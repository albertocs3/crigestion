import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { hashIdempotencyPayload } from "@/modules/platform/application/http";

export const requestFiscalYearReopeningSchema = z.object({
  reasonCode: z.enum([
    "CLOSE_ERROR",
    "OMITTED_TRANSACTION",
    "PREMATURE_CLOSE",
    "ACCOUNTING_CORRECTION",
    "OTHER"
  ]),
  reason: z.string().trim().min(10).max(500)
}).strict();

export const rejectFiscalYearReopeningSchema = z.object({
  reason: z.string().trim().min(10).max(500)
}).strict();

export type RequestFiscalYearReopeningCommand = z.infer<typeof requestFiscalYearReopeningSchema>;
export type RejectFiscalYearReopeningCommand = z.infer<typeof rejectFiscalYearReopeningSchema>;

const REOPEN_REQUEST_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export type FiscalYearReopenPreflightReport = {
  sourceClosed: boolean;
  successorOpen: boolean;
  successorLinkValid: boolean;
  automaticEntryEvidenceValid: boolean;
  alreadyReopenedCount: number;
  successorJournalActivityCount: number;
  successorCloseRequestCount: number;
  successorChildFiscalYearCount: number;
  successorUnlinkedAccountCount: number;
  successorPlanMismatchCount: number;
  successorMissingAccountCount: number;
  successorBusinessActivityCount: number;
  ready: boolean;
};

export type FiscalYearReopenRequestDto = {
  id: string;
  closeRequestId: string;
  fiscalYearId: string;
  successorFiscalYearId: string;
  year: number;
  successorYear: number;
  status: "REQUESTED" | "COMPLETED" | "CANCELLED" | "REJECTED" | "EXPIRED";
  reasonCode: RequestFiscalYearReopeningCommand["reasonCode"];
  reason: string;
  requestedById: string;
  requestedByName: string;
  requestedAt: string;
  expiresAt: string;
  approvedById: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  cancelledById: string | null;
  cancelledByName: string | null;
  cancelledAt: string | null;
  rejectedById: string | null;
  rejectedByName: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  expiredAt: string | null;
  regularizationReversalEntryId: string | null;
  closingReversalEntryId: string | null;
  openingReversalEntryId: string | null;
  originalEntries: {
    regularization: { id: string; number: string } | null;
    closing: { id: string; number: string } | null;
    opening: { id: string; number: string } | null;
  };
  reversalEntries: {
    regularization: { id: string; number: string } | null;
    closing: { id: string; number: string } | null;
    opening: { id: string; number: string } | null;
  };
  preflight: FiscalYearReopenPreflightReport;
};

type MutationContext = Pick<RequestContext, "correlationId"> & {
  idempotencyKey: string;
  requestHash: string;
};

type Result =
  | { ok: true; status: 200 | 201; value: FiscalYearReopenRequestDto }
  | {
      ok: false;
      status: 404 | 409;
      error: {
        code:
          | "FISCAL_YEAR_CLOSE_REQUEST_NOT_FOUND"
          | "FISCAL_YEAR_CLOSE_REQUEST_NOT_COMPLETED"
          | "FISCAL_YEAR_CLOSE_ALREADY_REOPENED"
          | "FISCAL_YEAR_REOPEN_ACTIVE_REQUEST_EXISTS"
          | "FISCAL_YEAR_REOPEN_REQUEST_NOT_FOUND"
          | "FISCAL_YEAR_REOPEN_REQUEST_NOT_PENDING"
          | "FISCAL_YEAR_REOPEN_SELF_APPROVAL_FORBIDDEN"
          | "FISCAL_YEAR_REOPEN_SELF_REJECTION_FORBIDDEN"
          | "FISCAL_YEAR_REOPEN_REQUEST_EXPIRED"
          | "FISCAL_YEAR_REOPEN_REQUEST_NOT_CANCELLABLE"
          | "FISCAL_YEAR_REOPEN_PRECONDITIONS_FAILED"
          | "IDEMPOTENCY_KEY_REUSED";
        message: string;
        preflight?: FiscalYearReopenPreflightReport;
      };
    };

const preflightSchema = z.object({
  sourceClosed: z.boolean(),
  successorOpen: z.boolean(),
  successorLinkValid: z.boolean(),
  automaticEntryEvidenceValid: z.boolean(),
  alreadyReopenedCount: z.number().int().nonnegative(),
  successorJournalActivityCount: z.number().int().nonnegative(),
  successorCloseRequestCount: z.number().int().nonnegative(),
  successorChildFiscalYearCount: z.number().int().nonnegative(),
  successorUnlinkedAccountCount: z.number().int().nonnegative(),
  successorPlanMismatchCount: z.number().int().nonnegative(),
  successorMissingAccountCount: z.number().int().nonnegative(),
  successorBusinessActivityCount: z.number().int().nonnegative(),
  ready: z.boolean()
}).strict();

