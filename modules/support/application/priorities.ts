import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { createIncidentPriorityUrgentNotifications } from "@/modules/platform/application/notifications";

const prioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);
const versionSchema = z.number().int().positive();

export const supportPriorityChangeSchema = z.object({
  expectedVersion: versionSchema,
  priority: prioritySchema,
  reason: z.string().trim().min(3).max(500)
}).strict();

export type SupportPriorityChangeCommand = z.infer<typeof supportPriorityChangeSchema>;
export type SupportPriorityChangeContext = RequestContext & { idempotencyKey: string; requestHash: string; scope: string };
export type SupportPriorityChangeDto = {
  incident: { id: string; priority: z.infer<typeof prioritySchema>; version: number };
  change: { id: string; fromPriority: z.infer<typeof prioritySchema>; toPriority: z.infer<typeof prioritySchema>; occurredAt: string };
};
type ErrorCode = "SUPPORT_INCIDENT_PRIORITY_FORBIDDEN" | "SUPPORT_INCIDENT_NOT_FOUND" | "SUPPORT_INCIDENT_VERSION_CONFLICT" | "SUPPORT_INCIDENT_PRIORITY_UNCHANGED" | "SUPPORT_INCIDENT_PRIORITY_FINALIZED" | "SUPPORT_INCIDENT_PRIORITY_RATE_LIMITED" | "SUPPORT_INCIDENT_PRIORITY_BUSY" | "IDEMPOTENCY_KEY_REUSED" | "IDEMPOTENCY_REPLAY_INVALID";
type Failure = { ok: false; status: 403 | 404 | 409 | 429 | 503; error: { code: ErrorCode; message: string; retryAfterSeconds?: number } };
export type SupportPriorityChangeResult = { ok: true; status: 200 | 201; value: SupportPriorityChangeDto } | Failure;

const replaySchema: z.ZodType<SupportPriorityChangeDto> = z.object({
  incident: z.object({ id: z.string().uuid(), priority: prioritySchema, version: versionSchema }).strict(),
  change: z.object({ id: z.string().uuid(), fromPriority: prioritySchema, toPriority: prioritySchema, occurredAt: z.string().datetime() }).strict()
}).strict();
type LockedIncident = { id: string; companyId: string; number: string; priority: z.infer<typeof prioritySchema>; status: "NEW" | "IN_PROGRESS" | "PENDING_CUSTOMER" | "PENDING_THIRD_PARTY" | "RESOLVED" | "CLOSED"; version: number; responsibleUserId: string };

