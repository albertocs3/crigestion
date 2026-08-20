import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";

const versionSchema = z.number().int().positive();
const confirmation = "CHANGE_INCIDENT_CUSTOMER" as const;

export const supportIncidentCustomerChangeSchema = z.object({
  expectedVersion: versionSchema,
  expectedCustomerId: z.string().uuid(),
  customerId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
  confirmation: z.literal(confirmation),
}).strict();

export type SupportIncidentCustomerChangeCommand = z.infer<typeof supportIncidentCustomerChangeSchema>;
export type SupportIncidentCustomerChangeContext = RequestContext & { idempotencyKey: string; requestHash: string; scope: string };
export type SupportIncidentCustomerChangeDto = {
  incident: { id: string; customerId: string; storeId: null; version: number };
  change: { id: string; resultingVersion: number; changedAt: string };
};

type ErrorCode =
  | "SUPPORT_INCIDENT_CUSTOMER_CHANGE_FORBIDDEN"
  | "SUPPORT_INCIDENT_NOT_FOUND"
  | "SUPPORT_CUSTOMER_NOT_FOUND"
  | "SUPPORT_INCIDENT_VERSION_CONFLICT"
  | "SUPPORT_INCIDENT_CUSTOMER_EXPECTATION_CONFLICT"
  | "SUPPORT_INCIDENT_CUSTOMER_UNCHANGED"
  | "SUPPORT_INCIDENT_CUSTOMER_CHANGE_STORE_ATTACHED"
  | "SUPPORT_INCIDENT_CUSTOMER_CHANGE_MERGED"
  | "SUPPORT_INCIDENT_CUSTOMER_CHANGE_RATE_LIMITED"
  | "SUPPORT_INCIDENT_CUSTOMER_CHANGE_BUSY"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_REPLAY_INVALID";
type Failure = { ok: false; status: 403 | 404 | 409 | 429 | 503; error: { code: ErrorCode; message: string; retryAfterSeconds?: number } };
export type SupportIncidentCustomerChangeResult = { ok: true; status: 200 | 201; value: SupportIncidentCustomerChangeDto } | Failure;

const replaySchema: z.ZodType<SupportIncidentCustomerChangeDto> = z.object({
  incident: z.object({ id: z.string().uuid(), customerId: z.string().uuid(), storeId: z.null(), version: versionSchema }).strict(),
  change: z.object({ id: z.string().uuid(), resultingVersion: versionSchema, changedAt: z.string().datetime() }).strict(),
}).strict();

type LockedIncident = {
  id: string;
  companyId: string;
  number: string;
  customerId: string;
  storeId: string | null;
  responsibleUserId: string;
  mergedIntoIncidentId: string | null;
  hasMergedDuplicates: boolean;
  status: "NEW" | "IN_PROGRESS" | "PENDING_CUSTOMER" | "PENDING_THIRD_PARTY" | "RESOLVED" | "CLOSED";
  version: number;
};

type CustomerSnapshot = { id: string; code: string; legalName: string; status: "ACTIVE" | "INACTIVE" };

export async function listSupportIncidentCustomerChangeReferences(actor: SessionUser, preferredCustomerId?: string, query?: string): Promise<CustomerSnapshot[]> {
  if (!canChangeCustomer(actor)) return [];
  const search = query?.trim().slice(0, 120) ?? "";
  const [listed, preferred] = await Promise.all([
    prisma.customer.findMany({
      where: search ? { OR: [{ code: { contains: search, mode: "insensitive" } }, { legalName: { contains: search, mode: "insensitive" } }] } : undefined,
      orderBy: [{ legalName: "asc" }, { id: "asc" }],
      take: 100,
      select: { id: true, code: true, legalName: true, status: true },
    }),
    preferredCustomerId ? prisma.customer.findUnique({ where: { id: preferredCustomerId }, select: { id: true, code: true, legalName: true, status: true } }) : Promise.resolve(null),
  ]);
  return preferred && !listed.some((customer) => customer.id === preferred.id)
    ? [...listed, preferred].sort((left, right) => left.legalName.localeCompare(right.legalName, "es") || left.id.localeCompare(right.id))
    : listed;
}

