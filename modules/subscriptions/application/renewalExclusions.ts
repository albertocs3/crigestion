import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { hashIdempotencyPayload } from "@/modules/platform/application/http";
import { getSessionSecret } from "@/modules/platform/application/environment";
import { calculateInvoiceLine, calculateInvoiceTaxSummaries, calculateInvoiceTotals } from "@/modules/billing/application/calculations";
import {
  currentSubscriptionRenewalCompanyId,
  subscriptionRenewalBusinessDate,
  subscriptionRenewalDateOnlySchema
} from "@/modules/subscriptions/application/renewals";

export const excludeSubscriptionRenewalSchema = z.object({
  companyId: z.string().uuid(),
  subscriptionId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  periodStart: subscriptionRenewalDateOnlySchema,
  processDate: subscriptionRenewalDateOnlySchema,
  reason: z.string().trim().min(3).max(500)
}).strict();

export type ExcludeSubscriptionRenewalCommand = z.infer<typeof excludeSubscriptionRenewalSchema>;
export type SubscriptionRenewalExclusionValue = {
  exclusionId: string;
  subscriptionId: string;
  periodStart: string;
  status: "RENEWAL_PENDING";
  version: number;
  excludedAt: string;
};
type ExclusionFailure = {
  ok: false;
  status: 404 | 409 | 422 | 429 | 503;
  error: { code: string; message: string };
};
export type ExcludeSubscriptionRenewalResult =
  | { ok: true; status: 201; value: SubscriptionRenewalExclusionValue }
  | ExclusionFailure;

export const waiveSubscriptionRenewalSchema = z.object({
  companyId: z.string().uuid(),
  subscriptionId: z.string().uuid(),
  exclusionId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  reasonCode: z.enum(["COMMERCIAL_WAIVER", "SERVICE_FAILURE", "OTHER"]),
  reasonDetail: z.string().trim().min(10).max(500)
}).strict();

export type WaiveSubscriptionRenewalCommand = z.infer<typeof waiveSubscriptionRenewalSchema>;
export type SubscriptionRenewalWaiverValue = {
  exclusionId: string;
  subscriptionId: string;
  resolution: "WAIVED";
  waivedPeriod: { start: string; endExclusive: string };
  status: "ACTIVE";
  nextRenewalDate: string;
  version: number;
  waivedAt: string;
  valuation: SubscriptionRenewalWaiverValuation;
  fiscalReview?: { id: string; status: "PENDING"; version: 1 };
};

type SubscriptionRenewalWaiverValuation = {
  subtotal: string;
  discountTotal: string;
  taxableBase: string;
  taxAmount: string;
  total: string;
  currency: "EUR";
  calculationVersion: "invoice-lines-v1";
  taxBreakdown: SubscriptionRenewalWaiverTaxBreakdown[];
};
type SubscriptionRenewalWaiverTaxBreakdown = {
  taxRateCode: string;
  taxRateName: string;
  taxRate: string;
  theoreticalTaxableBase: string;
  theoreticalTaxAmount: string;
  theoreticalTotal: string;
};
export type WaiveSubscriptionRenewalResult =
  | { ok: true; status: 200; value: SubscriptionRenewalWaiverValue }
  | ExclusionFailure;

const waiverValueSchema = z.object({
  exclusionId: z.string().uuid(), subscriptionId: z.string().uuid(), resolution: z.literal("WAIVED"),
  waivedPeriod: z.object({ start: subscriptionRenewalDateOnlySchema, endExclusive: subscriptionRenewalDateOnlySchema }).strict(),
  status: z.literal("ACTIVE"), nextRenewalDate: subscriptionRenewalDateOnlySchema,
  version: z.number().int().positive(), waivedAt: z.string().datetime(),
  valuation: z.object({
    subtotal: z.string().regex(/^\d+\.\d{2}$/), discountTotal: z.string().regex(/^\d+\.\d{2}$/),
    taxableBase: z.string().regex(/^\d+\.\d{2}$/), taxAmount: z.string().regex(/^\d+\.\d{2}$/),
    total: z.string().regex(/^\d+\.\d{2}$/), currency: z.literal("EUR"), calculationVersion: z.literal("invoice-lines-v1"),
    taxBreakdown: z.array(z.object({
      taxRateCode: z.string().min(1).max(40), taxRateName: z.string().min(1).max(120),
      taxRate: z.string().regex(/^\d+\.\d{2}$/), theoreticalTaxableBase: z.string().regex(/^\d+\.\d{2}$/),
      theoreticalTaxAmount: z.string().regex(/^\d+\.\d{2}$/), theoreticalTotal: z.string().regex(/^\d+\.\d{2}$/)
    }).strict()).default([])
  }).strict(),
  fiscalReview: z.object({ id: z.string().uuid(), status: z.literal("PENDING"), version: z.literal(1) }).strict().optional()
}).strict();

const optionalQueryText = z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).max(120).optional());
const optionalQueryUuid = z.preprocess((value) => value === "" ? undefined : value, z.string().uuid().optional());
const optionalQueryCursor = z.preprocess((value) => value === "" ? undefined : value, z.string().regex(/^[A-Za-z0-9_-]{20,500}\.[A-Za-z0-9_-]{40,100}$/).optional());
const optionalQueryDate = z.preprocess((value) => value === "" ? undefined : value, subscriptionRenewalDateOnlySchema.optional());
const canonicalLimit = z.preprocess(
  (value) => value === undefined ? 25 : value,
  z.union([z.number().int().min(1).max(100), z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).transform(Number)])
);

