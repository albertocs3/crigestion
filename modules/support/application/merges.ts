import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { createIncidentMergedNotifications } from "@/modules/platform/application/notifications";

const versionSchema = z.number().int().positive();
export const supportIncidentMergeSchema = z.object({
  primaryIncidentId: z.string().uuid(),
  duplicateIncidentId: z.string().uuid(),
  expectedPrimaryVersion: versionSchema,
  expectedDuplicateVersion: versionSchema,
  reason: z.string().trim().min(3).max(500),
  confirmation: z.literal("MERGE_DUPLICATE_INCIDENT")
}).strict();

export type SupportIncidentMergeCandidate = {
  id: string;
  number: string;
  title: string;
  version: number;
};

export type SupportIncidentMergeCommand = z.infer<typeof supportIncidentMergeSchema>;
export type SupportIncidentMergeContext = RequestContext & { idempotencyKey: string; requestHash: string; scope: string };
type MergeDto = { merge: { id: string; mergedAt: string }; primary: { id: string; number: string; version: number }; duplicate: { id: string; number: string; status: "CLOSED"; closeReason: "DUPLICATE"; version: number } };
type ErrorCode = "SUPPORT_INCIDENT_MERGE_FORBIDDEN" | "SUPPORT_INCIDENT_NOT_FOUND" | "SUPPORT_INCIDENT_MERGE_SAME_INCIDENT" | "SUPPORT_INCIDENT_MERGE_CUSTOMER_MISMATCH" | "SUPPORT_INCIDENT_MERGE_VERSION_CONFLICT" | "SUPPORT_INCIDENT_MERGE_PRIMARY_ALREADY_MERGED" | "SUPPORT_INCIDENT_MERGE_DUPLICATE_ALREADY_MERGED" | "SUPPORT_INCIDENT_MERGE_FINALIZED" | "SUPPORT_INCIDENT_MERGE_RATE_LIMITED" | "SUPPORT_INCIDENT_MERGE_BUSY" | "IDEMPOTENCY_KEY_REUSED" | "IDEMPOTENCY_REPLAY_INVALID";
type Failure = { ok: false; status: 403 | 404 | 409 | 429 | 503; error: { code: ErrorCode; message: string; retryAfterSeconds?: number } };
export type SupportIncidentMergeResult = { ok: true; status: 200 | 201; value: MergeDto } | Failure;
const replaySchema: z.ZodType<MergeDto> = z.object({ merge: z.object({ id: z.string().uuid(), mergedAt: z.string().datetime() }).strict(), primary: z.object({ id: z.string().uuid(), number: z.string(), version: versionSchema }).strict(), duplicate: z.object({ id: z.string().uuid(), number: z.string(), status: z.literal("CLOSED"), closeReason: z.literal("DUPLICATE"), version: versionSchema }).strict() }).strict();
type LockedIncident = { id: string; companyId: string; customerId: string; number: string; status: "NEW" | "IN_PROGRESS" | "PENDING_CUSTOMER" | "PENDING_THIRD_PARTY" | "RESOLVED" | "CLOSED"; version: number; responsibleUserId: string; mergedIntoIncidentId: string | null };

