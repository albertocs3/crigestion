import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { createIncidentReopenedNotification } from "@/modules/platform/application/notifications";

const statusSchema = z.enum(["NEW", "IN_PROGRESS", "PENDING_CUSTOMER", "PENDING_THIRD_PARTY", "RESOLVED", "CLOSED"]);
const closeReasonSchema = z.enum(["DUPLICATE", "NOT_APPLICABLE", "CUSTOMER_WITHDRAWS", "UNREACHABLE", "RESOLVED_EXTERNALLY", "OTHER"]);
const versionSchema = z.number().int().positive();
const reasonSchema = z.string().trim().min(3).max(500);

export const supportStatusTransitionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set-pending"), expectedVersion: versionSchema, targetStatus: z.enum(["PENDING_CUSTOMER", "PENDING_THIRD_PARTY"]), reason: reasonSchema }).strict(),
  z.object({ action: z.literal("resume"), expectedVersion: versionSchema, reason: reasonSchema }).strict(),
  z.object({ action: z.literal("resolve"), expectedVersion: versionSchema, solution: z.string().trim().min(3).max(4000) }).strict(),
  z.object({ action: z.literal("close"), expectedVersion: versionSchema, closeReason: closeReasonSchema, detail: z.string().trim().min(3).max(500).optional() }).strict(),
  z.object({ action: z.literal("reopen"), expectedVersion: versionSchema, reason: reasonSchema }).strict()
]).superRefine((value, ctx) => {
  if (value.action === "close" && value.closeReason === "OTHER" && !value.detail) ctx.addIssue({ code: "custom", path: ["detail"], message: "El detalle es obligatorio para Otros." });
  if (value.action === "close" && value.closeReason !== "OTHER" && value.detail) ctx.addIssue({ code: "custom", path: ["detail"], message: "El detalle solo se admite para Otros." });
});

export type SupportStatusTransitionCommand = z.infer<typeof supportStatusTransitionSchema>;
export type SupportStatusTransitionContext = RequestContext & { idempotencyKey: string; requestHash: string; scope: string };
export type SupportStatusTransitionDto = { incident: { id: string; status: z.infer<typeof statusSchema>; version: number }; transition: { id: string; fromStatus: z.infer<typeof statusSchema>; toStatus: z.infer<typeof statusSchema>; occurredAt: string } };
type Failure = { ok: false; status: 403 | 404 | 409; error: { code: "SUPPORT_INCIDENT_TRANSITION_FORBIDDEN" | "SUPPORT_INCIDENT_NOT_FOUND" | "SUPPORT_INCIDENT_VERSION_CONFLICT" | "SUPPORT_INCIDENT_TRANSITION_INVALID" | "IDEMPOTENCY_KEY_REUSED" | "IDEMPOTENCY_REPLAY_INVALID"; message: string } };
export type SupportStatusTransitionResult = { ok: true; status: 200 | 201; value: SupportStatusTransitionDto } | Failure;

const replaySchema: z.ZodType<SupportStatusTransitionDto> = z.object({
  incident: z.object({ id: z.string().uuid(), status: statusSchema, version: versionSchema }).strict(),
  transition: z.object({ id: z.string().uuid(), fromStatus: statusSchema, toStatus: statusSchema, occurredAt: z.string().datetime() }).strict()
}).strict();

type LockedIncident = { id: string; companyId: string; number: string; status: z.infer<typeof statusSchema>; version: number; responsibleUserId: string };

