import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { hashIdempotencyPayload } from "@/modules/platform/application/http";

const reactivationDateOnlySchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "La fecha no es valida.");

export const createSubscriptionReactivationScheduleSchema = z.object({
  expectedVersion: z.number().int().positive(),
  effectiveDate: reactivationDateOnlySchema,
  nextRenewalDate: reactivationDateOnlySchema,
  reason: z.string().trim().min(3).max(500)
}).strict();

export const revokeSubscriptionReactivationScheduleSchema = z.object({
  expectedSubscriptionVersion: z.number().int().positive(),
  expectedScheduleVersion: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500)
}).strict();

export const applySubscriptionReactivationScheduleSchema = z.object({
  expectedSubscriptionVersion: z.number().int().positive(),
  expectedScheduleVersion: z.number().int().positive()
}).strict();

export const subscriptionReactivationScheduleParamsSchema = z.object({
  subscriptionId: z.string().uuid(),
  scheduleId: z.string().uuid()
}).strict();

export type CreateSubscriptionReactivationScheduleCommand = z.infer<typeof createSubscriptionReactivationScheduleSchema>;
export type RevokeSubscriptionReactivationScheduleCommand = z.infer<typeof revokeSubscriptionReactivationScheduleSchema>;
export type ApplySubscriptionReactivationScheduleCommand = z.infer<typeof applySubscriptionReactivationScheduleSchema>;

export type SubscriptionReactivationScheduleDto = {
  id: string;
  status: "PENDING" | "APPLIED" | "REVOKED";
  effectiveDate: string;
  nextRenewalDate: string;
  previousNextRenewalDate: string;
  reason: string;
  version: number;
  requestedAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
  appliedAt: string | null;
  appliedBusinessDate: string | null;
  reactivationId: string | null;
  lastAutomationAttempt?: {
    attemptNumber: number;
    outcome: "APPLIED" | "BLOCKED";
    stableCode: string | null;
    startedAt: string;
    completedAt: string;
  } | null;
};

export type SubscriptionReactivationScheduleMutationDto = {
  subscriptionVersion: number;
  schedule: SubscriptionReactivationScheduleDto;
};

export type SubscriptionReactivationScheduleApplyDto = SubscriptionReactivationScheduleMutationDto & {
  status: "ACTIVE";
  nextRenewalDate: string;
  reactivationId: string;
};

type ScheduleFailure = {
  ok: false;
  status: 404 | 409 | 422 | 429 | 503;
  error: { code: string; message: string };
};

export type SubscriptionReactivationScheduleMutationResult =
  | { ok: true; status: 200 | 201; value: SubscriptionReactivationScheduleMutationDto }
  | ScheduleFailure;

export type SubscriptionReactivationScheduleApplyResult =
  | { ok: true; status: 200; value: SubscriptionReactivationScheduleApplyDto }
  | ScheduleFailure;

export type SubscriptionReactivationAutomationResult =
  | { outcome: "IDLE" }
  | { outcome: "SKIPPED"; scheduleId: string }
  | { outcome: "APPLIED"; scheduleId: string; subscriptionId: string; reactivationId: string }
  | { outcome: "BLOCKED"; scheduleId: string; subscriptionId: string; stableCode: string };

type MutationContext = Pick<RequestContext, "correlationId"> & {
  idempotencyKey: string;
  requestHash: string;
};

const scheduleDtoSchema: z.ZodType<SubscriptionReactivationScheduleDto> = z.object({
  id: z.string().uuid(), status: z.enum(["PENDING", "APPLIED", "REVOKED"]),
  effectiveDate: reactivationDateOnlySchema, nextRenewalDate: reactivationDateOnlySchema,
  previousNextRenewalDate: reactivationDateOnlySchema, reason: z.string(), version: z.number().int().positive(),
  requestedAt: z.string().datetime(), revokedAt: z.string().datetime().nullable(), revocationReason: z.string().nullable(),
  appliedAt: z.string().datetime().nullable(), appliedBusinessDate: reactivationDateOnlySchema.nullable(),
  reactivationId: z.string().uuid().nullable(),
  lastAutomationAttempt: z.object({
    attemptNumber: z.number().int().positive(), outcome: z.enum(["APPLIED", "BLOCKED"]),
    stableCode: z.string().nullable(), startedAt: z.string().datetime(), completedAt: z.string().datetime()
  }).strict().nullable().default(null)
}).strict();

const mutationDtoSchemaBase = z.object({
  subscriptionVersion: z.number().int().positive(), schedule: scheduleDtoSchema
}).strict();
const mutationDtoSchema: z.ZodType<SubscriptionReactivationScheduleMutationDto> = mutationDtoSchemaBase;

const applyDtoSchema: z.ZodType<SubscriptionReactivationScheduleApplyDto> = mutationDtoSchemaBase.extend({
  status: z.literal("ACTIVE"), nextRenewalDate: reactivationDateOnlySchema, reactivationId: z.string().uuid()
}).strict();

