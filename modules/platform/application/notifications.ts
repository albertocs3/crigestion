import "server-only";

import { createHash } from "node:crypto";
import { NotificationSeverity, NotificationStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";

const pageSizeSchema = z.coerce.number().int().min(1).max(100).default(25);
export const notificationListSchema = z.object({
  state: z.enum(["ALL", "UNREAD", "READ", "ARCHIVED"]).default("UNREAD"),
  limit: pageSizeSchema,
  cursor: z.string().trim().min(1).max(500).optional()
}).strict();

export const notificationStateSchema = z.object({
  state: z.enum(["READ", "UNREAD", "ARCHIVED"]),
  expectedVersion: z.number().int().positive()
}).strict();

export const notificationParamsSchema = z.object({ notificationId: z.string().uuid() }).strict();

export type NotificationListQuery = z.infer<typeof notificationListSchema>;
export type NotificationStateCommand = z.infer<typeof notificationStateSchema>;
export type NotificationDto = {
  id: string;
  kind: string;
  severity: "INFO" | "URGENT" | "CRITICAL";
  messageCode: string;
  status: "UNREAD" | "READ" | "ARCHIVED";
  incident: { id: string; number: string; href: string };
  createdAt: string;
  readAt: string | null;
  archivedAt: string | null;
  version: number;
};

type Cursor = { version: 1; state: NotificationListQuery["state"]; createdAt: string; id: string };
type StateResult =
  | { ok: true; status: 200; value: NotificationDto }
  | { ok: false; status: 404 | 409 | 429; error: { code: "NOTIFICATION_NOT_FOUND" | "NOTIFICATION_VERSION_CONFLICT" | "NOTIFICATION_STATE_INVALID" | "NOTIFICATION_STATE_RATE_LIMITED" | "IDEMPOTENCY_KEY_REUSED" | "IDEMPOTENCY_REPLAY_INVALID"; message: string; retryAfterSeconds?: number } };

const notificationSelect = {
  id: true,
  kind: true,
  severity: true,
  messageCode: true,
  status: true,
  incidentId: true,
  incidentNumber: true,
  createdAt: true,
  readAt: true,
  archivedAt: true,
  version: true
} satisfies Prisma.NotificationSelect;

const replaySchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  severity: z.enum(["INFO", "URGENT", "CRITICAL"]),
  messageCode: z.string(),
  status: z.enum(["UNREAD", "READ", "ARCHIVED"]),
  incident: z.object({ id: z.string().uuid(), number: z.string(), href: z.string() }).strict(),
  createdAt: z.string().datetime(),
  readAt: z.string().datetime().nullable(),
  archivedAt: z.string().datetime().nullable(),
  version: z.number().int().positive()
}).strict();

export async function listNotifications(actor: SessionUser, query: NotificationListQuery) {
  const companyId = await currentCompanyId();
  if (!companyId) return { items: [], nextCursor: null, unreadCount: 0 };
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && (!cursor || cursor.state !== query.state)) return null;
  const where: Prisma.NotificationWhereInput = {
    companyId,
    recipientUserId: actor.id,
    expiresAt: { gt: new Date() },
    ...(query.state === "ALL" ? {} : { status: query.state }),
    ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {})
  };
  const [rows, unreadCount] = await prisma.$transaction([
    prisma.notification.findMany({ where, select: notificationSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: query.limit + 1 }),
    prisma.notification.count({ where: { companyId, recipientUserId: actor.id, status: "UNREAD", expiresAt: { gt: new Date() } } })
  ]);
  const page = rows.slice(0, query.limit);
  return {
    items: page.map(mapNotification),
    nextCursor: rows.length > query.limit && page.at(-1) ? encodeCursor(page.at(-1)!, query.state) : null,
    unreadCount
  };
}

export async function getUnreadNotificationCount(actor: SessionUser): Promise<number> {
  const companyId = await currentCompanyId();
  return companyId ? prisma.notification.count({ where: { companyId, recipientUserId: actor.id, status: "UNREAD", expiresAt: { gt: new Date() } } }) : 0;
}

