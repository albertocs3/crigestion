import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSessionSecret } from "@/modules/platform/application/environment";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { hashIdempotencyPayload } from "@/modules/platform/application/http";
import { currentSubscriptionRenewalCompanyId, subscriptionRenewalDateOnlySchema } from "@/modules/subscriptions/application/renewals";

const defaultLimit = 25;
const maxLimit = 100;
const maxExportRows = 5000;
const maxExportBytes = 5 * 1024 * 1024;
const optionalText = z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).max(120).optional());
const optionalUuid = z.preprocess((value) => value === "" ? undefined : value, z.string().uuid().optional());
const optionalDate = z.preprocess((value) => value === "" ? undefined : value, subscriptionRenewalDateOnlySchema.optional());
const optionalCursor = z.preprocess((value) => value === "" ? undefined : value, z.string().regex(/^[A-Za-z0-9_-]{20,700}\.[A-Za-z0-9_-]{40,100}$/).optional());
const canonicalLimit = z.preprocess(
  (value) => value === undefined ? defaultLimit : value,
  z.union([z.number().int().min(1).max(maxLimit), z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).transform(Number)])
);

const waiverFilterShape = {
  reasonCode: z.preprocess((value) => value === "" ? undefined : value, z.enum(["COMMERCIAL_WAIVER", "SERVICE_FAILURE", "OTHER"]).optional()),
  customerId: optionalUuid,
  search: optionalText,
  periodFrom: optionalDate,
  periodTo: optionalDate,
  waivedFrom: optionalDate,
  waivedTo: optionalDate
};

function validateFilterRanges(value: { periodFrom?: string; periodTo?: string; waivedFrom?: string; waivedTo?: string }, context: z.RefinementCtx) {
  if (value.periodFrom && value.periodTo && value.periodFrom > value.periodTo) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["periodTo"], message: "La fecha final del periodo no puede ser anterior a la inicial." });
  }
  if (value.waivedFrom && value.waivedTo && value.waivedFrom > value.waivedTo) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["waivedTo"], message: "La fecha final de condonacion no puede ser anterior a la inicial." });
  }
  if ("search" in value && value.search && (!value.waivedFrom || !value.waivedTo)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["search"], message: "La busqueda requiere un rango de fechas de condonacion." });
  }
  if (value.waivedFrom && value.waivedTo) {
    const days = Math.round((parseDateOnly(value.waivedTo).getTime() - parseDateOnly(value.waivedFrom).getTime()) / 86_400_000) + 1;
    if (days > 366) context.addIssue({ code: z.ZodIssueCode.custom, path: ["waivedTo"], message: "El rango de condonacion no puede abarcar mas de 366 dias." });
  }
}

export const listSubscriptionRenewalWaiversSchema = z.object({
  ...waiverFilterShape,
  limit: canonicalLimit,
  cursor: optionalCursor
}).strict().superRefine(validateFilterRanges);

export const exportSubscriptionRenewalWaiversSchema = z.object({
  ...waiverFilterShape,
  waivedFrom: subscriptionRenewalDateOnlySchema,
  waivedTo: subscriptionRenewalDateOnlySchema
}).strict().superRefine((value, context) => {
  validateFilterRanges(value, context);
  if (value.waivedFrom > value.waivedTo) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["waivedTo"], message: "La fecha final de condonacion no puede ser anterior a la inicial." });
  }
});

export type ListSubscriptionRenewalWaiversCommand = z.infer<typeof listSubscriptionRenewalWaiversSchema>;
export type ExportSubscriptionRenewalWaiversCommand = z.infer<typeof exportSubscriptionRenewalWaiversSchema>;
type SubscriptionRenewalWaiverFilters = Omit<ListSubscriptionRenewalWaiversCommand, "limit" | "cursor">;

type WaiverValuation = {
  subtotal: string;
  discountTotal: string;
  taxableBase: string;
  taxAmount: string;
  total: string;
  currency: "EUR";
  calculationVersion: string;
  taxBreakdown: Array<{
    taxRateCode: string;
    taxRateName: string;
    taxRate: string;
    theoreticalTaxableBase: string;
    theoreticalTaxAmount: string;
    theoreticalTotal: string;
  }>;
};