export const subscriptionReactivationScheduleSelect = {
  id: true, status: true, effectiveDate: true, nextRenewalDate: true, previousNextRenewalDate: true,
  reason: true, version: true, requestedAt: true, revokedAt: true, revocationReason: true,
  appliedAt: true, appliedBusinessDate: true, reactivationId: true,
  automationAttempts: {
    orderBy: [{ attemptNumber: "desc" as const }], take: 1,
    select: { attemptNumber: true, outcome: true, stableCode: true, startedAt: true, completedAt: true }
  }
} satisfies Prisma.SubscriptionReactivationScheduleSelect;

export function hashSubscriptionReactivationScheduleRequest(action: "create" | "revoke" | "apply", payload: unknown): string {
  return hashIdempotencyPayload(`subscription-reactivation-schedule-${action}:v1`, payload);
}

export async function createSubscriptionReactivationSchedule(
  subscriptionId: string,
  command: CreateSubscriptionReactivationScheduleCommand,
  actor: SessionUser,
  context: MutationContext
): Promise<SubscriptionReactivationScheduleMutationResult> {
  const replay = await readReplay(context, mutationDtoSchema, 201);
  if (replay) return replay;
  const companyId = await currentCompanyId();
  if (!companyId) return failure(404, "SUBSCRIPTION_NOT_FOUND", "La suscripcion no existe.");
  if (await consumeRateLimit(actor, companyId, "create", context.correlationId)) {
    return failure(429, "SUBSCRIPTION_REACTIVATION_SCHEDULE_RATE_LIMITED", "Demasiadas programaciones de reactivacion. Espere quince minutos.");
  }

  return executeMutation(async (tx) => {
    const stored = await replayInTransaction(tx, context, mutationDtoSchema, 201);
    if (stored) return stored;
    const subscription = await lockSubscription(tx, companyId, subscriptionId);
    if (!subscription) return failure(404, "SUBSCRIPTION_NOT_FOUND", "La suscripcion no existe.");
    if (subscription.version !== command.expectedVersion) return failure(409, "SUBSCRIPTION_VERSION_CONFLICT", "La suscripcion ha cambiado; recargue los datos.");
    if (subscription.status !== "CANCELLED") return failure(409, "SUBSCRIPTION_NOT_SCHEDULABLE_FOR_REACTIVATION", "Solo se puede programar la reactivacion de una suscripcion cancelada.");
    if (!hasCancellationEvidence(subscription)) throw new Error("SUBSCRIPTION_CANCELLATION_EVIDENCE_INCOMPLETE");

    await lockSchedules(tx, companyId, subscriptionId);
    if (await tx.subscriptionReactivationSchedule.count({ where: { companyId, subscriptionId, status: "PENDING" } })) {
      return failure(409, "SUBSCRIPTION_PENDING_REACTIVATION_EXISTS", "Ya existe una reactivacion programada pendiente.");
    }
    await lockEligibilityRows(tx, companyId, subscription);
    const eligibility = await validateEligibility(tx, companyId, subscription, command.effectiveDate, command.nextRenewalDate, true);
    if (eligibility) return eligibility;

    const requestedAt = await databaseClock(tx);
    const resultingVersion = subscription.version + 1;
    const schedule = await tx.subscriptionReactivationSchedule.create({
      data: {
        companyId, subscriptionId, effectiveDate: parseDateOnly(command.effectiveDate), nextRenewalDate: parseDateOnly(command.nextRenewalDate),
        previousNextRenewalDate: subscription.nextRenewalDate, reason: command.reason,
        createdAgainstVersion: subscription.version, scheduledSubscriptionVersion: resultingVersion,
        requestedById: actor.id, requestedAt, cancelledByIdSnapshot: subscription.cancelledById!,
        cancelledAtSnapshot: subscription.cancelledAt!, cancellationEffectiveDateSnapshot: subscription.cancellationEffectiveDate!,
        cancellationReasonSnapshot: subscription.cancellationReason!, cancellationModeSnapshot: subscription.cancellationMode!
      },
      select: subscriptionReactivationScheduleSelect
    });
    await tx.subscription.update({ where: { id: subscriptionId }, data: { version: { increment: 1 }, updatedById: actor.id } });
    const value = { subscriptionVersion: resultingVersion, schedule: mapSubscriptionReactivationSchedule(schedule) };
    await tx.auditEvent.create({ data: {
      eventType: "SUBSCRIPTION_REACTIVATION_SCHEDULED", actorType: "USER",
      payload: {
        actorUserId: actor.id, companyId, subscriptionId, number: subscription.number, scheduleId: schedule.id,
        effectiveDate: command.effectiveDate, nextRenewalDate: command.nextRenewalDate,
        previousVersion: subscription.version, subscriptionVersion: resultingVersion, hasReason: true,
        ...(context.correlationId ? { correlationId: context.correlationId } : {})
      }
    } });
    await storeReplay(tx, context, 201, value);
    return { ok: true as const, status: 201 as const, value };
  });
}