const dtoSchema = z.object({
  id: z.string().uuid(),
  closeRequestId: z.string().uuid(),
  fiscalYearId: z.string().uuid(),
  successorFiscalYearId: z.string().uuid(),
  year: z.number().int(),
  successorYear: z.number().int(),
  status: z.enum(["REQUESTED", "COMPLETED", "CANCELLED", "REJECTED", "EXPIRED"]),
  reasonCode: requestFiscalYearReopeningSchema.shape.reasonCode,
  reason: z.string(),
  requestedById: z.string().uuid(),
  requestedByName: z.string(),
  requestedAt: z.string(),
  expiresAt: z.string(),
  approvedById: z.string().uuid().nullable(),
  approvedByName: z.string().nullable(),
  approvedAt: z.string().nullable(),
  cancelledById: z.string().uuid().nullable(),
  cancelledByName: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  rejectedById: z.string().uuid().nullable(),
  rejectedByName: z.string().nullable(),
  rejectedAt: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  expiredAt: z.string().nullable(),
  regularizationReversalEntryId: z.string().uuid().nullable(),
  closingReversalEntryId: z.string().uuid().nullable(),
  openingReversalEntryId: z.string().uuid().nullable(),
  originalEntries: z.object({
    regularization: z.object({ id: z.string().uuid(), number: z.string() }).nullable(),
    closing: z.object({ id: z.string().uuid(), number: z.string() }).nullable(),
    opening: z.object({ id: z.string().uuid(), number: z.string() }).nullable()
  }).strict(),
  reversalEntries: z.object({
    regularization: z.object({ id: z.string().uuid(), number: z.string() }).nullable(),
    closing: z.object({ id: z.string().uuid(), number: z.string() }).nullable(),
    opening: z.object({ id: z.string().uuid(), number: z.string() }).nullable()
  }).strict(),
  preflight: preflightSchema
}).strict();

const requestSelect = {
  id: true,
  closeRequestId: true,
  fiscalYearId: true,
  successorFiscalYearId: true,
  status: true,
  reasonCode: true,
  reason: true,
  preflightSnapshot: true,
  requestedById: true,
  requestedAt: true,
  expiresAt: true,
  approvedById: true,
  approvedAt: true,
  cancelledById: true,
  cancelledAt: true,
  rejectedById: true,
  rejectedAt: true,
  rejectionReason: true,
  expiredAt: true,
  regularizationReversalEntryId: true,
  closingReversalEntryId: true,
  openingReversalEntryId: true,
  requestedBy: { select: { displayName: true } },
  approvedBy: { select: { displayName: true } },
  cancelledBy: { select: { displayName: true } },
  rejectedBy: { select: { displayName: true } },
  regularizationReversalEntry: { select: { id: true, number: true } },
  closingReversalEntry: { select: { id: true, number: true } },
  openingReversalEntry: { select: { id: true, number: true } },
  closeRequest: {
    select: {
      regularizationEntry: { select: { id: true, number: true } },
      closingEntry: { select: { id: true, number: true } },
      openingEntry: { select: { id: true, number: true } }
    }
  },
  fiscalYear: { select: { year: true } },
  successorFiscalYear: { select: { year: true } }
} satisfies Prisma.AccountingFiscalYearReopenRequestSelect;

const automaticEntrySelect = {
  id: true,
  fiscalYearId: true,
  year: true,
  number: true,
  accountingDate: true,
  origin: true,
  status: true,
  totalDebit: true,
  totalCredit: true,
  reversedByEntry: { select: { id: true } },
  lines: {
    orderBy: { position: "asc" as const },
    select: { accountId: true, concept: true, debit: true, credit: true }
  }
} satisfies Prisma.AccountingJournalEntrySelect;

const closeEvidenceSelect = {
  id: true,
  companyId: true,
  fiscalYearId: true,
  successorFiscalYearId: true,
  status: true,
  requestedById: true,
  approvedById: true,
  approvedAt: true,
  regularizationEntryId: true,
  closingEntryId: true,
  openingEntryId: true,
  fiscalYear: { select: { id: true, companyId: true, year: true, startDate: true, endDate: true, status: true } },
  successorFiscalYear: { select: { id: true, companyId: true, year: true, startDate: true, endDate: true, status: true, sourceFiscalYearId: true } },
  regularizationEntry: { select: automaticEntrySelect },
  closingEntry: { select: automaticEntrySelect },
  openingEntry: { select: automaticEntrySelect }
} satisfies Prisma.AccountingFiscalYearCloseRequestSelect;

type CloseEvidence = Prisma.AccountingFiscalYearCloseRequestGetPayload<{ select: typeof closeEvidenceSelect }>;
type AutomaticEntry = NonNullable<CloseEvidence["openingEntry"]>;

export function hashFiscalYearReopenRequest(
  closeRequestId: string,
  command: RequestFiscalYearReopeningCommand
): string {
  return hashIdempotencyPayload("accounting-fiscal-year-reopen-request:v1", { closeRequestId, ...command });
}

export function hashFiscalYearReopenApproval(requestId: string): string {
  return hashIdempotencyPayload("accounting-fiscal-year-reopen-approve:v1", { requestId });
}

export function hashFiscalYearReopenCancellation(requestId: string): string {
  return hashIdempotencyPayload("accounting-fiscal-year-reopen-cancel:v1", { requestId });
}

export function hashFiscalYearReopenRejection(
  requestId: string,
  command: RejectFiscalYearReopeningCommand
): string {
  return hashIdempotencyPayload("accounting-fiscal-year-reopen-reject:v1", { requestId, ...command });
}

