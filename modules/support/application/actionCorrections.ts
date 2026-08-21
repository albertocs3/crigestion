import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { getSessionSecret } from "@/modules/platform/application/environment";

const versionSchema = z.number().int().positive();

export const supportActionCorrectionSchema = z.object({
  expectedIncidentVersion: versionSchema,
  expectedActionVersion: versionSchema,
  text: z.string().trim().min(3).max(4000),
  reason: z.string().trim().min(3).max(500),
}).strict();

export const supportActionCorrectionParamsSchema = z.object({
  incidentId: z.string().uuid(),
  actionId: z.string().uuid(),
}).strict();

export const supportActionCorrectionHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().max(2048).optional(),
}).strict();

export type SupportActionCorrectionCommand = z.infer<typeof supportActionCorrectionSchema>;
export type SupportActionCorrectionContext = RequestContext & { idempotencyKey: string; requestHash: string; scope: string };

export type SupportActionCorrectionDto = {
  incident: { id: string; version: number };
  action: { id: string; text: string; version: number };
  correction: { id: string; resultingIncidentVersion: number; resultingActionVersion: number; correctedAt: string };
};

export type SupportActionCorrectionHistoryDto = {
  incident: { id: string; number: string };
  action: { id: string };
  items: Array<{
    id: string;
    previousText: string;
    correctedText: string;
    reason: string;
    resultingActionVersion: number;
    resultingIncidentVersion: number;
    correctedAt: string;
    correctedBy: { id: string; displayName: string };
  }>;
  hasMore: boolean;
  nextCursor: string | null;
};

type HistoryError =
  | { ok: false; status: 403; error: { code: "SUPPORT_ACTION_CORRECTION_FORBIDDEN"; message: string } }
  | { ok: false; status: 404; error: { code: "SUPPORT_ACTION_NOT_FOUND"; message: string } }
  | { ok: false; status: 429; error: { code: "SUPPORT_ACTION_CORRECTION_HISTORY_RATE_LIMITED"; message: string; retryAfterSeconds: number } }
  | { ok: false; status: 503; error: { code: "SUPPORT_ACTION_CORRECTION_HISTORY_BUSY"; message: string; retryAfterSeconds: number } };
export type SupportActionCorrectionHistoryResult = { ok: true; value: SupportActionCorrectionHistoryDto } | HistoryError;

type ErrorCode =
  | "SUPPORT_ACTION_CORRECTION_FORBIDDEN"
  | "SUPPORT_INCIDENT_NOT_FOUND"
  | "SUPPORT_ACTION_NOT_FOUND"
  | "SUPPORT_INCIDENT_VERSION_CONFLICT"
  | "SUPPORT_ACTION_VERSION_CONFLICT"
  | "SUPPORT_ACTION_CORRECTION_UNCHANGED"
  | "SUPPORT_INCIDENT_MERGED_READ_ONLY"
  | "SUPPORT_ACTION_CORRECTION_RATE_LIMITED"
  | "SUPPORT_ACTION_CORRECTION_BUSY"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_REPLAY_INVALID";

type Failure = { ok: false; status: 403 | 404 | 409 | 429 | 503; error: { code: ErrorCode; message: string; retryAfterSeconds?: number } };
export type SupportActionCorrectionResult = { ok: true; status: 200 | 201; value: SupportActionCorrectionDto } | Failure;

const replaySchema: z.ZodType<SupportActionCorrectionDto> = z.object({
  incident: z.object({ id: z.string().uuid(), version: versionSchema }).strict(),
  action: z.object({ id: z.string().uuid(), text: z.string(), version: versionSchema }).strict(),
  correction: z.object({ id: z.string().uuid(), resultingIncidentVersion: versionSchema, resultingActionVersion: versionSchema, correctedAt: z.string().datetime() }).strict(),
}).strict();

type LockedRow = {
  incidentId: string;
  companyId: string;
  incidentNumber: string;
  incidentStatus: "NEW" | "IN_PROGRESS" | "PENDING_CUSTOMER" | "PENDING_THIRD_PARTY" | "RESOLVED" | "CLOSED";
  incidentVersion: number;
  responsibleUserId: string;
  mergedIntoIncidentId: string | null;
  actionId: string;
  authorUserId: string;
  originalText: string;
  currentText: string;
  actionVersion: number;
};