export type SubscriptionRenewalWaiverReportItem = {
  id: string;
  subscription: { id: string; number: string; name: string };
  customer: { id: string; code: string; legalName: string; labelSource: "CAPTURED_AT_WAIVER" | "BACKFILLED_CURRENT_MASTER" };
  subscriptionState: { periodicity: "MONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "ANNUAL"; paymentMethod: "BANK_TRANSFER" | "CASH" | "DIRECT_DEBIT"; currentStatus: "DRAFT" | "ACTIVE" | "RENEWAL_PENDING" | "CANCELLED"; currentNextRenewalDate: string };
  periodStart: string;
  periodEndExclusive: string;
  waivedAt: string;
  waivedBy: { id: string; displayName: string };
  reasonCode: "COMMERCIAL_WAIVER" | "SERVICE_FAILURE" | "OTHER";
  hasReason: boolean;
  reason?: string;
  versions: { against: number; resulting: number };
  valuation: WaiverValuation;
  fiscalReview?: {
    id: string;
    status: "PENDING" | "IN_REVIEW" | "ESCALATED" | "ACTION_REQUIRED" | "CLOSED";
    version: number;
    openedBy: { id: string; displayName: string };
    openedAt: string;
    startedBy: { id: string; displayName: string } | null;
    startedAt: string | null;
    decision: "NO_ADDITIONAL_ACTION" | "MANUAL_ACCOUNTING_ACTION_REQUIRED" | "BILLING_REGULARIZATION_REQUIRED" | "EXTERNAL_FISCAL_ACTION_REQUIRED" | "EXTERNAL_ADVICE_REQUIRED" | null;
    actionDueDate: string | null;
    decidedBy: { id: string; displayName: string } | null;
    decidedAt: string | null;
    closedAt: string | null;
    completedBy: { id: string; displayName: string } | null;
    evidenceCount: number;
    hasLinkedAccountingEntry: boolean;
    isOwnWaiver: boolean;
    isAssignedToActor: boolean;
  };
};

export type SubscriptionRenewalWaiverReportSummary = {
  count: number;
  subtotal: string;
  discountTotal: string;
  taxableBase: string;
  taxAmount: string;
  total: string;
  currency: "EUR";
};

export type SubscriptionRenewalWaiverReport = {
  waivers: SubscriptionRenewalWaiverReportItem[];
  summary: SubscriptionRenewalWaiverReportSummary;
  nextCursor: string | null;
};

type ReportFailure = { ok: false; status: 409 | 422 | 429; error: { code: string; message: string } };
export type ListSubscriptionRenewalWaiversResult = { ok: true; status: 200; value: SubscriptionRenewalWaiverReport } | ReportFailure;
export type ExportSubscriptionRenewalWaiversResult = { ok: true; status: 200; value: { filename: string; content: string; rowCount: number; byteCount: number } } | ReportFailure;

const cursorSchema = z.object({
  v: z.literal(1),
  resolvedAt: z.string().datetime(),
  id: z.string().uuid(),
  filterHash: z.string().length(64),
  cutoffSequence: z.string().regex(/^\d+$/)
}).strict();

const waiverSelect = {
  id: true,
  periodStart: true,
  periodEndExclusive: true,
  resolvedAt: true,
  resolutionReasonCode: true,
  resolvedAgainstVersion: true,
  resolvedSubscriptionVersion: true,
  waivedSubtotal: true,
  waivedDiscountTotal: true,
  waivedTaxableBase: true,
  waivedTaxAmount: true,
  waivedTotal: true,
  waiverCalculationVersion: true,
  waiverSnapshot: { select: {
    customerId: true, customerCodeSnapshot: true, customerLegalNameSnapshot: true,
    source: true, currency: true,
    taxSummaries: { orderBy: [{ taxRateCodeSnapshot: "asc" as const }, { taxRateSnapshot: "asc" as const }], select: {
      taxRateCodeSnapshot: true, taxRateNameSnapshot: true, taxRateSnapshot: true,
      theoreticalTaxableBase: true, theoreticalTaxAmount: true, theoreticalTotal: true
    } }
  } },
  subscription: {
    select: {
      id: true,
      number: true,
      name: true,
      periodicity: true,
      paymentMethod: true,
      status: true,
      nextRenewalDate: true
    }
  },
  resolvedBy: { select: { id: true, displayName: true } }
} satisfies Prisma.SubscriptionRenewalExclusionSelect;

type WaiverRecord = Prisma.SubscriptionRenewalExclusionGetPayload<{ select: typeof waiverSelect }> & { resolutionReasonDetail?: string | null };
const fiscalReviewSelect = {
  id: true, status: true, version: true, openedAt: true, startedAt: true, decision: true,
  actionDueDate: true, decidedAt: true, closedAt: true,
  openedBy: { select: { id: true, displayName: true } },
  startedBy: { select: { id: true, displayName: true } },
  decidedBy: { select: { id: true, displayName: true } },
  closedBy: { select: { id: true, displayName: true } },
  _count: { select: { evidences: true } },
  accountingEntry: { select: { id: true } }
} satisfies Prisma.SubscriptionRenewalWaiverReviewSelect;
type FiscalReviewRecord = Prisma.SubscriptionRenewalWaiverReviewGetPayload<{ select: typeof fiscalReviewSelect }>;
type WaiverRecordWithOptionalEvidence = WaiverRecord & { resolutionReasonDetail?: string | null; fiscalReview?: FiscalReviewRecord | null };

export async function listSubscriptionRenewalWaivers(
  command: ListSubscriptionRenewalWaiversCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<ListSubscriptionRenewalWaiversResult> {
  const companyId = await currentSubscriptionRenewalCompanyId();
  if (!companyId) return failure(409, "PLATFORM_NOT_INITIALIZED", "La plataforma no esta inicializada.");
  const filterHash = waiverFilterHash(command, companyId);
  const cursor = command.cursor ? decodeCursor(command.cursor, filterHash) : null;
  if (command.cursor && !cursor) return failure(422, "SUBSCRIPTION_RENEWAL_WAIVER_CURSOR_INVALID", "El cursor del historial no es valido para estos filtros.");
  const where = waiverWhere(companyId, command);
  const canReadReason = actor.permissions.includes("Subscriptions.ManageRenewalExclusions");
  const canViewFiscalReview = actor.permissions.includes("Subscriptions.ViewRenewalWaiverFiscalReviews");
  const cutoffSequence = cursor
    ? BigInt(cursor.cutoffSequence)
    : await subscriptionRenewalWaiverCutoff(companyId);
  return prisma.$transaction(async (tx) => {
    const frozenWhere: Prisma.SubscriptionRenewalExclusionWhereInput = { AND: [where, { waiverSequence: { lte: cutoffSequence } }] };
    const select = {
      ...waiverSelect,
      ...(canReadReason ? { resolutionReasonDetail: true as const } : {}),
      ...(canViewFiscalReview ? { fiscalReview: { select: fiscalReviewSelect } } : {})
    };
    const records = await tx.subscriptionRenewalExclusion.findMany({
      where: cursor ? { AND: [frozenWhere, { OR: [
        { resolvedAt: { lt: new Date(cursor.resolvedAt) } },
        { resolvedAt: new Date(cursor.resolvedAt), id: { lt: cursor.id } }
      ] }] } : frozenWhere,
      orderBy: [{ resolvedAt: "desc" }, { id: "desc" }],
      take: command.limit + 1,
      select
    });
    const aggregate = await tx.subscriptionRenewalExclusion.aggregate({
      where: frozenWhere,
      _count: { _all: true },
      _sum: { waivedSubtotal: true, waivedDiscountTotal: true, waivedTaxableBase: true, waivedTaxAmount: true, waivedTotal: true }
    });
    const page = records.slice(0, command.limit);
    const reasonFlags = canReadReason || page.length === 0 ? [] : await tx.$queryRaw<Array<{ id: string; hasReason: boolean }>>(Prisma.sql`
      SELECT "id", ("resolutionReasonDetail" IS NOT NULL) AS "hasReason"
      FROM "subscription_renewal_exclusions"
      WHERE "companyId" = ${companyId}::uuid
        AND "id" IN (${Prisma.join(page.map((record) => Prisma.sql`${record.id}::uuid`))})
    `);
    const hasReasonById = new Map(reasonFlags.map((row) => [row.id, row.hasReason]));
    const value: SubscriptionRenewalWaiverReport = {
      waivers: page.map((record) => mapWaiver(
        record as WaiverRecordWithOptionalEvidence,
        canReadReason,
        canReadReason ? Boolean((record as WaiverRecord).resolutionReasonDetail) : hasReasonById.get(record.id) ?? false,
        canViewFiscalReview,
        actor.id
      )),
      summary: mapSummary(aggregate),
      nextCursor: records.length > command.limit && page.length > 0
        ? encodeCursor(page.at(-1)!.resolvedAt!, page.at(-1)!.id, filterHash, cutoffSequence)
        : null
    };
    await tx.auditEvent.create({ data: {
      eventType: "SUBSCRIPTION_RENEWAL_WAIVERS_VIEWED",
      actorType: "USER",
      payload: safeAuditPayload(
        command, actor, companyId, value.waivers.length, context.correlationId,
        canReadReason, value.waivers.filter((waiver) => waiver.reason !== undefined).length
      )
    } });
    return { ok: true as const, status: 200 as const, value };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

async function subscriptionRenewalWaiverCutoff(companyId: string): Promise<bigint> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${'subscription-renewal-waiver-cutoff:' + companyId}, 0))`;
    const aggregate = await tx.subscriptionRenewalExclusion.aggregate({
      where: { companyId, status: "RESOLVED", resolution: "WAIVED" },
      _max: { waiverSequence: true }
    });
    return aggregate._max.waiverSequence ?? 0n;
  });
}

export async function exportSubscriptionRenewalWaiversCsv(
  command: ExportSubscriptionRenewalWaiversCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<ExportSubscriptionRenewalWaiversResult> {
  const companyId = await currentSubscriptionRenewalCompanyId();
  if (!companyId) return failure(409, "PLATFORM_NOT_INITIALIZED", "La plataforma no esta inicializada.");
  if (await consumeExportRateLimit(companyId, actor, context.correlationId)) {
    return failure(429, "SUBSCRIPTION_RENEWAL_WAIVER_EXPORT_RATE_LIMITED", "Demasiadas exportaciones. Espere quince minutos.");
  }
  const where = waiverWhere(companyId, command);
  return prisma.$transaction(async (tx) => {
    const records = await tx.subscriptionRenewalExclusion.findMany({
      where,
      orderBy: [{ resolvedAt: "desc" }, { id: "desc" }],
      take: maxExportRows + 1,
      select: waiverSelect
    });
    if (records.length > maxExportRows) {
      await tx.auditEvent.create({ data: {
        eventType: "SUBSCRIPTION_RENEWAL_WAIVERS_EXPORT_REJECTED", actorType: "USER",
        payload: { ...safeAuditPayload(command, actor, companyId, maxExportRows, context.correlationId, false, 0), reason: "ROW_LIMIT_EXCEEDED" }
      } });
      return failure(422, "SUBSCRIPTION_RENEWAL_WAIVER_EXPORT_TOO_LARGE", "La exportacion supera 5000 filas; acote los filtros.");
    }
    const waivers = records.map((record) => mapWaiver(record, false, false, false, actor.id));
    const content = waiversCsv(waivers);
    const byteCount = Buffer.byteLength(`\uFEFF${content}`, "utf8");
    if (byteCount > maxExportBytes) {
      await tx.auditEvent.create({ data: {
        eventType: "SUBSCRIPTION_RENEWAL_WAIVERS_EXPORT_REJECTED", actorType: "USER",
        payload: { ...safeAuditPayload(command, actor, companyId, waivers.length, context.correlationId, false, 0), reason: "BYTE_LIMIT_EXCEEDED", byteCount }
      } });
      return failure(422, "SUBSCRIPTION_RENEWAL_WAIVER_EXPORT_TOO_LARGE", "La exportacion supera 5 MiB; acote los filtros.");
    }
    await tx.auditEvent.create({ data: {
      eventType: "SUBSCRIPTION_RENEWAL_WAIVERS_EXPORTED", actorType: "USER",
      payload: { ...safeAuditPayload(command, actor, companyId, waivers.length, context.correlationId, false, 0), byteCount }
    } });
    return { ok: true as const, status: 200 as const, value: {
      filename: `condonaciones-renovacion-${formatDateOnly(new Date())}.csv`,
      content, rowCount: waivers.length, byteCount
    } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

function waiverWhere(companyId: string, command: SubscriptionRenewalWaiverFilters): Prisma.SubscriptionRenewalExclusionWhereInput {
  return {
    companyId,
    status: "RESOLVED",
    resolution: "WAIVED",
    ...(command.reasonCode ? { resolutionReasonCode: command.reasonCode } : {}),
    ...(command.periodFrom || command.periodTo ? { periodStart: {
      ...(command.periodFrom ? { gte: parseDateOnly(command.periodFrom) } : {}),
      ...(command.periodTo ? { lte: parseDateOnly(command.periodTo) } : {})
    } } : {}),
    ...(command.waivedFrom || command.waivedTo ? { resolvedAt: {
      ...(command.waivedFrom ? { gte: madridStartOfDay(command.waivedFrom) } : {}),
      ...(command.waivedTo ? { lt: nextMadridDateOnly(command.waivedTo) } : {})
    } } : {}),
    subscription: {
      ...(command.customerId ? { customerId: command.customerId } : {}),
      ...(command.search ? { OR: [
        { number: { contains: command.search, mode: "insensitive" } },
        { name: { contains: command.search, mode: "insensitive" } }
      ] } : {})
    }
  };
}

function mapWaiver(
  record: WaiverRecordWithOptionalEvidence,
  canReadReason: boolean,
  hasReason: boolean,
  canViewFiscalReview: boolean,
  actorId: string
): SubscriptionRenewalWaiverReportItem {
  if (!record.resolvedAt || !record.resolvedBy || !record.resolutionReasonCode
    || record.waivedSubtotal === null || record.waivedDiscountTotal === null
    || record.waivedTaxableBase === null || record.waivedTaxAmount === null || record.waivedTotal === null
    || !record.waiverCalculationVersion || !record.resolvedAgainstVersion || !record.resolvedSubscriptionVersion
    || !record.waiverSnapshot || record.waiverSnapshot.currency !== "EUR" || record.waiverSnapshot.taxSummaries.length === 0) throw new Error("SUBSCRIPTION_RENEWAL_WAIVER_REPORT_EVIDENCE_INCOMPLETE");
  return {
    id: record.id,
    subscription: { id: record.subscription.id, number: record.subscription.number, name: record.subscription.name },
    customer: {
      id: record.waiverSnapshot.customerId,
      code: record.waiverSnapshot.customerCodeSnapshot,
      legalName: record.waiverSnapshot.customerLegalNameSnapshot,
      labelSource: record.waiverSnapshot.source
    },
    subscriptionState: {
      periodicity: record.subscription.periodicity, paymentMethod: record.subscription.paymentMethod,
      currentStatus: record.subscription.status, currentNextRenewalDate: formatDateOnly(record.subscription.nextRenewalDate)
    },
    periodStart: formatDateOnly(record.periodStart), periodEndExclusive: formatDateOnly(record.periodEndExclusive),
    waivedAt: record.resolvedAt.toISOString(), waivedBy: record.resolvedBy,
    reasonCode: record.resolutionReasonCode,
    hasReason,
    ...(canReadReason && record.resolutionReasonDetail ? { reason: record.resolutionReasonDetail } : {}),
    versions: { against: record.resolvedAgainstVersion, resulting: record.resolvedSubscriptionVersion },
    valuation: {
      subtotal: record.waivedSubtotal.toFixed(2), discountTotal: record.waivedDiscountTotal.toFixed(2),
      taxableBase: record.waivedTaxableBase.toFixed(2), taxAmount: record.waivedTaxAmount.toFixed(2),
      total: record.waivedTotal.toFixed(2), currency: "EUR", calculationVersion: record.waiverCalculationVersion,
      taxBreakdown: record.waiverSnapshot.taxSummaries.map((summary) => ({
        taxRateCode: summary.taxRateCodeSnapshot, taxRateName: summary.taxRateNameSnapshot,
        taxRate: summary.taxRateSnapshot.toFixed(2), theoreticalTaxableBase: summary.theoreticalTaxableBase.toFixed(2),
        theoreticalTaxAmount: summary.theoreticalTaxAmount.toFixed(2), theoreticalTotal: summary.theoreticalTotal.toFixed(2)
      }))
    },
    ...(canViewFiscalReview && record.fiscalReview ? { fiscalReview: {
      id: record.fiscalReview.id, status: record.fiscalReview.status, version: record.fiscalReview.version,
      openedBy: record.fiscalReview.openedBy, openedAt: record.fiscalReview.openedAt.toISOString(),
      startedBy: record.fiscalReview.startedBy, startedAt: record.fiscalReview.startedAt?.toISOString() ?? null,
      decision: record.fiscalReview.decision,
      actionDueDate: record.fiscalReview.actionDueDate ? formatDateOnly(record.fiscalReview.actionDueDate) : null,
      decidedBy: record.fiscalReview.decidedBy, decidedAt: record.fiscalReview.decidedAt?.toISOString() ?? null,
      closedAt: record.fiscalReview.closedAt?.toISOString() ?? null,
      completedBy: record.fiscalReview.closedBy,
      evidenceCount: record.fiscalReview._count.evidences,
      hasLinkedAccountingEntry: Boolean(record.fiscalReview.accountingEntry),
      isOwnWaiver: record.fiscalReview.openedBy.id === actorId,
      isAssignedToActor: record.fiscalReview.startedBy?.id === actorId
    } } : {})
  };
}

function mapSummary(aggregate: {
  _count: { _all: number };
  _sum: { waivedSubtotal: Prisma.Decimal | null; waivedDiscountTotal: Prisma.Decimal | null; waivedTaxableBase: Prisma.Decimal | null; waivedTaxAmount: Prisma.Decimal | null; waivedTotal: Prisma.Decimal | null };
}): SubscriptionRenewalWaiverReportSummary {
  return {
    count: aggregate._count._all,
    subtotal: (aggregate._sum.waivedSubtotal ?? new Prisma.Decimal(0)).toFixed(2),
    discountTotal: (aggregate._sum.waivedDiscountTotal ?? new Prisma.Decimal(0)).toFixed(2),
    taxableBase: (aggregate._sum.waivedTaxableBase ?? new Prisma.Decimal(0)).toFixed(2),
    taxAmount: (aggregate._sum.waivedTaxAmount ?? new Prisma.Decimal(0)).toFixed(2),
    total: (aggregate._sum.waivedTotal ?? new Prisma.Decimal(0)).toFixed(2),
    currency: "EUR"
  };
}

function waiversCsv(waivers: SubscriptionRenewalWaiverReportItem[]): string {
  const header = [
    "naturaleza_informe", "condonada_en", "periodo_desde", "periodo_hasta_exclusivo", "suscripcion_numero", "suscripcion_nombre",
    "cliente_codigo_snapshot", "cliente_nombre_snapshot", "cliente_snapshot_origen", "motivo_codigo", "subtotal_contractual", "descuento",
    "base_imponible_teorica", "iva_teorico", "total_teorico", "desglose_iva_teorico", "moneda", "version_calculo",
    "resuelta_por", "version_anterior", "version_resultante"
  ];
  const rows = waivers.map((waiver) => [
    "INFORME_INTERNO_NO_FISCAL", waiver.waivedAt, waiver.periodStart, waiver.periodEndExclusive, waiver.subscription.number, waiver.subscription.name,
    waiver.customer.code, waiver.customer.legalName, waiver.customer.labelSource, waiver.reasonCode, waiver.valuation.subtotal,
    waiver.valuation.discountTotal, waiver.valuation.taxableBase, waiver.valuation.taxAmount, waiver.valuation.total,
    waiver.valuation.taxBreakdown.map((summary) => `${summary.taxRateCode} ${summary.taxRate}%: base ${summary.theoreticalTaxableBase}, IVA ${summary.theoreticalTaxAmount}, total ${summary.theoreticalTotal}`).join(" | "),
    waiver.valuation.currency, waiver.valuation.calculationVersion, waiver.waivedBy.displayName,
    waiver.versions.against.toString(), waiver.versions.resulting.toString()
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n");
}

function csvCell(value: string): string {
  const safe = /^[\u0000-\u0020]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

function safeAuditPayload(
  command: SubscriptionRenewalWaiverFilters & { limit?: number; cursor?: string },
  actor: SessionUser,
  companyId: string,
  resultCount: number,
  correlationId: string | undefined,
  reasonDetailAuthorized: boolean,
  reasonDetailDisclosedCount: number
): Prisma.InputJsonObject {
  return {
    actorUserId: actor.id, companyId, resultCount, reasonDetailAuthorized, reasonDetailDisclosedCount,
    ...(command.reasonCode ? { reasonCode: command.reasonCode } : {}),
    ...(command.customerId ? { customerId: command.customerId } : {}),
    ...(command.periodFrom ? { periodFrom: command.periodFrom } : {}), ...(command.periodTo ? { periodTo: command.periodTo } : {}),
    ...(command.waivedFrom ? { waivedFrom: command.waivedFrom } : {}), ...(command.waivedTo ? { waivedTo: command.waivedTo } : {}),
    hasSearch: Boolean(command.search), hasCursor: Boolean(command.cursor), ...(command.limit ? { limit: command.limit } : {}),
    ...(correlationId ? { correlationId } : {})
  };
}

async function consumeExportRateLimit(companyId: string, actor: SessionUser, correlationId?: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const key = `subscription-renewal-waiver-export:${companyId}:${actor.id}`;
    const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${key}, clock_timestamp(), 1, clock_timestamp(), clock_timestamp())
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '15 minutes' THEN 1 ELSE LEAST("rate_limit_buckets"."count" + 1, 7) END,
        "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '15 minutes' THEN clock_timestamp() ELSE "rate_limit_buckets"."windowStart" END,
        "updatedAt" = clock_timestamp()
      RETURNING "count"
    `);
    const limited = (rows[0]?.count ?? 0) > 5;
    if ((rows[0]?.count ?? 0) === 6) await tx.auditEvent.create({ data: {
      eventType: "SUBSCRIPTION_RENEWAL_WAIVERS_EXPORT_RATE_LIMITED", actorType: "USER",
      payload: { actorUserId: actor.id, companyId, ...(correlationId ? { correlationId } : {}) }
    } });
    return limited;
  });
}

