import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";
import { hashIdempotencyPayload } from "@/modules/platform/application/http";
import { normalizeDateOnlyInput } from "@/modules/billing/application/invoices";

const defaultLimit = 25;
const maxLimit = 100;
const reservedRefundStatuses = ["REQUESTED", "APPROVED"] as const;

const dateOnlySchema = z.preprocess(
  (value) => (typeof value === "string" ? normalizeDateOnlyInput(value) : value),
  z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidDateOnly, "La fecha no es valida.")
);
const moneySchema = z.string().trim().regex(/^\d{1,12}\.\d{2}$/).refine((value) => new Prisma.Decimal(value).gt(0), "El importe debe ser positivo.");

export const listCustomerCreditsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  cursor: z.string().uuid().optional(),
  status: z.enum(["WITH_BALANCE", "EXHAUSTED", "ALL"]).default("WITH_BALANCE"),
  customerId: z.string().uuid().optional(),
  search: z.string().trim().min(1).max(120).optional()
});

export const applyCustomerCreditSchema = z.object({
  targetDueDateId: z.string().uuid(),
  applicationDate: dateOnlySchema,
  amount: moneySchema,
  notes: z.string().trim().min(1).max(500).nullable().default(null)
}).strict();

export const requestCustomerCreditRefundSchema = z.object({
  bankAccountId: z.string().uuid(),
  requestedDate: dateOnlySchema,
  amount: moneySchema,
  reasonCode: z.enum(["CUSTOMER_REQUEST", "DUPLICATE_OR_EXCESS", "CANCELLATION", "OTHER"]),
  reference: z.string().trim().min(1).max(120).nullable().default(null),
  notes: z.string().trim().min(1).max(500).nullable().default(null)
}).strict();

export type ListCustomerCreditsCommand = z.infer<typeof listCustomerCreditsSchema>;
export type ApplyCustomerCreditCommand = z.infer<typeof applyCustomerCreditSchema>;
export type RequestCustomerCreditRefundCommand = z.infer<typeof requestCustomerCreditRefundSchema>;

type MutationContext = {
  correlationId?: string;
  idempotencyKey: string;
  requestHash: string;
};

export type CustomerCreditStatus = "HELD" | "AVAILABLE" | "PARTIALLY_USED" | "EXHAUSTED";

export type CustomerCreditDetail = {
  id: string;
  companyId: string;
  customer: { id: string; code: string; legalName: string };
  sourceInvoice: { id: string; number: string | null; issueDate: string; verifactuStatus: string };
  currency: string;
  originalAmount: string;
  appliedAmount: string;
  reservedRefundAmount: string;
  postedRefundAmount: string;
  availableAmount: string;
  status: CustomerCreditStatus;
  createdAt: string;
  applications: Array<{
    id: string;
    applicationDate: string;
    amount: string;
    targetInvoice: { id: string; number: string | null };
    targetDueDateId: string;
    createdAt: string;
  }>;
  refunds: Array<{
    id: string;
    status: "REQUESTED" | "APPROVED" | "POSTED" | "CANCELLED";
    requestedDate: string;
    amount: string;
    reasonCode: string;
    bankAccount: { id: string; name: string; maskedIban: string };
    accountingEntry: { id: string; number: string } | null;
    requestedById: string;
    approvedById: string | null;
    createdAt: string;
  }>;
  eligibleDueDates: Array<{
    id: string;
    invoiceId: string;
    invoiceNumber: string | null;
    dueDate: string;
    pendingAmount: string;
  }>;
};

export type CustomerCreditList = {
  credits: CustomerCreditDetail[];
  summary: { count: number; originalAmount: string; appliedAmount: string; refundedAmount: string; availableAmount: string };
  nextCursor: string | null;
};

type CreditError = {
  ok: false;
  status: 404 | 409;
  error: { code: string; message: string };
};
type CreditResult = { ok: true; status: 200 | 201; value: CustomerCreditDetail } | CreditError;

