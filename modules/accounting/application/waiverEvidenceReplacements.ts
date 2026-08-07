import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { hashIdempotencyPayload } from "@/modules/platform/application/http";

const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const money = z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/).default("0.00");
const proposalLine = z.object({
  accountId: z.string().uuid(), concept: z.string().trim().min(1).max(240), debit: money, credit: money
}).strict();

export const requestWaiverEvidenceReplacementSchema = z.object({
  expectedReviewVersion: z.literal(4),
  reasonCode: z.enum(["CORRECTED_CLASSIFICATION", "CORRECTED_AMOUNT", "CORRECTED_DATE", "OTHER"]),
  reasonDetail: z.string().trim().min(10).max(500),
  accountingDate: z.string().trim().regex(dateOnly).refine(isValidDateOnly, "La fecha no es válida."),
  concept: z.string().trim().min(2).max(240),
  lines: z.array(proposalLine).min(2).max(200)
}).strict();
export const approveWaiverEvidenceReplacementSchema = z.object({
  expectedVersion: z.literal(1), expectedProposalDigest: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export const rejectWaiverEvidenceReplacementSchema = z.object({ expectedVersion: z.literal(1), rejectionDetail: z.string().trim().min(10).max(500) }).strict();
export const cancelWaiverEvidenceReplacementSchema = z.object({ expectedVersion: z.literal(1) }).strict();

export type RequestWaiverEvidenceReplacementCommand = z.infer<typeof requestWaiverEvidenceReplacementSchema>;
export type ApproveWaiverEvidenceReplacementCommand = z.infer<typeof approveWaiverEvidenceReplacementSchema>;
export type RejectWaiverEvidenceReplacementCommand = z.infer<typeof rejectWaiverEvidenceReplacementSchema>;
export type CancelWaiverEvidenceReplacementCommand = z.infer<typeof cancelWaiverEvidenceReplacementSchema>;

export type WaiverEvidenceReplacementDto = {
  id: string; reviewId: string; sourceEvidenceId: string; reversalRequestId: string;
  status: "REQUESTED" | "COMPLETED" | "REJECTED" | "CANCELLED"; version: number;
  reasonCode: RequestWaiverEvidenceReplacementCommand["reasonCode"]; accountingDate: string;
  requestedById: string; requestedAt: string; approvedById: string | null; approvedAt: string | null;
  replacementEntry: { id: string; number: string } | null;
  resultingEvidence: { id: string; sequence: number } | null;
};

export type WaiverEvidenceReplacementDetailDto = {
  id: string; reviewId: string; status: "REQUESTED" | "COMPLETED" | "REJECTED" | "CANCELLED"; version: number;
  reasonCode: RequestWaiverEvidenceReplacementCommand["reasonCode"]; reasonDetail: string;
  accountingDate: string; concept: string; requestedAt: string;
  proposalDigest: string;
  isRequestedByActor: boolean;
  requestedBy: { displayName: string };
  sourceEvidence: {
    sequence: number; entryNumber: string; accountingDate: string; concept: string;
    lines: Array<{ position: number; concept: string; debit: string; credit: string; account: { code: string; name: string } }>;
  };
  reversal: { entryNumber: string; accountingDate: string };
  lines: Array<{ position: number; concept: string; debit: string; credit: string; account: { code: string; name: string } }>;
  eligibility: {
    canApprove: boolean;
    blockers: Array<"REQUEST_NOT_PENDING" | "REQUESTER_CANNOT_APPROVE" | "WAIVER_MAKER_CANNOT_APPROVE"
      | "REVIEW_CLOSER_CANNOT_APPROVE" | "FISCAL_YEAR_NOT_OPEN" | "ACCOUNT_NOT_POSTABLE" | "SOURCE_EVIDENCE_SUPERSEDED">;
  };
};

export type WaiverEvidenceReplacementDetailResult =
  | { ok: true; status: 200; value: WaiverEvidenceReplacementDetailDto }
  | { ok: false; status: 404; error: { code: "WAIVER_REPLACEMENT_REQUEST_NOT_FOUND"; message: string } }
  | { ok: false; status: 429; retryAfterSeconds: number; error: { code: "WAIVER_REPLACEMENT_PROPOSAL_RATE_LIMITED"; message: string } };

export async function prepareWaiverEvidenceReplacement(reviewId: string): Promise<{ reviewId: string; fiscalYear: number } | null> {
  const companyId = await prisma.installation.findFirst({ where: { status: "INITIALIZED" }, select: { companyId: true } }).then((row) => row?.companyId);
  if (!companyId) return null;
  const review = await prisma.subscriptionRenewalWaiverReview.findFirst({ where: {
    id: reviewId, companyId, status: "CLOSED", version: 4, decision: "MANUAL_ACCOUNTING_ACTION_REQUIRED"
  }, select: { id: true, evidences: { where: { kind: "ACCOUNTING_JOURNAL_ENTRY" }, orderBy: [{ sequence: "desc" }, { id: "desc" }], take: 1, select: {
    replacementSourceRequests: { where: { status: { in: ["REQUESTED", "COMPLETED"] } }, take: 1, select: { id: true } },
    reversalRequests: { where: { status: "COMPLETED", reasonCode: { not: "DUPLICATE_REGULARIZATION" } }, take: 1,
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }], select: { reversalEntry: { select: { fiscalYear: { select: { year: true, status: true } } } } } }
  } } } });
  const evidence = review?.evidences[0]; const fiscal = evidence?.reversalRequests[0]?.reversalEntry?.fiscalYear;
  return review && evidence?.replacementSourceRequests.length === 0 && fiscal?.status === "OPEN" ? { reviewId: review.id, fiscalYear: fiscal.year } : null;
}