export async function transitionSupportIncident(incidentId: string, command: SupportStatusTransitionCommand, actor: SessionUser, context: SupportStatusTransitionContext): Promise<SupportStatusTransitionResult> {
  const requiredPermission = command.action === "reopen" ? "Support.Reopen" : "Support.ManageAssigned";
  if (!actor.permissions.includes("Support.View") || !actor.permissions.includes(requiredPermission)) return failure(403, "SUPPORT_INCIDENT_TRANSITION_FORBIDDEN", "No tienes permiso para cambiar el estado de la incidencia.");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const key = scopedKey(actor, context);
        const replay = await tx.idempotencyRecord.findUnique({ where: { key } });
        if (replay) return parseReplay(replay.requestHash, context.requestHash, replay.responseBody);
        const companyId = (await tx.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId;
        if (!companyId) return failure(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
        const rows = await tx.$queryRaw<LockedIncident[]>(Prisma.sql`SELECT "id", "companyId", "number", "status", "version", "responsibleUserId" FROM "support_incidents" WHERE "id" = ${incidentId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`);
        const incident = rows[0];
        if (!incident) return failure(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
        if (command.action !== "reopen" && actor.id !== incident.responsibleUserId && actor.role.code !== "Administrador") {
          await tx.auditEvent.create({ data: { eventType: "SUPPORT_INCIDENT_TRANSITION_DENIED", actorType: "USER", payload: { actorUserId: actor.id, companyId, incidentId, reason: "NOT_RESPONSIBLE", ...(context.correlationId ? { correlationId: context.correlationId } : {}) } } });
          return failure(403, "SUPPORT_INCIDENT_TRANSITION_FORBIDDEN", "Solo el responsable o un administrador puede cambiar este estado.");
        }
        if (incident.version !== command.expectedVersion) return failure(409, "SUPPORT_INCIDENT_VERSION_CONFLICT", "La incidencia ha cambiado. Recarga antes de continuar.");
        const target = targetStatus(command);
        if (!isAllowed(incident.status, command.action)) return failure(409, "SUPPORT_INCIDENT_TRANSITION_INVALID", "La transición no es válida desde el estado actual.");
        const now = new Date();
        const resultingVersion = incident.version + 1;
        const transition = await tx.supportIncidentStatusTransition.create({ data: {
          companyId, incidentId, actorUserId: actor.id, fromStatus: incident.status, toStatus: target, resultingVersion,
          reasonText: command.action === "set-pending" || command.action === "resume" || command.action === "reopen" ? command.reason : null,
          solutionText: command.action === "resolve" ? command.solution : null,
          closeReason: command.action === "close" ? command.closeReason : null,
          closeReasonDetail: command.action === "close" ? command.detail ?? null : null,
          occurredAt: now
        }, select: { id: true, occurredAt: true } });
        await tx.supportIncident.update({ where: { id: incident.id }, data: {
          status: target, version: resultingVersion,
          resolvedAt: target === "RESOLVED" ? now : null,
          closedAt: target === "CLOSED" ? now : null,
          solution: command.action === "resolve" ? command.solution : null,
          closeReason: command.action === "close" ? command.closeReason : null,
          closeReasonDetail: command.action === "close" ? command.detail ?? null : null
        } });
        const event = await tx.supportIncidentEvent.create({ data: { companyId, incidentId, actorUserId: actor.id, responsibleUserIdAtEvent: incident.responsibleUserId, transitionId: transition.id, eventType: "STATUS_CHANGED", fromStatus: incident.status, toStatus: target, resultingVersion }, select: { id: true } });
        if (command.action === "reopen") await createIncidentReopenedNotification(tx, { companyId, incidentId, sourceEventId: event.id, incidentNumber: incident.number, responsibleUserId: incident.responsibleUserId, correlationId: context.correlationId });
        const value: SupportStatusTransitionDto = { incident: { id: incident.id, status: target, version: resultingVersion }, transition: { id: transition.id, fromStatus: incident.status, toStatus: target, occurredAt: transition.occurredAt.toISOString() } };
        await tx.auditEvent.create({ data: { eventType: "SUPPORT_INCIDENT_STATUS_CHANGED", actorType: "USER", payload: { actorUserId: actor.id, companyId, incidentId, incidentNumber: incident.number, action: command.action, previousStatus: incident.status, status: target, previousVersion: incident.version, version: resultingVersion, hasReason: "reason" in command, hasSolution: "solution" in command, closeReason: command.action === "close" ? command.closeReason : null, ...(context.correlationId ? { correlationId: context.correlationId } : {}) } } });
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
  throw new Error("SUPPORT_STATUS_TRANSITION_RETRY_EXHAUSTED");
}

export function hashSupportStatusTransitionRequest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function targetStatus(command: SupportStatusTransitionCommand): z.infer<typeof statusSchema> { if (command.action === "set-pending") return command.targetStatus; if (command.action === "resolve") return "RESOLVED"; if (command.action === "close") return "CLOSED"; return "IN_PROGRESS"; }
function isAllowed(status: z.infer<typeof statusSchema>, action: SupportStatusTransitionCommand["action"]) { if (action === "reopen") return status === "RESOLVED" || status === "CLOSED"; if (status === "RESOLVED" || status === "CLOSED") return false; if (action === "resume") return status === "PENDING_CUSTOMER" || status === "PENDING_THIRD_PARTY"; return true; }
function scopedKey(actor: SessionUser, context: SupportStatusTransitionContext) { return `v1:support:${createHash("sha256").update(`${actor.id}:${context.scope}:${context.idempotencyKey}`).digest("hex")}`; }
function parseReplay(storedHash: string, requestHash: string, body: Prisma.JsonValue): SupportStatusTransitionResult { if (storedHash !== requestHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se usó con otra petición."); const parsed = replaySchema.safeParse(body); return parsed.success ? { ok: true, status: 200, value: parsed.data } : failure(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es válida."); }
function failure(status: Failure["status"], code: Failure["error"]["code"], message: string): Failure { return { ok: false, status, error: { code, message } }; }
