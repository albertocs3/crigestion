import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { hashIdempotencyPayload } from "@/modules/platform/application/http";
import {
  buildAccountingFiscalYearClosePreflight,
  type AccountingFiscalYearClosePreflightReport
} from "./fiscalYearClosePreflight";

export type FiscalYearCloseRequestDto = {
  id: string;
  fiscalYearId: string;
  year: number;
  status: "REQUESTED" | "COMPLETED" | "CANCELLED";
  requestedById: string;
  requestedAt: string;
  approvedById: string | null;
  approvedAt: string | null;
  cancelledById: string | null;
  cancelledAt: string | null;
  successorFiscalYearId: string | null;
  regularizationEntryId: string | null;
  closingEntryId: string | null;
  openingEntryId: string | null;
  preflight: AccountingFiscalYearClosePreflightReport;
};

export type FiscalYearCloseRequestMutationContext = Pick<RequestContext, "correlationId"> & {
  idempotencyKey: string;
  requestHash: string;
};

type FiscalYearCloseRequestResult =
  | { ok: true; status: 200 | 201; value: FiscalYearCloseRequestDto }
  | {
      ok: false;
      status: 404 | 409;
      error: {
        code:
          | "FISCAL_YEAR_NOT_FOUND"
          | "FISCAL_YEAR_NOT_OPEN"
          | "NEXT_FISCAL_YEAR_ALREADY_EXISTS"
          | "FISCAL_YEAR_CLOSE_PRECONDITIONS_FAILED"
          | "FISCAL_YEAR_CLOSE_ACTIVE_REQUEST_EXISTS"
          | "FISCAL_YEAR_CLOSE_REQUEST_NOT_FOUND"
          | "FISCAL_YEAR_CLOSE_REQUEST_NOT_CANCELLABLE"
          | "IDEMPOTENCY_KEY_REUSED";
        message: string;
        preflight?: AccountingFiscalYearClosePreflightReport;
      };
    };

const preflightSchema = z.object({
  ready: z.boolean(),
  journalEntryCount: z.number().int().nonnegative(),
  unbalancedEntryCount: z.number().int().nonnegative(),
  headerLineMismatchCount: z.number().int().nonnegative(),
  invalidEntryShapeCount: z.number().int().nonnegative(),
  invalidLineCount: z.number().int().nonnegative(),
  crossFiscalYearLineCount: z.number().int().nonnegative(),
  draftInvoiceCount: z.number().int().nonnegative(),
  invoiceWithoutEntryCount: z.number().int().nonnegative(),
  unresolvedVerifactuInvoiceCount: z.number().int().nonnegative(),
  draftPurchaseCount: z.number().int().nonnegative(),
  purchaseWithoutEntryCount: z.number().int().nonnegative(),
  pendingCustomerRefundCount: z.number().int().nonnegative(),
  pendingSupplierRefundCount: z.number().int().nonnegative(),
  unsupportedAccountBalanceCount: z.number().int().nonnegative(),
  resultAccountReady: z.boolean()
}).strict();

const dtoSchema = z.object({
  id: z.string().uuid(),
  fiscalYearId: z.string().uuid(),
  year: z.number().int(),
  status: z.enum(["REQUESTED", "COMPLETED", "CANCELLED"]),
  requestedById: z.string().uuid(),
  requestedAt: z.string(),
  approvedById: z.string().uuid().nullable(),
  approvedAt: z.string().nullable(),
  cancelledById: z.string().uuid().nullable(),
  cancelledAt: z.string().nullable(),
  successorFiscalYearId: z.string().uuid().nullable(),
  regularizationEntryId: z.string().uuid().nullable(),
  closingEntryId: z.string().uuid().nullable(),
  openingEntryId: z.string().uuid().nullable(),
  preflight: preflightSchema
}).strict();

const requestSelect = {
  id: true,
  fiscalYearId: true,
  status: true,
  preflightSnapshot: true,
  requestedById: true,
  requestedAt: true,
  approvedById: true,
  approvedAt: true,
  cancelledById: true,
  cancelledAt: true,
  successorFiscalYearId: true,
  regularizationEntryId: true,
  closingEntryId: true,
  openingEntryId: true,
  fiscalYear: { select: { year: true } }
} satisfies Prisma.AccountingFiscalYearCloseRequestSelect;

export function hashFiscalYearCloseRequest(fiscalYearId: string): string {
  return hashIdempotencyPayload("accounting-fiscal-year-close-request:v1", { fiscalYearId });
}

export function hashFiscalYearCloseCancellation(requestId: string): string {
  return hashIdempotencyPayload("accounting-fiscal-year-close-cancel:v1", { requestId });
}

