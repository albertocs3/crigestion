import "server-only";

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { VerifactuPayloadCipher } from "@/modules/billing/infrastructure/verifactu/payloadCipher";

export type VerifactuTransportResult = {
  outcome: "ACCEPTED" | "ACCEPTED_WITH_ERRORS" | "REJECTED" | "RETRYABLE_FAILURE" | "UNKNOWN";
  stableCode: string | null;
  externalSubmissionId?: string;
  aeatCsv?: string;
  aeatCodes?: string[];
  response?: { ciphertext: Uint8Array; sha256: string; encryptionKeyId: string };
  retryDisposition?: "RETRY" | "DEAD";
  credentialVersionId?: string;
  mtlsRefId?: string;
  endpointKind?: "STANDARD" | "SEAL";
  requestSha256?: string;
};

export type VerifactuFiscalKey = { issuerName: string; issuerTaxId: string; invoiceNumber: string; issueDate: string };
export type VerifactuTransportContext = {
  companyId: string;
  sifInstallationId: string;
  invoiceId: string;
  preparationKey: string;
  recordType: "ALTA" | "ANULACION";
};

export type VerifactuTransport = {
  submit(input: { xml: Uint8Array; credentialRef: string; environment: "TEST" | "PRODUCTION"; requestId: string; fiscalKey: VerifactuFiscalKey; context: VerifactuTransportContext }): Promise<VerifactuTransportResult>;
  reconcile(input: { credentialRef: string; environment: "TEST" | "PRODUCTION"; requestId: string; fiscalKey: VerifactuFiscalKey; context: VerifactuTransportContext; externalSubmissionId: string | null }): Promise<VerifactuTransportResult>;
};

type ClaimedMessage = {
  id: string;
  fiscalRecordId: string;
  operation: "SUBMIT" | "RECONCILE";
  idempotencyKey: string;
  attemptCount: number;
  maxAttempts: number;
  leaseToken: string;
  leaseOwner: string;
  bodySha256: string;
};

export async function processNextVerifactuOutboxMessage(options: {
  workerId: string;
  companyId: string;
  environment: "TEST" | "PRODUCTION";
  cipher: VerifactuPayloadCipher;
  transport: VerifactuTransport;
  now?: () => Date;
  leaseMs?: number;
}): Promise<{ kind: "idle" | "processed" | "lease-lost"; outcome?: VerifactuTransportResult["outcome"] }> {
  const now = options.now ?? (() => new Date());
  await recoverExpiredSubmitLease(now(), options.companyId, options.environment);
  const claimed = await claimNextMessage(options.workerId, options.companyId, options.environment, now(), options.leaseMs ?? 90_000);
  if (!claimed) return { kind: "idle" };
  const claimedMessage = claimed;

  const record = await prisma.verifactuFiscalRecord.findFirstOrThrow({
    where: { id: claimed.fiscalRecordId, companyId: options.companyId, sifInstallation: { environment: options.environment } },
    select: {
      id: true,
      companyId: true,
      invoiceId: true,
      preparationKey: true,
      recordType: true,
      cancelledRecordId: true,
      payloadCiphertext: true,
      payloadSha256: true,
      encryptionKeyId: true,
      issuerTaxId: true,
      issuerName: true,
      invoiceNumber: true,
      invoiceIssueDate: true,
      sifInstallation: { select: { id: true, environment: true, credentialRef: true } },
      attempts: {
        where: { externalSubmissionId: { not: null } },
        orderBy: { attemptNumber: "desc" },
        take: 1,
        select: { externalSubmissionId: true }
      }
    }
  });

  let result: VerifactuTransportResult;
  const startedAt = now();
  let plaintextXml: Uint8Array | null = null;
  try {
    if (!record.sifInstallation.credentialRef) {
      await prisma.auditEvent.create({ data: { eventType: "VERIFACTU_MTLS_USE_DENIED", actorType: "SYSTEM", payload: { fiscalRecordId: record.id, operation: claimed.operation, stableCode: "VERIFACTU_CREDENTIAL_UNAVAILABLE" } } });
      result = fatalLocalFailure("VERIFACTU_CREDENTIAL_UNAVAILABLE");
      return await finish();
    }
    if (!safeHashEquals(claimed.bodySha256, record.payloadSha256)) throw new Error("payload-hash-mismatch");
    const xml = options.cipher.decrypt(record.payloadCiphertext, {
      companyId: record.companyId,
      sifInstallationId: record.sifInstallation.id,
      invoiceId: record.invoiceId,
      preparationKey: record.preparationKey,
      payloadSha256: record.payloadSha256,
      recordType: record.recordType,
      environment: record.sifInstallation.environment
    });
    plaintextXml = xml;
    const decryptedSha256 = createHash("sha256").update(xml).digest("hex");
    if (!safeHashEquals(decryptedSha256, record.payloadSha256)) throw new Error("plaintext-hash-mismatch");
    await prisma.auditEvent.create({ data: { eventType: "VERIFACTU_MTLS_USE_STARTED", actorType: "SYSTEM", payload: { fiscalRecordId: record.id, operation: claimed.operation, mtlsRefId: record.sifInstallation.credentialRef, requestId: claimed.idempotencyKey } } });
    const fiscalKey = { issuerName: record.issuerName, issuerTaxId: record.issuerTaxId, invoiceNumber: record.invoiceNumber, issueDate: formatAeatDate(record.invoiceIssueDate) };
    const context = {
      companyId: record.companyId,
      sifInstallationId: record.sifInstallation.id,
      invoiceId: record.invoiceId,
      preparationKey: record.preparationKey,
      recordType: record.recordType
    };
    result = claimed.operation === "SUBMIT"
      ? await options.transport.submit({ xml, credentialRef: record.sifInstallation.credentialRef, environment: record.sifInstallation.environment, requestId: claimed.idempotencyKey, fiscalKey, context })
      : await options.transport.reconcile({
          credentialRef: record.sifInstallation.credentialRef,
          environment: record.sifInstallation.environment,
          requestId: claimed.idempotencyKey,
          fiscalKey,
          context,
          externalSubmissionId: record.attempts[0]?.externalSubmissionId ?? null
        });
  } catch (error) {
    result = isLocalIntegrityFailure(error)
      ? fatalLocalFailure("VERIFACTU_PAYLOAD_INTEGRITY_FAILED")
      : claimed.operation === "SUBMIT"
        ? { outcome: "UNKNOWN", stableCode: "VERIFACTU_TRANSPORT_RESULT_UNKNOWN" }
        : { outcome: "RETRYABLE_FAILURE", stableCode: "VERIFACTU_TRANSPORT_UNAVAILABLE", retryDisposition: "RETRY" };
  } finally {
    plaintextXml?.fill(0);
  }

  return await finish();

  async function finish(): Promise<{ kind: "processed" | "lease-lost"; outcome?: VerifactuTransportResult["outcome"] }> {
    const finalized = await finalizeAttempt({ claimed: claimedMessage, record, result, startedAt, completedAt: now(), companyId: options.companyId, environment: options.environment });
    return finalized ? { kind: "processed", outcome: result.outcome } : { kind: "lease-lost" };
  }
}

