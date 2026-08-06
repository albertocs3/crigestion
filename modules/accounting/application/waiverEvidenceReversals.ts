import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { hashIdempotencyPayload } from "@/modules/platform/application/http";

const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

export const requestWaiverEvidenceReversalSchema = z.object({
  expectedReviewVersion: z.literal(4),
  reasonCode: z.enum(["ACCOUNTING_ERROR", "INCORRECT_CLASSIFICATION", "DUPLICATE_REGULARIZATION", "OTHER"]),
  reasonDetail: z.string().trim().min(10).max(500),
  accountingDate: z.string().regex(dateOnly)
}).strict();

export const approveWaiverEvidenceReversalSchema = z.object({ expectedVersion: z.literal(1) }).strict();
export const rejectWaiverEvidenceReversalSchema = z.object({ expectedVersion: z.literal(1), rejectionDetail: z.string().trim().min(10).max(500) }).strict();
export const cancelWaiverEvidenceReversalSchema = z.object({ expectedVersion: z.literal(1) }).strict();

export type RequestWaiverEvidenceReversalCommand = z.infer<typeof requestWaiverEvidenceReversalSchema>;
export type ApproveWaiverEvidenceReversalCommand = z.infer<typeof approveWaiverEvidenceReversalSchema>;
export type RejectWaiverEvidenceReversalCommand = z.infer<typeof rejectWaiverEvidenceReversalSchema>;
export type CancelWaiverEvidenceReversalCommand = z.infer<typeof cancelWaiverEvidenceReversalSchema>;

export type WaiverEvidenceReversalDto = {
  id: string;
  reviewId: string;
  evidenceId: string;
  targetEntryId: string;
  status: "REQUESTED" | "COMPLETED" | "REJECTED" | "CANCELLED";
  version: number;
  reasonCode: RequestWaiverEvidenceReversalCommand["reasonCode"];
  accountingDate: string;
  requestedById: string;
  requestedAt: string;
  approvedById: string | null;
  approvedAt: string | null;
  reversalEntry: { id: string; number: string } | null;
};

type MutationContext = Pick<RequestContext, "correlationId"> & { idempotencyKey: string; requestHash: string };
type FailureCode = "WAIVER_REVIEW_NOT_FOUND" | "WAIVER_REVIEW_NOT_REVERSIBLE" | "WAIVER_REVERSAL_INDEPENDENCE_REQUIRED"
  | "WAIVER_REVERSAL_FISCAL_YEAR_NOT_OPEN" | "WAIVER_REVERSAL_ACTIVE_REQUEST_EXISTS" | "WAIVER_REVERSAL_REQUEST_NOT_FOUND"
  | "WAIVER_REVERSAL_REQUEST_NOT_PENDING" | "WAIVER_REVERSAL_SELF_APPROVAL_FORBIDDEN" | "WAIVER_REVERSAL_RATE_LIMITED"
  | "WAIVER_REVERSAL_SELF_REJECTION_FORBIDDEN" | "WAIVER_REVERSAL_NOT_CANCELLABLE"
  | "IDEMPOTENCY_KEY_REUSED";
type Result = { ok: true; status: 200 | 201; value: WaiverEvidenceReversalDto }
  | { ok: false; status: 404 | 409 | 429; error: { code: FailureCode; message: string } };

const dtoSchema = z.object({
  id: z.string().uuid(), reviewId: z.string().uuid(), evidenceId: z.string().uuid(), targetEntryId: z.string().uuid(),
  status: z.enum(["REQUESTED", "COMPLETED", "REJECTED", "CANCELLED"]), version: z.number().int(),
  reasonCode: requestWaiverEvidenceReversalSchema.shape.reasonCode, accountingDate: z.string(), requestedById: z.string().uuid(),
  requestedAt: z.string(), approvedById: z.string().uuid().nullable(), approvedAt: z.string().nullable(),
  reversalEntry: z.object({ id: z.string().uuid(), number: z.string() }).nullable()
}).strict();

const requestSelect = {
  id: true, reviewId: true, evidenceId: true, targetEntryId: true, status: true, version: true, reasonCode: true,
  accountingDate: true, requestedById: true, requestedAt: true, approvedById: true, approvedAt: true,
  reversalEntry: { select: { id: true, number: true } }
} satisfies Prisma.AccountingWaiverReversalRequestSelect;

export function hashWaiverEvidenceReversalRequest(reviewId: string, command: RequestWaiverEvidenceReversalCommand): string {
  return hashIdempotencyPayload("accounting-waiver-evidence-reversal-request:v1", { reviewId, ...command });
}