export async function correctSupportAction(
  incidentId: string,
  actionId: string,
  command: SupportActionCorrectionCommand,
  actor: SessionUser,
  context: SupportActionCorrectionContext,
): Promise<SupportActionCorrectionResult> {
  if (!actor.permissions.includes("Support.View") || !actor.permissions.includes("Support.CorrectActions")) {
    return fail(403, "SUPPORT_ACTION_CORRECTION_FORBIDDEN", "No tienes permiso para corregir actuaciones.");
  }
  const key = scopedKey(actor, context);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const stored = await tx.idempotencyRecord.findUnique({ where: { key } });
        const companyId = (await tx.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId;
        if (!companyId) return fail(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
        const parsedReplay = stored ? parseReplay(stored.requestHash, context.requestHash, stored.responseBody) : null;
        if (parsedReplay?.ok) {
          const replayTarget = await tx.supportIncidentAction.findFirst({
            where: { id: actionId, incidentId, companyId },
            select: {
              authorUserId: true,
              incident: {
                select: {
                  responsibleUserId: true,
                  collaborators: { where: { userId: actor.id, removedAt: null }, take: 1, select: { id: true } },
                },
              },
            },
          });
          if (!replayTarget) {
            const incidentExists = await tx.supportIncident.findFirst({ where: { id: incidentId, companyId }, select: { id: true } });
            await auditDenied(tx, actor.id, companyId, incidentId, actionId, incidentExists ? "ACTION_NOT_FOUND" : "INCIDENT_NOT_FOUND", context.correlationId);
            return incidentExists
              ? fail(404, "SUPPORT_ACTION_NOT_FOUND", "La actuación no existe.")
              : fail(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
          }
          const isCurrentMember = actor.id === replayTarget.incident.responsibleUserId
            || replayTarget.incident.collaborators.length > 0;
          if (actor.role.code !== "Administrador" && (actor.id !== replayTarget.authorUserId || !isCurrentMember)) {
            await auditDenied(tx, actor.id, companyId, incidentId, actionId, "NOT_ORIGINAL_AUTHOR_OR_MEMBER", context.correlationId);
            return fail(403, "SUPPORT_ACTION_CORRECTION_FORBIDDEN", "Solo el autor que siga en el equipo o un administrador puede corregir la actuación.");
          }
          return parsedReplay;
        }
        const rate = await consumeRateLimit(tx, companyId, actor.id);
        if (rate.limited) {
          if (rate.firstLimitedRequest) await auditDenied(tx, actor.id, companyId, incidentId, actionId, "RATE_LIMITED", context.correlationId);
          return fail(429, "SUPPORT_ACTION_CORRECTION_RATE_LIMITED", "Se han realizado demasiados intentos. Inténtalo más tarde.", rate.retryAfterSeconds);
        }
        const row = (await tx.$queryRaw<LockedRow[]>(Prisma.sql`
          SELECT incident."id" AS "incidentId", incident."companyId", incident."number" AS "incidentNumber",
            incident."status" AS "incidentStatus", incident."version" AS "incidentVersion",
            incident."responsibleUserId", incident."mergedIntoIncidentId",
            action."id" AS "actionId", action."authorUserId", action."text" AS "originalText",
            COALESCE(latest."correctedText", action."text") AS "currentText",
            COALESCE(latest."resultingActionVersion", 1) AS "actionVersion"
          FROM "support_incidents" incident
          JOIN "support_incident_actions" action
            ON action."incidentId" = incident."id" AND action."companyId" = incident."companyId"
          LEFT JOIN LATERAL (
            SELECT correction."correctedText", correction."resultingActionVersion"
            FROM "support_incident_action_corrections" correction
            WHERE correction."actionId" = action."id"
            ORDER BY correction."resultingActionVersion" DESC
            LIMIT 1
          ) latest ON TRUE
          WHERE incident."id" = ${incidentId}::uuid
            AND incident."companyId" = ${companyId}::uuid
            AND action."id" = ${actionId}::uuid
          FOR UPDATE OF incident, action
        `))[0];
        if (!row) {
          const incidentExists = await tx.supportIncident.findFirst({ where: { id: incidentId, companyId }, select: { id: true } });
          await auditDenied(tx, actor.id, companyId, incidentId, actionId, incidentExists ? "ACTION_NOT_FOUND" : "INCIDENT_NOT_FOUND", context.correlationId);
          return incidentExists
            ? fail(404, "SUPPORT_ACTION_NOT_FOUND", "La actuación no existe.")
            : fail(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
        }
        const isCollaborator = Boolean(await tx.supportIncidentCollaborator.findFirst({ where: { incidentId, companyId, userId: actor.id, removedAt: null }, select: { id: true } }));
        const isCurrentMember = actor.id === row.responsibleUserId || isCollaborator;
        if (actor.role.code !== "Administrador" && (actor.id !== row.authorUserId || !isCurrentMember)) {
          await auditDenied(tx, actor.id, companyId, incidentId, actionId, "NOT_ORIGINAL_AUTHOR_OR_MEMBER", context.correlationId);
          return fail(403, "SUPPORT_ACTION_CORRECTION_FORBIDDEN", "Solo el autor que siga en el equipo o un administrador puede corregir la actuación.");
        }
        if (stored) {
          await auditDenied(tx, actor.id, companyId, incidentId, actionId, parsedReplay!.error.code, context.correlationId);
          return parsedReplay!;
        }
        if (row.mergedIntoIncidentId) {
          await auditDenied(tx, actor.id, companyId, incidentId, actionId, "MERGED_READ_ONLY", context.correlationId);
          return fail(409, "SUPPORT_INCIDENT_MERGED_READ_ONLY", "Una incidencia fusionada es de solo lectura.");
        }
        if (row.incidentVersion !== command.expectedIncidentVersion) {
          await auditDenied(tx, actor.id, companyId, incidentId, actionId, "INCIDENT_VERSION_CONFLICT", context.correlationId);
          return fail(409, "SUPPORT_INCIDENT_VERSION_CONFLICT", "La incidencia ha cambiado. Recarga antes de continuar.");
        }
        if (row.actionVersion !== command.expectedActionVersion) {
          await auditDenied(tx, actor.id, companyId, incidentId, actionId, "ACTION_VERSION_CONFLICT", context.correlationId);
          return fail(409, "SUPPORT_ACTION_VERSION_CONFLICT", "La actuación ha cambiado. Recarga antes de continuar.");
        }
        if (row.currentText === command.text) {
          await auditDenied(tx, actor.id, companyId, incidentId, actionId, "UNCHANGED", context.correlationId);
          return fail(409, "SUPPORT_ACTION_CORRECTION_UNCHANGED", "El texto corregido coincide con el vigente.");
        }

        const correctedAt = new Date();
        const resultingActionVersion = row.actionVersion + 1;
        const resultingIncidentVersion = row.incidentVersion + 1;
        const correction = await tx.supportIncidentActionCorrection.create({
          data: {
            companyId,
            incidentId,
            actionId,
            originalAuthorUserId: row.authorUserId,
            correctedByUserId: actor.id,
            previousText: row.currentText,
            correctedText: command.text,
            reason: command.reason,
            resultingActionVersion,
            resultingIncidentVersion,
            correctedAt,
          },
          select: { id: true, correctedAt: true },
        });
        await tx.supportIncident.update({ where: { id: incidentId }, data: { version: resultingIncidentVersion } });
        await tx.supportIncidentEvent.create({
          data: {
            companyId,
            incidentId,
            actorUserId: actor.id,
            responsibleUserIdAtEvent: row.responsibleUserId,
            actionCorrectionId: correction.id,
            eventType: "ACTION_CORRECTED",
            fromStatus: row.incidentStatus,
            toStatus: row.incidentStatus,
            resultingVersion: resultingIncidentVersion,
            createdAt: correctedAt,
          },
        });
        const value: SupportActionCorrectionDto = {
          incident: { id: incidentId, version: resultingIncidentVersion },
          action: { id: actionId, text: command.text, version: resultingActionVersion },
          correction: { id: correction.id, resultingIncidentVersion, resultingActionVersion, correctedAt: correction.correctedAt.toISOString() },
        };
        await tx.auditEvent.create({
          data: {
            eventType: "SUPPORT_INCIDENT_ACTION_CORRECTED",
            actorType: "USER",
            payload: {
              actorUserId: actor.id,
              companyId,
              incidentId,
              incidentNumber: row.incidentNumber,
              actionId,
              correctionId: correction.id,
              previousIncidentVersion: row.incidentVersion,
              incidentVersion: resultingIncidentVersion,
              previousActionVersion: row.actionVersion,
              actionVersion: resultingActionVersion,
              hasText: true,
              hasReason: true,
              ...(context.correlationId ? { correlationId: context.correlationId } : {}),
            },
          },
        });
        await tx.idempotencyRecord.create({ data: { key, requestHash: context.requestHash, responseStatus: 201, responseBody: value as unknown as Prisma.InputJsonValue } });
        return { ok: true, status: 201, value };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isSerializationConflict(error)) {
        if (attempt < 2) continue;
        return fail(503, "SUPPORT_ACTION_CORRECTION_BUSY", "No se pudo completar la corrección por concurrencia. Inténtalo de nuevo.", 3);
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const replay = await prisma.idempotencyRecord.findUnique({ where: { key } });
        if (replay) return correctSupportAction(incidentId, actionId, command, actor, context);
      }
      throw error;
    }
  }
  return fail(503, "SUPPORT_ACTION_CORRECTION_BUSY", "No se pudo completar la corrección por concurrencia. Inténtalo de nuevo.", 3);
}

export async function listSupportActionCorrections(
  incidentId: string,
  actionId: string,
  query: z.infer<typeof supportActionCorrectionHistoryQuerySchema>,
  actor: SessionUser,
  context: RequestContext = {},
): Promise<SupportActionCorrectionHistoryResult> {
  if (!actor.permissions.includes("Support.View")) {
    return { ok: false, status: 403, error: { code: "SUPPORT_ACTION_CORRECTION_FORBIDDEN", message: "No tienes permiso para consultar correcciones de actuaciones." } };
  }
  try {
    return await prisma.$transaction(async (tx) => {
    const companyId = (await tx.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId;
    if (!companyId) return historyNotFound();
    const cursor = query.cursor ? decodeHistoryCursor(query.cursor, companyId, incidentId, actionId, query.limit) : null;
    if (query.cursor && !cursor) return historyNotFound();
    const rate = await consumeHistoryRateLimit(tx, companyId, actor.id);
    if (rate.limited) {
      if (rate.firstLimitedRequest) {
        await tx.auditEvent.create({
          data: {
            eventType: "SUPPORT_ACTION_CORRECTION_HISTORY_RATE_LIMITED",
            actorType: "USER",
            payload: {
              actorUserId: actor.id,
              companyId,
              incidentFingerprint: fingerprint(incidentId),
              actionFingerprint: fingerprint(actionId),
              retryAfterSeconds: rate.retryAfterSeconds,
              ...(context.correlationId ? { correlationId: context.correlationId } : {}),
            },
          },
        });
      }
      return { ok: false, status: 429, error: { code: "SUPPORT_ACTION_CORRECTION_HISTORY_RATE_LIMITED", message: "Se han consultado demasiadas páginas. Inténtalo más tarde.", retryAfterSeconds: rate.retryAfterSeconds } };
    }
    const action = await tx.supportIncidentAction.findFirst({
      where: { id: actionId, incidentId, companyId },
      select: { id: true, incident: { select: { id: true, number: true } } },
    });
    if (!action) {
      await tx.auditEvent.create({
        data: {
          eventType: "SUPPORT_ACTION_CORRECTION_HISTORY_DENIED",
          actorType: "USER",
          payload: {
            actorUserId: actor.id,
            companyId,
            incidentFingerprint: fingerprint(incidentId),
            actionFingerprint: fingerprint(actionId),
            reason: "ACTION_NOT_FOUND",
            ...(context.correlationId ? { correlationId: context.correlationId } : {}),
          },
        },
      });
      return historyNotFound();
    }
    const rows = await tx.supportIncidentActionCorrection.findMany({
      where: {
        companyId,
        incidentId,
        actionId,
        ...(cursor ? { resultingActionVersion: { lt: cursor.resultingActionVersion } } : {}),
      },
      orderBy: { resultingActionVersion: "desc" },
      take: query.limit + 1,
      select: {
        id: true,
        previousText: true,
        correctedText: true,
        reason: true,
        resultingActionVersion: true,
        resultingIncidentVersion: true,
        correctedAt: true,
        correctedBy: { select: { id: true, displayName: true } },
      },
    });
    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    const oldest = page[page.length - 1];
    await tx.auditEvent.create({
      data: {
        eventType: "SUPPORT_ACTION_CORRECTION_HISTORY_VIEWED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          companyId,
          incidentFingerprint: fingerprint(incidentId),
          actionFingerprint: fingerprint(actionId),
          resultCount: page.length,
          hasMore,
          cursorPresent: Boolean(query.cursor),
          ...(context.correlationId ? { correlationId: context.correlationId } : {}),
        },
      },
    });
    return {
      ok: true,
      value: {
        incident: action.incident,
        action: { id: action.id },
        items: page.reverse().map((item) => ({ ...item, correctedAt: item.correctedAt.toISOString() })),
        hasMore,
        nextCursor: hasMore && oldest
          ? encodeHistoryCursor(companyId, incidentId, actionId, query.limit, oldest.resultingActionVersion)
          : null,
      },
    };
    }, { maxWait: 1_000, timeout: 5_000 });
  } catch (error) {
    if (isHistoryBusyError(error)) {
      return { ok: false, status: 503, error: { code: "SUPPORT_ACTION_CORRECTION_HISTORY_BUSY", message: "No se pudo consultar el historial en este momento. Inténtalo de nuevo.", retryAfterSeconds: 3 } };
    }
    throw error;
  }
}

export function isSupportActionCorrectionHistoryCursor(
  value: string,
  incidentId: string,
  actionId: string,
  limit: number,
): boolean {
  return Boolean(decodeHistoryCursor(value, null, incidentId, actionId, limit));
}

export function hashSupportActionCorrectionRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function scopedKey(actor: SessionUser, context: SupportActionCorrectionContext): string {
  return `v1:support:${createHash("sha256").update(`${actor.id}:${context.scope}:${context.idempotencyKey}`).digest("hex")}`;
}

function parseReplay(storedHash: string, requestHash: string, body: Prisma.JsonValue): SupportActionCorrectionResult {
  if (storedHash !== requestHash) return fail(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se usó con otra petición.");
  const parsed = replaySchema.safeParse(body);
  return parsed.success ? { ok: true, status: 200, value: parsed.data } : fail(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es válida.");
}

function isSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001"));
}

function fail(status: Failure["status"], code: ErrorCode, message: string, retryAfterSeconds?: number): Failure {
  return { ok: false, status, error: { code, message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) } };
}

async function auditDenied(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  companyId: string,
  incidentId: string,
  actionId: string,
  reason: string,
  correlationId?: string,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      eventType: "SUPPORT_INCIDENT_ACTION_CORRECTION_DENIED",
      actorType: "USER",
      payload: {
        actorUserId,
        companyId,
        incidentFingerprint: createHash("sha256").update(incidentId).digest("hex"),
        actionFingerprint: createHash("sha256").update(actionId).digest("hex"),
        reason,
        ...(correlationId ? { correlationId } : {}),
      },
    },
  });
}