export async function listFiscalYearCloseRequests(fiscalYearIds?: string[]): Promise<FiscalYearCloseRequestDto[]> {
  const installation = await prisma.installation.findFirstOrThrow({
    where: { status: "INITIALIZED" },
    select: { companyId: true }
  });
  if (!installation.companyId) throw new Error("Initialized installation without company.");
  const records = await prisma.accountingFiscalYearCloseRequest.findMany({
    where: {
      companyId: installation.companyId,
      ...(fiscalYearIds ? { fiscalYearId: { in: fiscalYearIds } } : {})
    },
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    ...(fiscalYearIds ? {} : { take: 50 }),
    select: requestSelect
  });
  return records.map(mapRequest);
}

export async function requestFiscalYearClose(
  fiscalYearId: string,
  actor: SessionUser,
  context: FiscalYearCloseRequestMutationContext
): Promise<FiscalYearCloseRequestResult> {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const companyId = await initializedCompanyId(tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.idempotencyKey}, 0))`;
      const replayResult = await replay(tx, context, 201);
      if (replayResult) return replayResult;

      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "accounting_fiscal_years"
        WHERE "id" = ${fiscalYearId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`);
      const fiscalYear = await tx.accountingFiscalYear.findFirst({
        where: { id: fiscalYearId, companyId },
        select: { id: true, companyId: true, year: true, startDate: true, endDate: true, status: true }
      });
      if (!fiscalYear) return { kind: "not-found" as const };
      if (fiscalYear.status !== "OPEN") return { kind: "not-open" as const };
      const successor = await tx.accountingFiscalYear.findFirst({
        where: { companyId, year: fiscalYear.year + 1 },
        select: { status: true, sourceFiscalYearId: true }
      });
      if (successor && (successor.status !== "REVERSED" || successor.sourceFiscalYearId !== fiscalYear.id)) {
        return { kind: "next-exists" as const };
      }
      const active = await tx.accountingFiscalYearCloseRequest.findFirst({
        where: { fiscalYearId, status: "REQUESTED" },
        select: { id: true }
      });
      if (active) return { kind: "active-exists" as const };

      const preflight = await buildAccountingFiscalYearClosePreflight(tx, fiscalYear);
      if (!preflight.ready) {
        await tx.auditEvent.create({
          data: {
            eventType: "ACCOUNTING_FISCAL_YEAR_CLOSE_REQUEST_BLOCKED",
            actorType: "USER",
            payload: {
              actorUserId: actor.id,
              fiscalYearId,
              year: fiscalYear.year,
              preflight,
              ...(context.correlationId ? { correlationId: context.correlationId } : {})
            }
          }
        });
        return { kind: "preconditions-failed" as const, preflight };
      }

      const created = await tx.accountingFiscalYearCloseRequest.create({
        data: {
          companyId,
          fiscalYearId,
          requestedById: actor.id,
          preflightSnapshot: preflight as unknown as Prisma.InputJsonValue
        },
        select: requestSelect
      });
      const value = mapRequest(created);
      await tx.auditEvent.create({
        data: {
          eventType: "ACCOUNTING_FISCAL_YEAR_CLOSE_REQUESTED",
          actorType: "USER",
          payload: {
            actorUserId: actor.id,
            closeRequestId: created.id,
            fiscalYearId,
            year: fiscalYear.year,
            preflight,
            ...(context.correlationId ? { correlationId: context.correlationId } : {})
          }
        }
      });
      await tx.idempotencyRecord.create({ data: {
        key: context.idempotencyKey,
        requestHash: context.requestHash,
        responseStatus: 201,
        responseBody: value
      } });
      return { kind: "created" as const, value };
    });

    if (result.kind === "replayed") return { ok: true, status: result.status, value: result.value };
    if (result.kind === "idempotency-conflict") return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave idempotente ya se uso con otra solicitud.");
    if (result.kind === "not-found") return failure(404, "FISCAL_YEAR_NOT_FOUND", "El ejercicio no existe.");
    if (result.kind === "not-open") return failure(409, "FISCAL_YEAR_NOT_OPEN", "Solo se puede solicitar el cierre de un ejercicio abierto.");
    if (result.kind === "next-exists") return failure(409, "NEXT_FISCAL_YEAR_ALREADY_EXISTS", "El ejercicio siguiente ya existe.");
    if (result.kind === "active-exists") return failure(409, "FISCAL_YEAR_CLOSE_ACTIVE_REQUEST_EXISTS", "Ya existe una solicitud de cierre pendiente para el ejercicio.");
    if (result.kind === "preconditions-failed") return {
      ok: false,
      status: 409,
      error: { code: "FISCAL_YEAR_CLOSE_PRECONDITIONS_FAILED", message: "El ejercicio no cumple las condiciones necesarias para solicitar el cierre.", preflight: result.preflight }
    };
    return { ok: true, status: 201, value: result.value };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return failure(409, "FISCAL_YEAR_CLOSE_ACTIVE_REQUEST_EXISTS", "Ya existe una solicitud de cierre pendiente para el ejercicio.");
    }
    throw error;
  }
}