export function hashWaiverEvidenceReversalApproval(requestId: string, command: ApproveWaiverEvidenceReversalCommand): string {
  return hashIdempotencyPayload("accounting-waiver-evidence-reversal-approve:v1", { requestId, ...command });
}

export function hashWaiverEvidenceReversalRejection(requestId: string, command: RejectWaiverEvidenceReversalCommand): string {
  return hashIdempotencyPayload("accounting-waiver-evidence-reversal-reject:v1", { requestId, ...command });
}

export function hashWaiverEvidenceReversalCancellation(requestId: string, command: CancelWaiverEvidenceReversalCommand): string {
  return hashIdempotencyPayload("accounting-waiver-evidence-reversal-cancel:v1", { requestId, ...command });
}

export async function requestWaiverEvidenceReversal(
  reviewId: string, command: RequestWaiverEvidenceReversalCommand, actor: SessionUser, context: MutationContext
): Promise<Result> {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const companyId = await currentCompanyId(tx);
      await beginLocks(tx, companyId, context.idempotencyKey);
      const replay = await replayMutation(tx, context, 201);
      if (replay) return replay;
      if (await consumeRateLimit(tx, companyId, actor.id, "request")) return { kind: "rate-limited" as const };
      await tx.$queryRaw`SELECT "id" FROM "subscription_renewal_waiver_reviews" WHERE "id" = ${reviewId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const review = await tx.subscriptionRenewalWaiverReview.findFirst({
        where: { id: reviewId, companyId },
        select: {
          id: true, status: true, version: true, decision: true, openedById: true, closedById: true,
          evidences: { where: { kind: "ACCOUNTING_JOURNAL_ENTRY" }, take: 1, select: {
            id: true, accountingJournalEntryId: true, accountingJournalEntry: { select: {
              accountingDate: true, fiscalYear: { select: { status: true, startDate: true, endDate: true } }
            } }
          } }
        }
      });
      if (!review) return { kind: "review-not-found" as const };
      const evidence = review.evidences[0];
      if (review.status !== "CLOSED" || review.version !== command.expectedReviewVersion
        || review.decision !== "MANUAL_ACCOUNTING_ACTION_REQUIRED" || !evidence) return { kind: "not-reversible" as const };
      if (actor.id === review.openedById || actor.id === review.closedById) {
        await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REVERSAL_REQUEST_DENIED", actor, context, { companyId, reviewId, denialReason: "INDEPENDENCE_REQUIRED" });
        return { kind: "independence" as const };
      }
      const accountingDate = parseDateOnly(command.accountingDate);
      const fiscal = evidence.accountingJournalEntry.fiscalYear;
      if (fiscal.status !== "OPEN" || accountingDate < evidence.accountingJournalEntry.accountingDate
        || accountingDate < fiscal.startDate || accountingDate > fiscal.endDate) {
        await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REVERSAL_REQUEST_DENIED", actor, context, { companyId, reviewId, denialReason: "FISCAL_YEAR_OR_DATE_INVALID" });
        return { kind: "year-not-open" as const };
      }
      const created = await tx.accountingWaiverReversalRequest.create({ data: {
        companyId, reviewId, evidenceId: evidence.id, targetEntryId: evidence.accountingJournalEntryId,
        reasonCode: command.reasonCode, reasonDetail: command.reasonDetail, accountingDate,
        requestedById: actor.id, targetSnapshot: {}
      }, select: requestSelect });
      await tx.accountingWaiverReversalEvent.create({ data: {
        companyId, requestId: created.id, requestVersion: created.version, type: "REQUESTED", actorId: actor.id,
        occurredAt: created.requestedAt, correlationId: context.correlationId
      } });
      const value = mapDto(created);
      await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REVERSAL_REQUESTED", actor, context, {
        companyId, reversalRequestId: created.id, reviewId, evidenceId: evidence.id,
        targetEntryId: evidence.accountingJournalEntryId, reasonCode: command.reasonCode
      });
      await storeReplay(tx, context, 201, value);
      return { kind: "created" as const, value };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return mapResult(result, 201);
  } catch (error) {
    if (isUniqueConstraintError(error)) return failure(409, "WAIVER_REVERSAL_ACTIVE_REQUEST_EXISTS", "Ya existe una solicitud activa o completada para esta evidencia.");
    throw error;
  }
}

export async function approveWaiverEvidenceReversal(
  requestId: string, command: ApproveWaiverEvidenceReversalCommand, actor: SessionUser, context: MutationContext
): Promise<Result> {
  const result = await prisma.$transaction(async (tx) => {
    const companyId = await currentCompanyId(tx);
    await beginLocks(tx, companyId, context.idempotencyKey);
    const replay = await replayMutation(tx, context, 200);
    if (replay) return replay;
    if (await consumeRateLimit(tx, companyId, actor.id, "approve")) return { kind: "rate-limited" as const };
    await tx.$queryRaw`SELECT "id" FROM "accounting_waiver_reversal_requests" WHERE "id" = ${requestId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT fiscal."id" FROM "accounting_waiver_reversal_requests" request
      JOIN "accounting_journal_entries" target ON target."id" = request."targetEntryId"
      JOIN "accounting_fiscal_years" fiscal ON fiscal."id" = target."fiscalYearId"
      WHERE request."id" = ${requestId}::uuid AND request."companyId" = ${companyId}::uuid FOR UPDATE OF fiscal`;
    const request = await tx.accountingWaiverReversalRequest.findFirst({ where: { id: requestId, companyId }, select: {
      id: true, status: true, version: true, requestedById: true, accountingDate: true,
      review: { select: { openedById: true, closedById: true } },
      targetEntry: { select: { id: true, fiscalYearId: true, year: true, number: true, totalDebit: true, totalCredit: true,
        fiscalYear: { select: { status: true } }, lines: { orderBy: { position: "asc" }, select: {
          accountId: true, position: true, concept: true, debit: true, credit: true
        } }
      } }
    } });
    if (!request) return { kind: "request-not-found" as const };
    if (request.status !== "REQUESTED" || request.version !== command.expectedVersion) return { kind: "request-not-pending" as const };
    if ([request.requestedById, request.review.openedById, request.review.closedById].includes(actor.id)) {
      await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REVERSAL_APPROVAL_DENIED", actor, context, {
        companyId, reversalRequestId: request.id, denialReason: "INDEPENDENCE_REQUIRED"
      });
      return { kind: "self-approval" as const };
    }
    if (request.targetEntry.fiscalYear.status !== "OPEN") {
      await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REVERSAL_APPROVAL_DENIED", actor, context, { companyId, reversalRequestId: request.id, denialReason: "FISCAL_YEAR_NOT_OPEN" });
      return { kind: "year-not-open" as const };
    }
    const last = await tx.accountingJournalEntry.findFirst({ where: { fiscalYearId: request.targetEntry.fiscalYearId }, orderBy: { sequence: "desc" }, select: { sequence: true } });
    const sequence = (last?.sequence ?? 0) + 1;
    const reversal = await tx.accountingJournalEntry.create({ data: {
      fiscalYearId: request.targetEntry.fiscalYearId, reversesEntryId: request.targetEntry.id,
      waiverReversalRequestId: request.id, year: request.targetEntry.year, sequence,
      number: `${request.targetEntry.year}/${sequence.toString().padStart(6, "0")}`,
      accountingDate: request.accountingDate, concept: `Reversión controlada ${request.targetEntry.number}`,
      origin: "WAIVER_REGULARIZATION_REVERSAL", totalDebit: request.targetEntry.totalCredit,
      totalCredit: request.targetEntry.totalDebit, createdById: actor.id,
      lines: { create: request.targetEntry.lines.map((line) => ({
        accountId: line.accountId, position: line.position, concept: line.concept, debit: line.credit, credit: line.debit
      })) }
    }, select: { id: true, number: true } });
    const approvedAt = new Date();
    const completed = await tx.accountingWaiverReversalRequest.update({ where: { id: request.id }, data: {
      status: "COMPLETED", version: 2, approvedById: actor.id, approvedAt
    }, select: requestSelect });
    await tx.accountingWaiverReversalEvent.create({ data: {
      companyId, requestId: request.id, requestVersion: 2, type: "COMPLETED", actorId: actor.id,
      occurredAt: completed.approvedAt!, correlationId: context.correlationId
    } });
    const value = mapDto(completed);
    await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REVERSED", actor, context, {
      companyId, reversalRequestId: request.id, requestedByUserId: request.requestedById,
      targetEntryId: request.targetEntry.id, reversalEntryId: reversal.id
    });
    await storeReplay(tx, context, 200, value);
    return { kind: "completed" as const, value };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return mapResult(result, 200);
}

export async function rejectWaiverEvidenceReversal(
  requestId: string, command: RejectWaiverEvidenceReversalCommand, actor: SessionUser, context: MutationContext
): Promise<Result> {
  return finishWithoutEntry(requestId, command.expectedVersion, "REJECTED", actor, context, command.rejectionDetail);
}

export async function cancelWaiverEvidenceReversal(
  requestId: string, command: CancelWaiverEvidenceReversalCommand, actor: SessionUser, context: MutationContext
): Promise<Result> {
  return finishWithoutEntry(requestId, command.expectedVersion, "CANCELLED", actor, context);
}

async function finishWithoutEntry(
  requestId: string, expectedVersion: 1, terminal: "REJECTED" | "CANCELLED", actor: SessionUser,
  context: MutationContext, rejectionDetail?: string
): Promise<Result> {
  const result = await prisma.$transaction(async (tx) => {
    const companyId = await currentCompanyId(tx);
    await beginLocks(tx, companyId, context.idempotencyKey);
    const replay = await replayMutation(tx, context, 200);
    if (replay) return replay;
    if (await consumeRateLimit(tx, companyId, actor.id, terminal.toLowerCase())) return { kind: "rate-limited" as const };
    await tx.$queryRaw`SELECT "id" FROM "accounting_waiver_reversal_requests" WHERE "id" = ${requestId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
    const request = await tx.accountingWaiverReversalRequest.findFirst({
      where: { id: requestId, companyId }, select: { id: true, status: true, version: true, requestedById: true }
    });
    if (!request) return { kind: "request-not-found" as const };
    if (request.status !== "REQUESTED" || request.version !== expectedVersion) return { kind: "request-not-pending" as const };
    if (terminal === "REJECTED" && request.requestedById === actor.id) {
      await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REVERSAL_REJECTION_DENIED", actor, context, { companyId, reversalRequestId: request.id, denialReason: "SELF_REJECTION" });
      return { kind: "self-rejection" as const };
    }
    if (terminal === "CANCELLED" && request.requestedById !== actor.id) {
      await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REVERSAL_CANCELLATION_DENIED", actor, context, { companyId, reversalRequestId: request.id, denialReason: "NOT_REQUESTER" });
      return { kind: "not-cancellable" as const };
    }
    const occurredAt = new Date();
    const updated = await tx.accountingWaiverReversalRequest.update({ where: { id: request.id }, data: terminal === "REJECTED"
      ? { status: terminal, version: 2, rejectedById: actor.id, rejectedAt: occurredAt, rejectionDetail }
      : { status: terminal, version: 2, cancelledById: actor.id, cancelledAt: occurredAt }, select: requestSelect });
    const actualAt = terminal === "REJECTED"
      ? await tx.accountingWaiverReversalRequest.findUniqueOrThrow({ where: { id: request.id }, select: { rejectedAt: true } }).then((row) => row.rejectedAt!)
      : await tx.accountingWaiverReversalRequest.findUniqueOrThrow({ where: { id: request.id }, select: { cancelledAt: true } }).then((row) => row.cancelledAt!);
    await tx.accountingWaiverReversalEvent.create({ data: {
      companyId, requestId: request.id, requestVersion: 2, type: terminal, actorId: actor.id,
      occurredAt: actualAt, correlationId: context.correlationId
    } });
    const value = mapDto(updated);
    await audit(tx, `ACCOUNTING_WAIVER_EVIDENCE_REVERSAL_${terminal}`, actor, context, {
      companyId, reversalRequestId: request.id, requestedByUserId: request.requestedById
    });
    await storeReplay(tx, context, 200, value);
    return { kind: "completed" as const, value };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return mapResult(result, 200);
}

function mapDto(record: Prisma.AccountingWaiverReversalRequestGetPayload<{ select: typeof requestSelect }>): WaiverEvidenceReversalDto {
  return { ...record, accountingDate: formatDateOnly(record.accountingDate), requestedAt: record.requestedAt.toISOString(),
    approvedAt: record.approvedAt?.toISOString() ?? null };
}

function mapResult(result: { kind: string; value?: WaiverEvidenceReversalDto }, successStatus: 200 | 201): Result {
  if ((result.kind === "created" || result.kind === "completed" || result.kind === "replayed") && result.value) return { ok: true, status: successStatus, value: result.value };
  if (result.kind === "review-not-found" || result.kind === "request-not-found") return failure(404,
    result.kind === "review-not-found" ? "WAIVER_REVIEW_NOT_FOUND" : "WAIVER_REVERSAL_REQUEST_NOT_FOUND", "No se encontró el recurso solicitado.");
  const failures: Record<string, [FailureCode, string]> = {
    "not-reversible": ["WAIVER_REVIEW_NOT_REVERSIBLE", "La revisión no dispone de evidencia contable reversible."],
    independence: ["WAIVER_REVERSAL_INDEPENDENCE_REQUIRED", "La solicitud requiere un actor independiente."],
    "year-not-open": ["WAIVER_REVERSAL_FISCAL_YEAR_NOT_OPEN", "El ejercicio de la evidencia debe estar abierto."],
    "request-not-pending": ["WAIVER_REVERSAL_REQUEST_NOT_PENDING", "La solicitud ya no está pendiente o su versión cambió."],
    "self-approval": ["WAIVER_REVERSAL_SELF_APPROVAL_FORBIDDEN", "La aprobación requiere un actor independiente."],
    "self-rejection": ["WAIVER_REVERSAL_SELF_REJECTION_FORBIDDEN", "El solicitante no puede rechazar su propia solicitud."],
    "not-cancellable": ["WAIVER_REVERSAL_NOT_CANCELLABLE", "Solo el solicitante puede cancelar una solicitud pendiente."],
    "rate-limited": ["WAIVER_REVERSAL_RATE_LIMITED", "Demasiados intentos; inténtelo de nuevo más tarde."],
    "idempotency-conflict": ["IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se utilizó con otra petición."]
  };
  const [code, message] = failures[result.kind] ?? ["WAIVER_REVIEW_NOT_REVERSIBLE", "La operación no pudo completarse."];
  return failure(result.kind === "rate-limited" ? 429 : 409, code, message);
}

async function currentCompanyId(tx: Prisma.TransactionClient): Promise<string> {
  const installation = await tx.installation.findFirstOrThrow({ where: { status: "INITIALIZED" }, select: { companyId: true } });
  if (!installation.companyId) throw new Error("Initialized installation without company.");
  return installation.companyId;
}

async function beginLocks(tx: Prisma.TransactionClient, companyId: string, idempotencyKey: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`accounting-fiscal-cycle:${companyId}`}, 0))`;
}

async function consumeRateLimit(tx: Prisma.TransactionClient, companyId: string, actorId: string, action: string): Promise<boolean> {
  const key = `accounting-waiver-evidence-reversal:${action}:${companyId}:${actorId}`;
  const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), ${key}, clock_timestamp(), 1, clock_timestamp(), clock_timestamp())
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '15 minutes' THEN 1 ELSE LEAST("rate_limit_buckets"."count" + 1, 12) END,
      "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '15 minutes' THEN clock_timestamp() ELSE "rate_limit_buckets"."windowStart" END,
      "updatedAt" = clock_timestamp() RETURNING "count"`);
  return (rows[0]?.count ?? 0) > 10;
}