export async function revokeSubscriptionReactivationSchedule(
  subscriptionId: string,
  scheduleId: string,
  command: RevokeSubscriptionReactivationScheduleCommand,
  actor: SessionUser,
  context: MutationContext
): Promise<SubscriptionReactivationScheduleMutationResult> {
  const replay = await readReplay(context, mutationDtoSchema, 200);
  if (replay) return replay;
  const companyId = await currentCompanyId();
  if (!companyId) return failure(404, "SUBSCRIPTION_REACTIVATION_SCHEDULE_NOT_FOUND", "La reactivacion programada no existe.");
  if (await consumeRateLimit(actor, companyId, "revoke", context.correlationId)) {
    return failure(429, "SUBSCRIPTION_REACTIVATION_SCHEDULE_RATE_LIMITED", "Demasiadas retiradas de reactivacion. Espere quince minutos.");
  }

  return executeMutation(async (tx) => {
    const stored = await replayInTransaction(tx, context, mutationDtoSchema, 200);
    if (stored) return stored;
    const subscription = await lockSubscription(tx, companyId, subscriptionId);
    if (!subscription) return failure(404, "SUBSCRIPTION_REACTIVATION_SCHEDULE_NOT_FOUND", "La reactivacion programada no existe.");
    if (subscription.version !== command.expectedSubscriptionVersion) return failure(409, "SUBSCRIPTION_VERSION_CONFLICT", "La suscripcion ha cambiado; recargue los datos.");
    await lockSchedule(tx, companyId, subscriptionId, scheduleId);
    const schedule = await tx.subscriptionReactivationSchedule.findFirst({ where: { id: scheduleId, companyId, subscriptionId }, select: subscriptionReactivationScheduleSelect });
    if (!schedule) return failure(404, "SUBSCRIPTION_REACTIVATION_SCHEDULE_NOT_FOUND", "La reactivacion programada no existe.");
    if (schedule.version !== command.expectedScheduleVersion) return failure(409, "SUBSCRIPTION_REACTIVATION_SCHEDULE_VERSION_CONFLICT", "La reactivacion programada ha cambiado; recargue los datos.");
    if (schedule.status !== "PENDING") return failure(409, "SUBSCRIPTION_REACTIVATION_SCHEDULE_NOT_PENDING", "Solo se puede retirar una reactivacion pendiente.");
    const revokedAt = await databaseClock(tx);
    const resultingVersion = subscription.version + 1;
    const revoked = await tx.subscriptionReactivationSchedule.update({
      where: { id: scheduleId },
      data: {
        status: "REVOKED", version: { increment: 1 }, revokedById: actor.id, revokedAt,
        revocationReason: command.reason, revokedAgainstVersion: subscription.version,
        revokedSubscriptionVersion: resultingVersion
      },
      select: subscriptionReactivationScheduleSelect
    });
    await tx.subscription.update({ where: { id: subscriptionId }, data: { version: { increment: 1 }, updatedById: actor.id } });
    const value = { subscriptionVersion: resultingVersion, schedule: mapSubscriptionReactivationSchedule(revoked) };
    await tx.auditEvent.create({ data: {
      eventType: "SUBSCRIPTION_REACTIVATION_SCHEDULE_REVOKED", actorType: "USER",
      payload: {
        actorUserId: actor.id, companyId, subscriptionId, number: subscription.number, scheduleId,
        previousVersion: subscription.version, subscriptionVersion: resultingVersion,
        scheduleVersion: revoked.version, hasReason: true,
        ...(context.correlationId ? { correlationId: context.correlationId } : {})
      }
    } });
    await storeReplay(tx, context, 200, value);
    return { ok: true as const, status: 200 as const, value };
  });
}

