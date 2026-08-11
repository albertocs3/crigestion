import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { hashIdempotencyPayload } from "@/modules/platform/application/http";

const quantitySchema = z.string().trim().regex(/^\d{1,9}(?:\.\d{1,3})?$/)
  .refine((value) => new Prisma.Decimal(value).greaterThan(0), "La cantidad debe ser mayor que cero.");

export const createSubscriptionChangeScheduleSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500),
  lines: z.array(z.object({
    subscriptionLineId: z.string().uuid(),
    quantity: quantitySchema
  }).strict()).min(1).max(100)
}).strict().superRefine((value, context) => {
  if (new Set(value.lines.map((line) => line.subscriptionLineId)).size !== value.lines.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: "No se puede repetir una linea." });
  }
});

export const revokeSubscriptionChangeScheduleSchema = z.object({
  expectedSubscriptionVersion: z.number().int().positive(),
  expectedScheduleVersion: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500)
}).strict();

export const subscriptionChangeScheduleParamsSchema = z.object({
  subscriptionId: z.string().uuid(),
  scheduleId: z.string().uuid()
}).strict();

export type CreateSubscriptionChangeScheduleCommand = z.infer<typeof createSubscriptionChangeScheduleSchema>;
export type RevokeSubscriptionChangeScheduleCommand = z.infer<typeof revokeSubscriptionChangeScheduleSchema>;

export type SubscriptionChangeScheduleDto = {
  id: string;
  status: "PENDING" | "APPLIED" | "REVOKED";
  effectiveDate: string;
  reason: string;
  version: number;
  requestedAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
  appliedAt: string | null;
  lines: Array<{
    subscriptionLineId: string;
    position: number;
    previousQuantity: string;
    newQuantity: string;
  }>;
};

export type SubscriptionChangeScheduleMutationDto = {
  subscriptionVersion: number;
  schedule: SubscriptionChangeScheduleDto;
};

type ChangeFailure = {
  ok: false;
  status: 403 | 404 | 409 | 422 | 429 | 503;
  error: { code: string; message: string };
};

export type SubscriptionChangeScheduleMutationResult =
  | { ok: true; status: 200 | 201; value: SubscriptionChangeScheduleMutationDto }
  | ChangeFailure;

export type DueSubscriptionChangeApplicationResult =
  | { outcome: "NONE"; subscriptionVersion: number }
  | { outcome: "APPLIED"; subscriptionVersion: number; scheduleId: string }
  | { outcome: "STALE"; subscriptionVersion: number };

type MutationContext = Pick<RequestContext, "correlationId"> & {
  idempotencyKey: string;
  requestHash: string;
};

export const subscriptionChangeScheduleReplaySchema: z.ZodType<SubscriptionChangeScheduleDto> = z.object({
  id: z.string().uuid(),
  status: z.enum(["PENDING", "APPLIED", "REVOKED"]),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string(),
  version: z.number().int().positive(),
  requestedAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  revocationReason: z.string().nullable(),
  appliedAt: z.string().datetime().nullable(),
  lines: z.array(z.object({
    subscriptionLineId: z.string().uuid(),
    position: z.number().int().positive(),
    previousQuantity: z.string(),
    newQuantity: z.string()
  }).strict()).min(1)
}).strict();

const mutationDtoSchema: z.ZodType<SubscriptionChangeScheduleMutationDto> = z.object({
  subscriptionVersion: z.number().int().positive(),
  schedule: subscriptionChangeScheduleReplaySchema
}).strict();

export const subscriptionChangeScheduleSelect = {
  id: true,
  status: true,
  effectiveDate: true,
  reason: true,
  version: true,
  requestedAt: true,
  revokedAt: true,
  revocationReason: true,
  appliedAt: true,
  lines: {
    orderBy: [{ position: "asc" as const }],
    select: {
      subscriptionLineId: true,
      position: true,
      previousQuantity: true,
      newQuantity: true
    }
  }
} satisfies Prisma.SubscriptionChangeScheduleSelect;

export function hashSubscriptionChangeScheduleRequest(action: "create" | "revoke", payload: unknown): string {
  return hashIdempotencyPayload(`subscription-change-schedule-${action}:v1`, payload);
}

/**
 * Applies the due quantity schedule inside the renewal-owned Serializable
 * transaction. The caller must already hold the subscription row lock.
 */