async function consumeRateLimit(
  tx: Prisma.TransactionClient,
  companyId: string,
  actorId: string,
): Promise<{ limited: false } | { limited: true; firstLimitedRequest: boolean; retryAfterSeconds: number }> {
  const now = new Date();
  const windowMs = 15 * 60 * 1000;
  const resetBefore = new Date(now.getTime() - windowMs);
  const [bucket] = await tx.$queryRaw<Array<{ count: number; windowStart: Date }>>(Prisma.sql`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), ${`support-action-correction:${companyId}:${actorId}`}, ${now}, 1, ${now}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${resetBefore} THEN 1 ELSE "rate_limit_buckets"."count" + 1 END,
      "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${resetBefore} THEN ${now} ELSE "rate_limit_buckets"."windowStart" END,
      "updatedAt" = ${now}
    RETURNING "count", "windowStart"
  `);
  if (!bucket || bucket.count <= 20) return { limited: false };
  return { limited: true, firstLimitedRequest: bucket.count === 21, retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStart.getTime() + windowMs - now.getTime()) / 1000)) };
}

function encodeHistoryCursor(
  companyId: string,
  incidentId: string,
  actionId: string,
  limit: number,
  resultingActionVersion: number,
): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, companyFingerprint: fingerprint(companyId), incidentId, actionId, limit, resultingActionVersion }), "utf8").toString("base64url");
  return `${payload}.${signHistoryCursor(payload)}`;
}

