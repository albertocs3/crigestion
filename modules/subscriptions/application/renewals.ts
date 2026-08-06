import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  createSubscriptionRenewalDraftInTransaction,
  type SubscriptionRenewalDraftResult
} from "@/modules/billing/application/subscriptionRenewalDrafts";
import { calculateInvoiceLine } from "@/modules/billing/application/calculations";
import {
  isVerifactuPreparationUnavailableError,
  issueSubscriptionRenewalInvoiceInTransaction,
  type IssueInvoiceDependencies
} from "@/modules/billing/application/invoices";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { hashIdempotencyPayload } from "@/modules/platform/application/http";
import { resolveScheduledCancellationBeforeRenewal } from "@/modules/subscriptions/application/subscriptions";
import {
  materializePreparationFailure,
  recordConfirmationAttempt,
  recordFailedConfirmationAfterRollback,
  recordSuccessfulPreparationAttempt
} from "@/modules/subscriptions/application/renewalAttempts";

export const subscriptionRenewalDateOnlySchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "La fecha no es valida.");

export const createSubscriptionRenewalDraftSchema = z.object({
  companyId: z.string().uuid(),
  subscriptionIds: z.array(z.string().uuid()).min(1).max(100),
  expectedVersions: z.record(z.string().uuid(), z.number().int().positive()).optional(),
  pendingExclusionIds: z.record(z.string().uuid(), z.string().uuid()).optional(),
  issueDate: subscriptionRenewalDateOnlySchema
}).strict().superRefine((value, context) => {
  if (new Set(value.subscriptionIds).size !== value.subscriptionIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["subscriptionIds"], message: "No se puede repetir una suscripcion." });
  }
  if (value.expectedVersions) {
    const ids = [...value.subscriptionIds].sort();
    const versionIds = Object.keys(value.expectedVersions).sort();
    if (ids.length !== versionIds.length || ids.some((id, index) => id !== versionIds[index])) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedVersions"], message: "Las versiones deben corresponder con todas las suscripciones." });
    }
  }
  if (value.pendingExclusionIds && Object.keys(value.pendingExclusionIds).some((id) => !value.subscriptionIds.includes(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["pendingExclusionIds"], message: "Las exclusiones deben corresponder con las suscripciones seleccionadas." });
  }
});

export type CreateSubscriptionRenewalDraftCommand = z.infer<typeof createSubscriptionRenewalDraftSchema>;
export const confirmSubscriptionRenewalSchema = z.object({
  companyId: z.string().uuid(),
  invoiceId: z.string().uuid()
}).strict();
export type ConfirmSubscriptionRenewalCommand = z.infer<typeof confirmSubscriptionRenewalSchema>;
export const releaseSubscriptionRenewalSchema = z.object({
  companyId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500)
}).strict();
export type ReleaseSubscriptionRenewalCommand = z.infer<typeof releaseSubscriptionRenewalSchema>;
export type SubscriptionRenewalDraftValue = {
  invoiceId: string | null;
  reservationIds: string[];
  cancelledSubscriptionIds: string[];
  lineCount: number;
  total: string;
};
type RenewalFailure = { ok: false; status: 404 | 409 | 422 | 429 | 503; error: { code: string; message: string } };
export type CreateSubscriptionRenewalDraftResult =
  | { ok: true; status: 200 | 201; value: SubscriptionRenewalDraftValue }
  | RenewalFailure;
type RenewalContext = Pick<RequestContext, "correlationId"> & { idempotencyKey: string; requestHash: string };
const renewalValueSchema = z.object({
  invoiceId: z.string().uuid().nullable(),
  reservationIds: z.array(z.string().uuid()),
  cancelledSubscriptionIds: z.array(z.string().uuid()),
  lineCount: z.number().int().nonnegative(),
  total: z.string().regex(/^\d+\.\d{2}$/)
}).strict();
const renewalFailureValueSchema = z.object({ code: z.string().min(1), message: z.string().min(1) }).strict();
const renewalConfirmationValueSchema = z.object({
  invoiceId: z.string().uuid(),
  number: z.string().min(1),
  billedAt: z.string().datetime(),
  subscriptions: z.array(z.object({
    id: z.string().uuid(),
    nextRenewalDate: subscriptionRenewalDateOnlySchema,
    version: z.number().int().positive()
  }).strict()).min(1)
}).strict();
export type SubscriptionRenewalConfirmationValue = z.infer<typeof renewalConfirmationValueSchema>;
export type ConfirmSubscriptionRenewalResult =
  | { ok: true; status: 200; value: SubscriptionRenewalConfirmationValue }
  | RenewalFailure;
export type ReleaseSubscriptionRenewalValue = {
  invoiceId: string;
  releasedReservationIds: string[];
  subscriptionIds: string[];
  releasedAt: string;
};
export type ReleaseSubscriptionRenewalResult =
  | { ok: true; status: 200; value: ReleaseSubscriptionRenewalValue }
  | RenewalFailure;
const releaseRenewalValueSchema = z.object({
  invoiceId: z.string().uuid(), releasedReservationIds: z.array(z.string().uuid()).min(1),
  subscriptionIds: z.array(z.string().uuid()).min(1), releasedAt: z.string().datetime()
}).strict();