async function replayMutation(tx: Prisma.TransactionClient, context: MutationContext, expectedStatus: 200 | 201) {
  const stored = await tx.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
  if (!stored) return null;
  const parsed = dtoSchema.safeParse(stored.responseBody);
  if (stored.requestHash !== context.requestHash || stored.responseStatus !== expectedStatus || !parsed.success) return { kind: "idempotency-conflict" as const };
  return { kind: "replayed" as const, value: parsed.data };
}

async function storeReplay(tx: Prisma.TransactionClient, context: MutationContext, status: 200 | 201, value: WaiverEvidenceReversalDto) {
  await tx.idempotencyRecord.create({ data: { key: context.idempotencyKey, requestHash: context.requestHash, responseStatus: status, responseBody: value } });
}

async function audit(tx: Prisma.TransactionClient, eventType: string, actor: SessionUser, context: Pick<RequestContext, "correlationId">, payload: Record<string, unknown>) {
  await tx.auditEvent.create({ data: { eventType, actorType: "USER", payload: {
    actorUserId: actor.id, ...payload, ...(context.correlationId ? { correlationId: context.correlationId } : {})
  } as Prisma.InputJsonValue } });
}

function isUniqueConstraintError(error: unknown): boolean { return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"; }
function parseDateOnly(value: string): Date { return new Date(`${value}T00:00:00.000Z`); }
function formatDateOnly(value: Date): string { return value.toISOString().slice(0, 10); }
function failure(status: 404 | 409 | 429, code: FailureCode, message: string): Result { return { ok: false, status, error: { code, message } }; }
