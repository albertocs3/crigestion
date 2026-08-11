import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { createIncidentReassignedNotification } from "@/modules/platform/application/notifications";

const version = z.number().int().positive();
const reason = z.string().trim().min(3).max(500);
export const supportParticipantChangeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add-collaborator"), expectedVersion: version, userId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("remove-collaborator"), expectedVersion: version, collaboratorId: z.string().uuid(), reason }).strict(),
  z.object({ action: z.literal("reassign"), expectedVersion: version, responsibleUserId: z.string().uuid(), reason }).strict()
]);
export type SupportParticipantChangeCommand = z.infer<typeof supportParticipantChangeSchema>;
export type SupportParticipantContext = RequestContext & { idempotencyKey: string; requestHash: string; scope: string };
type Dto = { incident: { id: string; version: number; responsibleUserId: string }; change: { id: string; type: "COLLABORATOR_ADDED" | "COLLABORATOR_REMOVED" | "RESPONSIBLE_CHANGED"; collaboratorId: string | null; occurredAt: string } };
type Failure = { ok: false; status: 403 | 404 | 409 | 422; error: { code: "SUPPORT_INCIDENT_PARTICIPANT_FORBIDDEN" | "SUPPORT_INCIDENT_NOT_FOUND" | "SUPPORT_INCIDENT_VERSION_CONFLICT" | "SUPPORT_PARTICIPANT_NOT_AVAILABLE" | "SUPPORT_COLLABORATOR_ALREADY_ACTIVE" | "SUPPORT_COLLABORATOR_NOT_ACTIVE" | "SUPPORT_RESPONSIBLE_UNCHANGED" | "SUPPORT_RESPONSIBLE_IS_COLLABORATOR" | "IDEMPOTENCY_KEY_REUSED" | "IDEMPOTENCY_REPLAY_INVALID"; message: string } };
export type SupportParticipantChangeResult = { ok: true; status: 200 | 201; value: Dto } | Failure;
const replaySchema: z.ZodType<Dto> = z.object({ incident: z.object({ id: z.string().uuid(), version, responsibleUserId: z.string().uuid() }).strict(), change: z.object({ id: z.string().uuid(), type: z.enum(["COLLABORATOR_ADDED", "COLLABORATOR_REMOVED", "RESPONSIBLE_CHANGED"]), collaboratorId: z.string().uuid().nullable(), occurredAt: z.string().datetime() }).strict() }).strict();
type Locked = { id: string; companyId: string; number: string; status: "NEW" | "IN_PROGRESS" | "PENDING_CUSTOMER" | "PENDING_THIRD_PARTY" | "RESOLVED" | "CLOSED"; version: number; responsibleUserId: string };