function decodeHistoryCursor(
  value: string,
  companyId: string | null,
  incidentId: string,
  actionId: string,
  limit: number,
): { resultingActionVersion: number } | null {
  try {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    const expected = Buffer.from(signHistoryCursor(payload), "base64url");
    const submitted = Buffer.from(signature, "base64url");
    if (submitted.toString("base64url") !== signature || submitted.length !== expected.length || !timingSafeEqual(submitted, expected)) return null;
    const parsed = z.object({
      v: z.literal(1),
      companyFingerprint: z.string().length(64),
      incidentId: z.string().uuid(),
      actionId: z.string().uuid(),
      limit: z.number().int().min(1).max(100),
      resultingActionVersion: z.number().int().min(2),
    }).strict().safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (!parsed.success
      || (companyId !== null && parsed.data.companyFingerprint !== fingerprint(companyId))
      || parsed.data.incidentId !== incidentId
      || parsed.data.actionId !== actionId
      || parsed.data.limit !== limit) return null;
    return { resultingActionVersion: parsed.data.resultingActionVersion };
  } catch {
    return null;
  }
}

function signHistoryCursor(payload: string): string {
  return createHmac("sha256", getSessionSecret()).update(`support-action-corrections-cursor:v1:${payload}`).digest("base64url");
}

