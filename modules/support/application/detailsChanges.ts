import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";

const versionSchema = z.number().int().positive();
const changedFieldSchema = z.enum(["title", "description", "categoryId", "storeId"]);

export const supportIncidentDetailsChangeSchema = z.object({
  expectedVersion: versionSchema,
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(3).max(4000),
  categoryId: z.string().uuid(),
  storeId: z.string().uuid().nullable(),
  reason: z.string().trim().min(3).max(500),
}).strict();

export type SupportIncidentDetailsChangeCommand = z.infer<typeof supportIncidentDetailsChangeSchema>;
export type SupportIncidentDetailsChangeContext = RequestContext & { idempotencyKey: string; requestHash: string; scope: string };
export type SupportIncidentDetailsChangeDto = {
  incident: { id: string; title: string; description: string; categoryId: string; storeId: string | null; version: number };
  change: { id: string; resultingVersion: number; changedFields: Array<z.infer<typeof changedFieldSchema>>; changedAt: string };
};

type ErrorCode =
  | "SUPPORT_INCIDENT_DETAILS_FORBIDDEN"
  | "SUPPORT_INCIDENT_NOT_FOUND"
  | "SUPPORT_INCIDENT_VERSION_CONFLICT"
  | "SUPPORT_INCIDENT_MERGED_READ_ONLY"
  | "SUPPORT_INCIDENT_DETAILS_UNCHANGED"
  | "SUPPORT_CATEGORY_NOT_AVAILABLE"
  | "SUPPORT_STORE_NOT_FOUND"
  | "SUPPORT_INCIDENT_DETAILS_RATE_LIMITED"
  | "SUPPORT_INCIDENT_DETAILS_BUSY"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_REPLAY_INVALID";
type Failure = { ok: false; status: 403 | 404 | 409 | 422 | 429 | 503; error: { code: ErrorCode; message: string; retryAfterSeconds?: number } };
export type SupportIncidentDetailsChangeResult = { ok: true; status: 200 | 201; value: SupportIncidentDetailsChangeDto } | Failure;

const replaySchema: z.ZodType<SupportIncidentDetailsChangeDto> = z.object({
  incident: z.object({ id: z.string().uuid(), title: z.string(), description: z.string(), categoryId: z.string().uuid(), storeId: z.string().uuid().nullable(), version: versionSchema }).strict(),
  change: z.object({ id: z.string().uuid(), resultingVersion: versionSchema, changedFields: z.array(changedFieldSchema).min(1), changedAt: z.string().datetime() }).strict(),
}).strict();

type LockedIncident = {
  id: string;
  companyId: string;
  number: string;
  customerId: string;
  storeId: string | null;
  categoryId: string;
  categoryName: string;
  responsibleUserId: string;
  mergedIntoIncidentId: string | null;
  title: string;
  description: string;
  status: "NEW" | "IN_PROGRESS" | "PENDING_CUSTOMER" | "PENDING_THIRD_PARTY" | "RESOLVED" | "CLOSED";
  version: number;
  storeCode: string | null;
  storeName: string | null;
};