export async function applySubscriptionReactivationSchedule(
  subscriptionId: string,
  scheduleId: string,
  command: ApplySubscriptionReactivationScheduleCommand,
  actor: SessionUser,
  context: MutationContext
): Promise<SubscriptionReactivationScheduleApplyResult> {
  const replay = await readReplay(context, applyDtoSchema, 200);
  if (replay) return replay;
  const companyId = await currentCompanyId();
  if (!companyId) return failure(404, "SUBSCRIPTION_REACTIVATION_SCHEDULE_NOT_FOUND", "La reactivacion programada no existe.");
  if (await consumeRateLimit(actor, companyId, "apply", context.correlationId)) {
    return failure(429, "SUBSCRIPTION_REACTIVATION_SCHEDULE_RATE_LIMITED", "Demasiadas aplicaciones de reactivacion. Espere quince minutos.");
  }

  return executeMutation(async (tx) => {
    const stored = await replayInTransaction(tx, context, applyDtoSchema, 200);
    if (stored) return stored;
    const subscription = await lockSubscription(tx, companyId, subscriptionId);
    if (!subscription) return failure(404, "SUBSCRIPTION_REACTIVATION_SCHEDULE_NOT_FOUND", "La reactivacion programada no existe.");
    if (subscription.version !== command.expectedSubscriptionVersion) return failure(409, "SUBSCRIPTION_VERSION_CONFLICT", "La suscripcion ha cambiado; recargue los datos.");
    await lockSchedule(tx, companyId, subscriptionId, scheduleId);
    const schedule = await tx.subscriptionReactivationSchedule.findFirst({
      where: { id: scheduleId, companyId, subscriptionId },
      select: {
        ...subscriptionReactivationScheduleSelect, createdAgainstVersion: true, scheduledSubscriptionVersion: true,
        requestedById: true, cancelledByIdSnapshot: true, cancelledAtSnapshot: true,
        cancellationEffectiveDateSnapshot: true, cancellationReasonSnapshot: true, cancellationModeSnapshot: true
      }
    });
    if (!schedule) return failure(404, "SUBSCRIPTION_REACTIVATION_SCHEDULE_NOT_FOUND", "La reactivacion programada no existe.");
    if (schedule.version !== command.expectedScheduleVersion) return failure(409, "SUBSCRIPTION_REACTIVATION_SCHEDULE_VERSION_CONFLICT", "La reactivacion programada ha cambiado; recargue los datos.");
    if (schedule.status !== "PENDING") return failure(409, "SUBSCRIPTION_REACTIVATION_SCHEDULE_NOT_PENDING", "Solo se puede aplicar una reactivacion pendiente.");
    if (schedule.scheduledSubscriptionVersion !== subscription.version) {
      return failure(409, "SUBSCRIPTION_REACTIVATION_SCHEDULE_STALE", "La suscripcion ha cambiado desde que se programo la reactivacion.");
    }
    if (subscription.status !== "CANCELLED") return failure(409, "SUBSCRIPTION_NOT_SCHEDULABLE_FOR_REACTIVATION", "La suscripcion ya no esta cancelada.");
    if (!hasCancellationEvidence(subscription) || !matchesCancellationSnapshot(subscription, schedule)) {
      return failure(409, "SUBSCRIPTION_REACTIVATION_SCHEDULE_STALE", "La reactivacion programada no corresponde con la baja vigente.");
    }

    const appliedAt = await databaseClock(tx);
    const businessDate = madridDateOnly(appliedAt);
    if (formatDateOnly(schedule.effectiveDate) > businessDate) {
      return failure(422, "SUBSCRIPTION_REACTIVATION_SCHEDULE_NOT_DUE", "La reactivacion programada todavia no ha vencido.");
    }
    await lockEligibilityRows(tx, companyId, subscription);
    const eligibility = await validateEligibility(tx, companyId, subscription, businessDate, formatDateOnly(schedule.nextRenewalDate), false);
    if (eligibility) return eligibility;

    const resultingVersion = subscription.version + 1;
    const reactivation = await tx.subscriptionReactivation.create({
      data: {
        companyId, subscriptionId, reactivatedById: actor.id, reactivatedAt: appliedAt,
        reason: schedule.reason, effectiveDate: parseDateOnly(businessDate), nextRenewalDate: schedule.nextRenewalDate,
        previousNextRenewalDate: subscription.nextRenewalDate, createdAgainstVersion: subscription.version,
        reactivatedSubscriptionVersion: resultingVersion, cancelledByIdSnapshot: subscription.cancelledById!,
        cancelledAtSnapshot: subscription.cancelledAt!, cancellationEffectiveDateSnapshot: subscription.cancellationEffectiveDate!,
        cancellationReasonSnapshot: subscription.cancellationReason!, cancellationModeSnapshot: subscription.cancellationMode!
      }
    });
    const applied = await tx.subscriptionReactivationSchedule.update({
      where: { id: scheduleId },
      data: {
        status: "APPLIED", version: { increment: 1 }, appliedById: actor.id, appliedAt,
        appliedBusinessDate: parseDateOnly(businessDate), appliedAgainstVersion: subscription.version,
        appliedSubscriptionVersion: resultingVersion, reactivationId: reactivation.id
      },
      select: subscriptionReactivationScheduleSelect
    });
    await tx.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: "ACTIVE", nextRenewalDate: schedule.nextRenewalDate, version: { increment: 1 }, updatedById: actor.id,
        cancelledById: null, cancelledAt: null, cancellationEffectiveDate: null, cancellationReason: null, cancellationMode: null
      }
    });
    const value: SubscriptionReactivationScheduleApplyDto = {
      subscriptionVersion: resultingVersion, schedule: mapSubscriptionReactivationSchedule(applied), status: "ACTIVE",
      nextRenewalDate: formatDateOnly(schedule.nextRenewalDate), reactivationId: reactivation.id
    };
    await tx.auditEvent.create({ data: {
      eventType: "SUBSCRIPTION_REACTIVATION_SCHEDULE_APPLIED", actorType: "USER",
      payload: {
        actorUserId: actor.id, requestedByUserId: schedule.requestedById, companyId, subscriptionId,
        number: subscription.number, scheduleId, reactivationId: reactivation.id,
        scheduledEffectiveDate: formatDateOnly(schedule.effectiveDate), appliedBusinessDate: businessDate,
        nextRenewalDate: value.nextRenewalDate, previousVersion: subscription.version,
        subscriptionVersion: resultingVersion, scheduleVersion: applied.version,
        ...(context.correlationId ? { correlationId: context.correlationId } : {})
      }
    } });
    await storeReplay(tx, context, 200, value);
    return { ok: true as const, status: 200 as const, value };
  });
}