function waiverFilterHash(command: SubscriptionRenewalWaiverFilters, companyId: string): string {
  return hashIdempotencyPayload("subscription-renewal-waiver-report-filters:v1", {
    companyId,
    reasonCode: command.reasonCode ?? null, customerId: command.customerId ?? null, search: command.search ?? null,
    periodFrom: command.periodFrom ?? null, periodTo: command.periodTo ?? null,
    waivedFrom: command.waivedFrom ?? null, waivedTo: command.waivedTo ?? null
  });
}

function encodeCursor(resolvedAt: Date, id: string, filterHash: string, cutoffSequence: bigint): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, resolvedAt: resolvedAt.toISOString(), id, filterHash, cutoffSequence: cutoffSequence.toString() }), "utf8").toString("base64url");
  return `${payload}.${signCursor(payload)}`;
}

function decodeCursor(value: string, filterHash: string): z.infer<typeof cursorSchema> | null {
  try {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    const expected = signCursor(payload);
    const submittedBytes = Buffer.from(signature, "base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    if (submittedBytes.length !== expectedBytes.length || !timingSafeEqual(submittedBytes, expectedBytes)) return null;
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return parsed.success && parsed.data.filterHash === filterHash ? parsed.data : null;
  } catch {
    return null;
  }
}

function signCursor(payload: string): string {
  return createHmac("sha256", getSessionSecret()).update(`subscription-renewal-waiver-report-cursor:v1:${payload}`).digest("base64url");
}

function failure(status: ReportFailure["status"], code: string, message: string): ReportFailure {
  return { ok: false, status, error: { code, message } };
}

function parseDateOnly(value: string): Date { return new Date(`${value}T00:00:00.000Z`); }
function formatDateOnly(value: Date): string { return value.toISOString().slice(0, 10); }

function madridStartOfDay(value: string): Date {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const utcMidnight = new Date(Date.UTC(year, month - 1, day));
  const firstOffset = madridOffsetMinutes(utcMidnight);
  let result = new Date(utcMidnight.getTime() - firstOffset * 60_000);
  const exactOffset = madridOffsetMinutes(result);
  if (exactOffset !== firstOffset) result = new Date(utcMidnight.getTime() - exactOffset * 60_000);
  return result;
}

function madridOffsetMinutes(value: Date): number {
  const timeZoneName = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", timeZoneName: "longOffset" })
    .formatToParts(value).find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(timeZoneName ?? "");
  if (!match) throw new Error("SUBSCRIPTION_RENEWAL_WAIVER_REPORT_TIME_ZONE_UNAVAILABLE");
  const offsetMinutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === "+" ? 1 : -1);
  return offsetMinutes;
}

function nextMadridDateOnly(value: string): Date {
  const next = parseDateOnly(value); next.setUTCDate(next.getUTCDate() + 1);
  return madridStartOfDay(formatDateOnly(next));
}