export async function changeSupportIncidentDetails(
  incidentId: string,
  command: SupportIncidentDetailsChangeCommand,
  actor: SessionUser,
  context: SupportIncidentDetailsChangeContext,
): Promise<SupportIncidentDetailsChangeResult> {
  if (!actor.permissions.includes("Support.View") || !actor.permissions.includes("Support.ManageAssigned")) {
    return fail(403, "SUPPORT_INCIDENT_DETAILS_FORBIDDEN", "No tienes permiso para modificar la incidencia.");
  }
  const key = scopedKey(actor, context);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const stored = await tx.idempotencyRecord.findUnique({ where: { key } });
        const companyId = (await tx.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId;
        if (!companyId) return fail(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
        const incident = (await tx.$queryRaw<LockedIncident[]>(Prisma.sql`
          SELECT incident."id", incident."companyId", incident."number", incident."customerId", incident."storeId", incident."categoryId", incident."responsibleUserId", incident."mergedIntoIncidentId", incident."title", incident."description", incident."status", incident."version",
            category."name" AS "categoryName", store."code" AS "storeCode", store."name" AS "storeName"
          FROM "support_incidents" incident
          JOIN "support_incident_categories" category ON category."id" = incident."categoryId" AND category."companyId" = incident."companyId"
          LEFT JOIN "customer_stores" store ON store."id" = incident."storeId" AND store."customerId" = incident."customerId"
          WHERE incident."id" = ${incidentId}::uuid AND incident."companyId" = ${companyId}::uuid
          FOR UPDATE OF incident
        `))[0];
        if (!incident) {
          await auditDenied(tx, actor.id, companyId, incidentId, "NOT_FOUND", context.correlationId);
          return fail(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
        }
        if (actor.id !== incident.responsibleUserId && actor.role.code !== "Administrador") {
          await auditDenied(tx, actor.id, companyId, incidentId, "NOT_RESPONSIBLE", context.correlationId);
          return fail(403, "SUPPORT_INCIDENT_DETAILS_FORBIDDEN", "Solo el responsable o un administrador puede modificar la incidencia.");
        }
        if (stored) {
          const replay = parseReplay(stored.requestHash, context.requestHash, stored.responseBody);
          if (replay.ok) return replay;
          const replayRate = await consumeRateLimit(tx, companyId, actor.id);
          if (replayRate.limited) {
            if (replayRate.firstLimitedRequest) await auditDenied(tx, actor.id, companyId, incidentId, "RATE_LIMITED", context.correlationId);
            return fail(429, "SUPPORT_INCIDENT_DETAILS_RATE_LIMITED", "Se han realizado demasiados intentos. Inténtalo más tarde.", replayRate.retryAfterSeconds);
          }
          await auditDenied(tx, actor.id, companyId, incidentId, replay.error.code, context.correlationId);
          return replay;
        }
        const rate = await consumeRateLimit(tx, companyId, actor.id);
        if (rate.limited) {
          if (rate.firstLimitedRequest) await auditDenied(tx, actor.id, companyId, incidentId, "RATE_LIMITED", context.correlationId);
          return fail(429, "SUPPORT_INCIDENT_DETAILS_RATE_LIMITED", "Se han realizado demasiados intentos. Inténtalo más tarde.", rate.retryAfterSeconds);
        }
        if (incident.mergedIntoIncidentId) {
          await auditDenied(tx, actor.id, companyId, incidentId, "MERGED_READ_ONLY", context.correlationId);
          return fail(409, "SUPPORT_INCIDENT_MERGED_READ_ONLY", "Una incidencia fusionada es de solo lectura.");
        }
        if (incident.version !== command.expectedVersion) {
          await auditDenied(tx, actor.id, companyId, incidentId, "VERSION_CONFLICT", context.correlationId);
          return fail(409, "SUPPORT_INCIDENT_VERSION_CONFLICT", "La incidencia ha cambiado. Recarga antes de continuar.");
        }

        const changedFields = changedFieldsFor(incident, command);
        if (changedFields.length === 0) {
          await auditDenied(tx, actor.id, companyId, incidentId, "UNCHANGED", context.correlationId);
          return fail(409, "SUPPORT_INCIDENT_DETAILS_UNCHANGED", "No se ha indicado ningún cambio.");
        }
        let correctedCategoryName = incident.categoryName;
        if (command.categoryId !== incident.categoryId) {
          const category = await tx.supportIncidentCategory.findFirst({ where: { id: command.categoryId, companyId, isActive: true }, select: { name: true } });
          if (!category) {
            await auditDenied(tx, actor.id, companyId, incidentId, "CATEGORY_NOT_AVAILABLE", context.correlationId);
            return fail(422, "SUPPORT_CATEGORY_NOT_AVAILABLE", "La categoría no está disponible.");
          }
          correctedCategoryName = category.name;
        }
        let correctedStoreCode = incident.storeCode;
        let correctedStoreName = incident.storeName;
        if (command.storeId !== incident.storeId && command.storeId) {
          const store = await tx.customerStore.findFirst({ where: { id: command.storeId, customerId: incident.customerId, status: "ACTIVE" }, select: { code: true, name: true } });
          if (!store) {
            await auditDenied(tx, actor.id, companyId, incidentId, "STORE_NOT_AVAILABLE", context.correlationId);
            return fail(422, "SUPPORT_STORE_NOT_FOUND", "La tienda no está disponible para este cliente.");
          }
          correctedStoreCode = store.code;
          correctedStoreName = store.name;
        } else if (!command.storeId) {
          correctedStoreCode = null;
          correctedStoreName = null;
        }

        const now = new Date();
        const resultingVersion = incident.version + 1;
        const change = await tx.supportIncidentDetailsChange.create({
          data: {
            companyId,
            incidentId,
            actorUserId: actor.id,
            customerId: incident.customerId,
            previousStoreId: incident.storeId,
            correctedStoreId: command.storeId,
            previousCategoryId: incident.categoryId,
            correctedCategoryId: command.categoryId,
            previousCategoryName: incident.categoryName,
            correctedCategoryName,
            previousStoreCode: incident.storeCode,
            previousStoreName: incident.storeName,
            correctedStoreCode,
            correctedStoreName,
            previousTitle: incident.title,
            correctedTitle: command.title,
            previousDescription: incident.description,
            correctedDescription: command.description,
            reason: command.reason,
            resultingVersion,
            changedAt: now,
          },
          select: { id: true, changedAt: true },
        });
        await tx.supportIncident.update({
          where: { id: incident.id },
          data: { storeId: command.storeId, categoryId: command.categoryId, title: command.title, description: command.description, version: resultingVersion },
        });
        await tx.supportIncidentEvent.create({
          data: {
            companyId,
            incidentId,
            actorUserId: actor.id,
            responsibleUserIdAtEvent: incident.responsibleUserId,
            detailsChangeId: change.id,
            eventType: "DETAILS_CHANGED",
            fromStatus: incident.status,
            toStatus: incident.status,
            resultingVersion,
            createdAt: now,
          },
        });
        const value: SupportIncidentDetailsChangeDto = {
          incident: { id: incident.id, title: command.title, description: command.description, categoryId: command.categoryId, storeId: command.storeId, version: resultingVersion },
          change: { id: change.id, resultingVersion, changedFields, changedAt: change.changedAt.toISOString() },
        };
        await tx.auditEvent.create({
          data: {
            eventType: "SUPPORT_INCIDENT_DETAILS_CHANGED",
            actorType: "USER",
            payload: {
              actorUserId: actor.id,
              companyId,
              incidentId,
              incidentNumber: incident.number,
              previousVersion: incident.version,
              version: resultingVersion,
              changedFields,
              previousCategoryId: incident.categoryId,
              categoryId: command.categoryId,
              previousStoreId: incident.storeId,
              storeId: command.storeId,
              titleChanged: changedFields.includes("title"),
              descriptionChanged: changedFields.includes("description"),
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
        return fail(503, "SUPPORT_INCIDENT_DETAILS_BUSY", "No se pudo completar el cambio por concurrencia. Inténtalo de nuevo.", 3);
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const replay = await prisma.idempotencyRecord.findUnique({ where: { key } });
        if (replay) return parseReplay(replay.requestHash, context.requestHash, replay.responseBody);
      }
      throw error;
    }
  }
  return fail(503, "SUPPORT_INCIDENT_DETAILS_BUSY", "No se pudo completar el cambio por concurrencia. Inténtalo de nuevo.", 3);
}

function isSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001"));
}

export function hashSupportIncidentDetailsChangeRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function changedFieldsFor(incident: LockedIncident, command: SupportIncidentDetailsChangeCommand): SupportIncidentDetailsChangeDto["change"]["changedFields"] {
  const fields: SupportIncidentDetailsChangeDto["change"]["changedFields"] = [];
  if (incident.title !== command.title) fields.push("title");
  if (incident.description !== command.description) fields.push("description");
  if (incident.categoryId !== command.categoryId) fields.push("categoryId");
  if (incident.storeId !== command.storeId) fields.push("storeId");
  return fields;
}

function scopedKey(actor: SessionUser, context: SupportIncidentDetailsChangeContext): string {
  return `v1:support:${createHash("sha256").update(`${actor.id}:${context.scope}:${context.idempotencyKey}`).digest("hex")}`;
}

function parseReplay(storedHash: string, requestHash: string, body: Prisma.JsonValue): SupportIncidentDetailsChangeResult {
  if (storedHash !== requestHash) return fail(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se usó con otra petición.");
  const parsed = replaySchema.safeParse(body);
  return parsed.success ? { ok: true, status: 200, value: parsed.data } : fail(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es válida.");
}

function fail(status: Failure["status"], code: ErrorCode, message: string, retryAfterSeconds?: number): Failure {
  return { ok: false, status, error: { code, message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) } };
}

async function auditDenied(tx: Prisma.TransactionClient, actorUserId: string, companyId: string, incidentId: string, reason: string, correlationId?: string): Promise<void> {
  await tx.auditEvent.create({ data: { eventType: "SUPPORT_INCIDENT_DETAILS_CHANGE_DENIED", actorType: "USER", payload: { actorUserId, companyId, incidentFingerprint: createHash("sha256").update(incidentId).digest("hex"), reason, ...(correlationId ? { correlationId } : {}) } } });
}

async function consumeRateLimit(tx: Prisma.TransactionClient, companyId: string, actorId: string): Promise<{ limited: false } | { limited: true; firstLimitedRequest: boolean; retryAfterSeconds: number }> {
  const now = new Date();
  const windowMs = 15 * 60 * 1000;
  const resetBefore = new Date(now.getTime() - windowMs);
  const [bucket] = await tx.$queryRaw<Array<{ count: number; windowStart: Date }>>(Prisma.sql`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), ${`support-details:${companyId}:${actorId}`}, ${now}, 1, ${now}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${resetBefore} THEN 1 ELSE "rate_limit_buckets"."count" + 1 END,
      "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${resetBefore} THEN ${now} ELSE "rate_limit_buckets"."windowStart" END,
      "updatedAt" = ${now}
    RETURNING "count", "windowStart"
  `);
  if (!bucket || bucket.count <= 20) return { limited: false };
  return { limited: true, firstLimitedRequest: bucket.count === 21, retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStart.getTime() + windowMs - now.getTime()) / 1000)) };
}