type MutationContext = Pick<RequestContext, "correlationId"> & { idempotencyKey: string; requestHash: string };
type FailureCode = "WAIVER_REVIEW_NOT_FOUND" | "WAIVER_EVIDENCE_NOT_REPLACEABLE" | "WAIVER_REPLACEMENT_INDEPENDENCE_REQUIRED"
  | "WAIVER_REPLACEMENT_FISCAL_YEAR_NOT_OPEN" | "WAIVER_REPLACEMENT_PROPOSAL_NOT_BALANCED"
  | "WAIVER_REPLACEMENT_ACCOUNT_NOT_POSTABLE" | "WAIVER_REPLACEMENT_ACTIVE_REQUEST_EXISTS"
  | "WAIVER_REPLACEMENT_REQUEST_NOT_FOUND" | "WAIVER_REPLACEMENT_REQUEST_NOT_PENDING"
  | "WAIVER_REPLACEMENT_PROPOSAL_CHANGED"
  | "WAIVER_REPLACEMENT_SELF_APPROVAL_FORBIDDEN" | "WAIVER_REPLACEMENT_SELF_REJECTION_FORBIDDEN"
  | "WAIVER_REPLACEMENT_NOT_CANCELLABLE" | "WAIVER_REPLACEMENT_RATE_LIMITED" | "IDEMPOTENCY_KEY_REUSED"
  | "WAIVER_REPLACEMENT_BUSY";
type Result = { ok: true; status: 200 | 201; value: WaiverEvidenceReplacementDto }
  | { ok: false; status: 404 | 409 | 422 | 429 | 503; error: { code: FailureCode; message: string } };

const requestSelect = {
  id: true, reviewId: true, sourceEvidenceId: true, reversalRequestId: true, status: true, version: true,
  reasonCode: true, accountingDate: true, requestedById: true, requestedAt: true, approvedById: true, approvedAt: true,
  replacementEntry: { select: { id: true, number: true } }, resultingEvidence: { select: { id: true, sequence: true } }
} satisfies Prisma.AccountingWaiverEvidenceReplacementRequestSelect;
const dtoSchema = z.object({
  id: z.string().uuid(), reviewId: z.string().uuid(), sourceEvidenceId: z.string().uuid(), reversalRequestId: z.string().uuid(),
  status: z.enum(["REQUESTED", "COMPLETED", "REJECTED", "CANCELLED"]), version: z.number().int(),
  reasonCode: requestWaiverEvidenceReplacementSchema.shape.reasonCode, accountingDate: z.string(), requestedById: z.string().uuid(),
  requestedAt: z.string(), approvedById: z.string().uuid().nullable(), approvedAt: z.string().nullable(),
  replacementEntry: z.object({ id: z.string().uuid(), number: z.string() }).nullable(),
  resultingEvidence: z.object({ id: z.string().uuid(), sequence: z.number().int().positive() }).nullable()
}).strict();

export function hashWaiverEvidenceReplacementRequest(reviewId: string, command: RequestWaiverEvidenceReplacementCommand): string {
  return hashIdempotencyPayload("accounting-waiver-evidence-replacement-request:v1", { reviewId, ...command });
}
export function hashWaiverEvidenceReplacementApproval(requestId: string, command: ApproveWaiverEvidenceReplacementCommand): string {
  return hashIdempotencyPayload("accounting-waiver-evidence-replacement-approve:v1", { requestId, ...command });
}
export function hashWaiverEvidenceReplacementRejection(requestId: string, command: RejectWaiverEvidenceReplacementCommand): string {
  return hashIdempotencyPayload("accounting-waiver-evidence-replacement-reject:v1", { requestId, ...command });
}
export function hashWaiverEvidenceReplacementCancellation(requestId: string, command: CancelWaiverEvidenceReplacementCommand): string {
  return hashIdempotencyPayload("accounting-waiver-evidence-replacement-cancel:v1", { requestId, ...command });
}