export async function changeNotificationState(
  notificationId: string,
  command: NotificationStateCommand,
  actor: SessionUser,
  context: RequestContext & { idempotencyKey: string; requestHash: string }
): Promise<StateResult> {
  const key = scopedIdempotencyKey(actor.id, notificationId, context.idempotencyKey);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const replay = await tx.idempotencyRecord.findUnique({ where: { key } });
        if (replay && replay.requestHash === context.requestHash) {
          const validReplay = replaySchema.safeParse(replay.responseBody);
          if (validReplay.success) return { ok: true, status: 200, value: validReplay.data };
        }
        const companyId = (await tx.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId;
        if (!companyId) return stateFail(404, "NOTIFICATION_NOT_FOUND", "La notificación no existe.");
        const rateLimit = await consumeStateRateLimit(tx, actor.id);
        if (rateLimit.limited) {
          if (rateLimit.firstLimitedRequest) await tx.auditEvent.create({ data: { eventType: "NOTIFICATION_STATE_RATE_LIMITED", actorType: "USER", payload: { actorUserId: actor.id, companyId, retryAfterSeconds: rateLimit.retryAfterSeconds, ...(context.correlationId ? { correlationId: context.correlationId } : {}) } } });
          return stateFail(429, "NOTIFICATION_STATE_RATE_LIMITED", "Demasiados cambios de notificaciones. Espera antes de reintentar.", rateLimit.retryAfterSeconds);
        }
        if (replay) {
          await auditStateDenied(tx, actor.id, companyId, notificationId, replay.requestHash === context.requestHash ? "IDEMPOTENCY_REPLAY_INVALID" : "IDEMPOTENCY_KEY_REUSED", context.correlationId);
          return parseReplay(replay.requestHash, context.requestHash, replay.responseBody);
        }
        const [locked] = await tx.$queryRaw<Array<{ id: string; status: NotificationStatus; version: number }>>(Prisma.sql`
          SELECT "id", "status", "version" FROM "notifications"
          WHERE "id" = ${notificationId}::uuid AND "companyId" = ${companyId}::uuid
            AND "recipientUserId" = ${actor.id}::uuid AND "expiresAt" > clock_timestamp()
          FOR UPDATE
        `);
        if (!locked) { await auditStateDenied(tx, actor.id, companyId, notificationId, "NOT_FOUND", context.correlationId); return stateFail(404, "NOTIFICATION_NOT_FOUND", "La notificación no existe."); }
        if (locked.version !== command.expectedVersion) { await auditStateDenied(tx, actor.id, companyId, notificationId, "VERSION_CONFLICT", context.correlationId); return stateFail(409, "NOTIFICATION_VERSION_CONFLICT", "La notificación ha cambiado. Recarga antes de continuar."); }
        if (locked.status === "ARCHIVED" || locked.status === command.state) { await auditStateDenied(tx, actor.id, companyId, notificationId, "STATE_INVALID", context.correlationId); return stateFail(409, "NOTIFICATION_STATE_INVALID", "El cambio de estado no es válido."); }
        const now = new Date();
        const nextVersion = locked.version + 1;
        const updated = await tx.notification.update({
          where: { id: locked.id },
          data: {
            status: command.state,
            version: nextVersion,
            readAt: command.state === "READ" ? now : command.state === "UNREAD" ? null : undefined,
            archivedAt: command.state === "ARCHIVED" ? now : null
          },
          select: notificationSelect
        });
        await tx.notificationStateChange.create({ data: { companyId, notificationId, actorUserId: actor.id, fromStatus: locked.status, toStatus: command.state, resultingVersion: nextVersion, occurredAt: now } });
        const value = mapNotification(updated);
        await tx.auditEvent.create({ data: { eventType: "NOTIFICATION_STATE_CHANGED", actorType: "USER", payload: { actorUserId: actor.id, companyId, notificationId, fromStatus: locked.status, toStatus: command.state, version: nextVersion, ...(context.correlationId ? { correlationId: context.correlationId } : {}) } } });
        await tx.idempotencyRecord.create({ data: { key, requestHash: context.requestHash, responseStatus: 200, responseBody: value as unknown as Prisma.InputJsonValue } });
        return { ok: true, status: 200, value };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && attempt < 2) continue;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const replay = await prisma.idempotencyRecord.findUnique({ where: { key } });
        if (replay) return parseReplay(replay.requestHash, context.requestHash, replay.responseBody);
      }
      throw error;
    }
  }
  throw new Error("NOTIFICATION_STATE_RETRY_EXHAUSTED");
}