export async function listFiscalYearReopenRequests(
  closeRequestIds?: string[],
  now: Date = new Date()
): Promise<FiscalYearReopenRequestDto[]> {
  return prisma.$transaction(async (tx) => {
    const companyId = await currentCompanyId(tx);
    await lockFiscalCycle(tx, companyId);
    await expireStaleReopenRequests(tx, companyId, now, closeRequestIds);
    const records = await tx.accountingFiscalYearReopenRequest.findMany({
      where: { companyId, ...(closeRequestIds ? { closeRequestId: { in: closeRequestIds } } : {}) },
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      ...(closeRequestIds ? {} : { take: 50 }),
      select: requestSelect
    });
    return records.map(mapRequest);
  });
}

export async function requestFiscalYearReopening(
  closeRequestId: string,
  command: RequestFiscalYearReopeningCommand,
  actor: SessionUser,
  context: MutationContext
): Promise<Result> {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const companyId = await currentCompanyId(tx);
      await beginLocks(tx, companyId, context.idempotencyKey);
      const replay = await replayMutation(tx, context, 201);
      if (replay) return replay;
      await lockCloseRequest(tx, closeRequestId, companyId);
      await expireStaleReopenRequests(tx, companyId, new Date(), [closeRequestId]);
      const close = await loadCloseEvidence(tx, closeRequestId, companyId);
      if (!close) return { kind: "close-not-found" as const };
      if (close.status !== "COMPLETED" || !close.successorFiscalYearId || !close.successorFiscalYear) {
        return { kind: "close-not-completed" as const };
      }
      const completedCount = await tx.accountingFiscalYearReopenRequest.count({
        where: { closeRequestId, status: "COMPLETED" }
      });
      if (completedCount > 0) return { kind: "already-reopened" as const };
      const activeCount = await tx.accountingFiscalYearReopenRequest.count({
        where: { closeRequestId, status: "REQUESTED" }
      });
      if (activeCount > 0) return { kind: "active-exists" as const };
      const preflight = await buildReopenPreflight(tx, close);
      if (!preflight.ready) {
        await audit(tx, "ACCOUNTING_FISCAL_YEAR_REOPEN_REQUEST_BLOCKED", actor, context, {
          closeRequestId,
          fiscalYearId: close.fiscalYearId,
          successorFiscalYearId: close.successorFiscalYearId,
          reasonCode: command.reasonCode,
          preflight
        });
        return { kind: "preconditions-failed" as const, preflight };
      }
      const requestedAt = new Date();
      const created = await tx.accountingFiscalYearReopenRequest.create({
        data: {
          companyId,
          closeRequestId,
          fiscalYearId: close.fiscalYearId,
          successorFiscalYearId: close.successorFiscalYearId,
          reasonCode: command.reasonCode,
          reason: command.reason,
          preflightSnapshot: preflight as unknown as Prisma.InputJsonValue,
          requestedById: actor.id,
          requestedAt,
          expiresAt: new Date(requestedAt.getTime() + REOPEN_REQUEST_LIFETIME_MS)
        },
        select: requestSelect
      });
      const value = mapRequest(created);
      await audit(tx, "ACCOUNTING_FISCAL_YEAR_REOPEN_REQUESTED", actor, context, {
        reopenRequestId: created.id,
        closeRequestId,
        fiscalYearId: close.fiscalYearId,
        successorFiscalYearId: close.successorFiscalYearId,
        reasonCode: command.reasonCode,
        preflight
      });
      await storeReplay(tx, context, 201, value);
      return { kind: "created" as const, value };
    });
    return mapMutationResult(result, 201);
  } catch (error) {
    if (isUniqueConstraintError(error)) return failure(409, "FISCAL_YEAR_REOPEN_ACTIVE_REQUEST_EXISTS", "Ya existe una solicitud de reapertura activa.");
    throw error;
  }
}

