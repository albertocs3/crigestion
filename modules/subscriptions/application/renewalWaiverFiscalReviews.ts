import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { hashIdempotencyPayload } from "@/modules/platform/application/http";
import { currentSubscriptionRenewalCompanyId, subscriptionRenewalDateOnlySchema } from "@/modules/subscriptions/application/renewals";

const decisionSchema = z.enum([
  "NO_ADDITIONAL_ACTION",
  "MANUAL_ACCOUNTING_ACTION_REQUIRED",
  "BILLING_REGULARIZATION_REQUIRED",
  "EXTERNAL_FISCAL_ACTION_REQUIRED",
  "EXTERNAL_ADVICE_REQUIRED"
]);

export const startRenewalWaiverFiscalReviewSchema = z.object({ expectedVersion: z.literal(1) }).strict();
export const decideRenewalWaiverFiscalReviewSchema = z.object({
  expectedVersion: z.literal(2),
  decision: decisionSchema,
  detail: z.string().trim().min(10).max(500),
  actionDueDate: subscriptionRenewalDateOnlySchema.optional()
}).strict().superRefine((value, context) => {
  if (value.decision === "NO_ADDITIONAL_ACTION" && value.actionDueDate) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["actionDueDate"], message: "Una revision sin acciones no admite vencimiento." });
  }
  if (value.decision !== "NO_ADDITIONAL_ACTION" && !value.actionDueDate) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["actionDueDate"], message: "La actuacion o escalado requiere vencimiento." });
  }
});
export const completeRenewalWaiverFiscalReviewSchema = z.object({
  expectedVersion: z.literal(3),
  detail: z.string().trim().min(10).max(500)
}).strict();

export type StartRenewalWaiverFiscalReviewCommand = z.infer<typeof startRenewalWaiverFiscalReviewSchema>;
export type DecideRenewalWaiverFiscalReviewCommand = z.infer<typeof decideRenewalWaiverFiscalReviewSchema>;
export type CompleteRenewalWaiverFiscalReviewCommand = z.infer<typeof completeRenewalWaiverFiscalReviewSchema>;
type ReviewContext = Pick<RequestContext, "correlationId"> & { idempotencyKey: string; requestHash: string };

const reviewValueSchema = z.object({
  id: z.string().uuid(), exclusionId: z.string().uuid(),
  status: z.enum(["PENDING", "IN_REVIEW", "ESCALATED", "ACTION_REQUIRED", "CLOSED"]),
  version: z.number().int().positive(),
  openedById: z.string().uuid(), openedAt: z.string().datetime(),
  startedById: z.string().uuid().nullable(), startedAt: z.string().datetime().nullable(),
  decision: decisionSchema.nullable(), actionDueDate: subscriptionRenewalDateOnlySchema.nullable(),
  decidedById: z.string().uuid().nullable(), decidedAt: z.string().datetime().nullable(),
  closedAt: z.string().datetime().nullable()
}).strict();

export type RenewalWaiverFiscalReviewValue = z.infer<typeof reviewValueSchema>;
type Failure = { ok: false; status: 404 | 409 | 422 | 429 | 503; error: { code: string; message: string } };
export type RenewalWaiverFiscalReviewResult = { ok: true; status: 200; value: RenewalWaiverFiscalReviewValue } | Failure;

export function hashStartRenewalWaiverFiscalReview(reviewId: string, command: StartRenewalWaiverFiscalReviewCommand): string {
  return hashIdempotencyPayload("subscription-renewal-waiver-fiscal-review-start:v1", { reviewId, ...command });
}

export function hashDecideRenewalWaiverFiscalReview(reviewId: string, command: DecideRenewalWaiverFiscalReviewCommand): string {
  return hashIdempotencyPayload("subscription-renewal-waiver-fiscal-review-decide:v1", { reviewId, ...command });
}

export function hashCompleteRenewalWaiverFiscalReview(reviewId: string, command: CompleteRenewalWaiverFiscalReviewCommand): string {
  return hashIdempotencyPayload("subscription-renewal-waiver-fiscal-review-complete:v1", { reviewId, ...command });
}

export async function startRenewalWaiverFiscalReview(
  reviewId: string,
  command: StartRenewalWaiverFiscalReviewCommand,
  actor: SessionUser,
  context: ReviewContext
): Promise<RenewalWaiverFiscalReviewResult> {
  return mutateReview(reviewId, "start", command, actor, context);
}