export async function getWaiverEvidenceReplacementDetail(
  requestId: string, actor: SessionUser, context: Pick<RequestContext, "correlationId"> = {}
): Promise<WaiverEvidenceReplacementDetailResult> {
  return prisma.$transaction(async (tx) => {
    const companyId = await currentCompanyId(tx);
    const rateLimit = await consumeDetailReadRateLimit(tx, companyId, actor, context);
    if (rateLimit.limited) return {
      ok: false as const, status: 429 as const,
      retryAfterSeconds: rateLimit.retryAfterSeconds,
      error: { code: "WAIVER_REPLACEMENT_PROPOSAL_RATE_LIMITED" as const, message: "Demasiadas consultas de propuestas; inténtelo de nuevo más tarde." }
    };
    const record = await tx.accountingWaiverEvidenceReplacementRequest.findFirst({ where: { id: requestId, companyId }, select: {
      id: true, reviewId: true, status: true, version: true, reasonCode: true, reasonDetail: true,
      accountingDate: true, concept: true, requestedAt: true, requestedById: true,
      requestedBy: { select: { displayName: true } },
      review: { select: { openedById: true, closedById: true } },
      fiscalYear: { select: { status: true } },
      sourceEvidence: { select: { sequence: true, accountingJournalEntry: { select: {
        number: true, accountingDate: true, concept: true,
        lines: { orderBy: { position: "asc" }, select: { position: true, concept: true, debit: true, credit: true,
          account: { select: { code: true, name: true } } } }
      } },
        supersededByEvidence: { select: { id: true } } } },
      reversalRequest: { select: { reversalEntry: { select: { number: true, accountingDate: true } } } },
      lines: { orderBy: { position: "asc" }, select: { accountId: true, position: true, concept: true, debit: true, credit: true,
        account: { select: { code: true, name: true, status: true, isPostable: true } } } }
    } });
    if (!record?.reversalRequest.reversalEntry) {
      if (await shouldAuditDeniedDetailLookup(tx, companyId, actor)) await audit(
        tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_PROPOSAL_LOOKUP_DENIED", actor, context, {
          companyId, requestIdHash: opaqueLookupHash("proposal-detail", requestId), denialReason: "REQUEST_NOT_FOUND_OR_NOT_VISIBLE"
        }
      );
      return { ok: false as const, status: 404 as const,
        error: { code: "WAIVER_REPLACEMENT_REQUEST_NOT_FOUND" as const, message: "No se encontró la solicitud." } };
    }
    const blockers: WaiverEvidenceReplacementDetailDto["eligibility"]["blockers"] = [];
    if (record.status !== "REQUESTED") blockers.push("REQUEST_NOT_PENDING");
    if (record.requestedById === actor.id) blockers.push("REQUESTER_CANNOT_APPROVE");
    if (record.review.openedById === actor.id) blockers.push("WAIVER_MAKER_CANNOT_APPROVE");
    if (record.review.closedById === actor.id) blockers.push("REVIEW_CLOSER_CANNOT_APPROVE");
    if (record.fiscalYear.status !== "OPEN") blockers.push("FISCAL_YEAR_NOT_OPEN");
    if (record.lines.some((line) => line.account.status !== "ACTIVE" || !line.account.isPostable)) blockers.push("ACCOUNT_NOT_POSTABLE");
    if (record.sourceEvidence.supersededByEvidence) blockers.push("SOURCE_EVIDENCE_SUPERSEDED");
    await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_PROPOSAL_VIEWED", actor, context, {
      companyId, replacementRequestId: record.id, reviewId: record.reviewId,
      status: record.status, version: record.version, lineCount: record.lines.length, canApprove: blockers.length === 0
    });
    return { ok: true as const, status: 200 as const, value: {
      id: record.id, reviewId: record.reviewId, status: record.status, version: record.version,
      reasonCode: record.reasonCode, reasonDetail: record.reasonDetail, accountingDate: formatDateOnly(record.accountingDate),
      concept: record.concept, requestedAt: record.requestedAt.toISOString(),
      proposalDigest: waiverEvidenceReplacementProposalDigest(record), isRequestedByActor: record.requestedById === actor.id,
      requestedBy: record.requestedBy,
      sourceEvidence: {
        sequence: record.sourceEvidence.sequence, entryNumber: record.sourceEvidence.accountingJournalEntry.number,
        accountingDate: formatDateOnly(record.sourceEvidence.accountingJournalEntry.accountingDate),
        concept: record.sourceEvidence.accountingJournalEntry.concept,
        lines: record.sourceEvidence.accountingJournalEntry.lines.map((line) => ({ position: line.position, concept: line.concept,
          debit: line.debit.toFixed(2), credit: line.credit.toFixed(2), account: line.account }))
      },
      reversal: { entryNumber: record.reversalRequest.reversalEntry.number,
        accountingDate: formatDateOnly(record.reversalRequest.reversalEntry.accountingDate) },
      lines: record.lines.map((line) => ({ position: line.position, concept: line.concept,
        debit: line.debit.toFixed(2), credit: line.credit.toFixed(2), account: { code: line.account.code, name: line.account.name } })),
      eligibility: { canApprove: blockers.length === 0, blockers }
    } };
  });
}