export async function approveFiscalYearReopening(
  requestId: string,
  actor: SessionUser,
  context: MutationContext
): Promise<Result> {
  const result = await prisma.$transaction(async (tx) => {
    const companyId = await currentCompanyId(tx);
    await beginLocks(tx, companyId, context.idempotencyKey);
    const replay = await replayMutation(tx, context, 200);
    if (replay) return replay;
    await expireStaleReopenRequests(tx, companyId, new Date());
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "accounting_fiscal_year_reopen_requests"
      WHERE "id" = ${requestId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`);
    const request = await tx.accountingFiscalYearReopenRequest.findFirst({
      where: { id: requestId, companyId },
      select: { id: true, closeRequestId: true, status: true, requestedById: true, reasonCode: true }
    });
    if (!request) return { kind: "request-not-found" as const };
    if (request.status === "EXPIRED") return { kind: "request-expired" as const };
    if (request.status !== "REQUESTED") return { kind: "request-not-pending" as const };
    if (request.requestedById === actor.id) {
      await audit(tx, "ACCOUNTING_FISCAL_YEAR_REOPEN_APPROVAL_DENIED", actor, context, {
        reopenRequestId: request.id,
        closeRequestId: request.closeRequestId,
        denialReason: "SELF_APPROVAL"
      });
      return { kind: "self-approval" as const };
    }
    await lockCloseRequest(tx, request.closeRequestId, companyId);
    const close = await loadCloseEvidence(tx, request.closeRequestId, companyId);
    if (!close || close.status !== "COMPLETED" || !close.successorFiscalYearId || !close.successorFiscalYear) {
      return { kind: "close-not-completed" as const };
    }
    await lockFiscalYears(tx, close.fiscalYearId, close.successorFiscalYearId, companyId);
    const preflight = await buildReopenPreflight(tx, close);
    if (!preflight.ready) {
      await audit(tx, "ACCOUNTING_FISCAL_YEAR_REOPEN_BLOCKED", actor, context, {
        reopenRequestId: request.id,
        closeRequestId: close.id,
        fiscalYearId: close.fiscalYearId,
        successorFiscalYearId: close.successorFiscalYearId,
        preflight
      });
      return { kind: "preconditions-failed" as const, preflight };
    }

    const openingReversal = close.openingEntry
      ? await createReversalEntry(tx, close.openingEntry, actor.id)
      : null;
    const closingReversal = close.closingEntry
      ? await createReversalEntry(tx, close.closingEntry, actor.id)
      : null;
    const regularizationReversal = close.regularizationEntry
      ? await createReversalEntry(tx, close.regularizationEntry, actor.id)
      : null;

    await tx.accountingFiscalYear.update({
      where: { id: close.successorFiscalYearId },
      data: { status: "REVERSED" }
    });
    await tx.accountingFiscalYear.update({
      where: { id: close.fiscalYearId },
      data: { status: "OPEN", closedAt: null, closedById: null }
    });
    const completed = await tx.accountingFiscalYearReopenRequest.update({
      where: { id: request.id },
      data: {
        status: "COMPLETED",
        approvedById: actor.id,
        approvedAt: new Date(),
        regularizationReversalEntryId: regularizationReversal?.id ?? null,
        closingReversalEntryId: closingReversal?.id ?? null,
        openingReversalEntryId: openingReversal?.id ?? null
      },
      select: requestSelect
    });
    const value = mapRequest(completed);
    await audit(tx, "ACCOUNTING_FISCAL_YEAR_REOPENED", actor, context, {
      reopenRequestId: request.id,
      closeRequestId: close.id,
      requestedByUserId: request.requestedById,
      closeRequestedByUserId: close.requestedById,
      closeApprovedByUserId: close.approvedById,
      fiscalYearId: close.fiscalYearId,
      successorFiscalYearId: close.successorFiscalYearId,
      reasonCode: request.reasonCode,
      originalEntries: entryReferences(close),
      reversalEntries: {
        regularization: regularizationReversal,
        closing: closingReversal,
        opening: openingReversal
      },
      preflight
    });
    await storeReplay(tx, context, 200, value);
    return { kind: "completed" as const, value };
  });
  return mapMutationResult(result, 200);
}

export async function cancelFiscalYearReopening(
  requestId: string,
  actor: SessionUser,
  context: MutationContext
): Promise<Result> {
  const result = await prisma.$transaction(async (tx) => {
    const companyId = await currentCompanyId(tx);
    await beginLocks(tx, companyId, context.idempotencyKey);
    const replay = await replayMutation(tx, context, 200);
    if (replay) return replay;
    await expireStaleReopenRequests(tx, companyId, new Date());
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "accounting_fiscal_year_reopen_requests"
      WHERE "id" = ${requestId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`);
    const request = await tx.accountingFiscalYearReopenRequest.findFirst({
      where: { id: requestId, companyId },
      select: { id: true, closeRequestId: true, fiscalYearId: true, successorFiscalYearId: true, status: true, requestedById: true }
    });
    if (!request) return { kind: "request-not-found" as const };
    if (request.status === "EXPIRED") return { kind: "request-expired" as const };
    if (request.status !== "REQUESTED" || request.requestedById !== actor.id) {
      await audit(tx, "ACCOUNTING_FISCAL_YEAR_REOPEN_CANCELLATION_DENIED", actor, context, {
        reopenRequestId: request.id,
        closeRequestId: request.closeRequestId,
        denialReason: request.status !== "REQUESTED" ? "INVALID_STATUS" : "NOT_REQUESTER"
      });
      return { kind: "not-cancellable" as const };
    }
    const cancelled = await tx.accountingFiscalYearReopenRequest.update({
      where: { id: request.id },
      data: { status: "CANCELLED", cancelledById: actor.id, cancelledAt: new Date() },
      select: requestSelect
    });
    const value = mapRequest(cancelled);
    await audit(tx, "ACCOUNTING_FISCAL_YEAR_REOPEN_CANCELLED", actor, context, {
      reopenRequestId: request.id,
      closeRequestId: request.closeRequestId,
      fiscalYearId: request.fiscalYearId,
      successorFiscalYearId: request.successorFiscalYearId
    });
    await storeReplay(tx, context, 200, value);
    return { kind: "cancelled" as const, value };
  });
  return mapMutationResult(result, 200);
}