async function claimNextMessage(workerId: string, companyId: string, environment: "TEST" | "PRODUCTION", now: Date, leaseMs: number): Promise<ClaimedMessage | null> {
  if (!workerId || workerId.length > 160 || leaseMs < 5_000 || leaseMs > 15 * 60_000) {
    throw new Error("VERIFACTU_WORKER_CONFIGURATION_INVALID");
  }
  const leaseToken = randomUUID();
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const rows = await prisma.$queryRaw<ClaimedMessage[]>(Prisma.sql`
    WITH candidate AS (
      SELECT message."id"
      FROM "verifactu_outbox_messages" message
      JOIN "verifactu_fiscal_records" record ON record."id" = message."fiscalRecordId"
      JOIN "verifactu_sif_installations" sif ON sif."id" = record."sifInstallationId"
      WHERE (
        message."status" = 'PENDING' AND message."nextAttemptAt" <= ${now}
      )
        AND record."companyId" = ${companyId}::uuid
        AND sif."environment" = ${environment}::"VerifactuEnvironment"
        AND message."attemptCount" < message."maxAttempts"
        AND NOT EXISTS (
          SELECT 1 FROM "platform_maintenance_state" maintenance
          WHERE maintenance."singletonKey" = 1 AND maintenance."enabled" = true
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "verifactu_fiscal_records" previous_record
          WHERE previous_record."sifInstallationId" = record."sifInstallationId"
            AND previous_record."chainPosition" < record."chainPosition"
            AND NOT EXISTS (
              SELECT 1 FROM "verifactu_submission_attempts" accepted_attempt
              WHERE accepted_attempt."fiscalRecordId" = previous_record."id"
                AND accepted_attempt."outcome" IN ('ACCEPTED', 'ACCEPTED_WITH_ERRORS', 'REJECTED')
            )
        )
      ORDER BY record."sifInstallationId", record."chainPosition", message."createdAt", message."id"
      FOR UPDATE OF message SKIP LOCKED
      LIMIT 1
    )
    UPDATE "verifactu_outbox_messages" message
    SET "status" = 'CLAIMED', "attemptCount" = message."attemptCount" + 1,
      "leaseOwner" = ${workerId}, "leaseToken" = ${leaseToken}::uuid,
      "leaseUntil" = ${leaseUntil}, "updatedAt" = ${now}
    FROM candidate
    WHERE message."id" = candidate."id"
    RETURNING message."id", message."fiscalRecordId", message."operation",
      message."idempotencyKey", message."bodySha256", message."attemptCount", message."maxAttempts", message."leaseToken", message."leaseOwner"
  `);
  return rows[0] ?? null;
}