export async function applyDueSubscriptionChangeBeforeRenewal(
  tx: Prisma.TransactionClient,
  command: {
    companyId: string;
    subscriptionId: string;
    asOfDate: string;
    initiatedByUserId: string;
    correlationId?: string;
  }
): Promise<DueSubscriptionChangeApplicationResult> {
  const subscription = await tx.subscription.findFirst({
    where: { id: command.subscriptionId, companyId: command.companyId },
    select: { id: true, number: true, status: true, pricingMode: true, version: true, nextRenewalDate: true }
  });
  if (!subscription) return { outcome: "STALE", subscriptionVersion: 0 };

  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "subscription_change_schedules"
    WHERE "companyId" = ${command.companyId}::uuid
      AND "subscriptionId" = ${command.subscriptionId}::uuid
      AND "status" = 'PENDING'
    ORDER BY "effectiveDate", "id"
    FOR UPDATE
  `);
  const schedule = await tx.subscriptionChangeSchedule.findFirst({
    where: { companyId: command.companyId, subscriptionId: command.subscriptionId, status: "PENDING" },
    orderBy: [{ effectiveDate: "asc" }, { id: "asc" }],
    select: {
      id: true, effectiveDate: true, scheduledSubscriptionVersion: true,
      lines: { orderBy: [{ position: "asc" }, { id: "asc" }], select: {
        subscriptionLineId: true, previousQuantity: true, newQuantity: true
      } }
    }
  });
  if (!schedule) return { outcome: "NONE", subscriptionVersion: subscription.version };

  const effectiveDate = formatDateOnly(schedule.effectiveDate);
  if (effectiveDate > command.asOfDate) return { outcome: "NONE", subscriptionVersion: subscription.version };
  if (subscription.status !== "ACTIVE"
    || subscription.pricingMode !== "PER_LICENSE"
    || subscription.version !== schedule.scheduledSubscriptionVersion
    || formatDateOnly(subscription.nextRenewalDate) !== effectiveDate
    || schedule.lines.length === 0) {
    return { outcome: "STALE", subscriptionVersion: subscription.version };
  }

  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "subscription_lines"
    WHERE "subscriptionId" = ${command.subscriptionId}::uuid
    ORDER BY "id" FOR UPDATE
  `);
  const currentLines = await tx.subscriptionLine.findMany({
    where: { subscriptionId: command.subscriptionId, id: { in: schedule.lines.map((line) => line.subscriptionLineId) } },
    select: { id: true, quantity: true }
  });
  const currentQuantity = new Map(currentLines.map((line) => [line.id, line.quantity]));
  if (currentLines.length !== schedule.lines.length
    || schedule.lines.some((line) => !currentQuantity.get(line.subscriptionLineId)?.equals(line.previousQuantity))) {
    return { outcome: "STALE", subscriptionVersion: subscription.version };
  }
  const hasBlocker = await tx.subscriptionRenewalReservation.count({
    where: { companyId: command.companyId, subscriptionId: command.subscriptionId, status: "RESERVED" }
  }) || await tx.subscriptionRenewalExclusion.count({
    where: { companyId: command.companyId, subscriptionId: command.subscriptionId, status: "OPEN" }
  }) || await tx.subscriptionCancellationSchedule.count({
    where: { companyId: command.companyId, subscriptionId: command.subscriptionId, status: "PENDING" }
  }) || await tx.subscriptionReactivationSchedule.count({
    where: { companyId: command.companyId, subscriptionId: command.subscriptionId, status: "PENDING" }
  });
  if (hasBlocker) return { outcome: "STALE", subscriptionVersion: subscription.version };

  const appliedAt = await databaseClock(tx);
  const resultingVersion = subscription.version + 1;
  await tx.subscriptionChangeSchedule.update({
    where: { id: schedule.id },
    data: {
      status: "APPLIED", version: { increment: 1 }, appliedById: command.initiatedByUserId,
      appliedAt, appliedAgainstVersion: subscription.version, appliedSubscriptionVersion: resultingVersion
    }
  });
  for (const line of schedule.lines) {
    await tx.subscriptionLine.update({
      where: { id: line.subscriptionLineId },
      data: { quantity: line.newQuantity }
    });
  }
  await tx.subscription.update({
    where: { id: subscription.id },
    data: { version: { increment: 1 }, updatedById: command.initiatedByUserId }
  });
  await tx.auditEvent.create({ data: {
    eventType: "SUBSCRIPTION_CHANGE_SCHEDULE_APPLIED",
    actorType: "SYSTEM",
    payload: {
      companyId: command.companyId, subscriptionId: subscription.id, number: subscription.number,
      scheduleId: schedule.id, effectiveDate, lineCount: schedule.lines.length,
      previousVersion: subscription.version, subscriptionVersion: resultingVersion,
      initiatedByUserId: command.initiatedByUserId,
      ...(command.correlationId ? { correlationId: command.correlationId } : {})
    }
  } });
  return { outcome: "APPLIED", subscriptionVersion: resultingVersion, scheduleId: schedule.id };
}

