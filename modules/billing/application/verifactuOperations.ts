import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";

export const verifactuOperationsQuerySchema = z.object({
  status: z.enum(["INCIDENTS", "ALL", "PENDING", "CLAIMED", "PROCESSED", "DEAD"]).default("INCIDENTS"),
  operation: z.enum(["ALL", "SUBMIT", "RECONCILE"]).default("ALL"),
  environment: z.enum(["ALL", "TEST", "PRODUCTION"]).default("ALL"),
  search: z.string().trim().max(80).default("")
}).strict();

export const interveneVerifactuMessageSchema = z.object({
  expectedUpdatedAt: z.string().datetime(),
  reason: z.enum(["CREDENTIAL_CORRECTED", "SERVICE_RECOVERED", "MANUAL_REVIEW"])
}).strict();

export type VerifactuOperationsQuery = z.infer<typeof verifactuOperationsQuerySchema>;
export type VerifactuOperationsDashboard = Awaited<ReturnType<typeof getVerifactuOperations>>;

export async function getVerifactuOperations(query: VerifactuOperationsQuery, now = new Date()) {
  const installation = await prisma.installation.findUnique({ where: { singletonKey: 1 }, select: { companyId: true } });
  if (!installation?.companyId) return null;
  const companyId = installation.companyId;
  const where: Prisma.VerifactuOutboxMessageWhereInput = {
    fiscalRecord: {
      companyId,
      ...(query.search ? { invoice: { number: { contains: query.search, mode: "insensitive" } } } : {}),
      ...(query.environment !== "ALL" ? { sifInstallation: { environment: query.environment } } : {})
    },
    ...(query.status === "INCIDENTS" ? { OR: [
      { status: "DEAD" },
      { status: "PENDING", lastErrorCode: { not: null } },
      {
        status: "PROCESSED",
        operation: "SUBMIT",
        fiscalRecord: {
          recordType: "ALTA",
          correctedRecordId: null,
          correction: null,
          attempts: { some: { outcome: "REJECTED" } }
        }
      }
    ] } : query.status !== "ALL" ? { status: query.status } : {}),
    ...(query.operation !== "ALL" ? { operation: query.operation } : {})
  };
  const warningLimit = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
  const staleBefore = new Date(now.getTime() - 30_000);
  const [messages, credentials, pendingReady, claimed, dead, scheduled, workerRuns, readyByEnvironment] = await Promise.all([
    prisma.verifactuOutboxMessage.findMany({
      where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 101,
      select: {
        id: true, operation: true, status: true, attemptCount: true, maxAttempts: true, nextAttemptAt: true,
        leaseUntil: true, lastErrorCode: true, updatedAt: true,
        fiscalRecord: { select: {
           id: true, recordType: true, chainPosition: true, correctedRecordId: true,
           correction: { select: { id: true } },
           invoice: { select: {
             id: true, number: true, issueDate: true, verifactuStatus: true,
             customerLegalNameSnapshot: true, customerTaxIdSnapshot: true
           } },
          sifInstallation: { select: { installationCode: true, environment: true } },
           attempts: { orderBy: [{ attemptNumber: "desc" }], take: 1, select: {
             id: true, kind: true, outcome: true, completedAt: true, stableErrorCode: true, aeatCodes: true
           } }
        } }
      }
    }),
    prisma.verifactuMtlsCredentialVersion.findMany({
      where: { status: "ACTIVE", validUntil: { lte: warningLimit }, credential: { status: "ACTIVE", companyId, sifInstallations: { some: { status: "ACTIVE" } } } },
      orderBy: [{ validUntil: "asc" }, { id: "asc" }],
      select: { id: true, validUntil: true, credential: { select: { alias: true, sifInstallations: { where: { status: "ACTIVE" }, select: { installationCode: true, environment: true } } } } }
    }),
    prisma.verifactuOutboxMessage.count({ where: { status: "PENDING", nextAttemptAt: { lte: now }, fiscalRecord: { companyId } } }),
    prisma.verifactuOutboxMessage.count({ where: { status: "CLAIMED", fiscalRecord: { companyId } } }),
    prisma.verifactuOutboxMessage.count({ where: { status: "DEAD", fiscalRecord: { companyId } } }),
    prisma.verifactuOutboxMessage.count({ where: { status: "PENDING", nextAttemptAt: { gt: now }, fiscalRecord: { companyId } } }),
    prisma.verifactuWorkerRun.findMany({
      where: { companyId },
      orderBy: [{ startedAt: "desc" }],
      take: 20,
      select: {
        id: true, workerId: true, environment: true, status: true, startedAt: true, heartbeatAt: true,
        lastPollAt: true, lastProcessedAt: true, stoppedAt: true, lastOutcome: true, lastErrorCode: true,
        processedCount: true, idleCount: true, errorCount: true, leaseLostCount: true
      }
    }),
    prisma.verifactuOutboxMessage.groupBy({
      by: ["status"],
      where: { status: "PENDING", nextAttemptAt: { lte: now }, fiscalRecord: { companyId } },
      _count: { _all: true }
    })
  ]);
  const recentWorkerRuns = workerRuns.filter((run, index, all) =>
    all.findIndex((candidate) => candidate.environment === run.environment) === index
  );
  return {
    generatedAt: now.toISOString(),
    summary: { pendingReady, claimed, scheduled, dead },
    credentialAlerts: credentials.flatMap((version) => version.credential.sifInstallations.map((sif) => ({
      versionId: version.id, credentialAlias: version.credential.alias, installationCode: sif.installationCode,
      environment: sif.environment, validUntil: version.validUntil.toISOString(),
      severity: version.validUntil <= now || version.validUntil.getTime() - now.getTime() <= 7 * 24 * 60 * 60_000 ? "CRITICAL" as const : "WARNING" as const
    }))),
    workerHealth: recentWorkerRuns.map((run) => ({
      id: run.id,
      workerId: run.workerId,
      environment: run.environment,
      status: run.status,
      health: run.status === "RUNNING" && run.heartbeatAt >= staleBefore ? "HEALTHY" as const
        : run.status === "RUNNING" || run.status === "STOPPING" ? "STALE" as const
          : run.status === "FAILED" ? "FAILED" as const : "STOPPED" as const,
      startedAt: run.startedAt.toISOString(),
      heartbeatAt: run.heartbeatAt.toISOString(),
      lastPollAt: run.lastPollAt?.toISOString() ?? null,
      lastProcessedAt: run.lastProcessedAt?.toISOString() ?? null,
      stoppedAt: run.stoppedAt?.toISOString() ?? null,
      lastOutcome: run.lastOutcome,
      lastErrorCode: run.lastErrorCode,
      counters: { processed: run.processedCount, idle: run.idleCount, errors: run.errorCount, leaseLost: run.leaseLostCount }
    })),
    workerAlert: pendingReady > 0 && !recentWorkerRuns.some((run) => run.status === "RUNNING" && run.heartbeatAt >= staleBefore)
      ? { severity: "CRITICAL" as const, code: "VERIFACTU_WORKER_NOT_RUNNING", message: "Hay mensajes listos pero ningún worker VeriFactu comunica actividad reciente." }
      : recentWorkerRuns.some((run) => run.status === "FAILED" || ((run.status === "RUNNING" || run.status === "STOPPING") && run.heartbeatAt < staleBefore))
        ? { severity: "WARNING" as const, code: "VERIFACTU_WORKER_UNHEALTHY", message: "El último worker de algún entorno está detenido por error o sin heartbeat reciente." }
        : null,
    readyQueueCount: readyByEnvironment.reduce((total, group) => total + group._count._all, 0),
    hasMore: messages.length > 100,
    messages: messages.slice(0, 100).map((message) => ({
      id: message.id, operation: message.operation, status: message.status, attemptCount: message.attemptCount,
      maxAttempts: message.maxAttempts, nextAttemptAt: message.nextAttemptAt.toISOString(), leaseUntil: message.leaseUntil?.toISOString() ?? null,
      lastErrorCode: message.lastErrorCode, updatedAt: message.updatedAt.toISOString(), recordType: message.fiscalRecord.recordType,
      chainPosition: message.fiscalRecord.chainPosition.toString(), invoice: {
        id: message.fiscalRecord.invoice.id, number: message.fiscalRecord.invoice.number,
        issueDate: message.fiscalRecord.invoice.issueDate.toISOString(), verifactuStatus: message.fiscalRecord.invoice.verifactuStatus
      },
      installation: message.fiscalRecord.sifInstallation,
      latestAttempt: message.fiscalRecord.attempts[0] ? {
        id: message.fiscalRecord.attempts[0].id,
        kind: message.fiscalRecord.attempts[0].kind, outcome: message.fiscalRecord.attempts[0].outcome,
        completedAt: message.fiscalRecord.attempts[0].completedAt.toISOString(), stableErrorCode: message.fiscalRecord.attempts[0].stableErrorCode,
        aeatCodes: jsonStringArray(message.fiscalRecord.attempts[0].aeatCodes)
      } : null,
      action: actionFor(message.operation, message.status, message.lastErrorCode),
      rejectionCorrection: message.operation === "SUBMIT"
        && message.status === "PROCESSED"
        && message.fiscalRecord.recordType === "ALTA"
        && message.fiscalRecord.correctedRecordId === null
        && message.fiscalRecord.correction === null
        && message.fiscalRecord.attempts[0]?.outcome === "REJECTED"
        ? {
            rejectedRecordId: message.fiscalRecord.id,
            expectedRejectedAttemptId: message.fiscalRecord.attempts[0].id,
            recipientName: message.fiscalRecord.invoice.customerLegalNameSnapshot,
            recipientTaxId: message.fiscalRecord.invoice.customerTaxIdSnapshot
          }
        : null
    }))
  };
}