async function recoverExpiredSubmitLease(now: Date, companyId: string, environment: "TEST" | "PRODUCTION"): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const expired = await tx.$queryRaw<Array<{
      id: string;
      fiscalRecordId: string;
      operation: "SUBMIT" | "RECONCILE";
      idempotencyKey: string;
      attemptCount: number;
    }>>(Prisma.sql`
      SELECT message."id", message."fiscalRecordId", message."operation", message."idempotencyKey", message."attemptCount"
      FROM "verifactu_outbox_messages" message
      JOIN "verifactu_fiscal_records" record ON record."id" = message."fiscalRecordId"
      JOIN "verifactu_sif_installations" sif ON sif."id" = record."sifInstallationId"
      WHERE message."status" = 'CLAIMED' AND message."leaseUntil" <= ${now}
        AND record."companyId" = ${companyId}::uuid
        AND sif."environment" = ${environment}::"VerifactuEnvironment"
        AND NOT EXISTS (
          SELECT 1 FROM "platform_maintenance_state" maintenance
          WHERE maintenance."singletonKey" = 1 AND maintenance."enabled" = true
        )
      ORDER BY message."leaseUntil", message."id"
      FOR UPDATE OF message SKIP LOCKED
      LIMIT 1
    `);
    const message = expired[0];
    if (!message) return;
    if (message.operation === "RECONCILE") {
      await tx.verifactuOutboxMessage.update({
        where: { id: message.id },
        data: {
          status: "PENDING",
          nextAttemptAt: now,
          leaseOwner: null,
          leaseToken: null,
          leaseUntil: null,
          lastErrorCode: "VERIFACTU_RECONCILE_LEASE_EXPIRED"
        }
      });
      return;
    }

    const record = await tx.verifactuFiscalRecord.findUniqueOrThrow({
      where: { id: message.fiscalRecordId },
      select: { id: true, invoiceId: true, payloadCiphertext: true, payloadSha256: true, encryptionKeyId: true }
    });
    const lastAttempt = await tx.verifactuSubmissionAttempt.aggregate({
      where: { fiscalRecordId: record.id },
      _max: { attemptNumber: true }
    });
    const attemptNumber = (lastAttempt._max.attemptNumber ?? 0) + 1;
    await tx.verifactuSubmissionAttempt.create({
      data: {
        fiscalRecordId: record.id,
        attemptNumber,
        kind: "SUBMIT",
        idempotencyKey: `${message.idempotencyKey}:lease-expired:${message.attemptCount}`,
        startedAt: now,
        completedAt: now,
        outcome: "UNKNOWN",
        requestCiphertext: record.payloadCiphertext,
        encryptionKeyId: record.encryptionKeyId,
        requestSha256: record.payloadSha256,
        stableErrorCode: "VERIFACTU_SUBMIT_LEASE_EXPIRED"
      }
    });
    await tx.verifactuOutboxMessage.update({
      where: { id: message.id },
      data: {
        status: "PROCESSED",
        processedAt: now,
        leaseOwner: null,
        leaseToken: null,
        leaseUntil: null,
        lastErrorCode: "VERIFACTU_SUBMIT_LEASE_EXPIRED"
      }
    });
    await ensureReconcilePending(tx, record.id, record.payloadSha256, now);
    await tx.invoice.update({ where: { id: record.invoiceId }, data: { verifactuStatus: "SENT" } });
    await tx.auditEvent.create({
      data: {
        eventType: "VERIFACTU_SUBMISSION_LEASE_EXPIRED",
        actorType: "SYSTEM",
        payload: { fiscalRecordId: record.id, invoiceId: record.invoiceId, attemptNumber }
      }
    });
  });
}