export async function processNextDueSubscriptionReactivationSchedule(
  workerId: string,
  retryCount = 0
): Promise<SubscriptionReactivationAutomationResult> {
  const normalizedWorkerId = workerId.trim();
  if (!normalizedWorkerId || normalizedWorkerId.length > 160) {
    throw new Error("SUBSCRIPTION_REACTIVATION_AUTOMATION_WORKER_ID_INVALID");
  }
  const companyId = await currentCompanyId();
  if (!companyId) return { outcome: "IDLE" };

  const candidates = await prisma.$queryRaw<Array<{ id: string; subscriptionId: string }>>(Prisma.sql`
    SELECT schedule."id", schedule."subscriptionId"
    FROM "subscription_reactivation_schedules" schedule
    LEFT JOIN LATERAL (
      SELECT attempt."startedAt"
      FROM "subscription_reactivation_automation_attempts" attempt
      WHERE attempt."scheduleId" = schedule."id"
      ORDER BY attempt."startedAt" DESC, attempt."id" DESC
      LIMIT 1
    ) latest_attempt ON TRUE
    WHERE schedule."companyId" = ${companyId}::uuid
      AND schedule."status" = 'PENDING'
      AND schedule."effectiveDate" <= (clock_timestamp() AT TIME ZONE 'Europe/Madrid')::date
      AND (
        latest_attempt."startedAt" IS NULL
        OR latest_attempt."startedAt" <= clock_timestamp() - INTERVAL '1 hour'
      )
    ORDER BY latest_attempt."startedAt" ASC NULLS FIRST, schedule."effectiveDate", schedule."id"
    LIMIT 1
  `);
  const candidate = candidates[0];
  if (!candidate) return { outcome: "IDLE" };

  try {
    return await prisma.$transaction(async (tx) => {
    const subscription = await lockSubscription(tx, companyId, candidate.subscriptionId);
    if (!subscription) return { outcome: "SKIPPED", scheduleId: candidate.id };
    await lockSchedule(tx, companyId, candidate.subscriptionId, candidate.id);
    const schedule = await tx.subscriptionReactivationSchedule.findFirst({
      where: { id: candidate.id, companyId, subscriptionId: candidate.subscriptionId },
      select: {
        ...subscriptionReactivationScheduleSelect, createdAgainstVersion: true, scheduledSubscriptionVersion: true,
        requestedById: true, cancelledByIdSnapshot: true, cancelledAtSnapshot: true,
        cancellationEffectiveDateSnapshot: true, cancellationReasonSnapshot: true, cancellationModeSnapshot: true
      }
    });
    if (!schedule || schedule.status !== "PENDING") {
      return { outcome: "SKIPPED", scheduleId: candidate.id };
    }

    const startedAt = await databaseClock(tx);
    const latestAttempt = await tx.subscriptionReactivationAutomationAttempt.findFirst({
      where: { scheduleId: schedule.id },
      orderBy: [{ attemptNumber: "desc" }],
      select: { attemptNumber: true, stableCode: true }
    });
    const attemptNumber = (latestAttempt?.attemptNumber ?? 0) + 1;
    const requesterHasSchedulingPermission = await tx.user.count({
      where: {
        id: schedule.requestedById,
        status: "ACTIVE",
        role: {
          permissions: {
            some: { permission: { code: "Subscriptions.ScheduleReactivations" } }
          }
        }
      }
    }) > 0;
    const requesterHasViewPermission = await tx.rolePermission.count({
      where: {
        role: { users: { some: { id: schedule.requestedById, status: "ACTIVE" } } },
        permission: { code: "Subscriptions.View" }
      }
    }) > 0;
    const requesterAuthorized = requesterHasSchedulingPermission && requesterHasViewPermission;

    const block = async (stableCode: string): Promise<SubscriptionReactivationAutomationResult> => {
      const completedAt = await databaseClock(tx);
      await tx.subscriptionReactivationAutomationAttempt.create({
        data: {
          companyId, subscriptionId: subscription.id, scheduleId: schedule.id, attemptNumber,
          workerId: normalizedWorkerId, startedAt, completedAt, outcome: "BLOCKED", stableCode
        }
      });
      if (latestAttempt?.stableCode !== stableCode) {
        await tx.auditEvent.create({ data: {
          eventType: "SUBSCRIPTION_REACTIVATION_AUTOMATION_BLOCKED", actorType: "SYSTEM",
          payload: {
            companyId, subscriptionId: subscription.id, number: subscription.number, scheduleId: schedule.id,
            requestedByUserId: schedule.requestedById, stableCode, attemptNumber, workerId: normalizedWorkerId
          }
        } });
      }
      return { outcome: "BLOCKED", scheduleId: schedule.id, subscriptionId: subscription.id, stableCode };
    };

    if (!requesterAuthorized) return block("SUBSCRIPTION_REACTIVATION_SCHEDULE_REQUESTER_NOT_AUTHORIZED");
    if (schedule.scheduledSubscriptionVersion !== subscription.version
      || subscription.status !== "CANCELLED"
      || !hasCancellationEvidence(subscription)
      || !matchesCancellationSnapshot(subscription, schedule)) {
      return block("SUBSCRIPTION_REACTIVATION_SCHEDULE_STALE");
    }

    const businessDate = madridDateOnly(startedAt);
    if (formatDateOnly(schedule.effectiveDate) > businessDate) {
      return { outcome: "SKIPPED", scheduleId: schedule.id };
    }
    await lockEligibilityRows(tx, companyId, subscription);
    const eligibility = await validateEligibility(
      tx,
      companyId,
      subscription,
      businessDate,
      formatDateOnly(schedule.nextRenewalDate),
      false
    );
    if (eligibility) return block(eligibility.error.code);

    const resultingVersion = subscription.version + 1;
    const reactivation = await tx.subscriptionReactivation.create({
      data: {
        companyId, subscriptionId: subscription.id, reactivatedById: schedule.requestedById, reactivatedAt: startedAt,
        reason: schedule.reason, effectiveDate: parseDateOnly(businessDate), nextRenewalDate: schedule.nextRenewalDate,
        previousNextRenewalDate: subscription.nextRenewalDate, createdAgainstVersion: subscription.version,
        reactivatedSubscriptionVersion: resultingVersion, cancelledByIdSnapshot: subscription.cancelledById!,
        cancelledAtSnapshot: subscription.cancelledAt!, cancellationEffectiveDateSnapshot: subscription.cancellationEffectiveDate!,
        cancellationReasonSnapshot: subscription.cancellationReason!, cancellationModeSnapshot: subscription.cancellationMode!
      }
    });
    const applied = await tx.subscriptionReactivationSchedule.update({
      where: { id: schedule.id },
      data: {
        status: "APPLIED", version: { increment: 1 }, appliedById: schedule.requestedById, appliedAt: startedAt,
        appliedBusinessDate: parseDateOnly(businessDate), appliedAgainstVersion: subscription.version,
        appliedSubscriptionVersion: resultingVersion, reactivationId: reactivation.id
      },
      select: { version: true }
    });
    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: "ACTIVE", nextRenewalDate: schedule.nextRenewalDate, version: { increment: 1 }, updatedById: schedule.requestedById,
        cancelledById: null, cancelledAt: null, cancellationEffectiveDate: null, cancellationReason: null, cancellationMode: null
      }
    });
    const completedAt = await databaseClock(tx);
    await tx.subscriptionReactivationAutomationAttempt.create({
      data: {
        companyId, subscriptionId: subscription.id, scheduleId: schedule.id, attemptNumber,
        workerId: normalizedWorkerId, startedAt, completedAt, outcome: "APPLIED", stableCode: null
      }
    });
    await tx.auditEvent.create({ data: {
      eventType: "SUBSCRIPTION_REACTIVATION_SCHEDULE_APPLIED", actorType: "SYSTEM",
      payload: {
        companyId, subscriptionId: subscription.id, number: subscription.number, scheduleId: schedule.id,
        reactivationId: reactivation.id, requestedByUserId: schedule.requestedById,
        scheduledEffectiveDate: formatDateOnly(schedule.effectiveDate), appliedBusinessDate: businessDate,
        nextRenewalDate: formatDateOnly(schedule.nextRenewalDate), previousVersion: subscription.version,
        subscriptionVersion: resultingVersion, scheduleVersion: applied.version,
        attemptNumber, workerId: normalizedWorkerId
      }
    } });
    return { outcome: "APPLIED", scheduleId: schedule.id, subscriptionId: subscription.id, reactivationId: reactivation.id };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (isRetryableTransactionError(error) && retryCount < 2) {
      return processNextDueSubscriptionReactivationSchedule(normalizedWorkerId, retryCount + 1);
    }
    throw error;
  }
}