export async function rejectFiscalYearReopening(
  requestId: string,
  command: RejectFiscalYearReopeningCommand,
  actor: SessionUser,
  context: MutationContext
): Promise<Result> {
  const result = await prisma.$transaction(async (tx) => {
    const companyId = await currentCompanyId(tx);
    await beginLocks(tx, companyId, context.idempotencyKey);
    const replay = await replayMutation(tx, context, 200);
    if (replay) return replay;
    await expireStaleReopenRequests(tx, companyId, new Date());
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "accounting_fiscal_year_reopen_requests"
      WHERE "id" = ${requestId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`);
    const request = await tx.accountingFiscalYearReopenRequest.findFirst({
      where: { id: requestId, companyId },
      select: {
        id: true,
        closeRequestId: true,
        fiscalYearId: true,
        successorFiscalYearId: true,
        status: true,
        requestedById: true
      }
    });
    if (!request) return { kind: "request-not-found" as const };
    if (request.status === "EXPIRED") return { kind: "request-expired" as const };
    if (request.status !== "REQUESTED") return { kind: "request-not-pending" as const };
    if (request.requestedById === actor.id) {
      await audit(tx, "ACCOUNTING_FISCAL_YEAR_REOPEN_REJECTION_DENIED", actor, context, {
        reopenRequestId: request.id,
        closeRequestId: request.closeRequestId,
        denialReason: "SELF_REJECTION"
      });
      return { kind: "self-rejection" as const };
    }
    const rejected = await tx.accountingFiscalYearReopenRequest.update({
      where: { id: request.id },
      data: {
        status: "REJECTED",
        rejectedById: actor.id,
        rejectedAt: new Date(),
        rejectionReason: command.reason
      },
      select: requestSelect
    });
    const value = mapRequest(rejected);
    await audit(tx, "ACCOUNTING_FISCAL_YEAR_REOPEN_REJECTED", actor, context, {
      reopenRequestId: request.id,
      closeRequestId: request.closeRequestId,
      fiscalYearId: request.fiscalYearId,
      successorFiscalYearId: request.successorFiscalYearId,
      requestedByUserId: request.requestedById
    });
    await storeReplay(tx, context, 200, value);
    return { kind: "rejected" as const, value };
  });
  return mapMutationResult(result, 200);
}

async function buildReopenPreflight(
  tx: Prisma.TransactionClient,
  close: CloseEvidence
): Promise<FiscalYearReopenPreflightReport> {
  const successor = close.successorFiscalYear;
  const successorId = close.successorFiscalYearId;
  if (!successor || !successorId) return invalidPreflight();
  const automaticEntryEvidenceValid =
    validAutomaticEntry(close.regularizationEntry, close.regularizationEntryId, "REGULARIZATION", close.fiscalYearId) &&
    validAutomaticEntry(close.closingEntry, close.closingEntryId, "CLOSING", close.fiscalYearId) &&
    validAutomaticEntry(close.openingEntry, close.openingEntryId, "OPENING", successorId);
  const closeHistory = await tx.accountingFiscalYearCloseRequest.findMany({
    where: {
      fiscalYearId: close.fiscalYearId,
      successorFiscalYearId: successorId,
      status: "COMPLETED"
    },
    select: {
      openingEntryId: true,
      reopenRequests: {
        where: { status: "COMPLETED" },
        select: { openingReversalEntryId: true }
      }
    }
  });
  const allowedSuccessorEntryIds = closeHistory.flatMap((completedClose) => [
    completedClose.openingEntryId,
    ...completedClose.reopenRequests.map((reopen) => reopen.openingReversalEntryId)
  ]).filter((id): id is string => id !== null);
  const [
    alreadyReopenedCount,
    successorJournalActivityCount,
    successorCloseRequestCount,
    successorChildFiscalYearCount,
    accountIntegrityRows,
    businessActivityRows
  ] = await Promise.all([
    tx.accountingFiscalYearReopenRequest.count({ where: { closeRequestId: close.id, status: "COMPLETED" } }),
    tx.accountingJournalEntry.count({
      where: {
        fiscalYearId: successorId,
        ...(allowedSuccessorEntryIds.length ? { id: { notIn: allowedSuccessorEntryIds } } : {})
      }
    }),
    tx.accountingFiscalYearCloseRequest.count({ where: { fiscalYearId: successorId } }),
    tx.accountingFiscalYear.count({ where: { sourceFiscalYearId: successorId } }),
    tx.$queryRaw<Array<{ unlinked: bigint; mismatched: bigint; missing: bigint }>>(Prisma.sql`
      SELECT
        (SELECT COUNT(*) FROM "accounting_accounts" destination
          WHERE destination."fiscalYearId" = ${successorId}::uuid AND destination."sourceAccountId" IS NULL) AS unlinked,
        (SELECT COUNT(*) FROM "accounting_accounts" destination
          JOIN "accounting_accounts" source ON source."id" = destination."sourceAccountId"
          WHERE destination."fiscalYearId" = ${successorId}::uuid
            AND source."fiscalYearId" = ${close.fiscalYearId}::uuid
            AND (destination."code", destination."name", destination."status", destination."type", destination."level", destination."isPostable", destination."supplierId")
              IS DISTINCT FROM
                (source."code", source."name", source."status", source."type", source."level", source."isPostable", source."supplierId")) AS mismatched,
        (SELECT COUNT(*) FROM "accounting_accounts" source
          WHERE source."fiscalYearId" = ${close.fiscalYearId}::uuid
            AND NOT EXISTS (
              SELECT 1 FROM "accounting_accounts" destination
              WHERE destination."fiscalYearId" = ${successorId}::uuid AND destination."sourceAccountId" = source."id"
            )) AS missing
    `),
    tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT (
        (SELECT COUNT(*) FROM "invoices" WHERE "companyId" = ${close.companyId}::uuid AND "issueDate" BETWEEN ${successor.startDate} AND ${successor.endDate})
        + (SELECT COUNT(*) FROM "purchase_invoices" WHERE "companyId" = ${close.companyId}::uuid AND "accountingDate" BETWEEN ${successor.startDate} AND ${successor.endDate})
        + (SELECT COUNT(*) FROM "supplier_payments" WHERE "companyId" = ${close.companyId}::uuid AND "paymentDate" BETWEEN ${successor.startDate} AND ${successor.endDate})
        + (SELECT COUNT(*) FROM "customer_payments" payment JOIN "invoices" invoice ON invoice."id" = payment."invoiceId" WHERE invoice."companyId" = ${close.companyId}::uuid AND payment."paymentDate" BETWEEN ${successor.startDate} AND ${successor.endDate})
        + (SELECT COUNT(*) FROM "customer_payment_returns" payment_return JOIN "invoices" invoice ON invoice."id" = payment_return."invoiceId" WHERE invoice."companyId" = ${close.companyId}::uuid AND payment_return."returnDate" BETWEEN ${successor.startDate} AND ${successor.endDate})
        + (SELECT COUNT(*) FROM "customer_credit_refunds" WHERE "companyId" = ${close.companyId}::uuid AND "requestedDate" BETWEEN ${successor.startDate} AND ${successor.endDate})
        + (SELECT COUNT(*) FROM "supplier_credit_refunds" WHERE "companyId" = ${close.companyId}::uuid AND ("requestedDate" BETWEEN ${successor.startDate} AND ${successor.endDate} OR "postingDate" BETWEEN ${successor.startDate} AND ${successor.endDate}))
        + (SELECT COUNT(*) FROM "customer_remittances" WHERE "chargeDate" BETWEEN ${successor.startDate} AND ${successor.endDate})
        + (SELECT COUNT(*) FROM "customer_credit_applications" application JOIN "customer_credits" credit ON credit."id" = application."creditId" WHERE credit."companyId" = ${close.companyId}::uuid AND application."applicationDate" BETWEEN ${successor.startDate} AND ${successor.endDate})
        + (SELECT COUNT(*) FROM "supplier_credit_applications" WHERE "companyId" = ${close.companyId}::uuid AND "applicationDate" BETWEEN ${successor.startDate} AND ${successor.endDate})
        + (SELECT COUNT(*) FROM "bank_movements" movement JOIN "bank_accounts" account ON account."id" = movement."bankAccountId" WHERE account."companyId" = ${close.companyId}::uuid AND movement."bookingDate" BETWEEN ${successor.startDate} AND ${successor.endDate})
      )::bigint AS count
    `)
  ]);
  const accountIntegrity = accountIntegrityRows[0] ?? { unlinked: 0n, mismatched: 0n, missing: 0n };
  const sourceClosed = close.fiscalYear.status === "CLOSED";
  const successorOpen = successor.status === "OPEN";
  const successorLinkValid = successor.companyId === close.companyId
    && successor.sourceFiscalYearId === close.fiscalYearId
    && successor.year === close.fiscalYear.year + 1;
  const report: FiscalYearReopenPreflightReport = {
    sourceClosed,
    successorOpen,
    successorLinkValid,
    automaticEntryEvidenceValid,
    alreadyReopenedCount,
    successorJournalActivityCount,
    successorCloseRequestCount,
    successorChildFiscalYearCount,
    successorUnlinkedAccountCount: Number(accountIntegrity.unlinked),
    successorPlanMismatchCount: Number(accountIntegrity.mismatched),
    successorMissingAccountCount: Number(accountIntegrity.missing),
    successorBusinessActivityCount: Number(businessActivityRows[0]?.count ?? 0n),
    ready: false
  };
  report.ready = sourceClosed && successorOpen && successorLinkValid && automaticEntryEvidenceValid
    && report.alreadyReopenedCount === 0
    && report.successorJournalActivityCount === 0
    && report.successorCloseRequestCount === 0
    && report.successorChildFiscalYearCount === 0
    && report.successorUnlinkedAccountCount === 0
    && report.successorPlanMismatchCount === 0
    && report.successorMissingAccountCount === 0
    && report.successorBusinessActivityCount === 0;
  return report;
}