export async function createSubscriptionChangeSchedule(
  subscriptionId: string,
  command: CreateSubscriptionChangeScheduleCommand,
  actor: SessionUser,
  context: MutationContext
): Promise<SubscriptionChangeScheduleMutationResult> {
  const denied = await requireChangePermissions(actor, context);
  if (denied) return denied;
  const replay = await readReplay(context, 201);
  if (replay) return replay;
  const companyId = await currentCompanyId();
  if (!companyId) return failure(404, "SUBSCRIPTION_NOT_FOUND", "La suscripcion no existe.");
  if (await consumeRateLimit(actor, companyId, "create", context.correlationId)) {
    return failure(429, "SUBSCRIPTION_CHANGE_SCHEDULE_RATE_LIMITED", "Demasiados cambios programados. Espere quince minutos.");
  }

  return executeMutation(async (tx) => {
    const stored = await replayInTransaction(tx, context, 201);
    if (stored) return stored;
    const subscription = await lockSubscription(tx, companyId, subscriptionId);
    if (!subscription) return failure(404, "SUBSCRIPTION_NOT_FOUND", "La suscripcion no existe.");
    if (subscription.version !== command.expectedVersion) {
      return failure(409, "SUBSCRIPTION_VERSION_CONFLICT", "La suscripcion ha cambiado; recargue los datos.");
    }
    if (subscription.status !== "ACTIVE" || subscription.pricingMode !== "PER_LICENSE") {
      return failure(409, "SUBSCRIPTION_NOT_SCHEDULABLE_FOR_CHANGE", "Solo se admiten cambios de cantidad en suscripciones activas por licencias.");
    }

    await lockRelatedRows(tx, companyId, subscriptionId);
    if (await tx.subscriptionChangeSchedule.count({ where: { companyId, subscriptionId, status: "PENDING" } })) {
      return failure(409, "SUBSCRIPTION_PENDING_CHANGE_EXISTS", "Ya existe un cambio programado pendiente.");
    }
    const blocker = await findBlocker(tx, companyId, subscriptionId);
    if (blocker) return blocker;

    const requestedIds = command.lines.map((line) => line.subscriptionLineId);
    const lines = await tx.subscriptionLine.findMany({
      where: { subscriptionId, id: { in: requestedIds } },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      select: { id: true, position: true, quantity: true }
    });
    if (lines.length !== requestedIds.length) {
      return failure(422, "SUBSCRIPTION_CHANGE_LINES_INVALID", "Una linea no pertenece a la suscripcion.");
    }
    const quantityById = new Map(command.lines.map((line) => [line.subscriptionLineId, new Prisma.Decimal(line.quantity)]));
    if (lines.some((line) => line.quantity.equals(quantityById.get(line.id)!))) {
      return failure(422, "SUBSCRIPTION_CHANGE_QUANTITY_UNCHANGED", "Todas las cantidades deben cambiar.");
    }

    const requestedAt = await databaseClock(tx);
    const resultingVersion = subscription.version + 1;
    const createdSchedule = await tx.subscriptionChangeSchedule.create({
      data: {
        companyId,
        subscriptionId,
        effectiveDate: subscription.nextRenewalDate,
        reason: command.reason,
        createdAgainstVersion: subscription.version,
        scheduledSubscriptionVersion: resultingVersion,
        requestedById: actor.id,
        requestedAt
      },
      select: { id: true }
    });
    await tx.subscriptionChangeScheduleLine.createMany({
      data: lines.map((line) => ({
        scheduleId: createdSchedule.id,
        subscriptionId,
        subscriptionLineId: line.id,
        position: line.position,
        previousQuantity: line.quantity,
        newQuantity: quantityById.get(line.id)!
      }))
    });
    const schedule = await tx.subscriptionChangeSchedule.findUniqueOrThrow({
      where: { id: createdSchedule.id },
      select: subscriptionChangeScheduleSelect
    });
    await tx.subscription.update({
      where: { id: subscriptionId },
      data: { version: { increment: 1 }, updatedById: actor.id }
    });
    const value = { subscriptionVersion: resultingVersion, schedule: mapSubscriptionChangeSchedule(schedule) };
    await tx.auditEvent.create({ data: {
      eventType: "SUBSCRIPTION_CHANGE_SCHEDULED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        companyId,
        subscriptionId,
        number: subscription.number,
        scheduleId: schedule.id,
        effectiveDate: value.schedule.effectiveDate,
        lineCount: value.schedule.lines.length,
        previousVersion: subscription.version,
        subscriptionVersion: resultingVersion,
        hasReason: true,
        ...(context.correlationId ? { correlationId: context.correlationId } : {})
      }
    } });
    await storeReplay(tx, context, 201, value);
    return { ok: true as const, status: 201 as const, value };
  });
}