export async function mergeSupportIncidents(command: SupportIncidentMergeCommand, actor: SessionUser, context: SupportIncidentMergeContext): Promise<SupportIncidentMergeResult> {
  if (!actor.permissions.includes("Support.View") || !actor.permissions.includes("Support.MergeIncidents")) return fail(403, "SUPPORT_INCIDENT_MERGE_FORBIDDEN", "No tienes permiso para fusionar incidencias.");
  const key = scopedKey(actor, context);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const stored = await tx.idempotencyRecord.findUnique({ where: { key } });
        if (stored && stored.requestHash === context.requestHash && replaySchema.safeParse(stored.responseBody).success) return parseReplay(stored.requestHash, context.requestHash, stored.responseBody);
        const companyId = (await tx.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId;
        if (!companyId) return fail(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
        const rate = await consumeRateLimit(tx, companyId, actor.id);
        if (rate.limited) { if (rate.firstLimitedRequest) await auditDenied(tx, actor.id, companyId, command, "RATE_LIMITED", context.correlationId); return fail(429, "SUPPORT_INCIDENT_MERGE_RATE_LIMITED", "Se han realizado demasiados intentos. Inténtalo más tarde.", rate.retryAfterSeconds); }
        if (stored) { await auditDenied(tx, actor.id, companyId, command, stored.requestHash === context.requestHash ? "REPLAY_INVALID" : "IDEMPOTENCY_KEY_REUSED", context.correlationId); return parseReplay(stored.requestHash, context.requestHash, stored.responseBody); }
        if (command.primaryIncidentId === command.duplicateIncidentId) { await auditDenied(tx, actor.id, companyId, command, "SAME_INCIDENT", context.correlationId); return fail(409, "SUPPORT_INCIDENT_MERGE_SAME_INCIDENT", "La incidencia no puede fusionarse consigo misma."); }
        const rows = await tx.$queryRaw<LockedIncident[]>(Prisma.sql`SELECT "id", "companyId", "customerId", "number", "status", "version", "responsibleUserId", "mergedIntoIncidentId" FROM "support_incidents" WHERE "companyId" = ${companyId}::uuid AND "id" IN (${command.primaryIncidentId}::uuid, ${command.duplicateIncidentId}::uuid) ORDER BY "id" FOR UPDATE`);
        if (rows.length !== 2) { await auditDenied(tx, actor.id, companyId, command, "NOT_FOUND", context.correlationId); return fail(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe."); }
        const primary = rows.find((item) => item.id === command.primaryIncidentId)!;
        const duplicate = rows.find((item) => item.id === command.duplicateIncidentId)!;
        if (actor.role.code !== "Administrador" && (actor.id !== primary.responsibleUserId || actor.id !== duplicate.responsibleUserId)) { await auditDenied(tx, actor.id, companyId, command, "NOT_RESPONSIBLE_FOR_BOTH", context.correlationId); return fail(403, "SUPPORT_INCIDENT_MERGE_FORBIDDEN", "Debes ser responsable de ambas incidencias para fusionarlas."); }
        if (primary.version !== command.expectedPrimaryVersion || duplicate.version !== command.expectedDuplicateVersion) { await auditDenied(tx, actor.id, companyId, command, "VERSION_CONFLICT", context.correlationId); return fail(409, "SUPPORT_INCIDENT_MERGE_VERSION_CONFLICT", "Alguna incidencia ha cambiado. Recarga antes de continuar."); }
        if (primary.customerId !== duplicate.customerId) { await auditDenied(tx, actor.id, companyId, command, "CUSTOMER_MISMATCH", context.correlationId); return fail(409, "SUPPORT_INCIDENT_MERGE_CUSTOMER_MISMATCH", "Las incidencias deben pertenecer al mismo cliente."); }
        if (primary.mergedIntoIncidentId) { await auditDenied(tx, actor.id, companyId, command, "PRIMARY_ALREADY_MERGED", context.correlationId); return fail(409, "SUPPORT_INCIDENT_MERGE_PRIMARY_ALREADY_MERGED", "La incidencia principal ya está fusionada en otra."); }
        if (duplicate.mergedIntoIncidentId) { await auditDenied(tx, actor.id, companyId, command, "DUPLICATE_ALREADY_MERGED", context.correlationId); return fail(409, "SUPPORT_INCIDENT_MERGE_DUPLICATE_ALREADY_MERGED", "La incidencia duplicada ya está fusionada."); }
        if ([primary.status, duplicate.status].some((status) => status === "RESOLVED" || status === "CLOSED")) { await auditDenied(tx, actor.id, companyId, command, "FINALIZED", context.correlationId); return fail(409, "SUPPORT_INCIDENT_MERGE_FINALIZED", "Las incidencias deben estar activas para fusionarlas."); }
        if (await tx.supportIncidentMerge.findFirst({ where: { companyId, primaryIncidentId: duplicate.id }, select: { id: true } })) { await auditDenied(tx, actor.id, companyId, command, "DUPLICATE_HAS_CHILDREN", context.correlationId); return fail(409, "SUPPORT_INCIDENT_MERGE_DUPLICATE_ALREADY_MERGED", "Una incidencia principal con duplicadas no puede fusionarse en otra."); }
        const now = new Date(); const primaryVersion = primary.version + 1; const duplicateVersion = duplicate.version + 1;
        const merge = await tx.supportIncidentMerge.create({ data: { companyId, primaryIncidentId: primary.id, duplicateIncidentId: duplicate.id, actorUserId: actor.id, primaryResponsibleUserId: primary.responsibleUserId, duplicateResponsibleUserId: duplicate.responsibleUserId, primaryVersionBefore: primary.version, duplicateVersionBefore: duplicate.version, primaryResultingVersion: primaryVersion, duplicateResultingVersion: duplicateVersion, primaryStatusBefore: primary.status, duplicateStatusBefore: duplicate.status, reason: command.reason, mergedAt: now }, select: { id: true, mergedAt: true } });
        await tx.supportIncident.update({ where: { id: primary.id }, data: { version: primaryVersion } });
        await tx.supportIncident.update({ where: { id: duplicate.id }, data: { status: "CLOSED", closeReason: "DUPLICATE", closeReasonDetail: null, closedAt: now, resolvedAt: null, solution: null, mergedIntoIncidentId: primary.id, version: duplicateVersion } });
        const primaryEvent = await tx.supportIncidentEvent.create({ data: { companyId, incidentId: primary.id, actorUserId: actor.id, responsibleUserIdAtEvent: primary.responsibleUserId, mergeId: merge.id, mergeRole: "PRIMARY", eventType: "INCIDENT_MERGED", fromStatus: primary.status, toStatus: primary.status, resultingVersion: primaryVersion, createdAt: now }, select: { id: true } });
        await tx.supportIncidentEvent.create({ data: { companyId, incidentId: duplicate.id, actorUserId: actor.id, responsibleUserIdAtEvent: duplicate.responsibleUserId, mergeId: merge.id, mergeRole: "DUPLICATE", eventType: "INCIDENT_MERGED", fromStatus: duplicate.status, toStatus: "CLOSED", resultingVersion: duplicateVersion, createdAt: now } });
        await createIncidentMergedNotifications(tx, { companyId, incidentId: primary.id, duplicateIncidentId: duplicate.id, sourceEventId: primaryEvent.id, incidentNumber: primary.number, primaryResponsibleUserId: primary.responsibleUserId, duplicateResponsibleUserId: duplicate.responsibleUserId, correlationId: context.correlationId });
        const value: MergeDto = { merge: { id: merge.id, mergedAt: merge.mergedAt.toISOString() }, primary: { id: primary.id, number: primary.number, version: primaryVersion }, duplicate: { id: duplicate.id, number: duplicate.number, status: "CLOSED", closeReason: "DUPLICATE", version: duplicateVersion } };
        await tx.auditEvent.create({ data: { eventType: "SUPPORT_INCIDENTS_MERGED", actorType: "USER", payload: { actorUserId: actor.id, companyId, mergeId: merge.id, primaryIncidentId: primary.id, duplicateIncidentId: duplicate.id, primaryVersion, duplicateVersion, hasReason: true, ...(context.correlationId ? { correlationId: context.correlationId } : {}) } } });
        await tx.idempotencyRecord.create({ data: { key, requestHash: context.requestHash, responseStatus: 201, responseBody: value as unknown as Prisma.InputJsonValue } });
        return { ok: true, status: 201, value };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isRetryableTransactionError(error)) { if (attempt < 2) continue; return fail(503, "SUPPORT_INCIDENT_MERGE_BUSY", "No se pudo completar la fusión por concurrencia. Inténtalo de nuevo.", 3); }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const replay = await prisma.idempotencyRecord.findUnique({ where: { key } });
        if (replay && replay.requestHash === context.requestHash && replaySchema.safeParse(replay.responseBody).success) return parseReplay(replay.requestHash, context.requestHash, replay.responseBody);
        if (replay) return registerRejectedReplay(actor, command, context, replay.requestHash, replay.responseBody);
      }
      throw error;
    }
  }
  return fail(503, "SUPPORT_INCIDENT_MERGE_BUSY", "No se pudo completar la fusión por concurrencia. Inténtalo de nuevo.", 3);
}