type LockedSubscription = NonNullable<Awaited<ReturnType<typeof lockSubscription>>>;

async function lockSubscription(tx: Prisma.TransactionClient, companyId: string, subscriptionId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscriptionId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`);
  return tx.subscription.findFirst({
    where: { id: subscriptionId, companyId },
    select: {
      id: true, number: true, customerId: true, status: true, version: true, pricingMode: true,
      nextRenewalDate: true, endDate: true, cancelledById: true, cancelledAt: true,
      cancellationEffectiveDate: true, cancellationReason: true, cancellationMode: true,
      lines: { select: { catalogItemId: true, quantity: true } }
    }
  });
}

async function lockSchedules(tx: Prisma.TransactionClient, companyId: string, subscriptionId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscription_reactivation_schedules" WHERE "companyId" = ${companyId}::uuid AND "subscriptionId" = ${subscriptionId}::uuid ORDER BY "id" FOR UPDATE`);
}

async function lockSchedule(tx: Prisma.TransactionClient, companyId: string, subscriptionId: string, scheduleId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscription_reactivation_schedules" WHERE "id" = ${scheduleId}::uuid AND "companyId" = ${companyId}::uuid AND "subscriptionId" = ${subscriptionId}::uuid FOR UPDATE`);
}

async function lockEligibilityRows(tx: Prisma.TransactionClient, companyId: string, subscription: LockedSubscription): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscription_cancellation_schedules" WHERE "companyId" = ${companyId}::uuid AND "subscriptionId" = ${subscription.id}::uuid ORDER BY "id" FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "customers" WHERE "id" = ${subscription.customerId}::uuid FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscription_renewal_reservations" WHERE "companyId" = ${companyId}::uuid AND "subscriptionId" = ${subscription.id}::uuid ORDER BY "id" FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscription_renewal_exclusions" WHERE "companyId" = ${companyId}::uuid AND "subscriptionId" = ${subscription.id}::uuid ORDER BY "id" FOR UPDATE`);
}