export async function revokeSubscriptionChangeSchedule(
  subscriptionId: string,
  scheduleId: string,
  command: RevokeSubscriptionChangeScheduleCommand,
  actor: SessionUser,
  context: MutationContext
): Promise<SubscriptionChangeScheduleMutationResult> {
  const denied = await requireChangePermissions(actor, context);
  if (denied) return denied;
  const replay = await readReplay(context, 200);
  if (replay) return replay;
  const companyId = await currentCompanyId();
  if (!companyId) return failure(404, "SUBSCRIPTION_CHANGE_SCHEDULE_NOT_FOUND", "El cambio programado no existe.");
  if (await consumeRateLimit(actor, companyId, "revoke", context.correlationId)) {
    return failure(429, "SUBSCRIPTION_CHANGE_SCHEDULE_RATE_LIMITED", "Demasiadas retiradas de cambios. Espere quince minutos.");
  }

  return executeMutation(async (tx) => {
    const stored = await replayInTransaction(tx, context, 200);
    if (stored) return stored;
    const subscription = await lockSubscription(tx, companyId, subscriptionId);
    if (!subscription) return failure(404, "SUBSCRIPTION_CHANGE_SCHEDULE_NOT_FOUND", "El cambio programado no existe.");
    if (subscription.version !== command.expectedSubscriptionVersion) {
      return failure(409, "SUBSCRIPTION_VERSION_CONFLICT", "La suscripcion ha cambiado; recargue los datos.");
    }
    await lockRelatedRows(tx, companyId, subscriptionId);
    const schedule = await tx.subscriptionChangeSchedule.findFirst({
      where: { id: scheduleId, companyId, subscriptionId },
      select: subscriptionChangeScheduleSelect
    });
    if (!schedule) return failure(404, "SUBSCRIPTION_CHANGE_SCHEDULE_NOT_FOUND", "El cambio programado no existe.");
    if (schedule.version !== command.expectedScheduleVersion) {
      return failure(409, "SUBSCRIPTION_CHANGE_SCHEDULE_VERSION_CONFLICT", "El cambio programado ha cambiado; recargue los datos.");
    }
    if (schedule.status !== "PENDING") {
      return failure(409, "SUBSCRIPTION_CHANGE_SCHEDULE_NOT_PENDING", "Solo se puede retirar un cambio pendiente.");
    }
    if (subscription.status !== "ACTIVE") {
      return failure(409, "SUBSCRIPTION_CHANGE_SCHEDULE_STALE", "La suscripcion ya no admite este cambio programado.");
    }

    const revokedAt = await databaseClock(tx);
    const resultingVersion = subscription.version + 1;
    const revoked = await tx.subscriptionChangeSchedule.update({
      where: { id: scheduleId },
      data: {
        status: "REVOKED",
        version: { increment: 1 },
        revokedById: actor.id,
        revokedAt,
        revocationReason: command.reason,
        revokedAgainstVersion: subscription.version,
        revokedSubscriptionVersion: resultingVersion
      },
      select: subscriptionChangeScheduleSelect
    });
    await tx.subscription.update({
      where: { id: subscriptionId },
      data: { version: { increment: 1 }, updatedById: actor.id }
    });
    const value = { subscriptionVersion: resultingVersion, schedule: mapSubscriptionChangeSchedule(revoked) };
    await tx.auditEvent.create({ data: {
      eventType: "SUBSCRIPTION_CHANGE_SCHEDULE_REVOKED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        companyId,
        subscriptionId,
        number: subscription.number,
        scheduleId,
        lineCount: revoked.lines.length,
        previousVersion: subscription.version,
        subscriptionVersion: resultingVersion,
        scheduleVersion: revoked.version,
        hasReason: true,
        ...(context.correlationId ? { correlationId: context.correlationId } : {})
      }
    } });
    await storeReplay(tx, context, 200, value);
    return { ok: true as const, status: 200 as const, value };
  });
}