function invalidPreflight(): FiscalYearReopenPreflightReport {
  return {
    sourceClosed: false,
    successorOpen: false,
    successorLinkValid: false,
    automaticEntryEvidenceValid: false,
    alreadyReopenedCount: 0,
    successorJournalActivityCount: 0,
    successorCloseRequestCount: 0,
    successorChildFiscalYearCount: 0,
    successorUnlinkedAccountCount: 0,
    successorPlanMismatchCount: 0,
    successorMissingAccountCount: 0,
    successorBusinessActivityCount: 0,
    ready: false
  };
}

function validAutomaticEntry(
  entry: AutomaticEntry | null,
  entryId: string | null,
  origin: "REGULARIZATION" | "CLOSING" | "OPENING",
  fiscalYearId: string
): boolean {
  if (!entryId) return entry === null;
  return entry?.id === entryId
    && entry.fiscalYearId === fiscalYearId
    && entry.origin === origin
    && entry.status === "POSTED"
    && entry.reversedByEntry === null;
}

async function createReversalEntry(
  tx: Prisma.TransactionClient,
  original: AutomaticEntry,
  actorId: string
): Promise<{ id: string; number: string }> {
  const last = await tx.accountingJournalEntry.findFirst({
    where: { fiscalYearId: original.fiscalYearId },
    orderBy: { sequence: "desc" },
    select: { sequence: true }
  });
  const sequence = (last?.sequence ?? 0) + 1;
  return tx.accountingJournalEntry.create({
    data: {
      fiscalYearId: original.fiscalYearId,
      reversesEntryId: original.id,
      year: original.year,
      sequence,
      number: `${original.year}/${sequence.toString().padStart(6, "0")}`,
      accountingDate: original.accountingDate,
      concept: `Reversion ${original.number}`,
      origin: "FISCAL_YEAR_CLOSE_REVERSAL",
      totalDebit: original.totalCredit,
      totalCredit: original.totalDebit,
      createdById: actorId,
      lines: {
        create: original.lines.map((line, index) => ({
          accountId: line.accountId,
          position: index + 1,
          concept: line.concept,
          debit: line.credit,
          credit: line.debit
        }))
      }
    },
    select: { id: true, number: true }
  });
}