export async function requestWaiverEvidenceReplacement(
  reviewId: string, command: RequestWaiverEvidenceReplacementCommand, actor: SessionUser, context: MutationContext
): Promise<Result> {
  try {
    const result = await runWaiverReplacementSerializable(async (tx) => {
      const companyId = await currentCompanyId(tx); await beginLocks(tx, companyId, context.idempotencyKey);
      const replay = await replayMutation(tx, context, 201);
      if (replay?.kind === "idempotency-conflict") await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_REQUEST_DENIED", actor, context, {
        companyId, reviewIdHash: opaqueLookupHash("request-idempotency", reviewId), denialReason: "IDEMPOTENCY_KEY_REUSED"
      });
      if (replay) return replay;
      if (await consumeRateLimit(tx, companyId, actor, "request", context)) return { kind: "rate-limited" as const };
      const normalized = normalizeLines(command.lines);
      if (!normalized) {
        await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_REQUEST_DENIED", actor, context, {
          companyId, reviewIdHash: opaqueLookupHash("unbalanced-proposal", reviewId),
          denialReason: "PROPOSAL_NOT_BALANCED", lineCount: command.lines.length
        });
        return { kind: "proposal-not-balanced" as const };
      }
      await tx.$queryRaw`SELECT "id" FROM "subscription_renewal_waiver_reviews" WHERE "id" = ${reviewId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
      const review = await tx.subscriptionRenewalWaiverReview.findFirst({ where: { id: reviewId, companyId }, select: {
        id: true, status: true, version: true, decision: true, openedById: true, closedById: true,
        evidences: { where: { kind: "ACCOUNTING_JOURNAL_ENTRY" }, orderBy: [{ sequence: "desc" }, { id: "desc" }], take: 1, select: {
          id: true, sequence: true, replacementSourceRequests: { where: { status: { in: ["REQUESTED", "COMPLETED"] } }, take: 1, select: { id: true } },
          reversalRequests: { where: { status: "COMPLETED" }, orderBy: [{ requestedAt: "desc" }, { id: "desc" }], take: 1, select: {
            id: true, reasonCode: true, accountingDate: true, reversalEntry: { select: { fiscalYearId: true,
              fiscalYear: { select: { status: true, startDate: true, endDate: true } } } }
          } }
        } }
      } });
      if (!review) {
        await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_REQUEST_DENIED", actor, context, {
          companyId, reviewIdHash: opaqueLookupHash("waiver-review", reviewId), denialReason: "REVIEW_NOT_FOUND_OR_NOT_VISIBLE"
        });
        return { kind: "review-not-found" as const };
      }
      const source = review.evidences[0]; const reversal = source?.reversalRequests[0];
      if (review.status !== "CLOSED" || review.version !== command.expectedReviewVersion
        || review.decision !== "MANUAL_ACCOUNTING_ACTION_REQUIRED" || !source || !reversal?.reversalEntry
        || reversal.reasonCode === "DUPLICATE_REGULARIZATION" || source.replacementSourceRequests.length > 0) {
        await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_REQUEST_DENIED", actor, context, { companyId, reviewId, denialReason: "NOT_REPLACEABLE" });
        return { kind: "not-replaceable" as const };
      }
      if ([review.openedById, review.closedById].includes(actor.id)) {
        await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_REQUEST_DENIED", actor, context, { companyId, reviewId, denialReason: "INDEPENDENCE_REQUIRED" });
        return { kind: "independence" as const };
      }
      const accountingDate = parseDateOnly(command.accountingDate); const fiscal = reversal.reversalEntry.fiscalYear;
      if (fiscal.status !== "OPEN" || accountingDate < reversal.accountingDate || accountingDate < fiscal.startDate || accountingDate > fiscal.endDate) {
        await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_REQUEST_DENIED", actor, context, { companyId, reviewId, denialReason: "FISCAL_YEAR_OR_DATE_INVALID" });
        return { kind: "year-not-open" as const };
      }
      const accountIds = [...new Set(normalized.lines.map((line) => line.accountId))];
      const accounts = await tx.accountingAccount.count({ where: { id: { in: accountIds }, fiscalYearId: reversal.reversalEntry.fiscalYearId, status: "ACTIVE", isPostable: true } });
      if (accounts !== accountIds.length) {
        await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_REQUEST_DENIED", actor, context, { companyId, reviewId, denialReason: "ACCOUNT_NOT_POSTABLE" });
        return { kind: "account-not-postable" as const };
      }
      const created = await tx.accountingWaiverEvidenceReplacementRequest.create({ data: {
        companyId, reviewId, sourceEvidenceId: source.id, reversalRequestId: reversal.id,
        fiscalYearId: reversal.reversalEntry.fiscalYearId, reasonCode: command.reasonCode, reasonDetail: command.reasonDetail,
        accountingDate, concept: command.concept, requestedById: actor.id,
        proposalSnapshot: { accountingDate: command.accountingDate, concept: command.concept, lineCount: normalized.lines.length, validationVersion: "waiver-replacement-proposal-v1" },
        lines: { create: normalized.lines.map((line) => ({ ...line })) }
      }, select: requestSelect });
      await tx.accountingWaiverEvidenceReplacementEvent.create({ data: {
        companyId, requestId: created.id, requestVersion: 1, type: "REQUESTED", actorId: actor.id,
        occurredAt: created.requestedAt, correlationId: context.correlationId
      } });
      const value = mapDto(created);
      await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_REQUESTED", actor, context, {
        companyId, replacementRequestId: created.id, reviewId, sourceEvidenceId: source.id, reversalRequestId: reversal.id, reasonCode: command.reasonCode
      });
      await storeReplay(tx, context, 201, value); return { kind: "created" as const, value };
    });
    return mapResult(result, 201);
  } catch (error) {
    if (isUniqueConstraintError(error)) return failure(409, "WAIVER_REPLACEMENT_ACTIVE_REQUEST_EXISTS", "Ya existe una sustitución activa o completada para esta evidencia.");
    throw error;
  }
}

export async function approveWaiverEvidenceReplacement(
  requestId: string, command: ApproveWaiverEvidenceReplacementCommand, actor: SessionUser, context: MutationContext
): Promise<Result> {
  const result = await runWaiverReplacementSerializable(async (tx) => {
    const companyId = await currentCompanyId(tx); await beginLocks(tx, companyId, context.idempotencyKey);
    const replay = await replayMutation(tx, context, 200);
    if (replay?.kind === "idempotency-conflict") await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_APPROVAL_DENIED", actor, context, {
      companyId, requestIdHash: opaqueLookupHash("approval-idempotency", requestId), denialReason: "IDEMPOTENCY_KEY_REUSED"
    });
    if (replay) return replay;
    if (await consumeRateLimit(tx, companyId, actor, "approve", context)) return { kind: "rate-limited" as const };
    await tx.$queryRaw`SELECT "id" FROM "accounting_waiver_evidence_replacement_requests" WHERE "id" = ${requestId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
    const request = await tx.accountingWaiverEvidenceReplacementRequest.findFirst({ where: { id: requestId, companyId }, select: {
      id: true, reviewId: true, status: true, version: true, requestedById: true, accountingDate: true, concept: true, fiscalYearId: true,
      fiscalYear: { select: { status: true, year: true } }, review: { select: { openedById: true, closedById: true } },
      sourceEvidence: { select: { id: true, sequence: true, kind: true, supersededByEvidence: { select: { id: true } } } },
      lines: { orderBy: { position: "asc" }, select: { accountId: true, position: true, concept: true, debit: true, credit: true } }
    } });
    if (!request) {
      await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_APPROVAL_DENIED", actor, context, {
        companyId, requestIdHash: opaqueLookupHash("approval", requestId), denialReason: "REQUEST_NOT_FOUND_OR_NOT_VISIBLE"
      });
      return { kind: "request-not-found" as const };
    }
    if (request.status !== "REQUESTED" || request.version !== command.expectedVersion || request.sourceEvidence.supersededByEvidence) {
      await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_APPROVAL_DENIED", actor, context, {
        companyId, replacementRequestId: request.id, denialReason: "REQUEST_NOT_PENDING",
        currentStatus: request.status, currentVersion: request.version, expectedVersion: command.expectedVersion,
        sourceSuperseded: Boolean(request.sourceEvidence.supersededByEvidence)
      });
      return { kind: "request-not-pending" as const };
    }
    if (waiverEvidenceReplacementProposalDigest(request) !== command.expectedProposalDigest) {
      await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_APPROVAL_DENIED", actor, context, {
        companyId, replacementRequestId: request.id, denialReason: "PROPOSAL_DIGEST_MISMATCH"
      });
      return { kind: "proposal-changed" as const };
    }
    if ([request.requestedById, request.review.openedById, request.review.closedById].includes(actor.id)) {
      await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_APPROVAL_DENIED", actor, context, { companyId, replacementRequestId: request.id, denialReason: "INDEPENDENCE_REQUIRED" });
      return { kind: "self-approval" as const };
    }
    if (request.fiscalYear.status !== "OPEN") {
      await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_APPROVAL_DENIED", actor, context, { companyId, replacementRequestId: request.id, denialReason: "FISCAL_YEAR_NOT_OPEN" });
      return { kind: "year-not-open" as const };
    }
    await tx.$queryRaw`SELECT "id" FROM "accounting_fiscal_years" WHERE "id" = ${request.fiscalYearId}::uuid FOR UPDATE`;
    const lockedAccounts = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT account."id" FROM "accounting_waiver_evidence_replacement_lines" line
      JOIN "accounting_accounts" account ON account."id" = line."accountId"
      WHERE line."requestId" = ${request.id}::uuid AND account."fiscalYearId" = ${request.fiscalYearId}::uuid
        AND account."status" = 'ACTIVE' AND account."isPostable" FOR UPDATE OF account
    `);
    if (lockedAccounts.length !== request.lines.length) {
      await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_APPROVAL_DENIED", actor, context, { companyId, replacementRequestId: request.id, denialReason: "ACCOUNT_NOT_POSTABLE" });
      return { kind: "account-not-postable" as const };
    }
    const last = await tx.accountingJournalEntry.findFirst({ where: { fiscalYearId: request.fiscalYearId }, orderBy: { sequence: "desc" }, select: { sequence: true } });
    const sequence = (last?.sequence ?? 0) + 1;
    const totalDebit = request.lines.reduce((sum, line) => sum.plus(line.debit), new Prisma.Decimal(0));
    const totalCredit = request.lines.reduce((sum, line) => sum.plus(line.credit), new Prisma.Decimal(0));
    const entry = await tx.accountingJournalEntry.create({ data: {
      fiscalYearId: request.fiscalYearId, waiverReplacementRequestId: request.id, year: request.fiscalYear.year, sequence,
      number: `${request.fiscalYear.year}/${sequence.toString().padStart(6, "0")}`, accountingDate: request.accountingDate,
      concept: request.concept, origin: "WAIVER_REGULARIZATION_REPLACEMENT", totalDebit, totalCredit, createdById: actor.id,
      lines: { create: request.lines }
    }, select: { id: true, number: true } });
    const evidence = await tx.subscriptionRenewalWaiverReviewEvidence.create({ data: {
      companyId, reviewId: request.reviewId, kind: request.sourceEvidence.kind,
      accountingJournalEntryId: entry.id, evidenceSnapshot: {}, addedById: actor.id,
      correlationId: context.correlationId, sequence: request.sourceEvidence.sequence + 1,
      supersedesEvidenceId: request.sourceEvidence.id, replacementRequestId: request.id
    }, select: { id: true, sequence: true } });
    const completed = await tx.accountingWaiverEvidenceReplacementRequest.update({ where: { id: request.id }, data: {
      status: "COMPLETED", version: 2, approvedById: actor.id, approvedAt: new Date(), replacementSnapshot: {}
    }, select: requestSelect });
    await tx.accountingWaiverEvidenceReplacementEvent.create({ data: {
      companyId, requestId: request.id, requestVersion: 2, type: "COMPLETED", actorId: actor.id,
      occurredAt: completed.approvedAt!, correlationId: context.correlationId
    } });
    const value = mapDto(completed);
    await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACED", actor, context, {
      companyId, replacementRequestId: request.id, requestedByUserId: request.requestedById,
      sourceEvidenceId: request.sourceEvidence.id, replacementEntryId: entry.id, resultingEvidenceId: evidence.id
    });
    await storeReplay(tx, context, 200, value); return { kind: "completed" as const, value };
  });
  return mapResult(result, 200);
}

export async function rejectWaiverEvidenceReplacement(
  requestId: string, command: RejectWaiverEvidenceReplacementCommand, actor: SessionUser, context: MutationContext
): Promise<Result> { return finishWithoutEntry(requestId, command.expectedVersion, "REJECTED", actor, context, command.rejectionDetail); }
export async function cancelWaiverEvidenceReplacement(
  requestId: string, command: CancelWaiverEvidenceReplacementCommand, actor: SessionUser, context: MutationContext
): Promise<Result> { return finishWithoutEntry(requestId, command.expectedVersion, "CANCELLED", actor, context); }

async function finishWithoutEntry(
  requestId: string, expectedVersion: 1, terminal: "REJECTED" | "CANCELLED", actor: SessionUser,
  context: MutationContext, rejectionDetail?: string
): Promise<Result> {
  const result = await runWaiverReplacementSerializable(async (tx) => {
    const companyId = await currentCompanyId(tx); await beginLocks(tx, companyId, context.idempotencyKey);
    const replay = await replayMutation(tx, context, 200);
    const denialEvent = terminal === "REJECTED"
      ? "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_REJECTION_DENIED"
      : "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_CANCELLATION_DENIED";
    if (replay?.kind === "idempotency-conflict") await audit(tx, denialEvent, actor, context, {
      companyId, requestIdHash: opaqueLookupHash(`${terminal.toLowerCase()}-idempotency`, requestId), denialReason: "IDEMPOTENCY_KEY_REUSED"
    });
    if (replay) return replay;
    if (await consumeRateLimit(tx, companyId, actor, terminal.toLowerCase(), context)) return { kind: "rate-limited" as const };
    await tx.$queryRaw`SELECT "id" FROM "accounting_waiver_evidence_replacement_requests" WHERE "id" = ${requestId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
    const request = await tx.accountingWaiverEvidenceReplacementRequest.findFirst({ where: { id: requestId, companyId }, select: { id: true, status: true, version: true, requestedById: true } });
    if (!request) {
      await audit(tx, denialEvent, actor, context, {
        companyId, requestIdHash: opaqueLookupHash(terminal.toLowerCase(), requestId), denialReason: "REQUEST_NOT_FOUND_OR_NOT_VISIBLE"
      });
      return { kind: "request-not-found" as const };
    }
    if (request.status !== "REQUESTED" || request.version !== expectedVersion) {
      await audit(tx, denialEvent, actor, context, {
        companyId, replacementRequestId: request.id, denialReason: "REQUEST_NOT_PENDING",
        currentStatus: request.status, currentVersion: request.version, expectedVersion
      });
      return { kind: "request-not-pending" as const };
    }
    if (terminal === "REJECTED" && request.requestedById === actor.id) {
      await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_REJECTION_DENIED", actor, context, { companyId, replacementRequestId: request.id, denialReason: "SELF_REJECTION" });
      return { kind: "self-rejection" as const };
    }
    if (terminal === "CANCELLED" && request.requestedById !== actor.id) {
      await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_CANCELLATION_DENIED", actor, context, { companyId, replacementRequestId: request.id, denialReason: "NOT_REQUESTER" });
      return { kind: "not-cancellable" as const };
    }
    const updated = await tx.accountingWaiverEvidenceReplacementRequest.update({ where: { id: request.id }, data: terminal === "REJECTED"
      ? { status: terminal, version: 2, rejectedById: actor.id, rejectedAt: new Date(), rejectionDetail }
      : { status: terminal, version: 2, cancelledById: actor.id, cancelledAt: new Date() }, select: requestSelect });
    const occurredAt = terminal === "REJECTED"
      ? (await tx.accountingWaiverEvidenceReplacementRequest.findUniqueOrThrow({ where: { id: request.id }, select: { rejectedAt: true } })).rejectedAt!
      : (await tx.accountingWaiverEvidenceReplacementRequest.findUniqueOrThrow({ where: { id: request.id }, select: { cancelledAt: true } })).cancelledAt!;
    await tx.accountingWaiverEvidenceReplacementEvent.create({ data: { companyId, requestId: request.id, requestVersion: 2,
      type: terminal, actorId: actor.id, occurredAt, correlationId: context.correlationId } });
    const value = mapDto(updated); await audit(tx, `ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_${terminal}`, actor, context, {
      companyId, replacementRequestId: request.id, requestedByUserId: request.requestedById
    });
    await storeReplay(tx, context, 200, value); return { kind: "completed" as const, value };
  });
  return mapResult(result, 200);
}