export async function changeSupportIncidentCustomer(
  incidentId: string,
  command: SupportIncidentCustomerChangeCommand,
  actor: SessionUser,
  context: SupportIncidentCustomerChangeContext,
): Promise<SupportIncidentCustomerChangeResult> {
  if (!canChangeCustomer(actor)) return denyUnauthorizedCustomerChange(incidentId, actor, context.correlationId);
  const key = scopedKey(actor, context);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const companyId = (await tx.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId;
        if (!companyId) return fail(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
        const stored = await tx.idempotencyRecord.findUnique({ where: { key } });
        if (stored) {
          const exists = await tx.supportIncident.findFirst({ where: { id: incidentId, companyId }, select: { id: true } });
          if (!exists) {
            await auditDenied(tx, actor.id, companyId, incidentId, "NOT_FOUND", context.correlationId);
            return fail(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
          }
          const replay = parseReplay(stored.requestHash, context.requestHash, stored.responseBody);
          if (replay.ok) return replay;
          const rate = await consumeRateLimit(tx, companyId, actor.id);
          if (rate.limited) {
            if (rate.firstLimitedRequest) await auditDenied(tx, actor.id, companyId, incidentId, "RATE_LIMITED", context.correlationId);
            return fail(429, "SUPPORT_INCIDENT_CUSTOMER_CHANGE_RATE_LIMITED", "Se han realizado demasiados intentos.", rate.retryAfterSeconds);
          }
          await auditDenied(tx, actor.id, companyId, incidentId, replay.error.code, context.correlationId);
          return replay;
        }
        const rate = await consumeRateLimit(tx, companyId, actor.id);
        if (rate.limited) {
          if (rate.firstLimitedRequest) await auditDenied(tx, actor.id, companyId, incidentId, "RATE_LIMITED", context.correlationId);
          return fail(429, "SUPPORT_INCIDENT_CUSTOMER_CHANGE_RATE_LIMITED", "Se han realizado demasiados intentos.", rate.retryAfterSeconds);
        }

        const incident = (await tx.$queryRaw<LockedIncident[]>(Prisma.sql`
          SELECT incident."id", incident."companyId", incident."number", incident."customerId", incident."storeId",
            incident."responsibleUserId", incident."mergedIntoIncidentId", incident."status", incident."version",
            EXISTS (SELECT 1 FROM "support_incidents" child WHERE child."companyId" = incident."companyId" AND child."mergedIntoIncidentId" = incident."id") AS "hasMergedDuplicates"
          FROM "support_incidents" incident
          WHERE incident."id" = ${incidentId}::uuid AND incident."companyId" = ${companyId}::uuid
          FOR UPDATE OF incident
        `))[0];
        if (!incident) {
          await auditDenied(tx, actor.id, companyId, incidentId, "NOT_FOUND", context.correlationId);
          return fail(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
        }
        if (incident.mergedIntoIncidentId || incident.hasMergedDuplicates) {
          await auditDenied(tx, actor.id, companyId, incidentId, "MERGED", context.correlationId);
          return fail(409, "SUPPORT_INCIDENT_CUSTOMER_CHANGE_MERGED", "No se puede cambiar el cliente de una incidencia que participa en una fusión.");
        }
        if (incident.storeId) {
          await auditDenied(tx, actor.id, companyId, incidentId, "STORE_ATTACHED", context.correlationId);
          return fail(409, "SUPPORT_INCIDENT_CUSTOMER_CHANGE_STORE_ATTACHED", "Retira primero la tienda de la incidencia.");
        }
        if (incident.version !== command.expectedVersion) {
          await auditDenied(tx, actor.id, companyId, incidentId, "VERSION_CONFLICT", context.correlationId);
          return fail(409, "SUPPORT_INCIDENT_VERSION_CONFLICT", "La incidencia ha cambiado. Recarga antes de continuar.");
        }
        if (incident.customerId !== command.expectedCustomerId) {
          await auditDenied(tx, actor.id, companyId, incidentId, "CUSTOMER_EXPECTATION_CONFLICT", context.correlationId);
          return fail(409, "SUPPORT_INCIDENT_CUSTOMER_EXPECTATION_CONFLICT", "El cliente vigente no coincide con el esperado.");
        }
        if (incident.customerId === command.customerId) {
          await auditDenied(tx, actor.id, companyId, incidentId, "UNCHANGED", context.correlationId);
          return fail(409, "SUPPORT_INCIDENT_CUSTOMER_UNCHANGED", "Selecciona un cliente diferente.");
        }

        const customers = await tx.$queryRaw<CustomerSnapshot[]>(Prisma.sql`
          SELECT "id", "code", "legalName", "status"
          FROM "customers"
          WHERE "id" IN (${incident.customerId}::uuid, ${command.customerId}::uuid)
          ORDER BY "id"
          FOR SHARE
        `);
        const previousCustomer = customers.find((customer) => customer.id === incident.customerId);
        const correctedCustomer = customers.find((customer) => customer.id === command.customerId);
        if (!previousCustomer || !correctedCustomer) {
          await auditDenied(tx, actor.id, companyId, incidentId, "CUSTOMER_NOT_FOUND", context.correlationId);
          return fail(404, "SUPPORT_CUSTOMER_NOT_FOUND", "El cliente no existe.");
        }

        const now = new Date();
        const resultingVersion = incident.version + 1;
        const change = await tx.supportIncidentCustomerChange.create({
          data: {
            companyId,
            incidentId,
            actorUserId: actor.id,
            previousCustomerId: previousCustomer.id,
            correctedCustomerId: correctedCustomer.id,
            previousCustomerCode: previousCustomer.code,
            previousCustomerLegalName: previousCustomer.legalName,
            correctedCustomerCode: correctedCustomer.code,
            correctedCustomerLegalName: correctedCustomer.legalName,
            reason: command.reason,
            resultingVersion,
            changedAt: now,
          },
          select: { id: true, changedAt: true },
        });
        await tx.supportIncident.update({ where: { id: incident.id }, data: { customerId: correctedCustomer.id, version: resultingVersion, updatedAt: now } });
        await tx.supportIncidentEvent.create({
          data: {
            companyId,
            incidentId,
            actorUserId: actor.id,
            responsibleUserIdAtEvent: incident.responsibleUserId,
            customerChangeId: change.id,
            eventType: "CUSTOMER_CHANGED",
            fromStatus: incident.status,
            toStatus: incident.status,
            resultingVersion,
            createdAt: now,
          },
        });
        const value: SupportIncidentCustomerChangeDto = {
          incident: { id: incident.id, customerId: correctedCustomer.id, storeId: null, version: resultingVersion },
          change: { id: change.id, resultingVersion, changedAt: change.changedAt.toISOString() },
        };
        await tx.auditEvent.create({
          data: {
            eventType: "SUPPORT_INCIDENT_CUSTOMER_CHANGED",
            actorType: "USER",
            payload: {
              actorUserId: actor.id,
              companyId,
              incidentId,
              previousCustomerId: previousCustomer.id,
              customerId: correctedCustomer.id,
              previousVersion: incident.version,
              version: resultingVersion,
              hadLinkedCommunications: await tx.supportCommunication.count({ where: { companyId, incidentId } }) > 0,
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
        return fail(503, "SUPPORT_INCIDENT_CUSTOMER_CHANGE_BUSY", "No se pudo completar el cambio por concurrencia.", 3);
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const collision = await resolveReplayCollision(key, incidentId, context.requestHash, actor, context.correlationId);
        if (collision) return collision;
      }
      throw error;
    }
  }
  return fail(503, "SUPPORT_INCIDENT_CUSTOMER_CHANGE_BUSY", "No se pudo completar el cambio por concurrencia.", 3);
}

async function denyUnauthorizedCustomerChange(incidentId: string, actor: SessionUser, correlationId?: string): Promise<Failure> {
  const companyId = (await prisma.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId;
  if (companyId) await prisma.$transaction((tx) => auditDenied(tx, actor.id, companyId, incidentId, "ROLE_OR_PERMISSION", correlationId));
  return fail(403, "SUPPORT_INCIDENT_CUSTOMER_CHANGE_FORBIDDEN", "Solo un administrador autorizado puede cambiar el cliente.");
}

async function resolveReplayCollision(
  key: string,
  incidentId: string,
  requestHash: string,
  actor: SessionUser,
  correlationId?: string,
): Promise<SupportIncidentCustomerChangeResult | null> {
  return prisma.$transaction(async (tx) => {
    const companyId = (await tx.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId;
    const stored = await tx.idempotencyRecord.findUnique({ where: { key } });
    if (!stored) return null;
    if (!companyId || !(await tx.supportIncident.findFirst({ where: { id: incidentId, companyId }, select: { id: true } }))) {
      if (companyId) await auditDenied(tx, actor.id, companyId, incidentId, "NOT_FOUND", correlationId);
      return fail(404, "SUPPORT_INCIDENT_NOT_FOUND", "La incidencia no existe.");
    }
    const replay = parseReplay(stored.requestHash, requestHash, stored.responseBody);
    if (replay.ok) return replay;
    const rate = await consumeRateLimit(tx, companyId, actor.id);
    if (rate.limited) {
      if (rate.firstLimitedRequest) await auditDenied(tx, actor.id, companyId, incidentId, "RATE_LIMITED", correlationId);
      return fail(429, "SUPPORT_INCIDENT_CUSTOMER_CHANGE_RATE_LIMITED", "Se han realizado demasiados intentos.", rate.retryAfterSeconds);
    }
    await auditDenied(tx, actor.id, companyId, incidentId, replay.error.code, correlationId);
    return replay;
  });
}

function canChangeCustomer(actor: SessionUser): boolean {
  return actor.role.code === "Administrador"
    && actor.permissions.includes("Support.View")
    && actor.permissions.includes("Support.ChangeIncidentCustomer")
    && actor.permissions.includes("Customers.View");
}

export function hashSupportIncidentCustomerChangeRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function scopedKey(actor: SessionUser, context: SupportIncidentCustomerChangeContext): string {
  return `v1:support:${createHash("sha256").update(`${actor.id}:${context.scope}:${context.idempotencyKey}`).digest("hex")}`;
}

function parseReplay(storedHash: string, requestHash: string, body: Prisma.JsonValue): SupportIncidentCustomerChangeResult {
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

async function auditDenied(tx: Prisma.TransactionClient, actorUserId: string, companyId: string, incidentId: string, reason: string, correlationId?: string): Promise<void> {
  await tx.auditEvent.create({ data: { eventType: "SUPPORT_INCIDENT_CUSTOMER_CHANGE_DENIED", actorType: "USER", payload: { actorUserId, companyId, incidentFingerprint: createHash("sha256").update(incidentId).digest("hex"), reason, ...(correlationId ? { correlationId } : {}) } } });
}

async function consumeRateLimit(tx: Prisma.TransactionClient, companyId: string, actorId: string): Promise<{ limited: false } | { limited: true; firstLimitedRequest: boolean; retryAfterSeconds: number }> {
  const now = new Date();
  const windowMs = 15 * 60 * 1000;
  const resetBefore = new Date(now.getTime() - windowMs);
  const [bucket] = await tx.$queryRaw<Array<{ count: number; windowStart: Date }>>(Prisma.sql`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), ${`support-customer-change:${companyId}:${actorId}`}, ${now}, 1, ${now}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${resetBefore} THEN 1 ELSE "rate_limit_buckets"."count" + 1 END,
      "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${resetBefore} THEN ${now} ELSE "rate_limit_buckets"."windowStart" END,
      "updatedAt" = ${now}
    RETURNING "count", "windowStart"
  `);
  if (!bucket || bucket.count <= 10) return { limited: false };
  return { limited: true, firstLimitedRequest: bucket.count === 11, retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStart.getTime() + windowMs - now.getTime()) / 1000)) };
}