async function registerRejectedReplay(
  actor: SessionUser,
  command: SupportIncidentMergeCommand,
  context: SupportIncidentMergeContext,
  storedHash: string,
  responseBody: Prisma.JsonValue,
): Promise<SupportIncidentMergeResult> {
  return prisma.$transaction(async (tx) => {
    const companyId = (
      await tx.installation.findFirst({
        where: { companyId: { not: null } },
        select: { companyId: true },
      })
    )?.companyId;
    if (!companyId) return fail(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
    const rate = await consumeRateLimit(tx, companyId, actor.id);
    if (rate.limited) {
      if (rate.firstLimitedRequest) await auditDenied(tx, actor.id, companyId, command, "RATE_LIMITED", context.correlationId);
      return fail(429, "SUPPORT_INCIDENT_MERGE_RATE_LIMITED", "Se han realizado demasiados intentos. Inténtalo más tarde.", rate.retryAfterSeconds);
    }
    await auditDenied(tx, actor.id, companyId, command, storedHash === context.requestHash ? "REPLAY_INVALID" : "IDEMPOTENCY_KEY_REUSED", context.correlationId);
    return parseReplay(storedHash, context.requestHash, responseBody);
  });
}

export async function listSupportMergeCandidates(
  duplicateIncidentId: string,
  actor: SessionUser,
): Promise<SupportIncidentMergeCandidate[]> {
  if (
    !actor.permissions.includes("Support.View") ||
    !actor.permissions.includes("Support.MergeIncidents")
  ) {
    return [];
  }
  const companyId = (
    await prisma.installation.findFirst({
      where: { companyId: { not: null } },
      select: { companyId: true },
    })
  )?.companyId;
  if (!companyId) return [];
  const duplicate = await prisma.supportIncident.findFirst({
    where: { id: duplicateIncidentId, companyId },
    select: {
      id: true,
      customerId: true,
      responsibleUserId: true,
      status: true,
      mergedIntoIncidentId: true,
      primaryMerges: { select: { id: true }, take: 1 },
    },
  });
  if (
    !duplicate ||
    duplicate.mergedIntoIncidentId ||
    duplicate.primaryMerges.length > 0 ||
    duplicate.status === "RESOLVED" ||
    duplicate.status === "CLOSED" ||
    (actor.role.code !== "Administrador" && duplicate.responsibleUserId !== actor.id)
  ) {
    return [];
  }
  return prisma.supportIncident.findMany({
    where: {
      companyId,
      customerId: duplicate.customerId,
      id: { not: duplicate.id },
      mergedIntoIncidentId: null,
      status: { in: ["NEW", "IN_PROGRESS", "PENDING_CUSTOMER", "PENDING_THIRD_PARTY"] },
      ...(actor.role.code === "Administrador" ? {} : { responsibleUserId: actor.id }),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 100,
    select: { id: true, number: true, title: true, version: true },
  });
}

export function hashSupportIncidentMergeRequest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function scopedKey(actor: SessionUser, context: SupportIncidentMergeContext) { return `v1:support:${createHash("sha256").update(`${actor.id}:${context.scope}:${context.idempotencyKey}`).digest("hex")}`; }
function parseReplay(storedHash: string, requestHash: string, body: Prisma.JsonValue): SupportIncidentMergeResult { if (storedHash !== requestHash) return fail(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se usó con otra petición."); const parsed = replaySchema.safeParse(body); return parsed.success ? { ok: true, status: 200, value: parsed.data } : fail(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es válida."); }
function fail(status: Failure["status"], code: ErrorCode, message: string, retryAfterSeconds?: number): Failure { return { ok: false, status, error: { code, message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) } }; }
async function auditDenied(tx: Prisma.TransactionClient, actorUserId: string, companyId: string, command: Pick<SupportIncidentMergeCommand, "primaryIncidentId" | "duplicateIncidentId">, reason: string, correlationId?: string) { await tx.auditEvent.create({ data: { eventType: "SUPPORT_INCIDENT_MERGE_DENIED", actorType: "USER", payload: { actorUserId, companyId, primaryFingerprint: createHash("sha256").update(command.primaryIncidentId).digest("hex"), duplicateFingerprint: createHash("sha256").update(command.duplicateIncidentId).digest("hex"), reason, ...(correlationId ? { correlationId } : {}) } } }); }
function isRetryableTransactionError(error: unknown): boolean { return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001")); }
async function consumeRateLimit(tx: Prisma.TransactionClient, companyId: string, actorId: string): Promise<{ limited: false } | { limited: true; firstLimitedRequest: boolean; retryAfterSeconds: number }> { const now = new Date(); const windowMs = 15 * 60_000; const resetBefore = new Date(now.getTime() - windowMs); const [bucket] = await tx.$queryRaw<Array<{ count: number; windowStart: Date }>>(Prisma.sql`INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt") VALUES (gen_random_uuid(), ${`support-merge:${companyId}:${actorId}`}, ${now}, 1, ${now}, ${now}) ON CONFLICT ("key") DO UPDATE SET "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${resetBefore} THEN 1 ELSE "rate_limit_buckets"."count" + 1 END, "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${resetBefore} THEN ${now} ELSE "rate_limit_buckets"."windowStart" END, "updatedAt" = ${now} RETURNING "count", "windowStart"`); if (!bucket || bucket.count <= 10) return { limited: false }; return { limited: true, firstLimitedRequest: bucket.count === 11, retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStart.getTime() + windowMs - now.getTime()) / 1000)) }; }
