import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";

const statusSchema = z.enum(["NEW", "IN_PROGRESS", "PENDING_CUSTOMER", "PENDING_THIRD_PARTY", "RESOLVED", "CLOSED"]);

export const createSupportActionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  text: z.string().trim().min(3).max(4000),
  performedAt: z.string().datetime({ offset: true })
}).strict();

export type CreateSupportActionCommand = z.infer<typeof createSupportActionSchema>;
export type SupportActionMutationContext = RequestContext & { idempotencyKey: string; requestHash: string; scope: string };
export type SupportActionResultDto = {
  action: { id: string; text: string; performedAt: string; recordedAt: string; author: { id: string; displayName: string } };
  incident: { id: string; status: z.infer<typeof statusSchema>; version: number; firstActionAt: string };
};

type ActionFailure = {
  ok: false;
  status: 403 | 404 | 409 | 422;
  error: {
    code: "SUPPORT_INCIDENT_ACTION_FORBIDDEN" | "SUPPORT_INCIDENT_NOT_FOUND" | "SUPPORT_INCIDENT_VERSION_CONFLICT" | "SUPPORT_INCIDENT_FINALIZED" | "SUPPORT_ACTION_DATE_INVALID" | "IDEMPOTENCY_KEY_REUSED" | "IDEMPOTENCY_REPLAY_INVALID";
    message: string;
  };
};
export type CreateSupportActionResult = { ok: true; status: 200 | 201; value: SupportActionResultDto } | ActionFailure;

const replaySchema: z.ZodType<SupportActionResultDto> = z.object({
  action: z.object({ id: z.string().uuid(), text: z.string(), performedAt: z.string().datetime(), recordedAt: z.string().datetime(), author: z.object({ id: z.string().uuid(), displayName: z.string() }).strict() }).strict(),
  incident: z.object({ id: z.string().uuid(), status: statusSchema, version: z.number().int().positive(), firstActionAt: z.string().datetime() }).strict()
}).strict();

type LockedIncident = { id: string; companyId: string; status: z.infer<typeof statusSchema>; version: number; responsibleUserId: string; createdAt: Date; firstActionAt: Date | null; number: string };