async function readLockedCustomerStatus(tx: Prisma.TransactionClient, customerId: string): Promise<"ACTIVE" | "INACTIVE" | null> {
  const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { status: true } });
  return customer?.status ?? null;
}

async function validateEligibility(
  tx: Prisma.TransactionClient,
  companyId: string,
  subscription: LockedSubscription,
  effectiveDateText: string,
  nextRenewalDateText: string,
  requireFutureEffectiveDate: boolean
): Promise<ScheduleFailure | null> {
  const businessDate = madridDateOnly(await databaseClock(tx));
  if (requireFutureEffectiveDate && effectiveDateText <= businessDate) {
    return failure(422, "SUBSCRIPTION_REACTIVATION_SCHEDULE_DATE_NOT_FUTURE", "La fecha efectiva debe ser posterior a la fecha de negocio actual.");
  }
  if (nextRenewalDateText < effectiveDateText || !subscription.cancellationEffectiveDate || nextRenewalDateText <= formatDateOnly(subscription.cancellationEffectiveDate)) {
    return failure(422, "SUBSCRIPTION_REACTIVATION_SCHEDULE_NEXT_RENEWAL_DATE_INVALID", "La proxima renovacion no es valida para esta reactivacion.");
  }
  if (!requireFutureEffectiveDate && nextRenewalDateText < businessDate) {
    return failure(422, "SUBSCRIPTION_REACTIVATION_SCHEDULE_RENEWAL_DATE_PASSED", "La proxima renovacion ha quedado atrasada; retire y reprograme la reactivacion.");
  }
  const nextRenewalDate = parseDateOnly(nextRenewalDateText);
  if (subscription.endDate && nextRenewalDate > subscription.endDate) {
    return failure(422, "SUBSCRIPTION_REACTIVATION_SCHEDULE_AFTER_END", "La proxima renovacion no puede ser posterior a la fecha final del contrato.");
  }
  if (await readLockedCustomerStatus(tx, subscription.customerId) !== "ACTIVE") {
    return failure(422, "CUSTOMER_NOT_ACTIVE", "El cliente debe estar activo.");
  }
  if (await tx.subscriptionCancellationSchedule.count({ where: { companyId, subscriptionId: subscription.id, status: "PENDING" } })) {
    return failure(409, "SUBSCRIPTION_PENDING_CANCELLATION_EXISTS", "La baja programada pendiente debe resolverse antes de continuar.");
  }
  if (subscription.lines.length === 0 || new Set(subscription.lines.map((line) => line.catalogItemId)).size !== subscription.lines.length
    || (subscription.pricingMode === "FIXED" && subscription.lines.some((line) => !line.quantity.equals(1)))) {
    return failure(422, "SUBSCRIPTION_CONFIGURATION_INVALID", "La configuracion economica de la suscripcion no es valida.");
  }
  if (await tx.subscriptionRenewalReservation.count({ where: { companyId, subscriptionId: subscription.id, status: "RESERVED" } })) {
    return failure(409, "SUBSCRIPTION_RENEWAL_RESERVED", "La renovacion esta reservada; debe liberarse antes de continuar.");
  }
  if (await tx.subscriptionRenewalExclusion.count({ where: { companyId, subscriptionId: subscription.id, status: "OPEN" } })) {
    return failure(409, "SUBSCRIPTION_RENEWAL_EXCLUSION_OPEN", "La renovacion pendiente debe resolverse antes de continuar.");
  }
  const latestBilled = await tx.subscriptionRenewalReservation.findFirst({
    where: { companyId, subscriptionId: subscription.id, status: "BILLED" },
    orderBy: [{ periodEndExclusive: "desc" }, { id: "desc" }], select: { periodEndExclusive: true }
  });
  if (latestBilled && nextRenewalDate < latestBilled.periodEndExclusive) {
    return failure(422, "SUBSCRIPTION_REACTIVATION_SCHEDULE_PERIOD_OVERLAP", "La proxima renovacion se solapa con un periodo ya facturado.");
  }
  const used = await tx.subscriptionRenewalReservation.count({
    where: { companyId, subscriptionId: subscription.id, periodStart: nextRenewalDate, status: { in: ["RESERVED", "BILLED"] } }
  }) || await tx.subscriptionRenewalExclusion.count({ where: { companyId, subscriptionId: subscription.id, periodStart: nextRenewalDate } });
  return used ? failure(422, "SUBSCRIPTION_REACTIVATION_SCHEDULE_PERIOD_OVERLAP", "La fecha elegida ya pertenece al historial de renovaciones.") : null;
}

function hasCancellationEvidence(subscription: LockedSubscription): boolean {
  return Boolean(subscription.cancelledById && subscription.cancelledAt && subscription.cancellationEffectiveDate
    && subscription.cancellationReason && subscription.cancellationMode);
}

function matchesCancellationSnapshot(subscription: LockedSubscription, schedule: {
  cancelledByIdSnapshot: string; cancelledAtSnapshot: Date; cancellationEffectiveDateSnapshot: Date;
  cancellationReasonSnapshot: string; cancellationModeSnapshot: "IMMEDIATE" | "SCHEDULED";
}): boolean {
  return subscription.cancelledById === schedule.cancelledByIdSnapshot
    && subscription.cancelledAt?.getTime() === schedule.cancelledAtSnapshot.getTime()
    && subscription.cancellationEffectiveDate?.getTime() === schedule.cancellationEffectiveDateSnapshot.getTime()
    && subscription.cancellationReason === schedule.cancellationReasonSnapshot
    && subscription.cancellationMode === schedule.cancellationModeSnapshot;
}