export const listSubscriptionRenewalExclusionsSchema = z.object({
  limit: canonicalLimit,
  cursor: optionalQueryCursor,
  reasonCode: z.preprocess((value) => value === "" ? undefined : value, z.enum(["MANUAL_EXCLUSION", "PREPARATION_FAILED", "LEGACY_PENDING"]).optional()),
  workState: z.preprocess((value) => value === "" ? undefined : value, z.enum(["READY", "RESERVED", "BLOCKED"]).optional()),
  customerId: optionalQueryUuid,
  search: optionalQueryText,
  periodFrom: optionalQueryDate,
  periodTo: optionalQueryDate
}).strict().superRefine((value, context) => {
  if (value.periodFrom && value.periodTo && value.periodFrom > value.periodTo) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["periodTo"], message: "La fecha final no puede ser anterior a la inicial." });
  }
});

export type ListSubscriptionRenewalExclusionsCommand = z.infer<typeof listSubscriptionRenewalExclusionsSchema>;
export type SubscriptionRenewalExclusionList = {
  exclusions: Array<{
    id: string;
    subscription: { id: string; number: string; name: string; version: number; periodicity: "MONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "ANNUAL" };
    customer: { id: string; code: string; legalName: string; status: "ACTIVE" | "INACTIVE" };
    group: { customerId: string; paymentMethod: "BANK_TRANSFER" | "CASH" | "DIRECT_DEBIT"; periodStart: string };
    periodStart: string;
    periodEndExclusive: string;
    reasonCode: "MANUAL_EXCLUSION" | "PREPARATION_FAILED" | "LEGACY_PENDING";
    hasReason: boolean;
    reason?: string;
    openedAt: string;
    openedBy: { id: string; displayName: string } | null;
    attemptCount: number;
    lastAttemptAt: string | null;
    lastErrorCode: string | null;
    work: {
      state: "READY" | "RESERVED" | "BLOCKED";
      action: "INVOICE" | "CANCEL" | null;
      blockers: string[];
      reservation: null | { id: string; invoiceId: string };
    };
    waiver: { allowed: boolean; blockers: string[]; valuation: SubscriptionRenewalWaiverValuation };
    retrySelection?: { subscriptionId: string; expectedVersion: number; pendingExclusionId: string };
  }>;
  nextCursor: string | null;
};

export type ListSubscriptionRenewalExclusionsResult =
  | { ok: true; status: 200; value: SubscriptionRenewalExclusionList }
  | { ok: false; status: 409 | 422; error: { code: string; message: string } };

const exclusionValueSchema = z.object({
  exclusionId: z.string().uuid(),
  subscriptionId: z.string().uuid(),
  periodStart: subscriptionRenewalDateOnlySchema,
  status: z.literal("RENEWAL_PENDING"),
  version: z.number().int().positive(),
  excludedAt: z.string().datetime()
}).strict();

type ExclusionContext = Pick<RequestContext, "correlationId"> & {
  idempotencyKey: string;
  requestHash: string;
};

export function hashSubscriptionRenewalExclusionRequest(command: ExcludeSubscriptionRenewalCommand): string {
  return hashIdempotencyPayload("subscription-renewal-exclusion:v1", command);
}

export function hashSubscriptionRenewalWaiverRequest(command: WaiveSubscriptionRenewalCommand): string {
  return hashIdempotencyPayload("subscription-renewal-waiver:v1", command);
}

export async function listSubscriptionRenewalExclusions(
  command: ListSubscriptionRenewalExclusionsCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<ListSubscriptionRenewalExclusionsResult> {
  const companyId = await currentSubscriptionRenewalCompanyId();
  if (!companyId) return listFailure(409, "PLATFORM_NOT_INITIALIZED", "La plataforma no esta inicializada.");
  const businessDate = parseDateOnly(await subscriptionRenewalBusinessDate());
  const fiscalYearOpen = Boolean(await prisma.accountingFiscalYear.findFirst({
    where: { companyId, status: "OPEN", startDate: { lte: businessDate }, endDate: { gte: businessDate } }, select: { id: true }
  }));
  const filters: Prisma.SubscriptionRenewalExclusionWhereInput = {
    companyId,
    status: "OPEN",
    ...(command.reasonCode ? { reasonCode: command.reasonCode } : {}),
    ...(command.periodFrom || command.periodTo ? { periodStart: {
      ...(command.periodFrom ? { gte: parseDateOnly(command.periodFrom) } : {}),
      ...(command.periodTo ? { lte: parseDateOnly(command.periodTo) } : {})
    } } : {}),
    subscription: {
      status: "RENEWAL_PENDING",
      ...(command.customerId ? { customerId: command.customerId } : {}),
      AND: [
        ...(command.search ? [{ OR: [
          { number: { contains: command.search, mode: "insensitive" as const } },
          { name: { contains: command.search, mode: "insensitive" as const } },
          { customer: { code: { contains: command.search, mode: "insensitive" as const } } },
          { customer: { legalName: { contains: command.search, mode: "insensitive" as const } } }
        ] }] : []),
        ...(command.workState === "RESERVED" ? [{ renewalReservations: { some: { status: "RESERVED" as const } } }] : []),
        ...(command.workState === "READY" ? [{
          renewalReservations: { none: { status: "RESERVED" as const } },
          OR: [
            { cancellationSchedules: { some: { status: "PENDING" as const, effectiveDate: { lte: businessDate } } } },
            ...(fiscalYearOpen ? [{ customer: { status: "ACTIVE" as const }, lines: { some: {} } }] : [])
          ]
        }] : []),
        ...(command.workState === "BLOCKED" ? [{
          renewalReservations: { none: { status: "RESERVED" as const } },
          cancellationSchedules: { none: { status: "PENDING" as const, effectiveDate: { lte: businessDate } } },
          OR: [
            { customer: { status: "INACTIVE" as const } },
            { lines: { none: {} } },
            ...(!fiscalYearOpen ? [{ id: { not: "00000000-0000-0000-0000-000000000000" } }] : [])
          ]
        }] : [])
      ]
    }
  };
  const canReadReason = actor.permissions.includes("Subscriptions.ManageRenewalExclusions");
  const filterHash = renewalPendingFilterHash(command);
  const cursor = command.cursor ? decodeRenewalPendingCursor(command.cursor, filterHash) : null;
  if (command.cursor && !cursor) return listFailure(422, "SUBSCRIPTION_RENEWAL_PENDING_CURSOR_INVALID", "El cursor de pendientes no es valido para estos filtros.");
  const cursorFilter: Prisma.SubscriptionRenewalExclusionWhereInput | undefined = cursor ? { OR: [
    { periodStart: { gt: parseDateOnly(cursor.periodStart) } },
    { periodStart: parseDateOnly(cursor.periodStart), id: { gt: cursor.id } }
  ] } : undefined;
  return prisma.$transaction(async (tx) => {
    const page = await tx.subscriptionRenewalExclusion.findMany({
      where: cursorFilter ? { AND: [filters, cursorFilter] } : filters,
      orderBy: [{ periodStart: "asc" }, { id: "asc" }],
      take: command.limit + 1,
      select: {
        id: true, periodStart: true, periodEndExclusive: true, reasonCode: true,
        ...(canReadReason ? { reasonDetail: true } : {}),
        openedAt: true, attemptCount: true, lastAttemptAt: true, lastErrorCode: true,
        openedBy: { select: { id: true, displayName: true } },
        subscription: { select: {
          id: true, number: true, name: true, version: true, periodicity: true, paymentMethod: true, endDate: true,
          customer: { select: { id: true, code: true, legalName: true, status: true } },
          lines: { orderBy: { position: "asc" }, select: {
            quantity: true, unitPrice: true, discountPercent: true, discountAmount: true,
            taxRateCodeSnapshot: true, taxRateNameSnapshot: true, taxRateSnapshot: true
          } },
          cancellationSchedules: { where: { status: "PENDING" }, select: { id: true, effectiveDate: true } },
          renewalReservations: { where: { status: "RESERVED" }, orderBy: { reservedAt: "asc" }, take: 1, select: { id: true, invoiceId: true, periodStart: true } }
        } }
      }
    });
    const hasNext = page.length > command.limit;
    const visiblePage = hasNext ? page.slice(0, command.limit) : page;
    const reasonFlags = visiblePage.length === 0 ? [] : await tx.$queryRaw<Array<{ id: string; hasReason: boolean }>>(Prisma.sql`
      SELECT "id", ("reasonDetail" IS NOT NULL) AS "hasReason"
      FROM "subscription_renewal_exclusions"
      WHERE "companyId" = ${companyId}::uuid
        AND "id" IN (${Prisma.join(visiblePage.map((item) => Prisma.sql`${item.id}::uuid`))})
    `);
    const hasReasonById = new Map(reasonFlags.map((item) => [item.id, item.hasReason]));
    const value: SubscriptionRenewalExclusionList = {
      exclusions: visiblePage.map((exclusion) => {
        const periodStart = formatDateOnly(exclusion.periodStart);
        const reservation = exclusion.subscription.renewalReservations.find((candidate) => candidate.periodStart.getTime() === exclusion.periodStart.getTime()) ?? null;
        const cancellationDue = exclusion.subscription.cancellationSchedules.some((schedule) => schedule.effectiveDate <= businessDate);
        const cancellationPending = exclusion.subscription.cancellationSchedules.length > 0;
        const blockers = cancellationDue || reservation ? [] : [
          ...(exclusion.subscription.customer.status !== "ACTIVE" ? ["CUSTOMER_NOT_ACTIVE"] : []),
          ...(exclusion.subscription.lines.length === 0 ? ["SUBSCRIPTION_RENEWAL_WITHOUT_LINES"] : []),
          ...(!fiscalYearOpen ? ["INVOICE_ACCOUNTING_FISCAL_YEAR_NOT_OPEN"] : [])
        ];
        const state = reservation ? "RESERVED" as const : blockers.length > 0 ? "BLOCKED" as const : "READY" as const;
        const reasonDetail = "reasonDetail" in exclusion ? exclusion.reasonDetail : null;
        const valuation = calculateWaiverValuation(exclusion.subscription.lines);
        const waiverBlockers = [
          ...(reservation ? ["SUBSCRIPTION_RENEWAL_ALREADY_RESERVED"] : []),
          ...(cancellationPending ? ["SUBSCRIPTION_CANCELLATION_PENDING"] : [])
        ];
        return {
          id: exclusion.id,
          subscription: { id: exclusion.subscription.id, number: exclusion.subscription.number, name: exclusion.subscription.name, version: exclusion.subscription.version, periodicity: exclusion.subscription.periodicity },
          customer: exclusion.subscription.customer,
          group: { customerId: exclusion.subscription.customer.id, paymentMethod: exclusion.subscription.paymentMethod, periodStart },
          periodStart, periodEndExclusive: formatDateOnly(exclusion.periodEndExclusive), reasonCode: exclusion.reasonCode,
          hasReason: hasReasonById.get(exclusion.id) ?? false, ...(reasonDetail ? { reason: reasonDetail } : {}),
          openedAt: exclusion.openedAt.toISOString(), openedBy: exclusion.openedBy,
          attemptCount: exclusion.attemptCount, lastAttemptAt: exclusion.lastAttemptAt?.toISOString() ?? null, lastErrorCode: exclusion.lastErrorCode,
          work: { state, action: state === "READY" ? cancellationDue ? "CANCEL" as const : "INVOICE" as const : null, blockers, reservation: reservation ? { id: reservation.id, invoiceId: reservation.invoiceId } : null },
          waiver: { allowed: waiverBlockers.length === 0, blockers: waiverBlockers, valuation },
          ...(state === "READY" ? { retrySelection: { subscriptionId: exclusion.subscription.id, expectedVersion: exclusion.subscription.version, pendingExclusionId: exclusion.id } } : {})
        };
      }),
      nextCursor: hasNext && visiblePage.length > 0 ? encodeRenewalPendingCursor(visiblePage.at(-1)!.periodStart, visiblePage.at(-1)!.id, filterHash) : null
    };
    await tx.auditEvent.create({ data: {
      eventType: "SUBSCRIPTION_RENEWAL_PENDING_VIEWED", actorType: "USER",
      payload: {
        actorUserId: actor.id, companyId, limit: command.limit, hasCursor: Boolean(command.cursor), resultCount: value.exclusions.length, hasNext,
        reasonDetailAuthorized: canReadReason, reasonDetailDisclosedCount: value.exclusions.filter((item) => item.reason !== undefined).length,
        exclusionIdsWithDisclosedReason: value.exclusions.flatMap((item) => item.reason !== undefined ? [item.id] : []),
        ...(command.reasonCode ? { reasonCode: command.reasonCode } : {}), ...(command.workState ? { workState: command.workState } : {}),
        ...(command.customerId ? { customerId: command.customerId } : {}), hasSearch: Boolean(command.search),
        ...(command.periodFrom ? { periodFrom: command.periodFrom } : {}), ...(command.periodTo ? { periodTo: command.periodTo } : {}),
        ...(context.correlationId ? { correlationId: context.correlationId } : {})
      }
    } });
    return { ok: true as const, status: 200 as const, value };
  });
}

export async function excludeSubscriptionRenewal(
  command: ExcludeSubscriptionRenewalCommand,
  actor: SessionUser,
  context: ExclusionContext
): Promise<ExcludeSubscriptionRenewalResult> {
  const semanticHash = hashSubscriptionRenewalExclusionRequest(command);
  if (context.requestHash !== semanticHash) {
    return failure(409, "IDEMPOTENCY_REQUEST_HASH_INVALID", "La huella idempotente no corresponde con la peticion.");
  }
  const today = await subscriptionRenewalBusinessDate();
  if (command.processDate > today) {
    return failure(422, "SUBSCRIPTION_RENEWAL_PROCESS_DATE_IN_FUTURE", "La fecha de proceso no puede ser futura.");
  }
  const storedExclusion = await prisma.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
  if (storedExclusion) {
    if (storedExclusion.requestHash !== semanticHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
    const replay = exclusionValueSchema.safeParse(storedExclusion.responseBody);
    if (!replay.success || storedExclusion.responseStatus !== 201) return failure(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es valida.");
    return { ok: true, status: 201, value: replay.data };
  }
  if (await consumeExclusionRateLimit(actor, command.companyId, context.correlationId)) {
    return failure(429, "SUBSCRIPTION_RENEWAL_EXCLUSION_RATE_LIMITED", "Demasiadas exclusiones. Espere quince minutos.");
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.idempotencyKey}, 0))`;
        const stored = await tx.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
        if (stored) {
          if (stored.requestHash !== semanticHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
          const replay = exclusionValueSchema.safeParse(stored.responseBody);
          if (!replay.success || stored.responseStatus !== 201) return failure(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es valida.");
          return { ok: true as const, status: 201 as const, value: replay.data };
        }
        const installation = await tx.installation.findFirst({ where: { companyId: command.companyId }, select: { companyId: true } });
        if (!installation) return failure(404, "SUBSCRIPTION_NOT_FOUND", "La suscripcion no existe.");
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "subscriptions"
          WHERE "id" = ${command.subscriptionId}::uuid AND "companyId" = ${command.companyId}::uuid
          FOR UPDATE
        `);
        const subscription = await tx.subscription.findFirst({
          where: { id: command.subscriptionId, companyId: command.companyId },
          select: {
            id: true, number: true, status: true, version: true, periodicity: true,
            nextRenewalDate: true, endDate: true,
            customer: { select: { status: true } },
            _count: { select: { lines: true } }
          }
        });
        if (!subscription) return failure(404, "SUBSCRIPTION_NOT_FOUND", "La suscripcion no existe.");
        const periodStart = formatDateOnly(subscription.nextRenewalDate);
        if (subscription.version !== command.expectedVersion) return failure(409, "SUBSCRIPTION_VERSION_CONFLICT", "La suscripcion ha cambiado desde la vista previa.");
        if (subscription.status !== "ACTIVE") return failure(409, "SUBSCRIPTION_RENEWAL_NOT_EXCLUDABLE", "Solo se puede excluir una renovacion activa.");
        if (periodStart !== command.periodStart) return failure(409, "SUBSCRIPTION_RENEWAL_PERIOD_CONFLICT", "El periodo de renovacion ha cambiado.");
        if (periodStart > command.processDate) return failure(422, "SUBSCRIPTION_RENEWAL_NOT_DUE", "La suscripcion aun no vence.");
        if (subscription.endDate && subscription.nextRenewalDate > subscription.endDate) return failure(422, "SUBSCRIPTION_RENEWAL_OUTSIDE_CONTRACT", "El periodo queda fuera de la vigencia del contrato.");
        if (subscription.customer.status !== "ACTIVE") return failure(422, "CUSTOMER_NOT_ACTIVE", "El cliente debe estar activo.");
        if (subscription._count.lines === 0) return failure(422, "SUBSCRIPTION_RENEWAL_WITHOUT_LINES", "La suscripcion no tiene lineas renovables.");

        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "subscription_cancellation_schedules"
          WHERE "subscriptionId" = ${subscription.id}::uuid AND "companyId" = ${command.companyId}::uuid AND "status" = 'PENDING'
          ORDER BY "effectiveDate", "id" FOR UPDATE
        `);
        if (await tx.subscriptionCancellationSchedule.count({
          where: { subscriptionId: subscription.id, companyId: command.companyId, status: "PENDING", effectiveDate: { lte: parseDateOnly(command.processDate) } }
        })) {
          return failure(409, "SUBSCRIPTION_CANCELLATION_DUE", "La baja vencida debe aplicarse y no puede posponerse mediante exclusion.");
        }
        if (await tx.subscriptionChangeSchedule.count({
          where: { subscriptionId: subscription.id, companyId: command.companyId, status: "PENDING" }
        })) {
          return failure(409, "SUBSCRIPTION_PENDING_CHANGE_EXISTS", "Retire el cambio programado antes de excluir la renovacion.");
        }
        if (await tx.subscriptionRenewalReservation.count({
          where: { companyId: command.companyId, subscriptionId: subscription.id, periodStart: subscription.nextRenewalDate, status: { in: ["RESERVED", "BILLED"] } }
        })) {
          return failure(409, "SUBSCRIPTION_RENEWAL_ALREADY_RESERVED", "El periodo ya esta reservado para facturacion.");
        }
        const clock = await tx.$queryRaw<Array<{ now: Date; periodEnd: Date }>>(Prisma.sql`
          SELECT clock_timestamp() AS "now",
            "subscription_next_renewal_date"(${subscription.nextRenewalDate}::date, ${subscription.periodicity}::"SubscriptionPeriodicity") AS "periodEnd"
        `);
        const excludedAt = clock[0]?.now;
        const periodEndExclusive = clock[0]?.periodEnd;
        if (!excludedAt || !periodEndExclusive) throw new Error("SUBSCRIPTION_RENEWAL_DATABASE_CLOCK_UNAVAILABLE");
        const exclusion = await tx.subscriptionRenewalExclusion.create({ data: {
          companyId: command.companyId,
          subscriptionId: subscription.id,
          periodStart: subscription.nextRenewalDate,
          periodEndExclusive,
          reasonCode: "MANUAL_EXCLUSION",
          reasonDetail: command.reason,
          openedAgainstVersion: subscription.version,
          openedById: actor.id,
          openedAt: excludedAt
        } });
        const updated = await tx.subscription.update({
          where: { id: subscription.id },
          data: { status: "RENEWAL_PENDING", version: { increment: 1 }, updatedById: actor.id },
          select: { version: true }
        });
        const value: SubscriptionRenewalExclusionValue = {
          exclusionId: exclusion.id,
          subscriptionId: subscription.id,
          periodStart,
          status: "RENEWAL_PENDING",
          version: updated.version,
          excludedAt: excludedAt.toISOString()
        };
        await tx.auditEvent.create({ data: {
          eventType: "SUBSCRIPTION_RENEWAL_EXCLUDED", actorType: "USER",
          payload: {
            actorUserId: actor.id, companyId: command.companyId, subscriptionId: subscription.id,
            exclusionId: exclusion.id, periodStart, reasonCode: "MANUAL_EXCLUSION",
            previousVersion: subscription.version, subscriptionVersion: updated.version,
            ...(context.correlationId ? { correlationId: context.correlationId } : {})
          }
        } });
        await tx.idempotencyRecord.create({ data: {
          key: context.idempotencyKey,
          requestHash: semanticHash,
          responseStatus: 201,
          responseBody: value as Prisma.InputJsonValue
        } });
        return { ok: true as const, status: 201 as const, value };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isRetryableTransactionError(error)) {
        if (attempt < 2) continue;
        return failure(503, "SUBSCRIPTION_RENEWAL_BUSY", "La renovacion esta ocupada; vuelva a intentarlo.");
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return failure(409, "SUBSCRIPTION_RENEWAL_ALREADY_EXCLUDED", "El periodo ya tiene una exclusion registrada.");
      }
      throw error;
    }
  }
  throw new Error("SUBSCRIPTION_RENEWAL_EXCLUSION_RETRY_EXHAUSTED");
}

export async function waiveSubscriptionRenewal(
  command: WaiveSubscriptionRenewalCommand,
  actor: SessionUser,
  context: ExclusionContext
): Promise<WaiveSubscriptionRenewalResult> {
  const semanticHash = hashSubscriptionRenewalWaiverRequest(command);
  if (context.requestHash !== semanticHash) return failure(409, "IDEMPOTENCY_REQUEST_HASH_INVALID", "La huella idempotente no corresponde con la peticion.");
  const storedWaiver = await prisma.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
  if (storedWaiver) {
    if (storedWaiver.requestHash !== semanticHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
    const replay = waiverValueSchema.safeParse(storedWaiver.responseBody);
    if (!replay.success || storedWaiver.responseStatus !== 200) return failure(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es valida.");
    return { ok: true, status: 200, value: replay.data };
  }
  if (await consumeWaiverRateLimit(actor, command.companyId, context.correlationId)) {
    return failure(429, "SUBSCRIPTION_RENEWAL_WAIVER_RATE_LIMITED", "Demasiadas condonaciones. Espere quince minutos.");
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.idempotencyKey}, 0))`;
        const stored = await tx.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
        if (stored) {
          if (stored.requestHash !== semanticHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
          const replay = waiverValueSchema.safeParse(stored.responseBody);
          if (!replay.success || stored.responseStatus !== 200) return failure(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es valida.");
          return { ok: true as const, status: 200 as const, value: replay.data };
        }
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'subscription-renewal-waiver-cutoff:' + command.companyId}, 0))`;
        await tx.$queryRaw`SELECT subscription."id"
          FROM "subscriptions" subscription
          JOIN "customers" customer ON customer."id" = subscription."customerId"
          WHERE subscription."id" = ${command.subscriptionId}::uuid AND subscription."companyId" = ${command.companyId}::uuid
          FOR UPDATE OF subscription, customer`;
        await tx.$queryRaw`SELECT "id" FROM "subscription_cancellation_schedules" WHERE "subscriptionId" = ${command.subscriptionId}::uuid AND "companyId" = ${command.companyId}::uuid AND "status" = 'PENDING' ORDER BY "id" FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "subscription_renewal_exclusions" WHERE "id" = ${command.exclusionId}::uuid AND "subscriptionId" = ${command.subscriptionId}::uuid AND "companyId" = ${command.companyId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "subscription_renewal_reservations" WHERE "subscriptionId" = ${command.subscriptionId}::uuid AND "companyId" = ${command.companyId}::uuid ORDER BY "id" FOR UPDATE`;
        const subscription = await tx.subscription.findFirst({
          where: { id: command.subscriptionId, companyId: command.companyId },
          select: {
            id: true, status: true, version: true, nextRenewalDate: true, customerId: true,
            customer: { select: { id: true, code: true, legalName: true } },
            lines: { orderBy: { position: "asc" }, select: {
              quantity: true, unitPrice: true, discountPercent: true, discountAmount: true,
              taxRateCodeSnapshot: true, taxRateNameSnapshot: true, taxRateSnapshot: true
            } }
          }
        });
        const exclusion = await tx.subscriptionRenewalExclusion.findFirst({
          where: { id: command.exclusionId, companyId: command.companyId, subscriptionId: command.subscriptionId },
          select: { id: true, status: true, periodStart: true, periodEndExclusive: true }
        });
        if (!subscription || !exclusion) return failure(404, "SUBSCRIPTION_RENEWAL_PENDING_NOT_FOUND", "El expediente pendiente no existe.");
        if (subscription.version !== command.expectedVersion) return failure(409, "SUBSCRIPTION_VERSION_CONFLICT", "La suscripcion ha cambiado desde la consulta.");
        if (subscription.status !== "RENEWAL_PENDING" || exclusion.status !== "OPEN" || exclusion.periodStart.getTime() !== subscription.nextRenewalDate.getTime()) {
          return failure(409, "SUBSCRIPTION_RENEWAL_NOT_WAIVABLE", "El expediente ya no se puede condonar.");
        }
        if (await tx.subscriptionCancellationSchedule.count({ where: { companyId: command.companyId, subscriptionId: command.subscriptionId, status: "PENDING" } })) {
          return failure(409, "SUBSCRIPTION_CANCELLATION_PENDING", "La baja pendiente debe resolverse antes de condonar el periodo.");
        }
        const activeReservations = await tx.subscriptionRenewalReservation.findMany({
          where: { companyId: command.companyId, subscriptionId: command.subscriptionId, periodStart: exclusion.periodStart, status: { in: ["RESERVED", "BILLED"] } },
          select: { status: true }
        });
        if (activeReservations.some((reservation) => reservation.status === "BILLED")) return failure(409, "SUBSCRIPTION_RENEWAL_ALREADY_BILLED", "El periodo ya esta facturado.");
        if (activeReservations.length > 0) return failure(409, "SUBSCRIPTION_RENEWAL_ALREADY_RESERVED", "Libere primero la reserva de facturacion.");
        const valuation = calculateWaiverValuation(subscription.lines);
        const sequenceRows = await tx.$queryRaw<Array<{ value: bigint }>>`SELECT nextval('subscription_renewal_waiver_sequence') AS "value"`;
        const waiverSequence = sequenceRows[0]?.value;
        if (waiverSequence === undefined) throw new Error("SUBSCRIPTION_RENEWAL_WAIVER_SEQUENCE_UNAVAILABLE");
        const clock = await tx.$queryRaw<Array<{ waivedAt: Date }>>`SELECT clock_timestamp() AS "waivedAt"`;
        const waivedAt = clock[0]?.waivedAt;
        if (!waivedAt) throw new Error("SUBSCRIPTION_RENEWAL_DATABASE_CLOCK_UNAVAILABLE");
        await tx.subscriptionRenewalWaiverSnapshot.create({ data: {
          exclusionId: exclusion.id, companyId: command.companyId, customerId: subscription.customerId,
          customerCodeSnapshot: subscription.customer.code,
          customerLegalNameSnapshot: subscription.customer.legalName,
          source: "CAPTURED_AT_WAIVER", currency: valuation.currency, capturedAt: waivedAt
        } });
        await tx.subscriptionRenewalWaiverTaxSummary.createMany({ data: valuation.taxBreakdown.map((summary) => ({
          exclusionId: exclusion.id, companyId: command.companyId,
          taxRateCodeSnapshot: summary.taxRateCode, taxRateNameSnapshot: summary.taxRateName,
          taxRateSnapshot: summary.taxRate, theoreticalTaxableBase: summary.theoreticalTaxableBase,
          theoreticalTaxAmount: summary.theoreticalTaxAmount, theoreticalTotal: summary.theoreticalTotal
        })) });
        await tx.subscriptionRenewalExclusion.update({ where: { id: exclusion.id }, data: {
          status: "RESOLVED", resolvedAt: waivedAt, resolvedById: actor.id, resolution: "WAIVED",
          resolvedInvoiceId: null, resolutionReasonCode: command.reasonCode,
          resolutionReasonDetail: command.reasonDetail, resolvedAgainstVersion: subscription.version,
          resolvedSubscriptionVersion: subscription.version + 1,
          waivedSubtotal: valuation.subtotal, waivedDiscountTotal: valuation.discountTotal,
          waivedTaxableBase: valuation.taxableBase, waivedTaxAmount: valuation.taxAmount,
          waivedTotal: valuation.total, waiverCalculationVersion: valuation.calculationVersion,
          waiverSequence,
          lastErrorCode: null
        } });
        const fiscalReview = await tx.subscriptionRenewalWaiverReview.create({ data: {
          companyId: command.companyId, exclusionId: exclusion.id, source: "CURRENT_WORKFLOW",
          openedById: actor.id, openedAt: waivedAt
        }, select: { id: true, status: true, version: true } });
        await tx.subscriptionRenewalWaiverReviewEvent.create({ data: {
          companyId: command.companyId, reviewId: fiscalReview.id, type: "OPENED", reviewVersion: 1,
          actorId: actor.id, occurredAt: waivedAt, correlationId: context.correlationId
        } });
        const updated = await tx.subscription.update({ where: { id: subscription.id }, data: {
          status: "ACTIVE", nextRenewalDate: exclusion.periodEndExclusive, version: { increment: 1 }, updatedById: actor.id
        }, select: { version: true, nextRenewalDate: true } });
        const value: SubscriptionRenewalWaiverValue = {
          exclusionId: exclusion.id, subscriptionId: subscription.id, resolution: "WAIVED",
          waivedPeriod: { start: formatDateOnly(exclusion.periodStart), endExclusive: formatDateOnly(exclusion.periodEndExclusive) },
          status: "ACTIVE", nextRenewalDate: formatDateOnly(updated.nextRenewalDate), version: updated.version,
          waivedAt: waivedAt.toISOString(), valuation,
          fiscalReview: { id: fiscalReview.id, status: "PENDING", version: 1 }
        };
        await tx.auditEvent.create({ data: {
          eventType: "SUBSCRIPTION_RENEWAL_PERIOD_WAIVED", actorType: "USER",
          payload: {
            actorUserId: actor.id, companyId: command.companyId, subscriptionId: subscription.id, exclusionId: exclusion.id,
            periodStart: value.waivedPeriod.start, periodEndExclusive: value.waivedPeriod.endExclusive,
            previousVersion: subscription.version, subscriptionVersion: updated.version,
            resolutionReasonCode: command.reasonCode, waivedTotal: valuation.total,
            currency: valuation.currency, calculationVersion: valuation.calculationVersion,
            ...(context.correlationId ? { correlationId: context.correlationId } : {})
          }
        } });
        await tx.idempotencyRecord.create({ data: {
          key: context.idempotencyKey, requestHash: semanticHash, responseStatus: 200,
          responseBody: value as Prisma.InputJsonValue
        } });
        return { ok: true as const, status: 200 as const, value };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isRetryableTransactionError(error)) {
        if (attempt < 2) continue;
        return failure(503, "SUBSCRIPTION_RENEWAL_BUSY", "La renovacion esta ocupada; vuelva a intentarlo.");
      }
      throw error;
    }
  }
  throw new Error("SUBSCRIPTION_RENEWAL_WAIVER_RETRY_EXHAUSTED");
}

export async function renewalExclusionCompanyId(): Promise<string | null> {
  return currentSubscriptionRenewalCompanyId();
}

async function consumeExclusionRateLimit(actor: SessionUser, companyId: string, correlationId?: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const key = `subscription-renewal-exclude:${companyId}:${actor.id}`;
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
    const limited = (rows[0]?.count ?? 0) > 20;
    if (limited) {
      await tx.auditEvent.create({ data: {
        eventType: "SUBSCRIPTION_RENEWAL_EXCLUSION_RATE_LIMITED", actorType: "USER",
        payload: { actorUserId: actor.id, companyId, ...(correlationId ? { correlationId } : {}) }
      } });
    }
    return limited;
  });
}

async function consumeWaiverRateLimit(actor: SessionUser, companyId: string, correlationId?: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const key = `subscription-renewal-waive:${companyId}:${actor.id}`;
    const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${key}, clock_timestamp(), 1, clock_timestamp(), clock_timestamp())
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '15 minutes' THEN 1 ELSE "rate_limit_buckets"."count" + 1 END,
        "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '15 minutes' THEN clock_timestamp() ELSE "rate_limit_buckets"."windowStart" END,
        "updatedAt" = clock_timestamp()
      RETURNING "count"
    `);
    const limited = (rows[0]?.count ?? 0) > 10;
    if (limited) await tx.auditEvent.create({ data: {
      eventType: "SUBSCRIPTION_RENEWAL_WAIVER_RATE_LIMITED", actorType: "USER",
      payload: { actorUserId: actor.id, companyId, ...(correlationId ? { correlationId } : {}) }
    } });
    return limited;
  });
}