function normalizeLines(lines: RequestWaiverEvidenceReplacementCommand["lines"]) {
  const normalized = lines.map((line, index) => ({ ...line, position: index + 1, debit: new Prisma.Decimal(line.debit), credit: new Prisma.Decimal(line.credit) }));
  const invalid = normalized.some((line) => line.debit.equals(line.credit) || (line.debit.gt(0) && line.credit.gt(0)));
  const debit = normalized.reduce((sum, line) => sum.plus(line.debit), new Prisma.Decimal(0));
  const credit = normalized.reduce((sum, line) => sum.plus(line.credit), new Prisma.Decimal(0));
  return invalid || debit.lte(0) || !debit.equals(credit) ? null : { lines: normalized, debit, credit };
}
function mapDto(record: Prisma.AccountingWaiverEvidenceReplacementRequestGetPayload<{ select: typeof requestSelect }>): WaiverEvidenceReplacementDto {
  return { ...record, accountingDate: formatDateOnly(record.accountingDate), requestedAt: record.requestedAt.toISOString(), approvedAt: record.approvedAt?.toISOString() ?? null };
}
function mapResult(result: { kind: string; value?: WaiverEvidenceReplacementDto }, successStatus: 200 | 201): Result {
  if ((result.kind === "created" || result.kind === "completed" || result.kind === "replayed") && result.value) return { ok: true, status: successStatus, value: result.value };
  if (result.kind === "review-not-found" || result.kind === "request-not-found") return failure(404,
    result.kind === "review-not-found" ? "WAIVER_REVIEW_NOT_FOUND" : "WAIVER_REPLACEMENT_REQUEST_NOT_FOUND", "No se encontró el recurso solicitado.");
  const failures: Record<string, [FailureCode, string]> = {
    "not-replaceable": ["WAIVER_EVIDENCE_NOT_REPLACEABLE", "La evidencia vigente no admite una sustitución."],
    "proposal-not-balanced": ["WAIVER_REPLACEMENT_PROPOSAL_NOT_BALANCED", "La propuesta debe estar cuadrada y contener debe y haber."],
    independence: ["WAIVER_REPLACEMENT_INDEPENDENCE_REQUIRED", "La solicitud requiere un actor independiente."],
    "year-not-open": ["WAIVER_REPLACEMENT_FISCAL_YEAR_NOT_OPEN", "El ejercicio contable debe estar abierto."],
    "account-not-postable": ["WAIVER_REPLACEMENT_ACCOUNT_NOT_POSTABLE", "La propuesta contiene cuentas no imputables."],
    "request-not-pending": ["WAIVER_REPLACEMENT_REQUEST_NOT_PENDING", "La solicitud ya no está pendiente o su versión cambió."],
    "proposal-changed": ["WAIVER_REPLACEMENT_PROPOSAL_CHANGED", "La propuesta no coincide con el detalle revisado; vuelva a cargarla."],
    "self-approval": ["WAIVER_REPLACEMENT_SELF_APPROVAL_FORBIDDEN", "La aprobación requiere un actor independiente."],
    "self-rejection": ["WAIVER_REPLACEMENT_SELF_REJECTION_FORBIDDEN", "El solicitante no puede rechazar su solicitud."],
    "not-cancellable": ["WAIVER_REPLACEMENT_NOT_CANCELLABLE", "Solo el solicitante puede cancelar una solicitud pendiente."],
    "rate-limited": ["WAIVER_REPLACEMENT_RATE_LIMITED", "Demasiados intentos; inténtelo de nuevo más tarde."],
    "idempotency-conflict": ["IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se utilizó con otra petición."],
    "transaction-busy": ["WAIVER_REPLACEMENT_BUSY", "La sustitución contable está ocupada; vuelva a intentarlo."]
  };
  const [code, message] = failures[result.kind] ?? ["WAIVER_EVIDENCE_NOT_REPLACEABLE", "La operación no pudo completarse."];
  return failure(result.kind === "proposal-not-balanced" ? 422 : result.kind === "rate-limited" ? 429 : result.kind === "transaction-busy" ? 503 : 409, code, message);
}
async function currentCompanyId(tx: Prisma.TransactionClient): Promise<string> {
  const installation = await tx.installation.findFirstOrThrow({ where: { status: "INITIALIZED" }, select: { companyId: true } });
  if (!installation.companyId) throw new Error("Initialized installation without company."); return installation.companyId;
}
async function beginLocks(tx: Prisma.TransactionClient, companyId: string, idempotencyKey: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`accounting-fiscal-cycle:${companyId}`}, 0))`;
}
async function consumeRateLimit(
  tx: Prisma.TransactionClient, companyId: string, actor: SessionUser, action: string, context: Pick<RequestContext, "correlationId">
): Promise<boolean> {
  const key = `accounting-waiver-evidence-replacement:${action}:${companyId}:${actor.id}`;
  const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), ${key}, clock_timestamp(), 1, clock_timestamp(), clock_timestamp())
    ON CONFLICT ("key") DO UPDATE SET "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '15 minutes' THEN 1 ELSE LEAST("rate_limit_buckets"."count" + 1, 12) END,
      "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '15 minutes' THEN clock_timestamp() ELSE "rate_limit_buckets"."windowStart" END,
      "updatedAt" = clock_timestamp() RETURNING "count"`);
  const count = rows[0]?.count ?? 0;
  if (count === 11) await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_RATE_LIMITED", actor, context, { companyId, action });
  return count > 10;
}
async function consumeDetailReadRateLimit(
  tx: Prisma.TransactionClient, companyId: string, actor: SessionUser, context: Pick<RequestContext, "correlationId">
): Promise<{ limited: boolean; retryAfterSeconds: number }> {
  const key = `accounting-waiver-evidence-replacement:detail:${companyId}:${actor.id}`;
  const rows = await tx.$queryRaw<Array<{ count: number; retryAfterSeconds: number }>>(Prisma.sql`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), ${key}, clock_timestamp(), 1, clock_timestamp(), clock_timestamp())
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '1 minute' THEN 1 ELSE LEAST("rate_limit_buckets"."count" + 1, 32) END,
      "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '1 minute' THEN clock_timestamp() ELSE "rate_limit_buckets"."windowStart" END,
      "updatedAt" = clock_timestamp()
    RETURNING "count", GREATEST(1, CEIL(EXTRACT(EPOCH FROM ("windowStart" + INTERVAL '1 minute' - clock_timestamp())))::integer) AS "retryAfterSeconds"`);
  const count = rows[0]?.count ?? 0;
  if (count === 31) await audit(tx, "ACCOUNTING_WAIVER_EVIDENCE_REPLACEMENT_RATE_LIMITED", actor, context, {
    companyId, action: "detail", limit: 30, windowSeconds: 60
  });
  return { limited: count > 30, retryAfterSeconds: rows[0]?.retryAfterSeconds ?? 60 };
}
async function shouldAuditDeniedDetailLookup(
  tx: Prisma.TransactionClient, companyId: string, actor: SessionUser
): Promise<boolean> {
  const key = `accounting-waiver-evidence-replacement:lookup-audit:${companyId}:${actor.id}`;
  const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), ${key}, clock_timestamp(), 1, clock_timestamp(), clock_timestamp())
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '15 minutes' THEN 1 ELSE LEAST("rate_limit_buckets"."count" + 1, 2) END,
      "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '15 minutes' THEN clock_timestamp() ELSE "rate_limit_buckets"."windowStart" END,
      "updatedAt" = clock_timestamp()
    RETURNING "count"`);
  return rows[0]?.count === 1;
}
async function replayMutation(tx: Prisma.TransactionClient, context: MutationContext, expectedStatus: 200 | 201) {
  const stored = await tx.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } }); if (!stored) return null;
  const parsed = dtoSchema.safeParse(stored.responseBody);
  if (stored.requestHash !== context.requestHash || stored.responseStatus !== expectedStatus || !parsed.success) return { kind: "idempotency-conflict" as const };
  return { kind: "replayed" as const, value: parsed.data };
}
async function storeReplay(tx: Prisma.TransactionClient, context: MutationContext, status: 200 | 201, value: WaiverEvidenceReplacementDto) {
  await tx.idempotencyRecord.create({ data: { key: context.idempotencyKey, requestHash: context.requestHash, responseStatus: status, responseBody: value } });
}
async function audit(tx: Prisma.TransactionClient, eventType: string, actor: SessionUser, context: Pick<RequestContext, "correlationId">, payload: Record<string, unknown>) {
  await tx.auditEvent.create({ data: { eventType, actorType: "USER", payload: { actorUserId: actor.id, ...payload,
    ...(context.correlationId ? { correlationId: context.correlationId } : {}) } as Prisma.InputJsonValue } });
}
export async function runWaiverReplacementSerializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T | { kind: "transaction-busy" }> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isSerializableTransactionConflict(error)) throw error;
      if (attempt === 3) return { kind: "transaction-busy" };
    }
  }
  return { kind: "transaction-busy" };
}
function isSerializableTransactionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001"));
}
function isUniqueConstraintError(error: unknown): boolean { return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"; }
function opaqueLookupHash(scope: string, id: string): string {
  return hashIdempotencyPayload("accounting-waiver-evidence-replacement-lookup:v1", { scope, id });
}
function waiverEvidenceReplacementProposalDigest(record: {
  id: string; version: number; accountingDate: Date; concept: string;
  lines: Array<{ accountId: string; position: number; concept: string; debit: Prisma.Decimal; credit: Prisma.Decimal }>;
}): string {
  return hashIdempotencyPayload("accounting-waiver-evidence-replacement-proposal-digest:v1", {
    requestId: record.id, version: record.version, accountingDate: formatDateOnly(record.accountingDate), concept: record.concept,
    lines: record.lines.map((line) => ({ accountId: line.accountId, position: line.position, concept: line.concept,
      debit: line.debit.toFixed(2), credit: line.credit.toFixed(2) }))
  });
}
function parseDateOnly(value: string): Date { return new Date(`${value}T00:00:00.000Z`); }
function formatDateOnly(value: Date): string { return value.toISOString().slice(0, 10); }
function isValidDateOnly(value: string): boolean {
  const parsed = parseDateOnly(value); return !Number.isNaN(parsed.getTime()) && formatDateOnly(parsed) === value;
}
function failure(status: 404 | 409 | 422 | 429 | 503, code: FailureCode, message: string): Result { return { ok: false, status, error: { code, message } }; }