export function mapSubscriptionReactivationSchedule(
  row: Prisma.SubscriptionReactivationScheduleGetPayload<{ select: typeof subscriptionReactivationScheduleSelect }>
): SubscriptionReactivationScheduleDto {
  return {
    id: row.id, status: row.status, effectiveDate: formatDateOnly(row.effectiveDate),
    nextRenewalDate: formatDateOnly(row.nextRenewalDate), previousNextRenewalDate: formatDateOnly(row.previousNextRenewalDate),
    reason: row.reason, version: row.version, requestedAt: row.requestedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null, revocationReason: row.revocationReason,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    appliedBusinessDate: row.appliedBusinessDate ? formatDateOnly(row.appliedBusinessDate) : null,
    reactivationId: row.reactivationId,
    lastAutomationAttempt: row.automationAttempts[0] ? {
      attemptNumber: row.automationAttempts[0].attemptNumber,
      outcome: row.automationAttempts[0].outcome,
      stableCode: row.automationAttempts[0].stableCode,
      startedAt: row.automationAttempts[0].startedAt.toISOString(),
      completedAt: row.automationAttempts[0].completedAt.toISOString()
    } : null
  };
}

async function databaseClock(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT date_trunc('milliseconds', clock_timestamp()) AS "now"`;
  const now = rows[0]?.now;
  if (!now) throw new Error("SUBSCRIPTION_DATABASE_CLOCK_UNAVAILABLE");
  return now;
}

async function currentCompanyId(): Promise<string | null> {
  return (await prisma.installation.findFirst({
    where: { companyId: { not: null } },
    select: { companyId: true }
  }))?.companyId ?? null;
}

async function readReplay<T extends SubscriptionReactivationScheduleMutationDto, S extends 200 | 201>(
  context: MutationContext,
  schema: z.ZodType<T>,
  expectedStatus: S
): Promise<{ ok: true; status: S; value: T } | ScheduleFailure | null> {
  const stored = await prisma.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
  return stored ? parseStoredReplay(stored, context, schema, expectedStatus) : null;
}

async function replayInTransaction<T extends SubscriptionReactivationScheduleMutationDto, S extends 200 | 201>(
  tx: Prisma.TransactionClient,
  context: MutationContext,
  schema: z.ZodType<T>,
  expectedStatus: S
): Promise<{ ok: true; status: S; value: T } | ScheduleFailure | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.idempotencyKey}, 0))`;
  const stored = await tx.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
  return stored ? parseStoredReplay(stored, context, schema, expectedStatus) : null;
}

function parseStoredReplay<T extends SubscriptionReactivationScheduleMutationDto, S extends 200 | 201>(
  stored: { requestHash: string; responseStatus: number; responseBody: unknown },
  context: MutationContext,
  schema: z.ZodType<T>,
  expectedStatus: S
): { ok: true; status: S; value: T } | ScheduleFailure {
  if (stored.requestHash !== context.requestHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
  const parsed = schema.safeParse(stored.responseBody);
  return stored.responseStatus === expectedStatus && parsed.success
    ? { ok: true, status: expectedStatus, value: parsed.data }
    : failure(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es compatible con el contrato actual.");
}

async function storeReplay(
  tx: Prisma.TransactionClient,
  context: MutationContext,
  status: 200 | 201,
  value: SubscriptionReactivationScheduleMutationDto
): Promise<void> {
  await tx.idempotencyRecord.create({ data: {
    key: context.idempotencyKey, requestHash: context.requestHash,
    responseStatus: status, responseBody: value as Prisma.InputJsonValue
  } });
}

async function consumeRateLimit(
  actor: SessionUser,
  companyId: string,
  action: "create" | "revoke" | "apply",
  correlationId?: string
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const key = `subscription-reactivation-schedule-${action}:${companyId}:${actor.id}`;
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
      eventType: "SUBSCRIPTION_REACTIVATION_SCHEDULE_RATE_LIMITED", actorType: "USER",
      payload: { actorUserId: actor.id, companyId, action, ...(correlationId ? { correlationId } : {}) }
    } });
    return count > 10;
  });
}

async function executeMutation<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T | ScheduleFailure> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isRetryableTransactionError(error)) {
        if (attempt < 2) continue;
        return failure(503, "SUBSCRIPTION_REACTIVATION_SCHEDULE_BUSY", "La suscripcion esta ocupada; vuelva a intentarlo.");
      }
      throw error;
    }
  }
  return failure(503, "SUBSCRIPTION_REACTIVATION_SCHEDULE_BUSY", "La suscripcion esta ocupada; vuelva a intentarlo.");
}

function isRetryableTransactionError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001");
}

function failure(status: ScheduleFailure["status"], code: string, message: string): ScheduleFailure {
  return { ok: false, status, error: { code, message } };
}

function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function madridDateOnly(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