const renewalPendingCursorSchema = z.object({
  v: z.literal(1),
  periodStart: subscriptionRenewalDateOnlySchema,
  id: z.string().uuid(),
  filterHash: z.string().length(64)
}).strict();

function renewalPendingFilterHash(command: ListSubscriptionRenewalExclusionsCommand): string {
  return hashIdempotencyPayload("subscription-renewal-pending-filters:v1", {
    reasonCode: command.reasonCode ?? null,
    workState: command.workState ?? null,
    customerId: command.customerId ?? null,
    search: command.search ?? null,
    periodFrom: command.periodFrom ?? null,
    periodTo: command.periodTo ?? null
  });
}

function encodeRenewalPendingCursor(periodStart: Date, id: string, filterHash: string): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, periodStart: formatDateOnly(periodStart), id, filterHash }), "utf8").toString("base64url");
  return `${payload}.${signRenewalPendingCursor(payload)}`;
}

function decodeRenewalPendingCursor(value: string, filterHash: string): z.infer<typeof renewalPendingCursorSchema> | null {
  try {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    const expectedSignature = signRenewalPendingCursor(payload);
    const submittedBytes = Buffer.from(signature, "base64url");
    const expectedBytes = Buffer.from(expectedSignature, "base64url");
    if (submittedBytes.length !== expectedBytes.length || !timingSafeEqual(submittedBytes, expectedBytes)) return null;
    const parsed = renewalPendingCursorSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return parsed.success && parsed.data.filterHash === filterHash ? parsed.data : null;
  } catch {
    return null;
  }
}