function historyNotFound(): HistoryError {
  return { ok: false, status: 404, error: { code: "SUPPORT_ACTION_NOT_FOUND", message: "La actuación no existe." } };
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isHistoryBusyError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2024" || error.code === "P2034") return true;
    if (error.code === "P2010" && (error.meta?.code === "40001" || error.meta?.code === "57014")) return true;
    return error.code === "P2028" && /timed out|timeout|unable to start a transaction/i.test(error.message);
  }
  return error instanceof Prisma.PrismaClientUnknownRequestError
    && error.message.includes('code: "57014"')
    && /statement timeout|canceling statement/i.test(error.message);
}

async function consumeHistoryRateLimit(
  tx: Prisma.TransactionClient,
  companyId: string,
  actorId: string,
): Promise<{ limited: false } | { limited: true; firstLimitedRequest: boolean; retryAfterSeconds: number }> {
  const now = new Date();
  const windowMs = 15 * 60 * 1000;
  const resetBefore = new Date(now.getTime() - windowMs);
  const [bucket] = await tx.$queryRaw<Array<{ count: number; windowStart: Date }>>(Prisma.sql`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), ${`support-action-correction-history:${companyId}:${actorId}`}, ${now}, 1, ${now}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${resetBefore} THEN 1 ELSE "rate_limit_buckets"."count" + 1 END,
      "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${resetBefore} THEN ${now} ELSE "rate_limit_buckets"."windowStart" END,
      "updatedAt" = ${now}
    RETURNING "count", "windowStart"
  `);
  if (!bucket || bucket.count <= 60) return { limited: false };
  return { limited: true, firstLimitedRequest: bucket.count === 61, retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStart.getTime() + windowMs - now.getTime()) / 1000)) };
}