export async function createIncidentCreatedNotifications(tx: Prisma.TransactionClient, input: { companyId: string; incidentId: string; sourceEventId: string; incidentNumber: string; responsibleUserId: string; priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT"; correlationId?: string }) {
  const recipients = new Map<string, { kind: string; messageCode: string; severity: NotificationSeverity }>();
  recipients.set(input.responsibleUserId, { kind: "SUPPORT_INCIDENT_ASSIGNED", messageCode: "support.incident.assigned", severity: "INFO" });
  if (input.priority === "URGENT") {
    const urgentRecipients = await tx.user.findMany({ where: { status: "ACTIVE", role: { permissions: { some: { permission: { code: "Support.ReceiveUrgentNotifications" } } } } }, select: { id: true } });
    for (const recipient of urgentRecipients) recipients.set(recipient.id, { kind: "SUPPORT_INCIDENT_URGENT", messageCode: "support.incident.urgent", severity: "URGENT" });
  }
  await persistGeneratedNotifications(tx, input, recipients);
}

export async function createIncidentReassignedNotification(tx: Prisma.TransactionClient, input: { companyId: string; incidentId: string; sourceEventId: string; incidentNumber: string; responsibleUserId: string; correlationId?: string }) {
  await persistGeneratedNotifications(tx, input, new Map([[input.responsibleUserId, { kind: "SUPPORT_INCIDENT_REASSIGNED", messageCode: "support.incident.reassigned", severity: NotificationSeverity.INFO }]]));
}

export async function createIncidentCollaboratorAddedNotification(tx: Prisma.TransactionClient, input: { companyId: string; incidentId: string; sourceEventId: string; incidentNumber: string; collaboratorUserId: string; correlationId?: string }) {
  await persistGeneratedNotifications(tx, input, new Map([[input.collaboratorUserId, { kind: "SUPPORT_INCIDENT_COLLABORATOR_ADDED", messageCode: "support.incident.collaborator-added", severity: NotificationSeverity.INFO }]]));
}

export async function createIncidentCollaboratorActionNotification(tx: Prisma.TransactionClient, input: { companyId: string; incidentId: string; sourceEventId: string; incidentNumber: string; responsibleUserId: string; correlationId?: string }) {
  await persistGeneratedNotifications(tx, input, new Map([[input.responsibleUserId, { kind: "SUPPORT_INCIDENT_COLLABORATOR_ACTION", messageCode: "support.incident.collaborator-action", severity: NotificationSeverity.INFO }]]));
}

export async function createIncidentReopenedNotification(tx: Prisma.TransactionClient, input: { companyId: string; incidentId: string; sourceEventId: string; incidentNumber: string; responsibleUserId: string; correlationId?: string }) {
  await persistGeneratedNotifications(tx, input, new Map([[input.responsibleUserId, { kind: "SUPPORT_INCIDENT_REOPENED", messageCode: "support.incident.reopened", severity: NotificationSeverity.INFO }]]));
}

async function persistGeneratedNotifications(tx: Prisma.TransactionClient, input: { companyId: string; incidentId: string; sourceEventId: string; incidentNumber: string; correlationId?: string }, recipients: Map<string, { kind: string; messageCode: string; severity: NotificationSeverity }>) {
  const expiresAt = new Date(); expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 1);
  const inserted = recipients.size > 0 ? await tx.notification.createMany({ data: [...recipients].map(([recipientUserId, value]) => ({ companyId: input.companyId, recipientUserId, incidentId: input.incidentId, sourceIncidentEventId: input.sourceEventId, incidentNumber: input.incidentNumber, expiresAt, ...value })), skipDuplicates: true }) : { count: 0 };
  await tx.auditEvent.create({ data: { eventType: "SUPPORT_NOTIFICATIONS_CREATED", actorType: "SYSTEM", payload: { companyId: input.companyId, incidentId: input.incidentId, sourceEventId: input.sourceEventId, recipientCount: inserted.count, ...(input.correlationId ? { correlationId: input.correlationId } : {}) } } });
}