export async function cancelFiscalYearCloseRequest(
  requestId: string,
  actor: SessionUser,
  context: FiscalYearCloseRequestMutationContext
): Promise<FiscalYearCloseRequestResult> {
  const result = await prisma.$transaction(async (tx) => {
    const companyId = await initializedCompanyId(tx);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.idempotencyKey}, 0))`;
    const replayResult = await replay(tx, context, 200);
    if (replayResult) return replayResult;
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "accounting_fiscal_year_close_requests"
      WHERE "id" = ${requestId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`);
    const request = await tx.accountingFiscalYearCloseRequest.findFirst({
      where: { id: requestId, companyId },
      select: requestSelect
    });
    if (!request) return { kind: "request-not-found" as const };
    if (request.status !== "REQUESTED" || request.requestedById !== actor.id) {
      await tx.auditEvent.create({ data: {
        eventType: "ACCOUNTING_FISCAL_YEAR_CLOSE_CANCELLATION_DENIED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          closeRequestId: request.id,
          fiscalYearId: request.fiscalYearId,
          denialReason: request.status !== "REQUESTED" ? "INVALID_STATUS" : "NOT_REQUESTER",
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      } });
      return { kind: "not-cancellable" as const };
    }
    const cancelled = await tx.accountingFiscalYearCloseRequest.update({
      where: { id: request.id },
      data: { status: "CANCELLED", cancelledById: actor.id, cancelledAt: new Date() },
      select: requestSelect
    });
    const value = mapRequest(cancelled);
    await tx.auditEvent.create({ data: {
      eventType: "ACCOUNTING_FISCAL_YEAR_CLOSE_CANCELLED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        closeRequestId: request.id,
        fiscalYearId: request.fiscalYearId,
        ...(context.correlationId ? { correlationId: context.correlationId } : {})
      }
    } });
    await tx.idempotencyRecord.create({ data: {
      key: context.idempotencyKey,
      requestHash: context.requestHash,
      responseStatus: 200,
      responseBody: value
    } });
    return { kind: "cancelled" as const, value };
  });
  if (result.kind === "replayed") return { ok: true, status: result.status, value: result.value };
  if (result.kind === "idempotency-conflict") return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave idempotente ya se uso con otra solicitud.");
  if (result.kind === "request-not-found") return failure(404, "FISCAL_YEAR_CLOSE_REQUEST_NOT_FOUND", "La solicitud de cierre no existe.");
  if (result.kind === "not-cancellable") return failure(409, "FISCAL_YEAR_CLOSE_REQUEST_NOT_CANCELLABLE", "Solo la persona solicitante puede cancelar una solicitud pendiente.");
  return { ok: true, status: 200, value: result.value };
}

async function initializedCompanyId(tx: Prisma.TransactionClient): Promise<string> {
  const installation = await tx.installation.findFirstOrThrow({
    where: { status: "INITIALIZED" },
    select: { companyId: true }
  });
  if (!installation.companyId) throw new Error("Initialized installation without company.");
  return installation.companyId;
}

async function replay(
  tx: Prisma.TransactionClient,
  context: FiscalYearCloseRequestMutationContext,
  expectedStatus: 200 | 201
) {
  const stored = await tx.idempotencyRecord.findUnique({
    where: { key: context.idempotencyKey },
    select: { requestHash: true, responseStatus: true, responseBody: true }
  });
  if (!stored) return null;
  const parsed = dtoSchema.safeParse(stored.responseBody);
  if (stored.requestHash !== context.requestHash || stored.responseStatus !== expectedStatus || !parsed.success) {
    return { kind: "idempotency-conflict" as const };
  }
  return { kind: "replayed" as const, status: expectedStatus, value: parsed.data };
}

function mapRequest(record: Prisma.AccountingFiscalYearCloseRequestGetPayload<{ select: typeof requestSelect }>): FiscalYearCloseRequestDto {
  const preflight = preflightSchema.parse(record.preflightSnapshot);
  return {
    id: record.id,
    fiscalYearId: record.fiscalYearId,
    year: record.fiscalYear.year,
    status: record.status,
    requestedById: record.requestedById,
    requestedAt: record.requestedAt.toISOString(),
    approvedById: record.approvedById,
    approvedAt: record.approvedAt?.toISOString() ?? null,
    cancelledById: record.cancelledById,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    successorFiscalYearId: record.successorFiscalYearId,
    regularizationEntryId: record.regularizationEntryId,
    closingEntryId: record.closingEntryId,
    openingEntryId: record.openingEntryId,
    preflight
  };
}

function failure(
  status: 404 | 409,
  code: Exclude<FiscalYearCloseRequestResult, { ok: true }>["error"]["code"],
  message: string
): FiscalYearCloseRequestResult {
  return { ok: false, status, error: { code, message } };
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