export const listSubscriptionRenewalPreviewSchema = z.object({
  processDate: subscriptionRenewalDateOnlySchema,
  includePending: z.boolean().default(false)
}).strict();
export type ListSubscriptionRenewalPreviewCommand = z.infer<typeof listSubscriptionRenewalPreviewSchema>;
export type SubscriptionRenewalPreview = {
  processDate: string;
  groups: Array<{
    key: string;
    customer: { id: string; code: string; legalName: string };
    paymentMethod: "BANK_TRANSFER" | "CASH" | "DIRECT_DEBIT";
    periodStart: string;
    estimatedTotal: string;
    selectable: boolean;
    subscriptions: Array<{
      id: string; number: string; name: string; status: "ACTIVE" | "RENEWAL_PENDING";
      periodicity: "MONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "ANNUAL";
      version: number; estimatedTotal: string; action: "INVOICE" | "CANCEL";
      pending: null | {
        exclusionId: string; reasonCode: "MANUAL_EXCLUSION" | "PREPARATION_FAILED" | "LEGACY_PENDING"; hasReason: boolean;
        reason?: string; excludedAt: string; excludedBy: { id: string; displayName: string } | null;
        attemptCount: number; lastAttemptAt: string | null; lastErrorCode: string | null;
      };
    }>;
  }>;
  reservedInvoices: Array<{
    invoiceId: string; issueDate: string; customer: { id: string; code: string; legalName: string };
    paymentMethod: "BANK_TRANSFER" | "CASH" | "DIRECT_DEBIT";
    subscriptionCount: number; total: string; reservedAt: string;
  }>;
};
export type ListSubscriptionRenewalPreviewResult =
  | { ok: true; status: 200; value: SubscriptionRenewalPreview }
  | { ok: false; status: 409 | 422; error: { code: string; message: string } };

class RenewalFunctionalRollback extends Error {
  constructor(readonly result: RenewalFailure) {
    super(result.error.code);
  }
}

export function hashSubscriptionRenewalDraftRequest(command: CreateSubscriptionRenewalDraftCommand): string {
  return hashIdempotencyPayload("subscription-renewal-draft:v1", {
    ...command,
    subscriptionIds: [...command.subscriptionIds].sort(),
    expectedVersions: command.expectedVersions
      ? Object.fromEntries(Object.entries(command.expectedVersions).sort(([left], [right]) => left.localeCompare(right)))
      : undefined,
    pendingExclusionIds: command.pendingExclusionIds
      ? Object.fromEntries(Object.entries(command.pendingExclusionIds).sort(([left], [right]) => left.localeCompare(right)))
      : undefined
  });
}

export function hashSubscriptionRenewalConfirmationRequest(command: ConfirmSubscriptionRenewalCommand): string {
  return hashIdempotencyPayload("subscription-renewal-confirmation:v1", command);
}

export function hashSubscriptionRenewalReleaseRequest(command: ReleaseSubscriptionRenewalCommand): string {
  return hashIdempotencyPayload("subscription-renewal-release:v1", command);
}