async function beginLocks(tx: Prisma.TransactionClient, companyId: string, idempotencyKey: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`;
  await lockFiscalCycle(tx, companyId);
}

async function lockFiscalCycle(tx: Prisma.TransactionClient, companyId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`accounting-fiscal-cycle:${companyId}`}, 0))`;
}

async function expireStaleReopenRequests(
  tx: Prisma.TransactionClient,
  companyId: string,
  now: Date,
  closeRequestIds?: string[]
): Promise<void> {
  if (closeRequestIds?.length === 0) return;
  const stale = await tx.accountingFiscalYearReopenRequest.findMany({
    where: {
      companyId,
      status: "REQUESTED",
      expiresAt: { lte: now },
      ...(closeRequestIds ? { closeRequestId: { in: closeRequestIds } } : {})
    },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      closeRequestId: true,
      fiscalYearId: true,
      successorFiscalYearId: true,
      requestedById: true,
      expiresAt: true
    }
  });
  for (const request of stale) {
    await tx.accountingFiscalYearReopenRequest.update({
      where: { id: request.id },
      data: { status: "EXPIRED", expiredAt: now }
    });
    await auditSystem(tx, "ACCOUNTING_FISCAL_YEAR_REOPEN_EXPIRED", {
      reopenRequestId: request.id,
      closeRequestId: request.closeRequestId,
      fiscalYearId: request.fiscalYearId,
      successorFiscalYearId: request.successorFiscalYearId,
      requestedByUserId: request.requestedById,
      expiresAt: request.expiresAt.toISOString()
    });
  }
}

async function lockCloseRequest(tx: Prisma.TransactionClient, closeRequestId: string, companyId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "accounting_fiscal_year_close_requests"
    WHERE "id" = ${closeRequestId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`);
}

async function lockFiscalYears(tx: Prisma.TransactionClient, sourceId: string, successorId: string, companyId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "accounting_fiscal_years"
    WHERE "id" IN (${sourceId}::uuid, ${successorId}::uuid) AND "companyId" = ${companyId}::uuid
    ORDER BY "year" FOR UPDATE`);
}

async function loadCloseEvidence(
  tx: Prisma.TransactionClient,
  closeRequestId: string,
  companyId: string
): Promise<CloseEvidence | null> {
  return tx.accountingFiscalYearCloseRequest.findFirst({
    where: { id: closeRequestId, companyId },
    select: closeEvidenceSelect
  });
}

async function currentCompanyId(client: Prisma.TransactionClient | typeof prisma): Promise<string> {
  const installation = await client.installation.findFirstOrThrow({
    where: { status: "INITIALIZED" },
    select: { companyId: true }
  });
  if (!installation.companyId) throw new Error("Initialized installation without company.");
  return installation.companyId;
}

async function replayMutation(
  tx: Prisma.TransactionClient,
  context: MutationContext,
  expectedStatus: 200 | 201
): Promise<{ kind: "replayed"; value: FiscalYearReopenRequestDto } | { kind: "idempotency-conflict" } | null> {
  const stored = await tx.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
  if (!stored) return null;
  const parsed = dtoSchema.safeParse(stored.responseBody);
  if (stored.requestHash !== context.requestHash || stored.responseStatus !== expectedStatus || !parsed.success) {
    return { kind: "idempotency-conflict" };
  }
  return { kind: "replayed", value: parsed.data };
}

async function storeReplay(
  tx: Prisma.TransactionClient,
  context: MutationContext,
  responseStatus: 200 | 201,
  responseBody: FiscalYearReopenRequestDto
): Promise<void> {
  await tx.idempotencyRecord.create({
    data: { key: context.idempotencyKey, requestHash: context.requestHash, responseStatus, responseBody }
  });
}

async function audit(
  tx: Prisma.TransactionClient,
  eventType: string,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId">,
  payload: Record<string, unknown>
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      eventType,
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        ...payload,
        ...(context.correlationId ? { correlationId: context.correlationId } : {})
      } as Prisma.InputJsonValue
    }
  });
}