async function finalizeAttempt(input: {
  claimed: ClaimedMessage;
  record: {
    id: string;
    invoiceId: string;
    recordType: "ALTA" | "ANULACION";
    cancelledRecordId: string | null;
    payloadCiphertext: Uint8Array;
    payloadSha256: string;
    encryptionKeyId: string;
  };
  result: VerifactuTransportResult;
  startedAt: Date;
  completedAt: Date;
  companyId: string;
  environment: "TEST" | "PRODUCTION";
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT message."id" FROM "verifactu_outbox_messages" message
      JOIN "verifactu_fiscal_records" record ON record."id" = message."fiscalRecordId"
      JOIN "verifactu_sif_installations" sif ON sif."id" = record."sifInstallationId"
      WHERE message."id" = ${input.claimed.id}::uuid AND message."status" = 'CLAIMED'
        AND message."leaseOwner" = ${input.claimed.leaseOwner}
        AND message."leaseToken" = ${input.claimed.leaseToken}::uuid
        AND message."leaseUntil" >= ${input.completedAt}
        AND record."companyId" = ${input.companyId}::uuid
        AND sif."environment" = ${input.environment}::"VerifactuEnvironment"
      FOR UPDATE OF message
    `);
    if (!locked[0]) return false;

    const lastAttempt = await tx.verifactuSubmissionAttempt.aggregate({
      where: { fiscalRecordId: input.record.id },
      _max: { attemptNumber: true }
    });
    const attemptNumber = (lastAttempt._max.attemptNumber ?? 0) + 1;
    await tx.verifactuSubmissionAttempt.create({
      data: {
        fiscalRecordId: input.record.id,
        attemptNumber,
        kind: input.claimed.operation,
        idempotencyKey: `${input.claimed.idempotencyKey}:${input.claimed.attemptCount}`,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        outcome: input.result.outcome,
        requestCiphertext: Buffer.from(input.record.payloadCiphertext),
        responseCiphertext: input.result.response ? Buffer.from(input.result.response.ciphertext) : null,
        encryptionKeyId: input.result.response?.encryptionKeyId ?? input.record.encryptionKeyId,
        requestSha256: input.record.payloadSha256,
        responseSha256: input.result.response?.sha256,
        externalSubmissionId: input.result.externalSubmissionId,
        aeatCsv: input.result.aeatCsv,
        aeatCodes: input.result.aeatCodes,
        stableErrorCode: input.result.stableCode,
        credentialVersionId: input.result.credentialVersionId
      }
    });

    const terminal = ["ACCEPTED", "ACCEPTED_WITH_ERRORS", "REJECTED"].includes(input.result.outcome)
      || (input.result.outcome === "UNKNOWN" && input.claimed.operation === "SUBMIT");
    const exhausted = input.claimed.attemptCount >= input.claimed.maxAttempts || input.result.retryDisposition === "DEAD";
    await tx.verifactuOutboxMessage.update({
      where: { id: input.claimed.id },
      data: terminal
        ? { status: "PROCESSED", processedAt: input.completedAt, leaseOwner: null, leaseToken: null, leaseUntil: null, lastErrorCode: input.result.stableCode }
        : exhausted
          ? { status: "DEAD", leaseOwner: null, leaseToken: null, leaseUntil: null, lastErrorCode: input.result.stableCode }
          : {
              status: "PENDING",
              nextAttemptAt: new Date(input.completedAt.getTime() + retryDelayMs(input.claimed.attemptCount)),
              leaseOwner: null,
              leaseToken: null,
              leaseUntil: null,
              lastErrorCode: input.result.stableCode
            }
    });

    if (input.result.outcome === "UNKNOWN" && input.claimed.operation === "SUBMIT") {
      await ensureReconcilePending(tx, input.record.id, input.record.payloadSha256, input.completedAt);
      await tx.auditEvent.create({
        data: {
          eventType: "VERIFACTU_SUBMISSION_RESULT_UNKNOWN",
          actorType: "SYSTEM",
          payload: { fiscalRecordId: input.record.id, invoiceId: input.record.invoiceId, sourceMessageId: input.claimed.id }
        }
      });
    }

    let invoiceStatus: "NOT_APPLICABLE" | "PENDING" | "SENT" | "ACCEPTED" | "ACCEPTED_WITH_ERRORS" | "REJECTED" | "CANCELLED" = input.result.outcome === "ACCEPTED" ? "ACCEPTED"
      : input.result.outcome === "ACCEPTED_WITH_ERRORS" ? "ACCEPTED_WITH_ERRORS"
        : input.result.outcome === "REJECTED" ? "REJECTED"
          : input.result.retryDisposition === "DEAD" ? "PENDING" : "SENT";
    if (input.record.recordType === "ANULACION") {
      if (input.result.outcome === "ACCEPTED" || input.result.outcome === "ACCEPTED_WITH_ERRORS") {
        invoiceStatus = "CANCELLED";
      } else if (input.result.outcome === "REJECTED" && input.record.cancelledRecordId) {
        const acceptedAlta = await tx.verifactuSubmissionAttempt.findFirst({
          where: { fiscalRecordId: input.record.cancelledRecordId, outcome: { in: ["ACCEPTED", "ACCEPTED_WITH_ERRORS"] } },
          orderBy: [{ completedAt: "desc" }, { id: "desc" }],
          select: { outcome: true }
        });
        invoiceStatus = acceptedAlta?.outcome === "ACCEPTED_WITH_ERRORS" ? "ACCEPTED_WITH_ERRORS" : "ACCEPTED";
      }
    }
    await tx.invoice.update({ where: { id: input.record.invoiceId }, data: { verifactuStatus: invoiceStatus } });
    await tx.auditEvent.create({
      data: {
        eventType: "VERIFACTU_SUBMISSION_ATTEMPTED",
        actorType: "SYSTEM",
        payload: {
          fiscalRecordId: input.record.id,
          invoiceId: input.record.invoiceId,
          operation: input.claimed.operation,
          attemptNumber,
          outcome: input.result.outcome,
          stableCode: input.result.stableCode
        }
      }
    });
    await tx.auditEvent.create({
      data: {
        eventType: !input.result.credentialVersionId && input.result.stableCode?.startsWith("VERIFACTU_CREDENTIAL_")
          ? "VERIFACTU_MTLS_USE_DENIED"
          : "VERIFACTU_MTLS_USE_COMPLETED",
        actorType: "SYSTEM",
        payload: {
          fiscalRecordId: input.record.id,
          operation: input.claimed.operation,
          attemptNumber,
          outcome: input.result.outcome,
          stableCode: input.result.stableCode,
          ...(input.result.mtlsRefId ? { mtlsRefId: input.result.mtlsRefId } : {}),
          ...(input.result.credentialVersionId ? { mtlsVersionId: input.result.credentialVersionId } : {})
        }
      }
    });
    return true;
  });
}

async function ensureReconcilePending(
  tx: Prisma.TransactionClient,
  fiscalRecordId: string,
  bodySha256: string,
  now: Date
): Promise<void> {
  const existing = await tx.verifactuOutboxMessage.findUnique({
    where: { fiscalRecordId_operation: { fiscalRecordId, operation: "RECONCILE" } },
    select: { id: true, status: true, attemptCount: true, maxAttempts: true }
  });
  if (!existing) {
    await tx.verifactuOutboxMessage.create({
      data: { fiscalRecordId, operation: "RECONCILE", idempotencyKey: `vf-reconcile:${fiscalRecordId}`, bodySha256, nextAttemptAt: now }
    });
    return;
  }
  if (existing.status === "PENDING" || existing.status === "CLAIMED") return;
  const terminalAttempt = await tx.verifactuSubmissionAttempt.findFirst({
    where: { fiscalRecordId, outcome: { in: ["ACCEPTED", "ACCEPTED_WITH_ERRORS", "REJECTED"] } },
    select: { id: true }
  });
  if (terminalAttempt) return;
  await tx.verifactuOutboxMessage.update({
    where: { id: existing.id },
    data: {
      status: "PENDING",
      nextAttemptAt: now,
      maxAttempts: Math.max(existing.maxAttempts, existing.attemptCount + 1),
      processedAt: null,
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      lastErrorCode: null
    }
  });
}

function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 5_000 * 2 ** Math.min(attempt - 1, 10));
}

function safeHashEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "ascii");
  const rightBytes = Buffer.from(right, "ascii");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function fatalLocalFailure(stableCode: string): VerifactuTransportResult {
  return { outcome: "RETRYABLE_FAILURE", stableCode, retryDisposition: "DEAD" };
}

function isLocalIntegrityFailure(error: unknown): boolean {
  return error instanceof Error && [
    "payload-hash-mismatch",
    "plaintext-hash-mismatch",
    "VERIFACTU_PAYLOAD_AUTHENTICATION_FAILED",
    "VERIFACTU_ENCRYPTED_PAYLOAD_INVALID",
    "VERIFACTU_ENCRYPTION_KEY_MISMATCH",
    "VERIFACTU_ENCRYPTION_KEY_NOT_FOUND",
    "VERIFACTU_PAYLOAD_CONTEXT_INVALID"
  ].some((code) => error.message.includes(code));
}

function formatAeatDate(value: Date): string {
  const day = String(value.getUTCDate()).padStart(2, "0");
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  return `${day}-${month}-${value.getUTCFullYear()}`;
}