export async function changeSupportIncidentPriority(incidentId: string, command: SupportPriorityChangeCommand, actor: SessionUser, context: SupportPriorityChangeContext): Promise<SupportPriorityChangeResult> {
  if (!actor.permissions.includes("Support.View") || !actor.permissions.includes("Support.ManageAssigned")) return fail(403, "SUPPORT_INCIDENT_PRIORITY_FORBIDDEN", "No tienes permiso para cambiar la prioridad de la incidencia.");
  const key = scopedKey(actor, context);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const stored = await tx.idempotencyRecord.findUnique({ where: { key } });
        if (stored && stored.requestHash === context.requestHash && replaySchema.safeParse(stored.responseBody).success) return parseReplay(stored.requestHash, context.requestHash, stored.responseBody);
        const companyId = (await tx.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId;
        if (!companyId) return fail(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
        const rate = await consumeRateLimit(tx, companyId, actor.id);
        if (rate.limited) {
          if (rate.firstLimitedRequest) await auditDenied(tx, actor.id, companyId, incidentId, "RATE_LIMITED", context.correlationId);
          return fail(429, "SUPPORT_INCIDENT_PRIORITY_RATE_LIMITED", "Se han realizado demasiados intentos. Inténtalo más tarde.", rate.retryAfterSeconds);
        }
        if (stored) { await auditDenied(tx, actor.id, companyId, incidentId, stored.requestHash === context.requestHash ? "REPLAY_INVALID" : "IDEMPOTENCY_KEY_REUSED", context.correlationId); return parseReplay(stored.requestHash, context.requestHash, stored.responseBody); }
        const incident = (await tx.$queryRaw<LockedIncident[]>(Prisma.sql`SELECT "id", "companyId", "number", "priority", "status", "version", "responsibleUserId" FROM "support_incidents" WHERE "id" = ${incidentId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`))[0];
        if (!incident) { await auditDenied(tx, actor.id, companyId, incidentId, "NOT_FOUND", context.correlationId); return fail(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe."); }
        if (actor.id !== incident.responsibleUserId && actor.role.code !== "Administrador") { await auditDenied(tx, actor.id, companyId, incidentId, "NOT_RESPONSIBLE", context.correlationId); return fail(403, "SUPPORT_INCIDENT_PRIORITY_FORBIDDEN", "Solo el responsable o un administrador puede cambiar la prioridad."); }
        if (incident.version !== command.expectedVersion) { await auditDenied(tx, actor.id, companyId, incidentId, "VERSION_CONFLICT", context.correlationId); return fail(409, "SUPPORT_INCIDENT_VERSION_CONFLICT", "La incidencia ha cambiado. Recarga antes de continuar."); }
        if (incident.status === "RESOLVED" || incident.status === "CLOSED") { await auditDenied(tx, actor.id, companyId, incidentId, "FINALIZED", context.correlationId); return fail(409, "SUPPORT_INCIDENT_PRIORITY_FINALIZED", "Reabre la incidencia antes de cambiar su prioridad."); }
        if (incident.priority === command.priority) { await auditDenied(tx, actor.id, companyId, incidentId, "UNCHANGED", context.correlationId); return fail(409, "SUPPORT_INCIDENT_PRIORITY_UNCHANGED", "La incidencia ya tiene esa prioridad."); }
        const now = new Date();
        const resultingVersion = incident.version + 1;
        const change = await tx.supportIncidentPriorityChange.create({ data: { companyId, incidentId, actorUserId: actor.id, fromPriority: incident.priority, toPriority: command.priority, reason: command.reason, resultingVersion, occurredAt: now }, select: { id: true, occurredAt: true } });
        await tx.supportIncident.update({ where: { id: incident.id }, data: { priority: command.priority, version: resultingVersion } });
        const event = await tx.supportIncidentEvent.create({ data: { companyId, incidentId, actorUserId: actor.id, responsibleUserIdAtEvent: incident.responsibleUserId, priorityChangeId: change.id, eventType: "PRIORITY_CHANGED", fromStatus: incident.status, toStatus: incident.status, resultingVersion, createdAt: now }, select: { id: true } });
        if (incident.priority !== "URGENT" && command.priority === "URGENT") await createIncidentPriorityUrgentNotifications(tx, { companyId, incidentId, sourceEventId: event.id, incidentNumber: incident.number, correlationId: context.correlationId });
        const value: SupportPriorityChangeDto = { incident: { id: incident.id, priority: command.priority, version: resultingVersion }, change: { id: change.id, fromPriority: incident.priority, toPriority: command.priority, occurredAt: change.occurredAt.toISOString() } };
        await tx.auditEvent.create({ data: { eventType: "SUPPORT_INCIDENT_PRIORITY_CHANGED", actorType: "USER", payload: { actorUserId: actor.id, companyId, incidentId, incidentNumber: incident.number, fromPriority: incident.priority, toPriority: command.priority, previousVersion: incident.version, version: resultingVersion, hasReason: true, ...(context.correlationId ? { correlationId: context.correlationId } : {}) } } });
        await tx.idempotencyRecord.create({ data: { key, requestHash: context.requestHash, responseStatus: 201, responseBody: value as unknown as Prisma.InputJsonValue } });
        return { ok: true, status: 201, value };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        if (attempt < 2) continue;
        return fail(503, "SUPPORT_INCIDENT_PRIORITY_BUSY", "No se pudo completar el cambio por concurrencia. Inténtalo de nuevo.", 3);
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const replay = await prisma.idempotencyRecord.findUnique({ where: { key } });
        if (replay) {
          if (replay.requestHash === context.requestHash && replaySchema.safeParse(replay.responseBody).success) return parseReplay(replay.requestHash, context.requestHash, replay.responseBody);
          return prisma.$transaction(async (tx) => {
            const companyId = (await tx.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId;
            if (!companyId) return fail(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
            const rate = await consumeRateLimit(tx, companyId, actor.id);
            if (rate.limited) {
              if (rate.firstLimitedRequest) await auditDenied(tx, actor.id, companyId, incidentId, "RATE_LIMITED", context.correlationId);
              return fail(429, "SUPPORT_INCIDENT_PRIORITY_RATE_LIMITED", "Se han realizado demasiados intentos. Inténtalo más tarde.", rate.retryAfterSeconds);
            }
            await auditDenied(tx, actor.id, companyId, incidentId, replay.requestHash === context.requestHash ? "REPLAY_INVALID" : "IDEMPOTENCY_KEY_REUSED", context.correlationId);
            return parseReplay(replay.requestHash, context.requestHash, replay.responseBody);
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        }
      }
      throw error;
    }
  }
  return fail(503, "SUPPORT_INCIDENT_PRIORITY_BUSY", "No se pudo completar el cambio por concurrencia. Inténtalo de nuevo.", 3);
}

export function hashSupportPriorityChangeRequest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function scopedKey(actor: SessionUser, context: SupportPriorityChangeContext) { return `v1:support:${createHash("sha256").update(`${actor.id}:${context.scope}:${context.idempotencyKey}`).digest("hex")}`; }
function parseReplay(storedHash: string, requestHash: string, body: Prisma.JsonValue): SupportPriorityChangeResult { if (storedHash !== requestHash) return fail(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se usó con otra petición."); const parsed = replaySchema.safeParse(body); return parsed.success ? { ok: true, status: 200, value: parsed.data } : fail(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es válida."); }
function fail(status: Failure["status"], code: ErrorCode, message: string, retryAfterSeconds?: number): Failure { return { ok: false, status, error: { code, message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) } }; }
async function auditDenied(tx: Prisma.TransactionClient, actorUserId: string, companyId: string, incidentId: string, reason: string, correlationId?: string) { await tx.auditEvent.create({ data: { eventType: "SUPPORT_INCIDENT_PRIORITY_CHANGE_DENIED", actorType: "USER", payload: { actorUserId, companyId, incidentFingerprint: createHash("sha256").update(incidentId).digest("hex"), reason, ...(correlationId ? { correlationId } : {}) } } }); }
async function consumeRateLimit(tx: Prisma.TransactionClient, companyId: string, actorId: string): Promise<{ limited: false } | { limited: true; firstLimitedRequest: boolean; retryAfterSeconds: number }> {
  const now = new Date(); const windowMs = 15 * 60 * 1000; const resetBefore = new Date(now.getTime() - windowMs);
  const [bucket] = await tx.$queryRaw<Array<{ count: number; windowStart: Date }>>(Prisma.sql`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt") VALUES (gen_random_uuid(), ${`support-priority:${companyId}:${actorId}`}, ${now}, 1, ${now}, ${now})
    ON CONFLICT ("key") DO UPDATE SET "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${resetBefore} THEN 1 ELSE "rate_limit_buckets"."count" + 1 END, "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${resetBefore} THEN ${now} ELSE "rate_limit_buckets"."windowStart" END, "updatedAt" = ${now}
    RETURNING "count", "windowStart"
  `);
  if (!bucket || bucket.count <= 20) return { limited: false };
  return { limited: true, firstLimitedRequest: bucket.count === 21, retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStart.getTime() + windowMs - now.getTime()) / 1000)) };
}