function signRenewalPendingCursor(payload: string): string {
  return createHmac("sha256", getSessionSecret()).update(`subscription-renewal-pending-cursor:v1:${payload}`).digest("base64url");
}

function failure(status: ExclusionFailure["status"], code: string, message: string): ExclusionFailure {
  return { ok: false, status, error: { code, message } };
}

function listFailure(status: 409 | 422, code: string, message: string): ListSubscriptionRenewalExclusionsResult {
  return { ok: false, status, error: { code, message } };
}

function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function calculateWaiverValuation(lines: Array<{
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  discountPercent: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  taxRateCodeSnapshot: string;
  taxRateNameSnapshot: string;
  taxRateSnapshot: Prisma.Decimal;
}>): SubscriptionRenewalWaiverValuation {
  const calculatedLines = lines.map((line) => ({
    taxRateCode: line.taxRateCodeSnapshot,
    taxRate: line.taxRateSnapshot,
    taxRateName: line.taxRateNameSnapshot,
    ...calculateInvoiceLine({
      quantity: line.quantity, unitPrice: line.unitPrice,
      discountPercent: line.discountPercent, discountAmount: line.discountAmount,
      taxRate: line.taxRateSnapshot
    })
  }));
  const totals = calculateInvoiceTotals(calculatedLines);
  const namesByRate = new Map(calculatedLines.map((line) => [`${line.taxRateCode}:${line.taxRate.toFixed(2)}`, line.taxRateName]));
  const taxBreakdown = calculateInvoiceTaxSummaries(calculatedLines).map((summary) => ({
    taxRateCode: summary.taxRateCode,
    taxRateName: namesByRate.get(`${summary.taxRateCode}:${summary.taxRate.toFixed(2)}`) ?? summary.taxRateCode,
    taxRate: summary.taxRate.toFixed(2), theoreticalTaxableBase: summary.taxableBase.toFixed(2),
    theoreticalTaxAmount: summary.taxAmount.toFixed(2), theoreticalTotal: summary.total.toFixed(2)
  }));
  return {
    subtotal: totals.subtotal.toFixed(2), discountTotal: totals.discountTotal.toFixed(2),
    taxableBase: totals.taxableBase.toFixed(2), taxAmount: totals.taxAmount.toFixed(2),
    total: totals.total.toFixed(2), currency: "EUR", calculationVersion: "invoice-lines-v1", taxBreakdown
  };
}

function isRetryableTransactionError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001");
}