export async function changeSupportParticipants(incidentId: string, command: SupportParticipantChangeCommand, actor: SessionUser, context: SupportParticipantContext): Promise<SupportParticipantChangeResult> {
  if (!actor.permissions.includes("Support.View") || !actor.permissions.includes("Support.ManageParticipants")) return fail(403, "SUPPORT_INCIDENT_PARTICIPANT_FORBIDDEN", "No tienes permiso para gestionar participantes.");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const key = scopedKey(actor, context); const replay = await tx.idempotencyRecord.findUnique({ where: { key } }); if (replay) return parseReplay(replay.requestHash, context.requestHash, replay.responseBody);
        const companyId = (await tx.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId; if (!companyId) return fail(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
        const incident = (await tx.$queryRaw<Locked[]>(Prisma.sql`SELECT "id", "companyId", "number", "status", "version", "responsibleUserId" FROM "support_incidents" WHERE "id" = ${incidentId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`))[0];
        if (!incident) return fail(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
        if (actor.id !== incident.responsibleUserId && actor.role.code !== "Administrador") { await tx.auditEvent.create({ data: { eventType: "SUPPORT_INCIDENT_PARTICIPANT_CHANGE_DENIED", actorType: "USER", payload: { actorUserId: actor.id, companyId, incidentId, reason: "NOT_RESPONSIBLE", ...(context.correlationId ? { correlationId: context.correlationId } : {}) } } }); return fail(403, "SUPPORT_INCIDENT_PARTICIPANT_FORBIDDEN", "Solo el responsable o un administrador puede gestionar participantes."); }
        if (incident.version !== command.expectedVersion) return fail(409, "SUPPORT_INCIDENT_VERSION_CONFLICT", "La incidencia ha cambiado. Recarga antes de continuar.");
        const now = new Date(); const resultingVersion = incident.version + 1; let collaboratorId: string | null = null; let type: Dto["change"]["type"]; let nextResponsible = incident.responsibleUserId;
        if (command.action === "add-collaborator") {
          if (command.userId === incident.responsibleUserId) return fail(422, "SUPPORT_RESPONSIBLE_IS_COLLABORATOR", "El responsable ya participa en la incidencia.");
          const user = await eligibleUser(tx, command.userId); if (!user) return fail(422, "SUPPORT_PARTICIPANT_NOT_AVAILABLE", "El usuario no está disponible para colaborar.");
          if (await tx.supportIncidentCollaborator.findFirst({ where: { incidentId, companyId, userId: command.userId, removedAt: null }, select: { id: true } })) return fail(409, "SUPPORT_COLLABORATOR_ALREADY_ACTIVE", "El usuario ya es colaborador activo.");
          const collaborator = await tx.supportIncidentCollaborator.create({ data: { companyId, incidentId, userId: command.userId, addedByUserId: actor.id, addedVersion: resultingVersion, addedAt: now }, select: { id: true } }); collaboratorId = collaborator.id; type = "COLLABORATOR_ADDED";
        } else if (command.action === "remove-collaborator") {
          const collaborator = await tx.supportIncidentCollaborator.findFirst({ where: { id: command.collaboratorId, incidentId, companyId, removedAt: null }, select: { id: true } }); if (!collaborator) return fail(409, "SUPPORT_COLLABORATOR_NOT_ACTIVE", "El colaborador ya no está activo.");
          await tx.supportIncidentCollaborator.update({ where: { id: collaborator.id }, data: { removedAt: now, removedByUserId: actor.id, removedVersion: resultingVersion } }); collaboratorId = collaborator.id; type = "COLLABORATOR_REMOVED";
        } else {
          if (command.responsibleUserId === incident.responsibleUserId) return fail(409, "SUPPORT_RESPONSIBLE_UNCHANGED", "El usuario ya es responsable.");
          const user = await eligibleUser(tx, command.responsibleUserId); if (!user) return fail(422, "SUPPORT_PARTICIPANT_NOT_AVAILABLE", "El nuevo responsable no está disponible.");
          if (await tx.supportIncidentCollaborator.findFirst({ where: { incidentId, companyId, userId: command.responsibleUserId, removedAt: null }, select: { id: true } })) return fail(409, "SUPPORT_RESPONSIBLE_IS_COLLABORATOR", "Retira primero al usuario como colaborador antes de reasignarle la incidencia.");
          nextResponsible = command.responsibleUserId; type = "RESPONSIBLE_CHANGED";
        }
        const change = await tx.supportIncidentParticipantChange.create({ data: { companyId, incidentId, actorUserId: actor.id, changeType: type, collaboratorId, fromResponsibleId: command.action === "reassign" ? incident.responsibleUserId : null, toResponsibleId: command.action === "reassign" ? command.responsibleUserId : null, reason: command.action === "add-collaborator" ? null : command.reason, resultingVersion, occurredAt: now }, select: { id: true, occurredAt: true } });
        await tx.supportIncident.update({ where: { id: incident.id }, data: { responsibleUserId: nextResponsible, version: resultingVersion } });
        const event = await tx.supportIncidentEvent.create({ data: { companyId, incidentId, actorUserId: actor.id, participantChangeId: change.id, eventType: type, fromStatus: incident.status, toStatus: incident.status, resultingVersion }, select: { id: true } });
        if (type === "RESPONSIBLE_CHANGED") await createIncidentReassignedNotification(tx, { companyId, incidentId, sourceEventId: event.id, incidentNumber: incident.number, responsibleUserId: nextResponsible, correlationId: context.correlationId });
        const value: Dto = { incident: { id: incident.id, version: resultingVersion, responsibleUserId: nextResponsible }, change: { id: change.id, type, collaboratorId, occurredAt: change.occurredAt.toISOString() } };
        await tx.auditEvent.create({ data: { eventType: `SUPPORT_INCIDENT_${type}`, actorType: "USER", payload: { actorUserId: actor.id, companyId, incidentId, incidentNumber: incident.number, collaboratorId, previousResponsibleUserId: command.action === "reassign" ? incident.responsibleUserId : null, responsibleUserId: nextResponsible, previousVersion: incident.version, version: resultingVersion, hasReason: command.action !== "add-collaborator", ...(context.correlationId ? { correlationId: context.correlationId } : {}) } } });
        await tx.idempotencyRecord.create({ data: { key, requestHash: context.requestHash, responseStatus: 201, responseBody: value as unknown as Prisma.InputJsonValue } }); return { ok: true, status: 201, value };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && attempt < 2) continue;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { const replay = await prisma.idempotencyRecord.findUnique({ where: { key: scopedKey(actor, context) } }); if (replay) return parseReplay(replay.requestHash, context.requestHash, replay.responseBody); }
      throw error;
    }
  }
  throw new Error("SUPPORT_PARTICIPANT_CHANGE_RETRY_EXHAUSTED");
}

export function hashSupportParticipantRequest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
async function eligibleUser(tx: Prisma.TransactionClient, userId: string) { return tx.user.findFirst({ where: { id: userId, status: "ACTIVE", AND: [{ role: { permissions: { some: { permission: { code: "Support.View" } } } } }, { role: { permissions: { some: { permission: { code: "Support.AddActions" } } } } }] }, select: { id: true } }); }
function scopedKey(actor: SessionUser, context: SupportParticipantContext) { return `v1:support:${createHash("sha256").update(`${actor.id}:${context.scope}:${context.idempotencyKey}`).digest("hex")}`; }
function parseReplay(stored: string, request: string, body: Prisma.JsonValue): SupportParticipantChangeResult { if (stored !== request) return fail(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se usó con otra petición."); const parsed = replaySchema.safeParse(body); return parsed.success ? { ok: true, status: 200, value: parsed.data } : fail(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es válida."); }
function fail(status: Failure["status"], code: Failure["error"]["code"], message: string): Failure { return { ok: false, status, error: { code, message } }; }
