import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { calculateInvoiceLine, calculateInvoiceTaxSummaries, calculateInvoiceTotals } from "@/modules/billing/application/calculations";
import { lockOpenFiscalYearForDatedMutation } from "@/modules/accounting/application/fiscalYearMutationBarrier";

export type SubscriptionRenewalDraftSource = {
  subscriptionId: string;
  expectedVersion: number;
};

export type CreateSubscriptionRenewalDraftInput = {
  companyId: string;
  issueDate: Date;
  sources: SubscriptionRenewalDraftSource[];
  initiatedByUserId: string;
  correlationId?: string;
};

export type SubscriptionRenewalDraftResult =
  | { kind: "created"; invoiceId: string; reservationIds: string[]; lineCount: number; total: string }
  | { kind: "invalid-group" }
  | { kind: "subscription-not-renewable" }
  | { kind: "renewal-already-reserved" }
  | { kind: "customer-not-active" }
  | { kind: "fiscal-year-not-open" };

/**
 * Internal Billing boundary. The subscriptions orchestrator owns the
 * Serializable transaction, cancellation gate and idempotency record.
 */
export async function createSubscriptionRenewalDraftInTransaction(
  tx: Prisma.TransactionClient,
  input: CreateSubscriptionRenewalDraftInput
): Promise<SubscriptionRenewalDraftResult> {
  if (input.sources.length === 0) return { kind: "invalid-group" };
  const sourceIds = input.sources.map((source) => source.subscriptionId);
  if (new Set(sourceIds).size !== sourceIds.length) return { kind: "invalid-group" };

  const subscriptions = await tx.subscription.findMany({
    where: { id: { in: sourceIds }, companyId: input.companyId },
    orderBy: { id: "asc" },
    select: {
      id: true,
      number: true,
      status: true,
      version: true,
      customerId: true,
      paymentMethod: true,
      periodicity: true,
      nextRenewalDate: true,
      endDate: true,
      customer: {
        select: {
          id: true, code: true, status: true, legalName: true, taxId: true,
          fiscalTreatment: true, fiscalAddressLine: true, fiscalPostalCode: true,
          fiscalCity: true, fiscalProvince: true, fiscalCountry: true,
          paymentTermsType: true, paymentDays: true, paymentFixedDay: true
        }
      },
      lines: {
        orderBy: { position: "asc" },
        select: {
          id: true, position: true, catalogItemId: true, catalogItemCodeSnapshot: true,
          catalogItemKindSnapshot: true, description: true, quantity: true, unitPrice: true,
          discountPercent: true, discountAmount: true, taxRateId: true,
          taxRateCodeSnapshot: true, taxRateNameSnapshot: true, taxRateSnapshot: true
        }
      }
    }
  });
  if (subscriptions.length !== input.sources.length) return { kind: "subscription-not-renewable" };

  const expectedVersions = new Map(input.sources.map((source) => [source.subscriptionId, source.expectedVersion]));
  const first = subscriptions[0];
  if (!first || subscriptions.some((subscription) =>
    !["ACTIVE", "RENEWAL_PENDING"].includes(subscription.status)
    || subscription.version !== expectedVersions.get(subscription.id)
    || subscription.lines.length === 0
    || subscription.nextRenewalDate > input.issueDate
    || (subscription.endDate !== null && subscription.nextRenewalDate > subscription.endDate)
  )) return { kind: "subscription-not-renewable" };
  if (subscriptions.some((subscription) =>
    subscription.customerId !== first.customerId
    || subscription.paymentMethod !== first.paymentMethod
    || subscription.nextRenewalDate.getTime() !== first.nextRenewalDate.getTime()
  )) return { kind: "invalid-group" };
  if (first.customer.status !== "ACTIVE") return { kind: "customer-not-active" };

  const activeReservations = await tx.subscriptionRenewalReservation.count({
    where: {
      companyId: input.companyId,
      subscriptionId: { in: sourceIds },
      periodStart: first.nextRenewalDate,
      status: { in: ["RESERVED", "BILLED"] }
    }
  });
  if (activeReservations > 0) return { kind: "renewal-already-reserved" };
  if (!await lockOpenFiscalYearForDatedMutation(tx, input.companyId, input.issueDate)) {
    return { kind: "fiscal-year-not-open" };
  }

  const calculatedLines = subscriptions.flatMap((subscription) =>
    subscription.lines.map((line) => ({
      id: randomUUID(),
      subscriptionId: subscription.id,
      subscriptionLineId: line.id,
      position: 0,
      catalogItemId: line.catalogItemId,
      catalogItemCodeSnapshot: line.catalogItemCodeSnapshot,
      catalogItemKindSnapshot: line.catalogItemKindSnapshot,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountPercent: line.discountPercent,
      discountAmount: line.discountAmount,
      taxRateId: line.taxRateId,
      taxRateCodeSnapshot: line.taxRateCodeSnapshot,
      taxRateNameSnapshot: line.taxRateNameSnapshot,
      taxRateSnapshot: line.taxRateSnapshot,
      ...calculateInvoiceLine({
        quantity: line.quantity, unitPrice: line.unitPrice,
        discountPercent: line.discountPercent, discountAmount: line.discountAmount,
        taxRate: line.taxRateSnapshot
      })
    }))
  ).map((line, index) => ({ ...line, position: index + 1 }));
  const totals = calculateInvoiceTotals(calculatedLines.map((line) => ({
    taxRateCode: line.taxRateCodeSnapshot,
    taxRate: line.taxRateSnapshot,
    lineSubtotal: line.lineSubtotal,
    lineDiscountTotal: line.lineDiscountTotal,
    lineTaxableBase: line.lineTaxableBase,
    lineTaxAmount: line.lineTaxAmount,
    lineTotal: line.lineTotal
  })));
  const taxSummaries = calculateInvoiceTaxSummaries(calculatedLines.map((line) => ({
    taxRateCode: line.taxRateCodeSnapshot,
    taxRate: line.taxRateSnapshot,
    lineSubtotal: line.lineSubtotal,
    lineDiscountTotal: line.lineDiscountTotal,
    lineTaxableBase: line.lineTaxableBase,
    lineTaxAmount: line.lineTaxAmount,
    lineTotal: line.lineTotal
  })));
  const customer = first.customer;
  const invoice = await tx.invoice.create({
    data: {
      companyId: input.companyId,
      documentType: "STANDARD",
      origin: "SUBSCRIPTION",
      status: "DRAFT",
      year: input.issueDate.getUTCFullYear(),
      customerId: customer.id,
      customerCodeSnapshot: customer.code,
      customerLegalNameSnapshot: customer.legalName,
      customerTaxIdSnapshot: customer.taxId,
      customerFiscalTreatmentSnapshot: customer.fiscalTreatment,
      customerFiscalAddressSnapshot: fiscalAddressSnapshot(customer),
      issueDate: input.issueDate,
      operationDate: first.nextRenewalDate,
      createdById: input.initiatedByUserId,
      ...totals
    },
    select: { id: true }
  });
  await tx.invoiceLine.createMany({
    data: calculatedLines.map((line) => ({
      id: line.id, invoiceId: invoice.id, position: line.position,
      catalogItemId: line.catalogItemId, catalogItemCodeSnapshot: line.catalogItemCodeSnapshot,
      catalogItemKindSnapshot: line.catalogItemKindSnapshot, description: line.description,
      quantity: line.quantity, unitPrice: line.unitPrice, discountPercent: line.discountPercent,
      discountAmount: line.discountAmount, taxRateId: line.taxRateId,
      taxRateCodeSnapshot: line.taxRateCodeSnapshot, taxRateNameSnapshot: line.taxRateNameSnapshot,
      taxRateSnapshot: line.taxRateSnapshot, lineSubtotal: line.lineSubtotal,
      lineDiscountTotal: line.lineDiscountTotal, lineTaxableBase: line.lineTaxableBase,
      lineTaxAmount: line.lineTaxAmount, lineTotal: line.lineTotal
    }))
  });
  await tx.invoiceTaxSummary.createMany({
    data: taxSummaries.map((summary) => ({ invoiceId: invoice.id, ...summary }))
  });
  await tx.invoiceDueDate.create({
    data: {
      invoiceId: invoice.id,
      position: 1,
      dueDate: calculateDueDate(input.issueDate, customer),
      amount: totals.total,
      paymentMethod: first.paymentMethod
    }
  });

  const reservationIds: string[] = [];
  for (const subscription of subscriptions) {
    const periodRows = await tx.$queryRaw<Array<{ periodEndExclusive: Date }>>(Prisma.sql`
      SELECT "subscription_next_renewal_date"(${subscription.nextRenewalDate}::date, ${subscription.periodicity}::"SubscriptionPeriodicity") AS "periodEndExclusive"
    `);
    const periodEndExclusive = periodRows[0]?.periodEndExclusive;
    if (!periodEndExclusive) throw new Error("SUBSCRIPTION_RENEWAL_PERIOD_UNAVAILABLE");
    const reservation = await tx.subscriptionRenewalReservation.create({
      data: {
        companyId: input.companyId, customerId: subscription.customerId,
        paymentMethod: subscription.paymentMethod, subscriptionId: subscription.id,
        invoiceId: invoice.id, periodStart: subscription.nextRenewalDate,
        periodEndExclusive, subscriptionVersionSnapshot: subscription.version,
        reservedById: input.initiatedByUserId
      },
      select: { id: true }
    });
    reservationIds.push(reservation.id);
    const sourceLines = calculatedLines.filter((line) => line.subscriptionId === subscription.id);
    await tx.subscriptionRenewalReservationLine.createMany({
      data: sourceLines.map((line) => ({
        reservationId: reservation.id, companyId: input.companyId,
        subscriptionId: subscription.id, subscriptionLineId: line.subscriptionLineId,
        invoiceId: invoice.id, invoiceLineId: line.id, periodStart: subscription.nextRenewalDate
      }))
    });
  }

  await tx.auditEvent.create({
    data: {
      eventType: "SUBSCRIPTION_RENEWAL_DRAFT_RESERVED",
      actorType: "USER",
      payload: {
        actorUserId: input.initiatedByUserId,
        companyId: input.companyId,
        invoiceId: invoice.id,
        subscriptionIds: sourceIds,
        reservationIds,
        periodStart: formatDateOnly(first.nextRenewalDate),
        lineCount: calculatedLines.length,
        ...(input.correlationId ? { correlationId: input.correlationId } : {})
      }
    }
  });
  return {
    kind: "created",
    invoiceId: invoice.id,
    reservationIds,
    lineCount: calculatedLines.length,
    total: totals.total.toFixed(2)
  };
}

function fiscalAddressSnapshot(customer: {
  fiscalAddressLine: string;
  fiscalPostalCode: string;
  fiscalCity: string;
  fiscalProvince: string | null;
  fiscalCountry: string;
}): Prisma.InputJsonObject {
  return {
    line1: customer.fiscalAddressLine,
    postalCode: customer.fiscalPostalCode,
    city: customer.fiscalCity,
    province: customer.fiscalProvince,
    country: customer.fiscalCountry
  };
}

function calculateDueDate(issueDate: Date, customer: {
  paymentTermsType: "IMMEDIATE" | "DAYS" | "FIXED_DAY_OF_MONTH";
  paymentDays: number | null;
  paymentFixedDay: number | null;
}): Date {
  if (customer.paymentTermsType === "DAYS") return addUtcDays(issueDate, customer.paymentDays ?? 0);
  if (customer.paymentTermsType === "FIXED_DAY_OF_MONTH") {
    const year = issueDate.getUTCFullYear();
    const month = issueDate.getUTCMonth();
    const day = customer.paymentFixedDay ?? 1;
    const targetMonth = issueDate.getUTCDate() <= day ? month : month + 1;
    const lastDay = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, targetMonth, Math.min(day, lastDay)));
  }
  return issueDate;
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