async function auditSystem(
  tx: Prisma.TransactionClient,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      eventType,
      actorType: "SYSTEM",
      payload: payload as Prisma.InputJsonValue
    }
  });
}

function entryReferences(close: CloseEvidence) {
  return {
    regularization: close.regularizationEntry ? { id: close.regularizationEntry.id, number: close.regularizationEntry.number } : null,
    closing: close.closingEntry ? { id: close.closingEntry.id, number: close.closingEntry.number } : null,
    opening: close.openingEntry ? { id: close.openingEntry.id, number: close.openingEntry.number } : null
  };
}

function mapRequest(record: Prisma.AccountingFiscalYearReopenRequestGetPayload<{ select: typeof requestSelect }>): FiscalYearReopenRequestDto {
  return {
    id: record.id,
    closeRequestId: record.closeRequestId,
    fiscalYearId: record.fiscalYearId,
    successorFiscalYearId: record.successorFiscalYearId,
    year: record.fiscalYear.year,
    successorYear: record.successorFiscalYear.year,
    status: record.status,
    reasonCode: record.reasonCode,
    reason: record.reason,
    requestedById: record.requestedById,
    requestedByName: record.requestedBy.displayName,
    requestedAt: record.requestedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    approvedById: record.approvedById,
    approvedByName: record.approvedBy?.displayName ?? null,
    approvedAt: record.approvedAt?.toISOString() ?? null,
    cancelledById: record.cancelledById,
    cancelledByName: record.cancelledBy?.displayName ?? null,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    rejectedById: record.rejectedById,
    rejectedByName: record.rejectedBy?.displayName ?? null,
    rejectedAt: record.rejectedAt?.toISOString() ?? null,
    rejectionReason: record.rejectionReason,
    expiredAt: record.expiredAt?.toISOString() ?? null,
    regularizationReversalEntryId: record.regularizationReversalEntryId,
    closingReversalEntryId: record.closingReversalEntryId,
    openingReversalEntryId: record.openingReversalEntryId,
    originalEntries: {
      regularization: record.closeRequest.regularizationEntry,
      closing: record.closeRequest.closingEntry,
      opening: record.closeRequest.openingEntry
    },
    reversalEntries: {
      regularization: record.regularizationReversalEntry,
      closing: record.closingReversalEntry,
      opening: record.openingReversalEntry
    },
    preflight: preflightSchema.parse(record.preflightSnapshot)
  };
}

function mapMutationResult(
  result: { kind: string; value?: FiscalYearReopenRequestDto; preflight?: FiscalYearReopenPreflightReport },
  successStatus: 200 | 201
): Result {
  if (result.kind === "created" || result.kind === "completed" || result.kind === "cancelled" || result.kind === "rejected" || result.kind === "replayed") {
    return { ok: true, status: successStatus, value: result.value! };
  }
  if (result.kind === "close-not-found") return failure(404, "FISCAL_YEAR_CLOSE_REQUEST_NOT_FOUND", "La solicitud de cierre no existe.");
  if (result.kind === "close-not-completed") return failure(409, "FISCAL_YEAR_CLOSE_REQUEST_NOT_COMPLETED", "El cierre no esta completado o carece de evidencia relacional.");
  if (result.kind === "already-reopened") return failure(409, "FISCAL_YEAR_CLOSE_ALREADY_REOPENED", "Este cierre ya tiene una reapertura completada.");
  if (result.kind === "active-exists") return failure(409, "FISCAL_YEAR_REOPEN_ACTIVE_REQUEST_EXISTS", "Ya existe una solicitud de reapertura pendiente.");
  if (result.kind === "request-not-found") return failure(404, "FISCAL_YEAR_REOPEN_REQUEST_NOT_FOUND", "La solicitud de reapertura no existe.");
  if (result.kind === "request-not-pending") return failure(409, "FISCAL_YEAR_REOPEN_REQUEST_NOT_PENDING", "La solicitud de reapertura ya no esta pendiente.");
  if (result.kind === "self-approval") return failure(409, "FISCAL_YEAR_REOPEN_SELF_APPROVAL_FORBIDDEN", "La persona solicitante no puede aprobar su propia reapertura.");
  if (result.kind === "self-rejection") return failure(409, "FISCAL_YEAR_REOPEN_SELF_REJECTION_FORBIDDEN", "La persona solicitante no puede rechazar su propia reapertura.");
  if (result.kind === "request-expired") return failure(409, "FISCAL_YEAR_REOPEN_REQUEST_EXPIRED", "La solicitud de reapertura ha caducado. Debe registrarse una nueva solicitud.");
  if (result.kind === "not-cancellable") return failure(409, "FISCAL_YEAR_REOPEN_REQUEST_NOT_CANCELLABLE", "Solo la persona solicitante puede cancelar una reapertura pendiente.");
  if (result.kind === "preconditions-failed") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "FISCAL_YEAR_REOPEN_PRECONDITIONS_FAILED",
        message: "El cierre no cumple las condiciones necesarias para una reapertura segura.",
        preflight: result.preflight
      }
    };
  }
  return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave idempotente ya se uso con otra solicitud.");
}

function failure(
  status: 404 | 409,
  code: Exclude<Result, { ok: true }>["error"]["code"],
  message: string
): Result {
  return { ok: false, status, error: { code, message } };
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