export async function createSupportAction(incidentId: string, command: CreateSupportActionCommand, actor: SessionUser, context: SupportActionMutationContext): Promise<CreateSupportActionResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const key = scopedKey(actor, context);
        const replay = await tx.idempotencyRecord.findUnique({ where: { key } });
        if (replay) return parseReplay(replay.requestHash, context.requestHash, replay.responseBody);
        const companyId = await currentCompanyId(tx);
        if (!companyId) return failure(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
        const rows = await tx.$queryRaw<LockedIncident[]>(Prisma.sql`
          SELECT "id", "companyId", "status", "version", "responsibleUserId", "createdAt", "firstActionAt", "number"
          FROM "support_incidents"
          WHERE "id" = ${incidentId}::uuid AND "companyId" = ${companyId}::uuid
          FOR UPDATE
        `);
        const incident = rows[0];
        if (!incident) return failure(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
        if (actor.id !== incident.responsibleUserId && actor.role.code !== "Administrador") {
          await tx.auditEvent.create({ data: { eventType: "SUPPORT_INCIDENT_ACTION_DENIED", actorType: "USER", payload: { actorUserId: actor.id, companyId, incidentId: incident.id, reason: "NOT_RESPONSIBLE", ...(context.correlationId ? { correlationId: context.correlationId } : {}) } } });
          return failure(403, "SUPPORT_INCIDENT_ACTION_FORBIDDEN", "Solo el responsable o un administrador puede registrar actuaciones.");
        }
        if (incident.version !== command.expectedVersion) return failure(409, "SUPPORT_INCIDENT_VERSION_CONFLICT", "La incidencia ha cambiado. Recarga antes de continuar.");
        if (incident.status === "RESOLVED" || incident.status === "CLOSED") return failure(409, "SUPPORT_INCIDENT_FINALIZED", "La incidencia debe reabrirse antes de registrar actuaciones.");
        const performedAt = new Date(command.performedAt);
        const now = new Date();
        if (performedAt < incident.createdAt || performedAt.getTime() > now.getTime() + 5 * 60 * 1000) return failure(422, "SUPPORT_ACTION_DATE_INVALID", "La fecha de la actuacion debe estar entre la creacion de la incidencia y el momento actual.");
        const action = await tx.supportIncidentAction.create({ data: { companyId, incidentId, authorUserId: actor.id, text: command.text, performedAt }, select: { id: true, text: true, performedAt: true, recordedAt: true } });
        const firstActionAt = incident.firstActionAt && incident.firstActionAt <= performedAt ? incident.firstActionAt : performedAt;
        const nextStatus = incident.status === "NEW" ? "IN_PROGRESS" : incident.status;
        const updated = await tx.supportIncident.updateMany({ where: { id: incident.id, companyId, version: command.expectedVersion }, data: { status: nextStatus, firstActionAt, version: { increment: 1 } } });
        if (updated.count !== 1) return failure(409, "SUPPORT_INCIDENT_VERSION_CONFLICT", "La incidencia ha cambiado. Recarga antes de continuar.");
        await tx.supportIncidentEvent.create({ data: { companyId, incidentId, actorUserId: actor.id, actionId: action.id, eventType: "ACTION_ADDED", fromStatus: incident.status === "NEW" ? "NEW" : null, toStatus: incident.status === "NEW" ? "IN_PROGRESS" : null } });
        const value: SupportActionResultDto = { action: { id: action.id, text: action.text, performedAt: action.performedAt.toISOString(), recordedAt: action.recordedAt.toISOString(), author: { id: actor.id, displayName: actor.displayName } }, incident: { id: incident.id, status: nextStatus, version: command.expectedVersion + 1, firstActionAt: firstActionAt.toISOString() } };
        await tx.auditEvent.create({ data: { eventType: "SUPPORT_INCIDENT_ACTION_ADDED", actorType: "USER", payload: { actorUserId: actor.id, companyId, incidentId: incident.id, incidentNumber: incident.number, actionId: action.id, previousStatus: incident.status, status: nextStatus, previousVersion: incident.version, version: command.expectedVersion + 1, performedAt: value.action.performedAt, hasText: true, ...(context.correlationId ? { correlationId: context.correlationId } : {}) } } });
        await tx.idempotencyRecord.create({ data: { key, requestHash: context.requestHash, responseStatus: 201, responseBody: value as unknown as Prisma.InputJsonValue } });
        return { ok: true, status: 201, value };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && attempt < 2) continue;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const replay = await prisma.idempotencyRecord.findUnique({ where: { key: scopedKey(actor, context) } });
        if (replay) return parseReplay(replay.requestHash, context.requestHash, replay.responseBody);
      }
      throw error;
    }
  }
  throw new Error("SUPPORT_ACTION_TRANSACTION_RETRY_EXHAUSTED");
}

export function hashSupportActionRequest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function scopedKey(actor: SessionUser, context: SupportActionMutationContext): string { return `v1:support:${createHash("sha256").update(`${actor.id}:${context.scope}:${context.idempotencyKey}`).digest("hex")}`; }
async function currentCompanyId(client: Pick<Prisma.TransactionClient, "installation">): Promise<string | null> { return (await client.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId ?? null; }
function parseReplay(storedHash: string, requestHash: string, body: Prisma.JsonValue): CreateSupportActionResult { if (storedHash !== requestHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion."); const parsed = replaySchema.safeParse(body); return parsed.success ? { ok: true, status: 200, value: parsed.data } : failure(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es valida."); }
function failure(status: ActionFailure["status"], code: ActionFailure["error"]["code"], message: string): ActionFailure { return { ok: false, status, error: { code, message } }; }