export function mapSubscriptionChangeSchedule(
  row: Prisma.SubscriptionChangeScheduleGetPayload<{ select: typeof subscriptionChangeScheduleSelect }>
): SubscriptionChangeScheduleDto {
  return {
    id: row.id,
    status: row.status,
    effectiveDate: formatDateOnly(row.effectiveDate),
    reason: row.reason,
    version: row.version,
    requestedAt: row.requestedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revocationReason: row.revocationReason,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    lines: row.lines.map((line) => ({
      subscriptionLineId: line.subscriptionLineId,
      position: line.position,
      previousQuantity: line.previousQuantity.toFixed(3),
      newQuantity: line.newQuantity.toFixed(3)
    }))
  };
}

async function requireChangePermissions(
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId">
): Promise<ChangeFailure | null> {
  const required = ["Subscriptions.ScheduleChanges", "Subscriptions.ManageEconomics", "Subscriptions.View"];
  const missing = required.find((permission) => !actor.permissions.includes(permission));
  if (!missing) return null;
  const companyId = await currentCompanyId();
  await prisma.auditEvent.create({ data: {
    eventType: "ACCESS_DENIED",
    actorType: "USER",
    payload: {
      userId: actor.id,
      permission: missing,
      ...(companyId ? { companyId } : {}),
      ...(context.correlationId ? { correlationId: context.correlationId } : {})
    }
  } });
  return failure(403, "FORBIDDEN", "No dispone de permiso para programar cambios de suscripcion.");
}

async function lockSubscription(tx: Prisma.TransactionClient, companyId: string, subscriptionId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "subscriptions"
    WHERE "id" = ${subscriptionId}::uuid AND "companyId" = ${companyId}::uuid
    FOR UPDATE
  `);
  return tx.subscription.findFirst({
    where: { id: subscriptionId, companyId },
    select: { id: true, number: true, status: true, pricingMode: true, version: true, nextRenewalDate: true }
  });
}

async function lockRelatedRows(tx: Prisma.TransactionClient, companyId: string, subscriptionId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscription_change_schedules" WHERE "companyId" = ${companyId}::uuid AND "subscriptionId" = ${subscriptionId}::uuid ORDER BY "id" FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscription_cancellation_schedules" WHERE "companyId" = ${companyId}::uuid AND "subscriptionId" = ${subscriptionId}::uuid ORDER BY "id" FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscription_reactivation_schedules" WHERE "companyId" = ${companyId}::uuid AND "subscriptionId" = ${subscriptionId}::uuid ORDER BY "id" FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscription_renewal_reservations" WHERE "companyId" = ${companyId}::uuid AND "subscriptionId" = ${subscriptionId}::uuid ORDER BY "id" FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscription_renewal_exclusions" WHERE "companyId" = ${companyId}::uuid AND "subscriptionId" = ${subscriptionId}::uuid ORDER BY "id" FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscription_lines" WHERE "subscriptionId" = ${subscriptionId}::uuid ORDER BY "id" FOR UPDATE`);
}

async function findBlocker(
  tx: Prisma.TransactionClient,
  companyId: string,
  subscriptionId: string
): Promise<ChangeFailure | null> {
  if (await tx.subscriptionRenewalReservation.count({ where: { companyId, subscriptionId, status: "RESERVED" } })) {
    return failure(409, "SUBSCRIPTION_RENEWAL_RESERVED", "La renovacion ya esta reservada.");
  }
  if (await tx.subscriptionRenewalExclusion.count({ where: { companyId, subscriptionId, status: "OPEN" } })) {
    return failure(409, "SUBSCRIPTION_RENEWAL_EXCLUSION_OPEN", "La renovacion pendiente debe resolverse antes de programar cambios.");
  }
  if (await tx.subscriptionCancellationSchedule.count({ where: { companyId, subscriptionId, status: "PENDING" } })) {
    return failure(409, "SUBSCRIPTION_PENDING_CANCELLATION_EXISTS", "Existe una baja programada pendiente.");
  }
  if (await tx.subscriptionReactivationSchedule.count({ where: { companyId, subscriptionId, status: "PENDING" } })) {
    return failure(409, "SUBSCRIPTION_PENDING_REACTIVATION_EXISTS", "Existe una reactivacion programada pendiente.");
  }
  return null;
}