const creditSelect = {
  id: true,
  companyId: true,
  customerId: true,
  currency: true,
  originalAmount: true,
  createdAt: true,
  customer: { select: { id: true, code: true, legalName: true } },
  sourceRectificationInvoice: { select: { id: true, number: true, issueDate: true, verifactuStatus: true } },
  applications: {
    orderBy: [{ applicationDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true, applicationDate: true, amount: true, targetDueDateId: true, createdAt: true,
      targetInvoice: { select: { id: true, number: true } }
    }
  },
  refunds: {
    orderBy: [{ requestedDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true, status: true, requestedDate: true, amount: true, reasonCode: true, requestedById: true, approvedById: true, createdAt: true,
      bankAccount: { select: { id: true, name: true, iban: true } },
      accountingEntry: { select: { id: true, number: true } }
    }
  }
} satisfies Prisma.CustomerCreditSelect;

type CreditRecord = Prisma.CustomerCreditGetPayload<{ select: typeof creditSelect }>;

export function hashCustomerCreditApplication(creditId: string, command: ApplyCustomerCreditCommand): string {
  return hashIdempotencyPayload("customer-credit-application:v1", { creditId, command });
}

export function hashCustomerCreditRefundRequest(creditId: string, command: RequestCustomerCreditRefundCommand): string {
  return hashIdempotencyPayload("customer-credit-refund-request:v1", { creditId, command });
}

export function hashCustomerCreditRefundAction(refundId: string, action: "approve" | "post" | "cancel"): string {
  return hashIdempotencyPayload(`customer-credit-refund-${action}:v1`, { refundId });
}

export async function listCustomerCredits(command: ListCustomerCreditsCommand, actor: SessionUser): Promise<CustomerCreditList> {
  const records = await prisma.customerCredit.findMany({
    where: {
      ...(command.customerId ? { customerId: command.customerId } : {}),
      ...(command.search ? { OR: [
        { customer: { legalName: { contains: command.search, mode: "insensitive" } } },
        { customer: { code: { contains: command.search, mode: "insensitive" } } },
        { sourceRectificationInvoice: { number: { contains: command.search, mode: "insensitive" } } }
      ] } : {})
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    cursor: command.cursor ? { id: command.cursor } : undefined,
    skip: command.cursor ? 1 : 0,
    take: command.limit + 1,
    select: creditSelect
  });
  const mapped = await Promise.all(records.slice(0, command.limit).map((record) => mapCredit(prisma, record)));
  const credits = mapped.filter((credit) => command.status === "ALL" || (command.status === "EXHAUSTED" ? credit.status === "EXHAUSTED" : credit.status !== "EXHAUSTED"));
  const summary = credits.reduce((totals, credit) => ({
    count: totals.count + 1,
    originalAmount: totals.originalAmount.plus(credit.originalAmount),
    appliedAmount: totals.appliedAmount.plus(credit.appliedAmount),
    refundedAmount: totals.refundedAmount.plus(credit.postedRefundAmount),
    availableAmount: totals.availableAmount.plus(credit.availableAmount)
  }), { count: 0, originalAmount: new Prisma.Decimal(0), appliedAmount: new Prisma.Decimal(0), refundedAmount: new Prisma.Decimal(0), availableAmount: new Prisma.Decimal(0) });

  await prisma.auditEvent.create({ data: { eventType: "CUSTOMER_CREDITS_VIEWED", actorType: "USER", payload: {
    actorUserId: actor.id, status: command.status, customerId: command.customerId ?? null, hasSearch: Boolean(command.search), resultCount: credits.length
  } } });

  return {
    credits,
    summary: { count: summary.count, originalAmount: summary.originalAmount.toFixed(2), appliedAmount: summary.appliedAmount.toFixed(2), refundedAmount: summary.refundedAmount.toFixed(2), availableAmount: summary.availableAmount.toFixed(2) },
    nextCursor: records.length > command.limit ? records[command.limit - 1]?.id ?? null : null
  };
}

export async function getCustomerCredit(creditId: string): Promise<CustomerCreditDetail | null> {
  const record = await prisma.customerCredit.findUnique({ where: { id: creditId }, select: creditSelect });
  return record ? mapCredit(prisma, record) : null;
}

export async function applyCustomerCredit(creditId: string, command: ApplyCustomerCreditCommand, actor: SessionUser, context: MutationContext): Promise<CreditResult> {
  return runSerializable(async (tx) => {
    const replay = await beginIdempotent(tx, context, "creditApplicationId");
    if (replay.kind === "conflict") return idempotencyConflict();
    if (replay.kind === "replay") return creditByMovement(tx, replay.id, "application");
    await lockCredit(tx, creditId);
    const credit = await tx.customerCredit.findUnique({ where: { id: creditId }, select: creditSelect });
    if (!credit) return creditNotFound();
    const mapped = await mapCredit(tx, credit);
    if (mapped.status === "HELD") return conflict("CUSTOMER_CREDIT_HELD", "El credito permanece bloqueado hasta la aceptacion fiscal de la rectificativa.");
    const amount = new Prisma.Decimal(command.amount);
    if (amount.gt(mapped.availableAmount)) return conflict("CUSTOMER_CREDIT_AMOUNT_EXCEEDS_AVAILABLE", "El importe supera el saldo disponible del credito.");

    const dueLink = await tx.invoiceDueDate.findUnique({ where: { id: command.targetDueDateId }, select: { invoiceId: true } });
    if (!dueLink) return conflict("CUSTOMER_CREDIT_TARGET_NOT_ELIGIBLE", "El vencimiento destino no esta disponible.");
    await tx.$queryRaw`SELECT "id" FROM "invoices" WHERE "id" = ${dueLink.invoiceId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "invoice_due_dates" WHERE "id" = ${command.targetDueDateId}::uuid FOR UPDATE`;
    const dueDate = await tx.invoiceDueDate.findUnique({
      where: { id: command.targetDueDateId },
      select: {
        id: true, invoiceId: true, dueDate: true, amount: true, status: true,
        invoice: { select: { id: true, number: true, issueDate: true, status: true, documentType: true, customerId: true, companyId: true } },
        payments: { select: { amount: true, returns: { select: { amount: true } } } },
        creditApplications: { select: { amount: true } },
        remittanceLines: { where: { status: "ACTIVE" }, select: { id: true }, take: 1 }
      }
    });
    if (!dueDate || dueDate.invoice.status !== "ISSUED" || dueDate.invoice.documentType !== "STANDARD" || dueDate.status !== "PENDING"
      || dueDate.invoice.customerId !== credit.customerId || dueDate.invoice.companyId !== credit.companyId || dueDate.remittanceLines.length > 0) {
      return conflict("CUSTOMER_CREDIT_TARGET_NOT_ELIGIBLE", "El vencimiento destino no esta disponible para compensacion.");
    }
    const pending = pendingDueDate(dueDate);
    if (amount.gt(pending)) return conflict("CUSTOMER_CREDIT_AMOUNT_EXCEEDS_PENDING", "El importe supera el pendiente del vencimiento.");
    const applicationDate = parseDateOnly(command.applicationDate);
    if (applicationDate < credit.sourceRectificationInvoice.issueDate || applicationDate < dueDate.invoice.issueDate) {
      return conflict("CUSTOMER_CREDIT_APPLICATION_DATE_INVALID", "La fecha de compensacion no puede ser anterior a los documentos implicados.");
    }

    const application = await tx.customerCreditApplication.create({ data: {
      creditId, targetInvoiceId: dueDate.invoiceId, targetDueDateId: dueDate.id, applicationDate, amount,
      notes: command.notes, createdById: actor.id
    }, select: { id: true } });
    await refreshInvoiceSettlement(tx, dueDate.invoiceId);
    await tx.auditEvent.create({ data: { eventType: "CUSTOMER_CREDIT_APPLIED", actorType: "USER", payload: {
      actorUserId: actor.id, creditId, applicationId: application.id, targetInvoiceId: dueDate.invoiceId, targetDueDateId: dueDate.id,
      amount: amount.toFixed(2), applicationDate: command.applicationDate, ...(context.correlationId ? { correlationId: context.correlationId } : {})
    } } });
    await storeIdempotency(tx, context, 201, { creditApplicationId: application.id });
    return creditByMovement(tx, application.id, "application", 201);
  });
}

export async function requestCustomerCreditRefund(creditId: string, command: RequestCustomerCreditRefundCommand, actor: SessionUser, context: MutationContext): Promise<CreditResult> {
  return runSerializable(async (tx) => {
    const replay = await beginIdempotent(tx, context, "creditRefundId");
    if (replay.kind === "conflict") return idempotencyConflict();
    if (replay.kind === "replay") return creditByMovement(tx, replay.id, "refund");
    await lockCredit(tx, creditId);
    const credit = await tx.customerCredit.findUnique({ where: { id: creditId }, select: creditSelect });
    if (!credit) return creditNotFound();
    const mapped = await mapCredit(tx, credit);
    if (mapped.status === "HELD") return conflict("CUSTOMER_CREDIT_HELD", "El credito permanece bloqueado hasta la aceptacion fiscal de la rectificativa.");
    const amount = new Prisma.Decimal(command.amount);
    if (amount.gt(mapped.availableAmount)) return conflict("CUSTOMER_CREDIT_AMOUNT_EXCEEDS_AVAILABLE", "El importe supera el saldo disponible del credito.");
    const bankAccount = await tx.bankAccount.findFirst({ where: { id: command.bankAccountId, companyId: credit.companyId, status: "ACTIVE" }, select: { id: true } });
    if (!bankAccount) return conflict("CUSTOMER_CREDIT_REFUND_BANK_ACCOUNT_NOT_AVAILABLE", "La cuenta bancaria no esta disponible.");
    if (parseDateOnly(command.requestedDate) < credit.sourceRectificationInvoice.issueDate) return conflict("CUSTOMER_CREDIT_REFUND_DATE_INVALID", "La fecha no puede ser anterior a la rectificativa.");
    const refund = await tx.customerCreditRefund.create({ data: {
      creditId, companyId: credit.companyId, customerId: credit.customerId, bankAccountId: bankAccount.id,
      requestedDate: parseDateOnly(command.requestedDate), amount, reasonCode: command.reasonCode,
      reference: command.reference, notes: command.notes, requestedById: actor.id
    }, select: { id: true } });
    await tx.auditEvent.create({ data: { eventType: "CUSTOMER_CREDIT_REFUND_REQUESTED", actorType: "USER", payload: {
      actorUserId: actor.id, creditId, refundId: refund.id, amount: amount.toFixed(2), requestedDate: command.requestedDate,
      reasonCode: command.reasonCode, bankAccountId: bankAccount.id, ...(context.correlationId ? { correlationId: context.correlationId } : {})
    } } });
    await storeIdempotency(tx, context, 201, { creditRefundId: refund.id });
    return creditByMovement(tx, refund.id, "refund", 201);
  });
}

export async function approveCustomerCreditRefund(refundId: string, actor: SessionUser, context: MutationContext): Promise<CreditResult> {
  return mutateRefund(refundId, actor, context, "approve");
}

export async function cancelCustomerCreditRefund(refundId: string, actor: SessionUser, context: MutationContext): Promise<CreditResult> {
  return mutateRefund(refundId, actor, context, "cancel");
}

export async function postCustomerCreditRefund(refundId: string, actor: SessionUser, context: MutationContext): Promise<CreditResult> {
  return mutateRefund(refundId, actor, context, "post");
}

async function mutateRefund(refundId: string, actor: SessionUser, context: MutationContext, action: "approve" | "post" | "cancel"): Promise<CreditResult> {
  return runSerializable(async (tx) => {
    const replay = await beginIdempotent(tx, context, "creditRefundId");
    if (replay.kind === "conflict") return idempotencyConflict();
    if (replay.kind === "replay") return creditByMovement(tx, replay.id, "refund");
    const link = await tx.customerCreditRefund.findUnique({ where: { id: refundId }, select: { creditId: true } });
    if (!link) return conflict("CUSTOMER_CREDIT_REFUND_NOT_FOUND", "El reembolso no existe.", 404);
    await lockCredit(tx, link.creditId);
    await tx.$queryRaw`SELECT "id" FROM "customer_credit_refunds" WHERE "id" = ${refundId}::uuid FOR UPDATE`;
    const refund = await tx.customerCreditRefund.findUnique({ where: { id: refundId }, select: {
      id: true, creditId: true, status: true, requestedById: true, approvedById: true, requestedDate: true, amount: true,
      bankAccount: { select: { id: true, status: true } },
      credit: { select: { companyId: true, customerId: true, sourceRectificationInvoice: { select: { customerCodeSnapshot: true, number: true } } } }
    } });
    if (!refund) return conflict("CUSTOMER_CREDIT_REFUND_NOT_FOUND", "El reembolso no existe.", 404);
    if (action === "approve") {
      if (refund.status !== "REQUESTED") return conflict("CUSTOMER_CREDIT_REFUND_NOT_REQUESTED", "El reembolso ya no esta pendiente de aprobacion.");
      if (refund.requestedById === actor.id) return conflict("CUSTOMER_CREDIT_REFUND_SELF_APPROVAL_FORBIDDEN", "La persona solicitante no puede aprobar su propio reembolso.");
      await tx.customerCreditRefund.update({ where: { id: refund.id }, data: { status: "APPROVED", approvedById: actor.id, approvedAt: new Date() } });
      await auditRefundAction(tx, "CUSTOMER_CREDIT_REFUND_APPROVED", refund, actor, context);
    } else if (action === "cancel") {
      if (refund.status !== "REQUESTED") return conflict("CUSTOMER_CREDIT_REFUND_NOT_CANCELLABLE", "Solo se puede cancelar una solicitud pendiente.");
      await tx.customerCreditRefund.update({ where: { id: refund.id }, data: { status: "CANCELLED", cancelledById: actor.id, cancelledAt: new Date() } });
      await auditRefundAction(tx, "CUSTOMER_CREDIT_REFUND_CANCELLED", refund, actor, context);
    } else {
      if (refund.status !== "APPROVED" || !refund.approvedById) return conflict("CUSTOMER_CREDIT_REFUND_NOT_APPROVED", "El reembolso debe estar aprobado antes de contabilizarse.");
      if (refund.bankAccount.status !== "ACTIVE") return conflict("CUSTOMER_CREDIT_REFUND_BANK_ACCOUNT_NOT_AVAILABLE", "La cuenta bancaria ya no esta activa.");
      const fiscalYear = (await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "accounting_fiscal_years"
        WHERE "companyId" = ${refund.credit.companyId}::uuid AND "status" = 'OPEN'
          AND "startDate" <= ${refund.requestedDate} AND "endDate" >= ${refund.requestedDate}
        FOR UPDATE
      `))[0];
      if (!fiscalYear) return conflict("CUSTOMER_CREDIT_REFUND_FISCAL_YEAR_NOT_OPEN", "No existe un ejercicio contable abierto para la fecha.");
      const customerCode = refund.credit.sourceRectificationInvoice.customerCodeSnapshot;
      if (!/^\d{1,6}$/.test(customerCode)) return conflict("CUSTOMER_CREDIT_REFUND_ACCOUNTING_ACCOUNT_NOT_AVAILABLE", "La cuenta contable del cliente no esta disponible.");
      const accountCodes = [`430${customerCode.padStart(6, "0")}`, "572000000"];
      const accounts = await tx.accountingAccount.findMany({ where: { fiscalYearId: fiscalYear.id, code: { in: accountCodes }, status: "ACTIVE", isPostable: true }, select: { id: true, code: true } });
      if (accounts.length !== 2) return conflict("CUSTOMER_CREDIT_REFUND_ACCOUNTING_ACCOUNT_NOT_AVAILABLE", "Falta alguna cuenta contable necesaria para el reembolso.");
      const lastEntry = await tx.accountingJournalEntry.findFirst({ where: { fiscalYearId: fiscalYear.id }, orderBy: { sequence: "desc" }, select: { sequence: true } });
      const sequence = (lastEntry?.sequence ?? 0) + 1;
      const number = `${refund.requestedDate.getUTCFullYear()}/${sequence.toString().padStart(6, "0")}`;
      const concept = `Reembolso credito ${refund.credit.sourceRectificationInvoice.number ?? refund.creditId}`.slice(0, 240);
      const accountByCode = new Map(accounts.map((account) => [account.code, account.id]));
      const entry = await tx.accountingJournalEntry.create({ data: {
        fiscalYearId: fiscalYear.id, customerCreditRefundId: refund.id, year: refund.requestedDate.getUTCFullYear(), sequence, number,
        accountingDate: refund.requestedDate, concept, origin: "CUSTOMER_CREDIT_REFUND", totalDebit: refund.amount, totalCredit: refund.amount,
        createdById: actor.id, lines: { create: [
          { accountId: accountByCode.get(accountCodes[0])!, position: 1, concept, debit: refund.amount, credit: new Prisma.Decimal(0) },
          { accountId: accountByCode.get(accountCodes[1])!, position: 2, concept, debit: new Prisma.Decimal(0), credit: refund.amount }
        ] }
      }, select: { id: true, number: true } });
      await tx.customerCreditRefund.update({ where: { id: refund.id }, data: { status: "POSTED", postedById: actor.id, postedAt: new Date() } });
      await tx.auditEvent.create({ data: { eventType: "CUSTOMER_CREDIT_REFUND_POSTED", actorType: "USER", payload: {
        actorUserId: actor.id, creditId: refund.creditId, refundId: refund.id, amount: refund.amount.toFixed(2), accountingJournalEntryId: entry.id,
        accountingJournalEntryNumber: entry.number, ...(context.correlationId ? { correlationId: context.correlationId } : {})
      } } });
    }
    await storeIdempotency(tx, context, 200, { creditRefundId: refund.id });
    return creditByMovement(tx, refund.id, "refund");
  });
}

async function mapCredit(tx: Prisma.TransactionClient | typeof prisma, record: CreditRecord): Promise<CustomerCreditDetail> {
  const applied = sum(record.applications);
  const reservedRefund = sum(record.refunds.filter((refund) => reservedRefundStatuses.includes(refund.status as typeof reservedRefundStatuses[number])));
  const postedRefund = sum(record.refunds.filter((refund) => refund.status === "POSTED"));
  const available = Prisma.Decimal.max(0, record.originalAmount.minus(applied).minus(reservedRefund).minus(postedRefund));
  const fiscalAvailable = ["ACCEPTED", "ACCEPTED_WITH_ERRORS", "NOT_APPLICABLE"].includes(record.sourceRectificationInvoice.verifactuStatus);
  const status: CustomerCreditStatus = !fiscalAvailable ? "HELD" : available.isZero() ? "EXHAUSTED" : available.equals(record.originalAmount) ? "AVAILABLE" : "PARTIALLY_USED";
  const eligibleDueDates = fiscalAvailable && !available.isZero() ? await eligibleDueDatesFor(tx, record.companyId, record.customerId) : [];
  return {
    id: record.id, companyId: record.companyId, customer: record.customer,
    sourceInvoice: { id: record.sourceRectificationInvoice.id, number: record.sourceRectificationInvoice.number, issueDate: formatDateOnly(record.sourceRectificationInvoice.issueDate), verifactuStatus: record.sourceRectificationInvoice.verifactuStatus },
    currency: record.currency, originalAmount: record.originalAmount.toFixed(2), appliedAmount: applied.toFixed(2), reservedRefundAmount: reservedRefund.toFixed(2), postedRefundAmount: postedRefund.toFixed(2), availableAmount: available.toFixed(2), status,
    createdAt: record.createdAt.toISOString(),
    applications: record.applications.map((application) => ({ id: application.id, applicationDate: formatDateOnly(application.applicationDate), amount: application.amount.toFixed(2), targetInvoice: application.targetInvoice, targetDueDateId: application.targetDueDateId, createdAt: application.createdAt.toISOString() })),
    refunds: record.refunds.map((refund) => ({ id: refund.id, status: refund.status, requestedDate: formatDateOnly(refund.requestedDate), amount: refund.amount.toFixed(2), reasonCode: refund.reasonCode, bankAccount: { id: refund.bankAccount.id, name: refund.bankAccount.name, maskedIban: maskIban(refund.bankAccount.iban) }, accountingEntry: refund.accountingEntry, requestedById: refund.requestedById, approvedById: refund.approvedById, createdAt: refund.createdAt.toISOString() })),
    eligibleDueDates
  };
}

async function eligibleDueDatesFor(tx: Prisma.TransactionClient | typeof prisma, companyId: string, customerId: string): Promise<CustomerCreditDetail["eligibleDueDates"]> {
  const records = await tx.invoiceDueDate.findMany({ where: {
    status: "PENDING", invoice: { companyId, customerId, status: "ISSUED", documentType: "STANDARD" },
    remittanceLines: { none: { status: "ACTIVE" } }
  }, orderBy: [{ dueDate: "asc" }, { id: "asc" }], take: 100, select: {
    id: true, invoiceId: true, dueDate: true, amount: true, invoice: { select: { number: true } },
    payments: { select: { amount: true, returns: { select: { amount: true } } } }, creditApplications: { select: { amount: true } }
  } });
  return records.map((record) => ({ id: record.id, invoiceId: record.invoiceId, invoiceNumber: record.invoice.number, dueDate: formatDateOnly(record.dueDate), pendingAmount: pendingDueDate(record).toFixed(2) })).filter((record) => new Prisma.Decimal(record.pendingAmount).gt(0));
}

async function refreshInvoiceSettlement(tx: Prisma.TransactionClient, invoiceId: string): Promise<void> {
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { total: true, dueDates: { select: {
    id: true, amount: true, payments: { select: { amount: true, returns: { select: { amount: true } } } }, creditApplications: { select: { amount: true } }
  } } } });
  let cash = new Prisma.Decimal(0);
  let credit = new Prisma.Decimal(0);
  for (const dueDate of invoice.dueDates) {
    const cashForDue = dueDate.payments.reduce((total, payment) => total.plus(payment.amount).minus(sum(payment.returns)), new Prisma.Decimal(0));
    const creditForDue = sum(dueDate.creditApplications);
    cash = cash.plus(cashForDue);
    credit = credit.plus(creditForDue);
    if (cashForDue.plus(creditForDue).equals(dueDate.amount)) await tx.invoiceDueDate.update({ where: { id: dueDate.id }, data: { status: creditForDue.gt(0) ? "SETTLED" : "PAID" } });
  }
  const settled = cash.plus(credit);
  const paymentStatus = settled.equals(invoice.total) ? (credit.gt(0) ? "SETTLED" : "PAID") : credit.gt(0) ? "PARTIALLY_SETTLED" : cash.gt(0) ? "PARTIALLY_PAID" : "PENDING";
  await tx.invoice.update({ where: { id: invoiceId }, data: { paymentStatus } });
}

function pendingDueDate(dueDate: { amount: Prisma.Decimal; payments: Array<{ amount: Prisma.Decimal; returns: Array<{ amount: Prisma.Decimal }> }>; creditApplications: Array<{ amount: Prisma.Decimal }> }): Prisma.Decimal {
  const cash = dueDate.payments.reduce((total, payment) => total.plus(payment.amount).minus(sum(payment.returns)), new Prisma.Decimal(0));
  return Prisma.Decimal.max(0, dueDate.amount.minus(cash).minus(sum(dueDate.creditApplications)));
}

async function beginIdempotent(tx: Prisma.TransactionClient, context: MutationContext, responseField: string): Promise<{ kind: "new" } | { kind: "conflict" } | { kind: "replay"; id: string }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.idempotencyKey}, 0))`;
  const stored = await tx.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
  if (!stored) return { kind: "new" };
  if (stored.requestHash !== context.requestHash) return { kind: "conflict" };
  const body = stored.responseBody;
  if (!body || typeof body !== "object" || Array.isArray(body)) return { kind: "conflict" };
  const id = body[responseField];
  return typeof id === "string" ? { kind: "replay", id } : { kind: "conflict" };
}

async function storeIdempotency(tx: Prisma.TransactionClient, context: MutationContext, status: number, body: Prisma.InputJsonValue): Promise<void> {
  await tx.idempotencyRecord.create({ data: { key: context.idempotencyKey, requestHash: context.requestHash, responseStatus: status, responseBody: body } });
}

async function creditByMovement(tx: Prisma.TransactionClient, movementId: string, kind: "application" | "refund", status: 200 | 201 = 200): Promise<CreditResult> {
  const movement = kind === "application"
    ? await tx.customerCreditApplication.findUnique({ where: { id: movementId }, select: { creditId: true } })
    : await tx.customerCreditRefund.findUnique({ where: { id: movementId }, select: { creditId: true } });
  if (!movement) return conflict("IDEMPOTENCY_REPLAY_INVALID", "No se pudo recuperar el resultado idempotente.");
  const credit = await tx.customerCredit.findUnique({ where: { id: movement.creditId }, select: creditSelect });
  if (!credit) return creditNotFound();
  return { ok: true, status, value: await mapCredit(tx, credit) };
}

async function lockCredit(tx: Prisma.TransactionClient, creditId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "customer_credits" WHERE "id" = ${creditId}::uuid FOR UPDATE`;
}

async function auditRefundAction(tx: Prisma.TransactionClient, eventType: string, refund: { id: string; creditId: string; amount: Prisma.Decimal }, actor: SessionUser, context: MutationContext): Promise<void> {
  await tx.auditEvent.create({ data: { eventType, actorType: "USER", payload: {
    actorUserId: actor.id, creditId: refund.creditId, refundId: refund.id, amount: refund.amount.toFixed(2), ...(context.correlationId ? { correlationId: context.correlationId } : {})
  } } });
}

async function runSerializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (error) { if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034" || attempt === 3) throw error; }
  }
  throw new Error("Unreachable serializable retry state.");
}

function sum(items: Array<{ amount: Prisma.Decimal }>): Prisma.Decimal {
  return items.reduce((total, item) => total.plus(item.amount), new Prisma.Decimal(0));
}
function creditNotFound(): CreditError { return conflict("CUSTOMER_CREDIT_NOT_FOUND", "El credito no existe.", 404); }
function idempotencyConflict(): CreditError { return conflict("IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se utilizo con otra operacion."); }
function conflict(code: string, message: string, status: 404 | 409 = 409): CreditError { return { ok: false, status, error: { code, message } }; }
function parseDateOnly(value: string): Date { return new Date(`${value}T00:00:00.000Z`); }
function formatDateOnly(value: Date): string { return value.toISOString().slice(0, 10); }
function isValidDateOnly(value: string): boolean { const date = parseDateOnly(value); return !Number.isNaN(date.getTime()) && formatDateOnly(date) === value; }
function maskIban(value: string): string { const compact = value.replace(/\s+/g, "").toUpperCase(); return compact.length <= 8 ? "****" : `${compact.slice(0, 4)} **** **** ${compact.slice(-4)}`; }