export async function currentSubscriptionRenewalCompanyId(): Promise<string | null> {
  return (await prisma.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId ?? null;
}

export async function subscriptionRenewalBusinessDate(): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ businessDate: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'Europe/Madrid')::date AS "businessDate"
  `;
  const businessDate = rows[0]?.businessDate;
  if (!businessDate) throw new Error("SUBSCRIPTION_RENEWAL_DATABASE_CLOCK_UNAVAILABLE");
  return formatDateOnly(businessDate);
}

export async function listSubscriptionRenewalPreview(
  command: ListSubscriptionRenewalPreviewCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<ListSubscriptionRenewalPreviewResult> {
  const today = await subscriptionRenewalBusinessDate();
  if (command.processDate > today) {
    return { ok: false, status: 422, error: { code: "SUBSCRIPTION_RENEWAL_PROCESS_DATE_IN_FUTURE", message: "La fecha de proceso no puede ser futura." } };
  }
  const companyId = await currentSubscriptionRenewalCompanyId();
  if (!companyId) {
    return { ok: false, status: 409, error: { code: "PLATFORM_NOT_INITIALIZED", message: "La plataforma no esta inicializada." } };
  }
  const processDate = parseDateOnly(command.processDate);
  const candidates = await prisma.$queryRaw<Array<{ id: string; candidateCount: number }>>(Prisma.sql`
    WITH eligible AS (
      SELECT s."id", s."customerId", s."paymentMethod", s."nextRenewalDate"
      FROM "subscriptions" s
      JOIN "customers" c ON c."id" = s."customerId"
      WHERE s."companyId" = ${companyId}::uuid
        AND (s."status"::text = 'ACTIVE' OR (${command.includePending} AND s."status"::text = 'RENEWAL_PENDING' AND EXISTS (
          SELECT 1 FROM "subscription_renewal_exclusions" exclusion
          WHERE exclusion."companyId" = s."companyId" AND exclusion."subscriptionId" = s."id"
            AND exclusion."periodStart" = s."nextRenewalDate" AND exclusion."status"::text = 'OPEN'
        )))
        AND s."nextRenewalDate" <= ${processDate}::date
        AND (s."endDate" IS NULL OR s."nextRenewalDate" <= s."endDate")
        AND c."status"::text = 'ACTIVE'
        AND EXISTS (SELECT 1 FROM "subscription_lines" line WHERE line."subscriptionId" = s."id")
        AND NOT EXISTS (
          SELECT 1 FROM "subscription_renewal_reservations" reservation
          WHERE reservation."companyId" = s."companyId"
            AND reservation."subscriptionId" = s."id"
            AND reservation."periodStart" = s."nextRenewalDate"
            AND reservation."status"::text IN ('RESERVED', 'BILLED')
        )
    ), group_keys AS (
      SELECT "customerId", "paymentMethod", "nextRenewalDate"
      FROM eligible
      GROUP BY "customerId", "paymentMethod", "nextRenewalDate"
      ORDER BY "customerId", "paymentMethod", "nextRenewalDate"
      LIMIT 25
    ), bounded AS (
      SELECT eligible."id",
        count(*) OVER (PARTITION BY eligible."customerId", eligible."paymentMethod", eligible."nextRenewalDate")::int AS "candidateCount",
        row_number() OVER (PARTITION BY eligible."customerId", eligible."paymentMethod", eligible."nextRenewalDate" ORDER BY eligible."id") AS position
      FROM eligible
      JOIN group_keys USING ("customerId", "paymentMethod", "nextRenewalDate")
    )
    SELECT "id", "candidateCount" FROM bounded WHERE position <= 100 ORDER BY "id"
  `);
  const candidateCounts = new Map(candidates.map((candidate) => [candidate.id, candidate.candidateCount]));
  const subscriptions = await prisma.subscription.findMany({
    where: { id: { in: candidates.map((candidate) => candidate.id) }, companyId },
    orderBy: [{ customerId: "asc" }, { paymentMethod: "asc" }, { nextRenewalDate: "asc" }, { id: "asc" }],
    select: {
      id: true, number: true, name: true, status: true, periodicity: true, paymentMethod: true,
      nextRenewalDate: true, endDate: true, version: true,
      customer: { select: { id: true, code: true, legalName: true } },
      lines: { select: { quantity: true, unitPrice: true, discountPercent: true, discountAmount: true, taxRateSnapshot: true } },
      cancellationSchedules: { where: { status: "PENDING", effectiveDate: { lte: processDate } }, take: 1, select: { id: true } },
      renewalExclusions: {
        where: { status: "OPEN" }, take: 1,
        select: {
          id: true, reasonCode: true, reasonDetail: true, openedAt: true, attemptCount: true,
          lastAttemptAt: true, lastErrorCode: true,
          openedBy: { select: { id: true, displayName: true } }
        }
      }
    }
  });
  const grouped = new Map<string, SubscriptionRenewalPreview["groups"][number]>();
  for (const subscription of subscriptions) {
    if (subscription.status !== "ACTIVE" && subscription.status !== "RENEWAL_PENDING") continue;
    const periodStart = formatDateOnly(subscription.nextRenewalDate);
    const total = subscription.lines.reduce((sum, line) => sum.plus(calculateInvoiceLine({
      quantity: line.quantity, unitPrice: line.unitPrice, discountPercent: line.discountPercent,
      discountAmount: line.discountAmount, taxRate: line.taxRateSnapshot
    }).lineTotal), new Prisma.Decimal(0));
    const key = `${subscription.customer.id}:${subscription.paymentMethod}:${periodStart}`;
    const group = grouped.get(key) ?? {
      key, customer: subscription.customer, paymentMethod: subscription.paymentMethod,
      periodStart, estimatedTotal: "0.00", selectable: true, subscriptions: []
    };
    group.subscriptions.push({
      id: subscription.id, number: subscription.number, name: subscription.name, status: subscription.status,
      periodicity: subscription.periodicity, version: subscription.version, estimatedTotal: total.toFixed(2),
      action: subscription.cancellationSchedules.length > 0 ? "CANCEL" : "INVOICE",
      pending: subscription.renewalExclusions[0] ? {
        exclusionId: subscription.renewalExclusions[0].id,
        reasonCode: subscription.renewalExclusions[0].reasonCode,
        hasReason: Boolean(subscription.renewalExclusions[0].reasonDetail),
        ...(actor.permissions.includes("Subscriptions.ManageRenewalExclusions") && subscription.renewalExclusions[0].reasonDetail
          ? { reason: subscription.renewalExclusions[0].reasonDetail } : {}),
        excludedAt: subscription.renewalExclusions[0].openedAt.toISOString(),
        excludedBy: subscription.renewalExclusions[0].openedBy,
        attemptCount: subscription.renewalExclusions[0].attemptCount,
        lastAttemptAt: subscription.renewalExclusions[0].lastAttemptAt?.toISOString() ?? null,
        lastErrorCode: subscription.renewalExclusions[0].lastErrorCode
      } : null
    });
    if (subscription.cancellationSchedules.length === 0) {
      group.estimatedTotal = new Prisma.Decimal(group.estimatedTotal).plus(total).toFixed(2);
    }
    grouped.set(key, group);
  }
  for (const group of grouped.values()) {
    group.selectable = group.subscriptions.every((subscription) => (candidateCounts.get(subscription.id) ?? 0) <= 100);
  }
  const reservedRows = await prisma.invoice.findMany({
    where: { companyId, origin: "SUBSCRIPTION", status: "DRAFT", subscriptionRenewalReservations: { some: { status: "RESERVED" } } },
    orderBy: [{ issueDate: "asc" }, { id: "asc" }],
    take: 100,
    select: {
      id: true, issueDate: true, total: true, customerId: true, customerCodeSnapshot: true,
      customerLegalNameSnapshot: true, dueDates: { take: 1, select: { paymentMethod: true } },
      subscriptionRenewalReservations: { where: { status: "RESERVED" }, orderBy: { reservedAt: "asc" }, select: { reservedAt: true } }
    }
  });
  const value: SubscriptionRenewalPreview = {
    processDate: command.processDate,
    groups: [...grouped.values()],
    reservedInvoices: reservedRows.map((invoice) => ({
      invoiceId: invoice.id, issueDate: formatDateOnly(invoice.issueDate),
      customer: { id: invoice.customerId!, code: invoice.customerCodeSnapshot, legalName: invoice.customerLegalNameSnapshot },
      paymentMethod: invoice.dueDates[0]?.paymentMethod ?? "BANK_TRANSFER",
      subscriptionCount: invoice.subscriptionRenewalReservations.length, total: invoice.total.toFixed(2),
      reservedAt: invoice.subscriptionRenewalReservations[0]!.reservedAt.toISOString()
    }))
  };
  await prisma.auditEvent.create({ data: {
    eventType: "SUBSCRIPTION_RENEWAL_PREVIEW_VIEWED", actorType: "USER",
    payload: { actorUserId: actor.id, companyId, processDate: command.processDate, includePending: command.includePending,
      groupCount: value.groups.length, candidateCount: value.groups.reduce((count, group) => count + group.subscriptions.length, 0),
      reservedInvoiceCount: value.reservedInvoices.length, ...(context.correlationId ? { correlationId: context.correlationId } : {}) }
  } });
  return { ok: true, status: 200, value };
}

export async function releaseSubscriptionRenewal(
  command: ReleaseSubscriptionRenewalCommand,
  actor: SessionUser,
  context: RenewalContext
): Promise<ReleaseSubscriptionRenewalResult> {
  const semanticHash = hashSubscriptionRenewalReleaseRequest(command);
  if (context.requestHash !== semanticHash) {
    return failure(409, "IDEMPOTENCY_REQUEST_HASH_INVALID", "La huella idempotente no corresponde con la peticion.");
  }
  const storedRelease = await prisma.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
  if (storedRelease) {
    if (storedRelease.requestHash !== semanticHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
    const replay = releaseRenewalValueSchema.safeParse(storedRelease.responseBody);
    if (!replay.success || storedRelease.responseStatus !== 200) return failure(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es valida.");
    return { ok: true, status: 200, value: replay.data };
  }
  if (await consumePersistentRenewalRateLimit(actor, command.companyId, "release", 10, context.correlationId)) {
    return failure(429, "SUBSCRIPTION_RENEWAL_RATE_LIMITED", "Demasiadas liberaciones. Espere quince minutos.");
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.idempotencyKey}, 0))`;
        const stored = await tx.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
        if (stored) {
          if (stored.requestHash !== semanticHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
          const replay = releaseRenewalValueSchema.safeParse(stored.responseBody);
          if (!replay.success || stored.responseStatus !== 200) return failure(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es valida.");
          return { ok: true as const, status: 200 as const, value: replay.data };
        }
        const sources = await tx.subscriptionRenewalReservation.findMany({
          where: { companyId: command.companyId, invoiceId: command.invoiceId },
          orderBy: { subscriptionId: "asc" }, select: { id: true, subscriptionId: true }
        });
        if (sources.length === 0) return failure(404, "SUBSCRIPTION_RENEWAL_INVOICE_NOT_FOUND", "El borrador de renovacion no existe.");
        const subscriptionIds = sources.map((source) => source.subscriptionId);
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "subscriptions" WHERE "companyId" = ${command.companyId}::uuid
            AND "id" IN (${Prisma.join(subscriptionIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "id" FOR UPDATE
        `);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "invoices" WHERE "id" = ${command.invoiceId}::uuid AND "companyId" = ${command.companyId}::uuid FOR UPDATE`);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscription_renewal_reservations" WHERE "invoiceId" = ${command.invoiceId}::uuid AND "companyId" = ${command.companyId}::uuid ORDER BY "subscriptionId" FOR UPDATE`);
        const invoice = await tx.invoice.findFirst({ where: { id: command.invoiceId, companyId: command.companyId }, select: { id: true, origin: true, status: true } });
        const reservations = await tx.subscriptionRenewalReservation.findMany({
          where: { companyId: command.companyId, invoiceId: command.invoiceId }, orderBy: { subscriptionId: "asc" },
          select: { id: true, subscriptionId: true, status: true }
        });
        if (!invoice || invoice.origin !== "SUBSCRIPTION") return failure(404, "SUBSCRIPTION_RENEWAL_INVOICE_NOT_FOUND", "El borrador de renovacion no existe.");
        if (invoice.status !== "DRAFT" || reservations.length === 0 || reservations.some((reservation) => reservation.status !== "RESERVED")) {
          return failure(409, "SUBSCRIPTION_RENEWAL_INVOICE_NOT_RELEASABLE", "El borrador de renovacion ya no se puede liberar.");
        }
        const clock = await tx.$queryRaw<Array<{ releasedAt: Date }>>`SELECT clock_timestamp() AS "releasedAt"`;
        const releasedAt = clock[0]?.releasedAt;
        if (!releasedAt) throw new Error("SUBSCRIPTION_RENEWAL_DATABASE_CLOCK_UNAVAILABLE");
        await tx.subscriptionRenewalReservation.updateMany({
          where: { companyId: command.companyId, invoiceId: command.invoiceId, status: "RESERVED" },
          data: { status: "RELEASED", releasedById: actor.id, releasedAt, releaseReason: command.reason }
        });
        const value: ReleaseSubscriptionRenewalValue = {
          invoiceId: command.invoiceId, releasedReservationIds: reservations.map((reservation) => reservation.id),
          subscriptionIds: reservations.map((reservation) => reservation.subscriptionId), releasedAt: releasedAt.toISOString()
        };
        await tx.auditEvent.create({ data: {
          eventType: "SUBSCRIPTION_RENEWAL_RELEASED", actorType: "USER",
          payload: { actorUserId: actor.id, companyId: command.companyId, invoiceId: command.invoiceId,
            reservationIds: value.releasedReservationIds, subscriptionIds: value.subscriptionIds,
            ...(context.correlationId ? { correlationId: context.correlationId } : {}) }
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
  throw new Error("SUBSCRIPTION_RENEWAL_RELEASE_RETRY_EXHAUSTED");
}

export async function confirmSubscriptionRenewal(
  command: ConfirmSubscriptionRenewalCommand,
  actor: SessionUser,
  context: RenewalContext,
  dependencies: IssueInvoiceDependencies = {}
): Promise<ConfirmSubscriptionRenewalResult> {
  const semanticHash = hashSubscriptionRenewalConfirmationRequest(command);
  if (context.requestHash !== semanticHash) {
    return failure(409, "IDEMPOTENCY_REQUEST_HASH_INVALID", "La huella idempotente no corresponde con la peticion.");
  }
  const storedConfirmation = await prisma.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
  if (storedConfirmation) {
    if (storedConfirmation.requestHash !== semanticHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
    const replay = renewalConfirmationValueSchema.safeParse(storedConfirmation.responseBody);
    if (!replay.success || storedConfirmation.responseStatus !== 200) return failure(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es valida.");
    return { ok: true, status: 200, value: replay.data };
  }
  if (await consumePersistentRenewalRateLimit(actor, command.companyId, "confirm", 10, context.correlationId)) {
    return failure(429, "SUBSCRIPTION_RENEWAL_RATE_LIMITED", "Demasiadas confirmaciones. Espere quince minutos.");
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.idempotencyKey}, 0))`;
        const stored = await tx.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
        if (stored) {
          if (stored.requestHash !== semanticHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
          const replay = renewalConfirmationValueSchema.safeParse(stored.responseBody);
          if (!replay.success || stored.responseStatus !== 200) {
            return failure(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es valida.");
          }
          return { ok: true as const, status: 200 as const, value: replay.data };
        }
        const installation = await tx.installation.findFirst({ where: { companyId: command.companyId }, select: { companyId: true } });
        if (!installation) return failure(404, "SUBSCRIPTION_RENEWAL_INVOICE_NOT_FOUND", "El borrador de renovacion no existe.");
        const reservationSources = await tx.subscriptionRenewalReservation.findMany({
          where: { invoiceId: command.invoiceId, companyId: command.companyId },
          orderBy: { subscriptionId: "asc" },
          select: { subscriptionId: true }
        });
        if (reservationSources.length === 0) return failure(404, "SUBSCRIPTION_RENEWAL_INVOICE_NOT_FOUND", "El borrador de renovacion no existe.");
        const sourceSubscriptionIds = reservationSources.map((reservation) => reservation.subscriptionId);
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "subscriptions"
          WHERE "companyId" = ${command.companyId}::uuid AND "id" IN (${Prisma.join(sourceSubscriptionIds.map((id) => Prisma.sql`${id}::uuid`))})
          ORDER BY "id" FOR UPDATE
        `);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "invoices" WHERE "id" = ${command.invoiceId}::uuid AND "companyId" = ${command.companyId}::uuid FOR UPDATE`);
        const invoice = await tx.invoice.findFirst({
          where: { id: command.invoiceId, companyId: command.companyId },
          select: { id: true, origin: true, status: true, issueDate: true }
        });
        if (!invoice || invoice.origin !== "SUBSCRIPTION") return failure(404, "SUBSCRIPTION_RENEWAL_INVOICE_NOT_FOUND", "El borrador de renovacion no existe.");
        if (invoice.status !== "DRAFT") return failure(409, "SUBSCRIPTION_RENEWAL_INVOICE_NOT_CONFIRMABLE", "La factura de renovacion ya no es confirmable.");
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "subscription_renewal_reservations"
          WHERE "invoiceId" = ${invoice.id}::uuid AND "companyId" = ${command.companyId}::uuid
          ORDER BY "subscriptionId" FOR UPDATE
        `);
        const reservations = await tx.subscriptionRenewalReservation.findMany({
          where: { invoiceId: invoice.id, companyId: command.companyId },
          orderBy: { subscriptionId: "asc" },
          select: {
            id: true, subscriptionId: true, status: true, periodStart: true,
            periodEndExclusive: true, subscriptionVersionSnapshot: true
          }
        });
        if (reservations.length === 0 || reservations.some((reservation) => reservation.status !== "RESERVED")) {
          return failure(409, "SUBSCRIPTION_RENEWAL_INVOICE_NOT_CONFIRMABLE", "La factura no conserva reservas confirmables.");
        }
        const subscriptionIds = reservations.map((reservation) => reservation.subscriptionId);
        if (subscriptionIds.length !== sourceSubscriptionIds.length
          || subscriptionIds.some((id, index) => id !== sourceSubscriptionIds[index])) {
          throw new Error("SUBSCRIPTION_RENEWAL_RESERVATION_SET_CHANGED");
        }
        const subscriptions = await tx.subscription.findMany({
          where: { companyId: command.companyId, id: { in: subscriptionIds } },
          orderBy: { id: "asc" },
          select: { id: true, status: true, version: true, nextRenewalDate: true }
        });
        const subscriptionById = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
        if (subscriptions.length !== reservations.length || reservations.some((reservation) => {
          const subscription = subscriptionById.get(reservation.subscriptionId);
          return !subscription
            || (subscription.status !== "ACTIVE" && subscription.status !== "RENEWAL_PENDING")
            || subscription.version !== reservation.subscriptionVersionSnapshot
            || subscription.nextRenewalDate.getTime() !== reservation.periodStart.getTime();
        })) {
          return failure(409, "SUBSCRIPTION_RENEWAL_RESERVATION_STALE", "Una suscripcion ha cambiado desde la reserva.");
        }
        const pendingSubscriptions = subscriptions.filter((subscription) => subscription.status === "RENEWAL_PENDING");
        const openExclusions = pendingSubscriptions.length === 0 ? [] : await tx.subscriptionRenewalExclusion.findMany({
          where: { companyId: command.companyId, subscriptionId: { in: pendingSubscriptions.map((subscription) => subscription.id) }, status: "OPEN" },
          select: { id: true, subscriptionId: true, periodStart: true }
        });
        const exclusionBySubscriptionId = new Map(openExclusions.map((exclusion) => [exclusion.subscriptionId, exclusion]));
        if (pendingSubscriptions.some((subscription) => {
          const exclusion = exclusionBySubscriptionId.get(subscription.id);
          return !exclusion || exclusion.periodStart.getTime() !== subscription.nextRenewalDate.getTime();
        })) {
          return failure(409, "SUBSCRIPTION_RENEWAL_EXCLUSION_STALE", "Un expediente pendiente ha cambiado o ya esta cerrado.");
        }

        const issued = await issueSubscriptionRenewalInvoiceInTransaction(
          tx,
          invoice.id,
          { issueDate: formatDateOnly(invoice.issueDate) },
          actor,
          { correlationId: context.correlationId, idempotencyKey: context.idempotencyKey, requestHash: semanticHash },
          dependencies
        );
        if (!issued.ok) {
          if (openExclusions.length > 0) {
            await tx.subscriptionRenewalExclusion.updateMany({
              where: { id: { in: openExclusions.map((exclusion) => exclusion.id) }, status: "OPEN" },
              data: { lastErrorCode: issued.error.code }
            });
          }
          await recordConfirmationAttempt(tx, {
            companyId: command.companyId, invoiceId: invoice.id,
            outcome: "FAILED", errorCode: issued.error.code
          }, actor, context);
          const status = issued.status === 404 || issued.status === 409 ? issued.status : 409;
          return failure(status, issued.error.code, issued.error.message);
        }
        const issuedInvoice = await tx.invoice.findUniqueOrThrow({
          where: { id: invoice.id },
          select: { issuedAt: true, number: true }
        });
        if (!issuedInvoice.issuedAt || !issuedInvoice.number) throw new Error("SUBSCRIPTION_RENEWAL_ISSUANCE_EVIDENCE_MISSING");

        const resultingSubscriptions: SubscriptionRenewalConfirmationValue["subscriptions"] = [];
        for (const reservation of reservations) {
          const updated = await tx.subscription.update({
            where: { id: reservation.subscriptionId },
            data: {
              status: "ACTIVE",
              nextRenewalDate: reservation.periodEndExclusive,
              version: { increment: 1 },
              updatedById: actor.id
            },
            select: { id: true, nextRenewalDate: true, version: true }
          });
          resultingSubscriptions.push({
            id: updated.id,
            nextRenewalDate: formatDateOnly(updated.nextRenewalDate),
            version: updated.version
          });
        }
        await tx.subscriptionRenewalReservation.updateMany({
          where: { invoiceId: invoice.id, companyId: command.companyId, status: "RESERVED" },
          data: { status: "BILLED", billedAt: issuedInvoice.issuedAt }
        });
        for (const exclusion of openExclusions) {
          await tx.subscriptionRenewalExclusion.update({
            where: { id: exclusion.id },
            data: {
              status: "RESOLVED", resolvedAt: issuedInvoice.issuedAt, resolvedById: actor.id,
              resolution: "BILLED", resolvedInvoiceId: invoice.id, lastErrorCode: null
            }
          });
        }
        if (openExclusions.length > 0) {
          await tx.auditEvent.create({ data: {
            eventType: "SUBSCRIPTION_RENEWAL_EXCLUSION_RESOLVED", actorType: "USER",
            payload: {
              actorUserId: actor.id, companyId: command.companyId, invoiceId: invoice.id,
              subscriptionIds: pendingSubscriptions.map((subscription) => subscription.id),
              exclusionIds: openExclusions.map((exclusion) => exclusion.id), resolution: "BILLED",
              ...(context.correlationId ? { correlationId: context.correlationId } : {})
            }
          } });
        }
        await recordConfirmationAttempt(tx, {
          companyId: command.companyId, invoiceId: invoice.id,
          outcome: "SUCCEEDED", errorCode: null
        }, actor, context);
        await tx.auditEvent.create({
          data: {
            eventType: "SUBSCRIPTION_RENEWAL_BILLED",
            actorType: "USER",
            payload: {
              actorUserId: actor.id,
              companyId: command.companyId,
              invoiceId: invoice.id,
              reservationIds: reservations.map((reservation) => reservation.id),
              subscriptionIds,
              exclusionIds: openExclusions.map((exclusion) => exclusion.id),
              ...(context.correlationId ? { correlationId: context.correlationId } : {})
            }
          }
        });
        const value: SubscriptionRenewalConfirmationValue = {
          invoiceId: invoice.id,
          number: issuedInvoice.number,
          billedAt: issuedInvoice.issuedAt.toISOString(),
          subscriptions: resultingSubscriptions
        };
        await tx.idempotencyRecord.create({
          data: {
            key: context.idempotencyKey,
            requestHash: semanticHash,
            responseStatus: 200,
            responseBody: value as Prisma.InputJsonValue
          }
        });
        return { ok: true as const, status: 200 as const, value };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isRetryableTransactionError(error)) {
        if (attempt < 2) continue;
        return failure(503, "SUBSCRIPTION_RENEWAL_BUSY", "La renovacion esta ocupada; vuelva a intentarlo.");
      }
      if (isVerifactuPreparationUnavailableError(error)) {
        await recordFailedConfirmationAfterRollback(
          command.companyId, command.invoiceId, "INVOICE_VERIFACTU_PREPARATION_UNAVAILABLE", actor, context
        );
        await prisma.auditEvent.create({ data: {
          eventType: "SUBSCRIPTION_RENEWAL_VERIFACTU_PREPARATION_FAILED", actorType: "USER",
          payload: { actorUserId: actor.id, companyId: command.companyId, invoiceId: command.invoiceId,
            ...(context.correlationId ? { correlationId: context.correlationId } : {}) }
        } });
        return failure(503, "INVOICE_VERIFACTU_PREPARATION_UNAVAILABLE", "No se pudo preparar el registro VeriFactu.");
      }
      throw error;
    }
  }
  throw new Error("SUBSCRIPTION_RENEWAL_CONFIRMATION_RETRY_EXHAUSTED");
}

export async function createSubscriptionRenewalDraft(
  command: CreateSubscriptionRenewalDraftCommand,
  actor: SessionUser,
  context: RenewalContext
): Promise<CreateSubscriptionRenewalDraftResult> {
  const subscriptionIds = [...command.subscriptionIds].sort();
  const semanticHash = hashSubscriptionRenewalDraftRequest(command);
  if (context.requestHash !== semanticHash) {
    return failure(409, "IDEMPOTENCY_REQUEST_HASH_INVALID", "La huella idempotente no corresponde con la peticion.");
  }
  const storedDraft = await prisma.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
  if (storedDraft) {
    if (storedDraft.requestHash !== semanticHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
    return replayStoredDraft(storedDraft.responseStatus, storedDraft.responseBody);
  }
  if (await consumePersistentRenewalRateLimit(actor, command.companyId, "prepare", 10, context.correlationId)) {
    return failure(429, "SUBSCRIPTION_RENEWAL_RATE_LIMITED", "Demasiadas preparaciones. Espere quince minutos.");
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.idempotencyKey}, 0))`;
        const stored = await tx.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
        if (stored) {
          if (stored.requestHash !== semanticHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
          return replayStoredDraft(stored.responseStatus, stored.responseBody);
        }
        const installation = await tx.installation.findFirst({ where: { companyId: command.companyId }, select: { companyId: true } });
        if (!installation) return failure(404, "SUBSCRIPTION_RENEWAL_COMPANY_NOT_FOUND", "La empresa no existe.");

        const sources: Array<{ subscriptionId: string; expectedVersion: number }> = [];
        const cancelledSubscriptionIds: string[] = [];
        for (const subscriptionId of subscriptionIds) {
          const resolution = await resolveScheduledCancellationBeforeRenewal(tx, {
            companyId: command.companyId,
            subscriptionId,
            asOfDate: command.issueDate,
            initiatedByUserId: actor.id,
            correlationId: context.correlationId
          });
          if (resolution.outcome === "NOT_FOUND") return failOrRollback(failure(404, "SUBSCRIPTION_NOT_FOUND", "Una suscripcion no existe."), cancelledSubscriptionIds);
          if (resolution.outcome === "NOT_RENEWABLE") return failOrRollback(failure(409, "SUBSCRIPTION_NOT_RENEWABLE", "Una suscripcion no es renovable."), cancelledSubscriptionIds);
          if (resolution.outcome === "NOT_DUE") return failOrRollback(failure(422, "SUBSCRIPTION_RENEWAL_NOT_DUE", "Una suscripcion aun no vence."), cancelledSubscriptionIds);
          if (resolution.outcome === "CANCELLED") {
            const expectedVersion = command.expectedVersions?.[subscriptionId];
            if (expectedVersion !== undefined && (!resolution.applied || resolution.subscriptionVersion !== expectedVersion + 1)) {
              return failOrRollback(failure(409, "SUBSCRIPTION_VERSION_CONFLICT", "Una suscripcion ha cambiado desde la vista previa."), [...cancelledSubscriptionIds, subscriptionId]);
            }
            cancelledSubscriptionIds.push(subscriptionId);
          } else {
            const expectedVersion = command.expectedVersions?.[subscriptionId];
            if (expectedVersion !== undefined && resolution.subscriptionVersion !== expectedVersion) {
              return failOrRollback(failure(409, "SUBSCRIPTION_VERSION_CONFLICT", "Una suscripcion ha cambiado desde la vista previa."), cancelledSubscriptionIds);
            }
            const source = await tx.subscription.findFirst({
              where: { id: subscriptionId, companyId: command.companyId },
              select: { status: true, nextRenewalDate: true }
            });
            if (!source) return failOrRollback(failure(404, "SUBSCRIPTION_NOT_FOUND", "Una suscripcion no existe."), cancelledSubscriptionIds);
            const pendingExclusionId = command.pendingExclusionIds?.[subscriptionId];
            if (source.status === "RENEWAL_PENDING") {
              if (!pendingExclusionId) {
                return failOrRollback(failure(409, "SUBSCRIPTION_RENEWAL_PENDING_SELECTION_REQUIRED", "Una renovacion pendiente debe seleccionarse mediante su expediente."), cancelledSubscriptionIds);
              }
              const exclusion = await tx.subscriptionRenewalExclusion.findFirst({
                where: {
                  id: pendingExclusionId, companyId: command.companyId, subscriptionId,
                  periodStart: source.nextRenewalDate, status: "OPEN"
                },
                select: { id: true }
              });
              if (!exclusion) {
                return failOrRollback(failure(409, "SUBSCRIPTION_RENEWAL_EXCLUSION_STALE", "El expediente pendiente ha cambiado o ya esta cerrado."), cancelledSubscriptionIds);
              }
            } else if (pendingExclusionId) {
              return failOrRollback(failure(409, "SUBSCRIPTION_RENEWAL_EXCLUSION_NOT_APPLICABLE", "Una suscripcion activa no admite un expediente pendiente."), cancelledSubscriptionIds);
            }
            sources.push({ subscriptionId, expectedVersion: resolution.subscriptionVersion });
          }
        }

        let value: SubscriptionRenewalDraftValue;
        let status: 200 | 201;
        if (sources.length === 0) {
          status = 200;
          value = { invoiceId: null, reservationIds: [], cancelledSubscriptionIds, lineCount: 0, total: "0.00" };
        } else {
          const draft = await createSubscriptionRenewalDraftInTransaction(tx, {
            companyId: command.companyId,
            issueDate: parseDateOnly(command.issueDate),
            sources,
            initiatedByUserId: actor.id,
            correlationId: context.correlationId
          });
          const draftFailure = mapDraftFailure(draft);
          if (draftFailure) return failOrRollback(draftFailure, cancelledSubscriptionIds);
          if (draft.kind !== "created") throw new Error("SUBSCRIPTION_RENEWAL_DRAFT_RESULT_UNREACHABLE");
          await recordSuccessfulPreparationAttempt(tx, {
            companyId: command.companyId, invoiceId: draft.invoiceId, reservationIds: draft.reservationIds
          }, actor, context);
          status = 201;
          value = {
            invoiceId: draft.invoiceId,
            reservationIds: draft.reservationIds,
            cancelledSubscriptionIds,
            lineCount: draft.lineCount,
            total: draft.total
          };
        }
        await tx.idempotencyRecord.create({
          data: {
            key: context.idempotencyKey,
            requestHash: semanticHash,
            responseStatus: status,
            responseBody: value as Prisma.InputJsonValue
          }
        });
        return { ok: true as const, status, value };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      if (!result.ok) {
        await materializePreparationFailure(command, result, actor, context);
        const canonical = await prisma.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
        if (canonical) {
          if (canonical.requestHash !== semanticHash) {
            return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
          }
          return replayStoredDraft(canonical.responseStatus, canonical.responseBody);
        }
      }
      return result;
    } catch (error) {
      if (error instanceof RenewalFunctionalRollback) return error.result;
      if (isRetryableTransactionError(error)) {
        if (attempt < 2) continue;
        return failure(503, "SUBSCRIPTION_RENEWAL_BUSY", "La renovacion esta ocupada; vuelva a intentarlo.");
      }
      throw error;
    }
  }
  throw new Error("SUBSCRIPTION_RENEWAL_TRANSACTION_RETRY_EXHAUSTED");
}

function failOrRollback(result: RenewalFailure, cancelledSubscriptionIds: string[]): RenewalFailure {
  if (cancelledSubscriptionIds.length > 0) throw new RenewalFunctionalRollback(result);
  return result;
}

function replayStoredDraft(responseStatus: number, responseBody: Prisma.JsonValue): CreateSubscriptionRenewalDraftResult {
  const success = renewalValueSchema.safeParse(responseBody);
  if (success.success && (responseStatus === 200 || responseStatus === 201)) {
    return { ok: true, status: responseStatus, value: success.data };
  }
  const storedFailure = renewalFailureValueSchema.safeParse(responseBody);
  if (storedFailure.success && [404, 409, 422, 429, 503].includes(responseStatus)) {
    return failure(responseStatus as RenewalFailure["status"], storedFailure.data.code, storedFailure.data.message);
  }
  return failure(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es valida.");
}

function mapDraftFailure(result: SubscriptionRenewalDraftResult): RenewalFailure | null {
  if (result.kind === "created") return null;
  if (result.kind === "invalid-group") return failure(422, "SUBSCRIPTION_RENEWAL_GROUP_INVALID", "Las suscripciones no se pueden agrupar en una unica factura.");
  if (result.kind === "subscription-not-renewable") return failure(409, "SUBSCRIPTION_NOT_RENEWABLE", "Una suscripcion no es renovable.");
  if (result.kind === "renewal-already-reserved") return failure(409, "SUBSCRIPTION_RENEWAL_ALREADY_RESERVED", "El periodo ya esta reservado para facturacion.");
  if (result.kind === "customer-not-active") return failure(422, "CUSTOMER_NOT_ACTIVE", "El cliente debe estar activo.");
  return failure(409, "INVOICE_ACCOUNTING_FISCAL_YEAR_NOT_OPEN", "El ejercicio contable de la factura no esta abierto.");
}

function failure(status: RenewalFailure["status"], code: string, message: string): RenewalFailure {
  return { ok: false, status, error: { code, message } };
}

async function consumePersistentRenewalRateLimit(
  actor: SessionUser,
  companyId: string,
  action: "prepare" | "confirm" | "release",
  limit: number,
  correlationId?: string
): Promise<boolean> {
  return prisma.$transaction((tx) => consumeRenewalRateLimit(tx, actor, companyId, action, limit, correlationId));
}

async function consumeRenewalRateLimit(
  tx: Prisma.TransactionClient,
  actor: SessionUser,
  companyId: string,
  action: "prepare" | "confirm" | "release",
  limit: number,
  correlationId?: string
): Promise<boolean> {
  const key = `subscription-renewal-${action}:${companyId}:${actor.id}`;
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
  const limited = (rows[0]?.count ?? 0) > limit;
  if (limited) {
    await tx.auditEvent.create({ data: {
      eventType: "SUBSCRIPTION_RENEWAL_RATE_LIMITED", actorType: "USER",
      payload: { actorUserId: actor.id, companyId, action, ...(correlationId ? { correlationId } : {}) }
    } });
  }
  return limited;
}

function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}


function isRetryableTransactionError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001");
}