export async function decideRenewalWaiverFiscalReview(
  reviewId: string,
  command: DecideRenewalWaiverFiscalReviewCommand,
  actor: SessionUser,
  context: ReviewContext
): Promise<RenewalWaiverFiscalReviewResult> {
  return mutateReview(reviewId, "decide", command, actor, context);
}

export async function completeRenewalWaiverFiscalReview(
  reviewId: string,
  command: CompleteRenewalWaiverFiscalReviewCommand,
  actor: SessionUser,
  context: ReviewContext
): Promise<RenewalWaiverFiscalReviewResult> {
  return mutateReview(reviewId, "complete", command, actor, context);
}

async function mutateReview(
  reviewId: string,
  action: "start" | "decide" | "complete",
  command: StartRenewalWaiverFiscalReviewCommand | DecideRenewalWaiverFiscalReviewCommand | CompleteRenewalWaiverFiscalReviewCommand,
  actor: SessionUser,
  context: ReviewContext
): Promise<RenewalWaiverFiscalReviewResult> {
  const expectedHash = action === "start"
    ? hashStartRenewalWaiverFiscalReview(reviewId, command as StartRenewalWaiverFiscalReviewCommand)
    : action === "decide"
      ? hashDecideRenewalWaiverFiscalReview(reviewId, command as DecideRenewalWaiverFiscalReviewCommand)
      : hashCompleteRenewalWaiverFiscalReview(reviewId, command as CompleteRenewalWaiverFiscalReviewCommand);
  if (context.requestHash !== expectedHash) return failure(409, "IDEMPOTENCY_REQUEST_HASH_INVALID", "La huella idempotente no corresponde con la peticion.");
  const stored = await prisma.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
  if (stored) return replay(stored, expectedHash);
  const companyId = await currentSubscriptionRenewalCompanyId();
  if (!companyId) return failure(409, "PLATFORM_NOT_INITIALIZED", "La plataforma no esta inicializada.");
  if (await consumeReviewRateLimit(companyId, actor, action, context.correlationId)) {
    return failure(429, "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_REVIEW_RATE_LIMITED", "Demasiadas decisiones de revision. Espere quince minutos.");
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.idempotencyKey}, 0))`;
        const storedInside = await tx.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
        if (storedInside) return replay(storedInside, expectedHash);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'subscription-renewal-waiver-review:' + reviewId}, 0))`;
        await tx.$queryRaw`SELECT "id" FROM "subscription_renewal_waiver_reviews"
          WHERE "id" = ${reviewId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
        const review = await tx.subscriptionRenewalWaiverReview.findFirst({
          where: { id: reviewId, companyId },
          select: { id: true, exclusionId: true, status: true, version: true, openedById: true, openedAt: true, startedById: true, decision: true }
        });
        if (!review) return failure(404, "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_REVIEW_NOT_FOUND", "La revision fiscal no existe.");
        if (review.openedById === actor.id) {
          await safeAudit(tx, "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_REVIEW_DECISION_DENIED", actor, companyId, review, context, { denialReason: "SELF_REVIEW" });
          return failure(409, "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_SELF_REVIEW_FORBIDDEN", "La persona que condono el periodo no puede revisarlo fiscalmente.");
        }
        if (review.version !== command.expectedVersion) return failure(409, "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_REVIEW_VERSION_CONFLICT", "La revision fiscal ha cambiado desde la consulta.");
        const clock = await tx.$queryRaw<Array<{ now: Date; businessDate: Date }>>`SELECT clock_timestamp() AS "now", (clock_timestamp() AT TIME ZONE 'Europe/Madrid')::date AS "businessDate"`;
        const now = clock[0]?.now;
        const businessDate = clock[0]?.businessDate;
        if (!now || !businessDate) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
        let updated;
        if (action === "start") {
          if (review.status !== "PENDING") return failure(409, "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_REVIEW_INVALID_TRANSITION", "La revision ya no esta pendiente de asignacion.");
          updated = await tx.subscriptionRenewalWaiverReview.update({ where: { id: review.id }, data: {
            status: "IN_REVIEW", version: { increment: 1 }, startedById: actor.id, startedAt: now
          }, select: reviewValueSelect });
          await tx.subscriptionRenewalWaiverReviewEvent.create({ data: {
            companyId, reviewId: review.id, type: "STARTED", reviewVersion: 2, actorId: actor.id,
            occurredAt: now, correlationId: context.correlationId
          } });
          await safeAudit(tx, "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_REVIEW_STARTED", actor, companyId, review, context, { reviewVersion: 2 });
        } else if (action === "decide") {
          const decisionCommand = command as DecideRenewalWaiverFiscalReviewCommand;
          if (review.status !== "IN_REVIEW" || review.startedById !== actor.id) {
            return failure(409, "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_REVIEW_NOT_ASSIGNED", "Solo la persona asignada puede decidir esta revision.");
          }
          if (decisionCommand.actionDueDate && parseDateOnly(decisionCommand.actionDueDate) < businessDate) {
            return failure(422, "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_ACTION_DUE_DATE_INVALID", "El vencimiento no puede ser anterior a la fecha de decision.");
          }
          const status = decisionCommand.decision === "NO_ADDITIONAL_ACTION" ? "CLOSED"
            : decisionCommand.decision === "EXTERNAL_ADVICE_REQUIRED" ? "ESCALATED" : "ACTION_REQUIRED";
          updated = await tx.subscriptionRenewalWaiverReview.update({ where: { id: review.id }, data: {
            status, version: { increment: 1 }, decision: decisionCommand.decision,
            decisionDetail: decisionCommand.detail, actionDueDate: decisionCommand.actionDueDate ? parseDateOnly(decisionCommand.actionDueDate) : null,
            decidedById: actor.id, decidedAt: now,
            ...(status === "CLOSED" ? { closedById: actor.id, closedAt: now } : {})
          }, select: reviewValueSelect });
          await tx.subscriptionRenewalWaiverReviewEvent.create({ data: {
            companyId, reviewId: review.id, type: "DECIDED", reviewVersion: 3, actorId: actor.id,
            decision: decisionCommand.decision, occurredAt: now, correlationId: context.correlationId
          } });
          await safeAudit(tx, "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_REVIEW_DECIDED", actor, companyId, review, context, {
            reviewVersion: 3, decision: decisionCommand.decision, status, hasActionDueDate: Boolean(decisionCommand.actionDueDate)
          });
        } else {
          const completionCommand = command as CompleteRenewalWaiverFiscalReviewCommand;
          if (review.status !== "ACTION_REQUIRED" || review.decision !== "MANUAL_ACCOUNTING_ACTION_REQUIRED" || review.startedById !== actor.id) {
            await safeAudit(tx, "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_REVIEW_COMPLETION_DENIED", actor, companyId, review, context, {
              denialReason: review.startedById !== actor.id ? "NOT_ASSIGNED" : "INVALID_STATE"
            });
            return failure(409, "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_REVIEW_NOT_COMPLETABLE", "La revision no admite este cierre contable o no esta asignada al usuario.");
          }
          await tx.$queryRaw`SELECT "id" FROM "accounting_journal_entries" WHERE "waiverReviewId" = ${review.id}::uuid FOR UPDATE`;
          const entry = await tx.accountingJournalEntry.findFirst({ where: {
            waiverReviewId: review.id,
            origin: "WAIVER_REGULARIZATION",
            status: "POSTED",
            fiscalYear: { companyId },
            reversedByEntry: null
          }, select: { id: true, totalDebit: true, totalCredit: true } });
          if (!entry || entry.totalDebit.lte(0) || !entry.totalDebit.equals(entry.totalCredit)) {
            return failure(422, "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_ACCOUNTING_EVIDENCE_INVALID", "El asiento no es una evidencia contable valida para esta revision.");
          }
          await tx.subscriptionRenewalWaiverReviewEvidence.create({ data: {
            companyId, reviewId: review.id, kind: "ACCOUNTING_JOURNAL_ENTRY",
            accountingJournalEntryId: entry.id, evidenceSnapshot: {}, addedById: actor.id,
            correlationId: context.correlationId
          } });
          const completionClock = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
          const completedAt = completionClock[0]?.now;
          if (!completedAt) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
          updated = await tx.subscriptionRenewalWaiverReview.update({ where: { id: review.id }, data: {
            status: "CLOSED", version: { increment: 1 }, completionDetail: completionCommand.detail,
            closedById: actor.id, closedAt: completedAt
          }, select: reviewValueSelect });
          await tx.subscriptionRenewalWaiverReviewEvent.create({ data: {
            companyId, reviewId: review.id, type: "COMPLETED", reviewVersion: 4, actorId: actor.id,
            decision: "MANUAL_ACCOUNTING_ACTION_REQUIRED", occurredAt: completedAt, correlationId: context.correlationId
          } });
          await safeAudit(tx, "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_REVIEW_COMPLETED", actor, companyId, review, context, {
            reviewVersion: 4, decision: review.decision, evidenceKind: "ACCOUNTING_JOURNAL_ENTRY", evidenceCount: 1
          });
        }
        const value = mapReview(updated);
        await tx.idempotencyRecord.create({ data: {
          key: context.idempotencyKey, requestHash: expectedHash, responseStatus: 200,
          responseBody: value as Prisma.InputJsonValue
        } });
        return { ok: true as const, status: 200 as const, value };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isRetryable(error)) {
        if (attempt < 2) continue;
        return failure(503, "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_REVIEW_BUSY", "La revision esta ocupada; vuelva a intentarlo.");
      }
      throw error;
    }
  }
  throw new Error("SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_REVIEW_RETRY_EXHAUSTED");
}

const reviewValueSelect = {
  id: true, exclusionId: true, status: true, version: true, openedById: true, openedAt: true,
  startedById: true, startedAt: true, decision: true, actionDueDate: true,
  decidedById: true, decidedAt: true, closedAt: true
} satisfies Prisma.SubscriptionRenewalWaiverReviewSelect;

function mapReview(review: Prisma.SubscriptionRenewalWaiverReviewGetPayload<{ select: typeof reviewValueSelect }>): RenewalWaiverFiscalReviewValue {
  return {
    id: review.id, exclusionId: review.exclusionId, status: review.status, version: review.version,
    openedById: review.openedById, openedAt: review.openedAt.toISOString(),
    startedById: review.startedById, startedAt: review.startedAt?.toISOString() ?? null,
    decision: review.decision, actionDueDate: review.actionDueDate ? formatDateOnly(review.actionDueDate) : null,
    decidedById: review.decidedById, decidedAt: review.decidedAt?.toISOString() ?? null,
    closedAt: review.closedAt?.toISOString() ?? null
  };
}

function replay(stored: { requestHash: string; responseStatus: number; responseBody: Prisma.JsonValue }, requestHash: string): RenewalWaiverFiscalReviewResult {
  if (stored.requestHash !== requestHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
  const parsed = reviewValueSchema.safeParse(stored.responseBody);
  return parsed.success && stored.responseStatus === 200
    ? { ok: true, status: 200, value: parsed.data }
    : failure(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es valida.");
}

async function safeAudit(
  tx: Prisma.TransactionClient,
  eventType: string,
  actor: SessionUser,
  companyId: string,
  review: { id: string; exclusionId: string; openedById: string },
  context: Pick<RequestContext, "correlationId">,
  extra: Prisma.InputJsonObject
) {
  await tx.auditEvent.create({ data: { eventType, actorType: "USER", payload: {
    actorUserId: actor.id, companyId, reviewId: review.id, exclusionId: review.exclusionId,
    waiverMakerUserId: review.openedById, ...extra,
    ...(context.correlationId ? { correlationId: context.correlationId } : {})
  } } });
}

async function consumeReviewRateLimit(companyId: string, actor: SessionUser, action: string, correlationId?: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const limit = action === "complete" ? 10 : 20;
    const cappedCount = limit + 2;
    const key = `subscription-renewal-waiver-fiscal-review:${companyId}:${actor.id}:${action}`;
    const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${key}, clock_timestamp(), 1, clock_timestamp(), clock_timestamp())
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '15 minutes' THEN 1 ELSE LEAST("rate_limit_buckets"."count" + 1, ${cappedCount}) END,
        "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '15 minutes' THEN clock_timestamp() ELSE "rate_limit_buckets"."windowStart" END,
        "updatedAt" = clock_timestamp()
      RETURNING "count"
    `);
    const count = rows[0]?.count ?? 0;
    if (count === limit + 1) await tx.auditEvent.create({ data: { eventType: "SUBSCRIPTION_RENEWAL_WAIVER_FISCAL_REVIEW_RATE_LIMITED", actorType: "USER", payload: {
      actorUserId: actor.id, companyId, action, ...(correlationId ? { correlationId } : {})
    } } });
    return count > limit;
  });
}

function failure(status: Failure["status"], code: string, message: string): Failure { return { ok: false, status, error: { code, message } }; }
function parseDateOnly(value: string) { return new Date(`${value}T00:00:00.000Z`); }
function formatDateOnly(value: Date) { return value.toISOString().slice(0, 10); }
function isRetryable(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001"));
}