export async function interveneVerifactuDeadMessage(input: {
  messageId: string; expectedUpdatedAt: string; reason: z.infer<typeof interveneVerifactuMessageSchema>["reason"];
  actor: SessionUser; correlationId?: string; idempotencyKey: string; requestHash: string; now?: Date;
}): Promise<{ ok: true; status: 200; value: InterventionResponse } | { ok: false; status: 404 | 409; error: { code: string; message: string } }> {
  const existing = await prisma.idempotencyRecord.findUnique({ where: { key: input.idempotencyKey } });
  if (existing) {
    if (existing.requestHash !== input.requestHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
    return { ok: true, status: 200, value: interventionResponseSchema.parse(existing.responseBody) };
  }
  const now = input.now ?? new Date();
  const singleton = await prisma.installation.findUnique({ where: { singletonKey: 1 }, select: { companyId: true } });
  if (!singleton?.companyId) return failure(404, "VERIFACTU_OUTBOX_MESSAGE_NOT_FOUND", "El mensaje operativo no existe.");
  const companyId = singleton.companyId;
  try {
    const value = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT message."id" FROM "verifactu_outbox_messages" message
        JOIN "verifactu_fiscal_records" record ON record."id" = message."fiscalRecordId"
        WHERE message."id" = ${input.messageId}::uuid AND record."companyId" = ${companyId}::uuid
        FOR UPDATE OF message
      `;
      if (!locked[0]) throw new Error("VERIFACTU_OUTBOX_MESSAGE_NOT_FOUND");
      const message = await tx.verifactuOutboxMessage.findFirst({
        where: { id: input.messageId, fiscalRecord: { companyId } },
        select: { id: true, operation: true, status: true, attemptCount: true, maxAttempts: true, updatedAt: true, lastErrorCode: true, bodySha256: true, fiscalRecordId: true, fiscalRecord: { select: { invoiceId: true } } }
      });
      if (!message) throw new Error("VERIFACTU_OUTBOX_MESSAGE_NOT_FOUND");
      if (message.status !== "DEAD" || message.updatedAt.toISOString() !== input.expectedUpdatedAt) throw new Error("VERIFACTU_OUTBOX_MESSAGE_CHANGED");
      const action = actionFor(message.operation, message.status, message.lastErrorCode);
      if (!action) throw new Error("VERIFACTU_OUTBOX_INTERVENTION_NOT_ALLOWED");
      let targetMessageId = message.id;
      if (action === "RETRY_SUBMIT") {
        await tx.verifactuOutboxMessage.update({ where: { id: message.id }, data: { status: "PENDING", nextAttemptAt: now, maxAttempts: Math.max(message.maxAttempts, message.attemptCount + 1), leaseOwner: null, leaseToken: null, leaseUntil: null, processedAt: null } });
      } else if (message.operation === "RECONCILE") {
        await tx.verifactuOutboxMessage.update({ where: { id: message.id }, data: { status: "PENDING", nextAttemptAt: now, maxAttempts: Math.max(message.maxAttempts, message.attemptCount + 1), leaseOwner: null, leaseToken: null, leaseUntil: null, processedAt: null } });
      } else {
        const terminal = await tx.verifactuSubmissionAttempt.findFirst({ where: { fiscalRecordId: message.fiscalRecordId, outcome: { in: ["ACCEPTED", "ACCEPTED_WITH_ERRORS", "REJECTED"] } }, select: { id: true } });
        if (terminal) throw new Error("VERIFACTU_OUTBOX_INTERVENTION_NOT_ALLOWED");
        const existingReconcile = await tx.verifactuOutboxMessage.findUnique({ where: { fiscalRecordId_operation: { fiscalRecordId: message.fiscalRecordId, operation: "RECONCILE" } }, select: { status: true, attemptCount: true, maxAttempts: true } });
        if (existingReconcile && ["PENDING", "CLAIMED"].includes(existingReconcile.status)) throw new Error("VERIFACTU_OUTBOX_MESSAGE_CHANGED");
        await tx.verifactuOutboxMessage.update({ where: { id: message.id }, data: { status: "PROCESSED", processedAt: now, leaseOwner: null, leaseToken: null, leaseUntil: null } });
        const reconcile = await tx.verifactuOutboxMessage.upsert({
          where: { fiscalRecordId_operation: { fiscalRecordId: message.fiscalRecordId, operation: "RECONCILE" } },
          create: { fiscalRecordId: message.fiscalRecordId, operation: "RECONCILE", idempotencyKey: `vf-manual-reconcile:${randomUUID()}`, bodySha256: message.bodySha256, nextAttemptAt: now },
          update: { status: "PENDING", nextAttemptAt: now, maxAttempts: Math.max(existingReconcile?.maxAttempts ?? 20, (existingReconcile?.attemptCount ?? 0) + 1), leaseOwner: null, leaseToken: null, leaseUntil: null, processedAt: null },
          select: { id: true }
        });
        targetMessageId = reconcile.id;
        await tx.invoice.update({ where: { id: message.fiscalRecord.invoiceId }, data: { verifactuStatus: "SENT" } });
      }
      const response: InterventionResponse = { messageId: targetMessageId, sourceMessageId: message.id, action, status: "PENDING", scheduledAt: now.toISOString() };
      await tx.auditEvent.create({ data: { eventType: "VERIFACTU_OUTBOX_INTERVENTION_REQUESTED", actorType: "USER", payload: {
        actorUserId: input.actor.id, messageId: message.id, targetMessageId, fiscalRecordId: message.fiscalRecordId,
        invoiceId: message.fiscalRecord.invoiceId, operation: message.operation, action, previousErrorCode: message.lastErrorCode,
        attemptCount: message.attemptCount, reason: input.reason, ...(input.correlationId ? { correlationId: input.correlationId } : {})
      } } });
      await tx.idempotencyRecord.create({ data: { key: input.idempotencyKey, requestHash: input.requestHash, responseStatus: 200, responseBody: response } });
      return response;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { ok: true, status: 200, value };
  } catch (error) {
    if (error instanceof Error && error.message === "VERIFACTU_OUTBOX_MESSAGE_NOT_FOUND") return failure(404, error.message, "El mensaje operativo no existe.");
    if (error instanceof Error && ["VERIFACTU_OUTBOX_MESSAGE_CHANGED", "VERIFACTU_OUTBOX_INTERVENTION_NOT_ALLOWED"].includes(error.message)) return failure(409, error.message, "El mensaje ya no admite esta intervencion.");
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) {
      const replay = await prisma.idempotencyRecord.findUnique({ where: { key: input.idempotencyKey } });
      if (replay?.requestHash === input.requestHash) return { ok: true, status: 200, value: interventionResponseSchema.parse(replay.responseBody) };
      return failure(409, "VERIFACTU_OUTBOX_INTERVENTION_CONFLICT", "La cola cambio durante la intervencion.");
    }
    throw error;
  }
}

type InterventionResponse = { messageId: string; sourceMessageId: string; action: "RETRY_SUBMIT" | "RECONCILE"; status: "PENDING"; scheduledAt: string };
const interventionResponseSchema = z.object({ messageId: z.string().uuid(), sourceMessageId: z.string().uuid(), action: z.enum(["RETRY_SUBMIT", "RECONCILE"]), status: z.literal("PENDING"), scheduledAt: z.string().datetime() }).strict();
function actionFor(operation: "SUBMIT" | "RECONCILE", status: string, error: string | null): "RETRY_SUBMIT" | "RECONCILE" | null {
  if (status !== "DEAD" || error === "VERIFACTU_PAYLOAD_INTEGRITY_FAILED") return null;
  if (operation === "RECONCILE") return "RECONCILE";
  return error?.startsWith("VERIFACTU_CREDENTIAL_") ? "RETRY_SUBMIT" : "RECONCILE";
}
function failure(status: 404 | 409, code: string, message: string) { return { ok: false as const, status, error: { code, message } }; }
export function hashVerifactuInterventionBody(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function jsonStringArray(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 20) : [];
}