async function currentCompanyId(): Promise<string | null> {
  return (await prisma.installation.findFirst({
    where: { companyId: { not: null } },
    select: { companyId: true }
  }))?.companyId ?? null;
}

async function databaseClock(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT date_trunc('milliseconds', clock_timestamp()) AS "now"`;
  const now = rows[0]?.now;
  if (!now) throw new Error("SUBSCRIPTION_DATABASE_CLOCK_UNAVAILABLE");
  return now;
}

async function readReplay(
  context: MutationContext,
  expectedStatus: 200 | 201
): Promise<SubscriptionChangeScheduleMutationResult | null> {
  const stored = await prisma.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
  return stored ? parseStoredReplay(stored, context, expectedStatus) : null;
}

async function replayInTransaction(
  tx: Prisma.TransactionClient,
  context: MutationContext,
  expectedStatus: 200 | 201
): Promise<SubscriptionChangeScheduleMutationResult | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.idempotencyKey}, 0))`;
  const stored = await tx.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
  return stored ? parseStoredReplay(stored, context, expectedStatus) : null;
}

function parseStoredReplay(
  stored: { requestHash: string; responseStatus: number; responseBody: unknown },
  context: MutationContext,
  expectedStatus: 200 | 201
): SubscriptionChangeScheduleMutationResult {
  if (stored.requestHash !== context.requestHash) {
    return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
  }
  const parsed = mutationDtoSchema.safeParse(stored.responseBody);
  return stored.responseStatus === expectedStatus && parsed.success
    ? { ok: true, status: expectedStatus, value: parsed.data }
    : failure(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es compatible con el contrato actual.");
}

async function storeReplay(
  tx: Prisma.TransactionClient,
  context: MutationContext,
  status: 200 | 201,
  value: SubscriptionChangeScheduleMutationDto
): Promise<void> {
  await tx.idempotencyRecord.create({ data: {
    key: context.idempotencyKey,
    requestHash: context.requestHash,
    responseStatus: status,
    responseBody: value as Prisma.InputJsonValue
  } });
}

async function consumeRateLimit(
  actor: SessionUser,
  companyId: string,
  action: "create" | "revoke",
  correlationId?: string
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const key = `subscription-change-schedule-${action}:${companyId}:${actor.id}`;
    const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${key}, clock_timestamp(), 1, clock_timestamp(), clock_timestamp())
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '15 minutes'
          THEN 1 ELSE "rate_limit_buckets"."count" + 1 END,
        "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '15 minutes'
          THEN clock_timestamp() ELSE "rate_limit_buckets"."windowStart" END,
        "updatedAt" = clock_timestamp()
      RETURNING "count"
    `);
    const count = rows[0]?.count ?? 0;
    if (count === 11) await tx.auditEvent.create({ data: {
      eventType: "SUBSCRIPTION_CHANGE_SCHEDULE_RATE_LIMITED",
      actorType: "USER",
      payload: { actorUserId: actor.id, companyId, action, ...(correlationId ? { correlationId } : {}) }
    } });
    return count > 10;
  });
}

async function executeMutation(
  work: (tx: Prisma.TransactionClient) => Promise<SubscriptionChangeScheduleMutationResult>
): Promise<SubscriptionChangeScheduleMutationResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isRetryableTransactionError(error)) {
        if (attempt < 2) continue;
        return failure(503, "SUBSCRIPTION_CHANGE_SCHEDULE_BUSY", "La suscripcion esta ocupada; vuelva a intentarlo.");
      }
      throw error;
    }
  }
  return failure(503, "SUBSCRIPTION_CHANGE_SCHEDULE_BUSY", "La suscripcion esta ocupada; vuelva a intentarlo.");
}

function isRetryableTransactionError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001");
}

function failure(status: ChangeFailure["status"], code: string, message: string): ChangeFailure {
  return { ok: false, status, error: { code, message } };
}

function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