export function hashNotificationStateRequest(notificationId: string, command: NotificationStateCommand) {
  return createHash("sha256").update(JSON.stringify({ notificationId, ...command })).digest("hex");
}

function mapNotification(row: { id: string; kind: string; severity: NotificationSeverity; messageCode: string; status: NotificationStatus; incidentId: string; incidentNumber: string; createdAt: Date; readAt: Date | null; archivedAt: Date | null; version: number }): NotificationDto {
  return { id: row.id, kind: row.kind, severity: row.severity, messageCode: row.messageCode, status: row.status, incident: { id: row.incidentId, number: row.incidentNumber, href: `/app/support/incidents/${row.incidentId}` }, createdAt: row.createdAt.toISOString(), readAt: row.readAt?.toISOString() ?? null, archivedAt: row.archivedAt?.toISOString() ?? null, version: row.version };
}
function encodeCursor(row: { createdAt: Date; id: string }, state: NotificationListQuery["state"]) { return Buffer.from(JSON.stringify({ version: 1, state, createdAt: row.createdAt.toISOString(), id: row.id }), "utf8").toString("base64url"); }
function decodeCursor(value: string): { state: NotificationListQuery["state"]; createdAt: Date; id: string } | null { try { const parsed = z.object({ version: z.literal(1), state: z.enum(["ALL", "UNREAD", "READ", "ARCHIVED"]), createdAt: z.string().datetime(), id: z.string().uuid() }).strict().parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor); return { state: parsed.state, createdAt: new Date(parsed.createdAt), id: parsed.id }; } catch { return null; } }
async function currentCompanyId() { return (await prisma.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId ?? null; }
function scopedIdempotencyKey(actorId: string, notificationId: string, clientKey: string) { return `v1:notif:${createHash("sha256").update(`${actorId}:${notificationId}:${clientKey}`).digest("hex")}`; }
function parseReplay(storedHash: string, requestHash: string, body: Prisma.JsonValue): StateResult { if (storedHash !== requestHash) return stateFail(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se usó con otra petición."); const parsed = replaySchema.safeParse(body); return parsed.success ? { ok: true, status: 200, value: parsed.data } : stateFail(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es válida."); }
function stateFail(status: 404 | 409 | 429, code: Extract<StateResult, { ok: false }>["error"]["code"], message: string, retryAfterSeconds?: number): StateResult { return { ok: false, status, error: { code, message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) } }; }

async function consumeStateRateLimit(tx: Prisma.TransactionClient, actorId: string): Promise<{ limited: false } | { limited: true; firstLimitedRequest: boolean; retryAfterSeconds: number }> {
  const now = new Date(); const windowMs = 15 * 60 * 1000; const windowStart = new Date(now.getTime() - windowMs);
  const [bucket] = await tx.$queryRaw<Array<{ count: number; windowStart: Date }>>(Prisma.sql`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), ${`notification-state:${actorId}`}, ${now}, 1, ${now}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN 1 ELSE "rate_limit_buckets"."count" + 1 END,
      "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN ${now} ELSE "rate_limit_buckets"."windowStart" END,
      "updatedAt" = ${now}
    RETURNING "count", "windowStart"
  `);
  if (!bucket || bucket.count <= 120) return { limited: false };
  return { limited: true, firstLimitedRequest: bucket.count === 121, retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStart.getTime() + windowMs - now.getTime()) / 1000)) };
}

async function auditStateDenied(tx: Prisma.TransactionClient, actorUserId: string, companyId: string, notificationId: string, reason: string, correlationId?: string) {
  await tx.auditEvent.create({ data: { eventType: "NOTIFICATION_STATE_DENIED", actorType: "USER", payload: { actorUserId, companyId, notificationFingerprint: createHash("sha256").update(notificationId).digest("hex"), reason, ...(correlationId ? { correlationId } : {}) } } });
}
