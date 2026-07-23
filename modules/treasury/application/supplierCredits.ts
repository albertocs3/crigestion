import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";
import { hashIdempotencyPayload } from "@/modules/platform/application/http";
import { refreshPurchasePaymentStatus } from "@/modules/purchases/application/purchases";
import { lockOpenFiscalYearForDatedMutation } from "@/modules/accounting/application/fiscalYearMutationBarrier";

const dateOnlySchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidDateOnly, "La fecha no es valida.");
const moneySchema = z.string().trim().regex(/^\d{1,12}\.\d{2}$/).refine((value) => new Prisma.Decimal(value).gt(0), "El importe debe ser positivo.");

export const listSupplierCreditsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().uuid().optional(),
  status: z.enum(["WITH_BALANCE", "EXHAUSTED", "ALL"]).default("WITH_BALANCE"),
  supplierId: z.string().uuid().optional(),
  search: z.string().trim().min(1).max(120).optional()
}).strict();
export const applySupplierCreditSchema = z.object({
  targetDueDateId: z.string().uuid(), applicationDate: dateOnlySchema, amount: moneySchema,
  notes: z.string().trim().min(1).max(500).nullable().default(null)
}).strict();
export const requestSupplierCreditRefundSchema = z.object({
  paymentMethod: z.enum(["BANK_TRANSFER", "CASH"]), bankAccountId: z.string().uuid().nullable().default(null),
  requestedDate: dateOnlySchema, amount: moneySchema,
  reasonCode: z.enum(["SUPPLIER_REQUEST", "DUPLICATE_OR_EXCESS", "OPERATION_CANCELLED", "OTHER"]),
  reference: z.string().trim().min(1).max(120).nullable().default(null),
  notes: z.string().trim().min(1).max(500).nullable().default(null)
}).strict().superRefine((value, context) => {
  if (value.paymentMethod === "BANK_TRANSFER" && !value.bankAccountId) context.addIssue({ code: "custom", path: ["bankAccountId"], message: "La transferencia requiere una cuenta bancaria." });
  if (value.paymentMethod === "CASH" && value.bankAccountId) context.addIssue({ code: "custom", path: ["bankAccountId"], message: "El reembolso en caja no admite cuenta bancaria." });
});
export const postSupplierCreditRefundSchema = z.object({ postingDate: dateOnlySchema }).strict();

export type ApplySupplierCreditCommand = z.infer<typeof applySupplierCreditSchema>;
export type RequestSupplierCreditRefundCommand = z.infer<typeof requestSupplierCreditRefundSchema>;
export type PostSupplierCreditRefundCommand = z.infer<typeof postSupplierCreditRefundSchema>;
type MutationContext = { correlationId?: string; idempotencyKey: string; requestHash: string };
type CreditError = { ok: false; status: 404 | 409; error: { code: string; message: string } };
type CreditResult = { ok: true; status: 200 | 201; value: SupplierCreditDetail } | CreditError;

export type SupplierCreditDetail = {
  id: string; companyId: string; supplier: { id: string; code: string; legalName: string };
  sourcePurchase: { id: string; supplierInvoiceNumber: string; issueDate: string };
  currency: string; originalAmount: string; appliedAmount: string; reservedRefundAmount: string;
  postedRefundAmount: string; availableAmount: string; status: "AVAILABLE" | "PARTIALLY_USED" | "EXHAUSTED"; createdAt: string;
  applications: Array<{ id: string; applicationDate: string; amount: string; targetPurchase: { id: string; supplierInvoiceNumber: string }; targetDueDateId: string; createdAt: string }>;
  refunds: Array<{ id: string; status: "REQUESTED" | "APPROVED" | "POSTED" | "CANCELLED"; paymentMethod: "BANK_TRANSFER" | "CASH"; requestedDate: string; postingDate: string | null; amount: string; reasonCode: string; bankAccount: { id: string; name: string; maskedIban: string } | null; accountingEntry: { id: string; number: string } | null; requestedById: string; approvedById: string | null; createdAt: string }>;
  eligibleDueDates: Array<{ id: string; purchaseInvoiceId: string; supplierInvoiceNumber: string; dueDate: string; pendingAmount: string }>;
};
export type SupplierCreditList = { credits: SupplierCreditDetail[]; summary: { count: number; originalAmount: string; appliedAmount: string; refundedAmount: string; availableAmount: string }; nextCursor: string | null };

const creditSelect = {
  id: true, companyId: true, supplierId: true, currency: true, originalAmount: true, createdAt: true,
  supplier: { select: { id: true, code: true, legalName: true } },
  sourceRectificationPurchaseInvoice: { select: { id: true, supplierInvoiceNumber: true, issueDate: true } },
  applications: { orderBy: [{ applicationDate: "asc" }, { createdAt: "asc" }, { id: "asc" }], select: {
    id: true, applicationDate: true, amount: true, targetDueDateId: true, createdAt: true,
    targetPurchaseInvoice: { select: { id: true, supplierInvoiceNumber: true } }
  } },
  refunds: { orderBy: [{ requestedDate: "asc" }, { createdAt: "asc" }, { id: "asc" }], select: {
    id: true, status: true, paymentMethod: true, requestedDate: true, postingDate: true, amount: true, reasonCode: true,
    requestedById: true, approvedById: true, createdAt: true,
    bankAccount: { select: { id: true, name: true, iban: true } }, accountingEntry: { select: { id: true, number: true } }
  } }
} satisfies Prisma.SupplierCreditSelect;
type CreditRecord = Prisma.SupplierCreditGetPayload<{ select: typeof creditSelect }>;

export function hashSupplierCreditApplication(creditId: string, command: ApplySupplierCreditCommand): string {
  return hashIdempotencyPayload("supplier-credit-application:v1", { creditId, command });
}
export function hashSupplierCreditRefundRequest(creditId: string, command: RequestSupplierCreditRefundCommand): string {
  return hashIdempotencyPayload("supplier-credit-refund-request:v1", { creditId, command });
}
export function hashSupplierCreditRefundAction(refundId: string, action: "approve" | "cancel", command: Record<string, never> = {}): string {
  return hashIdempotencyPayload(`supplier-credit-refund-${action}:v1`, { refundId, command });
}
export function hashSupplierCreditRefundPost(refundId: string, command: PostSupplierCreditRefundCommand): string {
  return hashIdempotencyPayload("supplier-credit-refund-post:v1", { refundId, command });
}

export async function listSupplierCredits(command: z.infer<typeof listSupplierCreditsSchema>, actor: SessionUser): Promise<SupplierCreditList> {
  const companyId = await currentCompanyId(prisma);
  const where = { companyId: companyId!, ...(command.supplierId ? { supplierId: command.supplierId } : {}), ...(command.search ? { OR: [
      { supplier: { legalName: { contains: command.search, mode: "insensitive" } } },
      { supplier: { code: { contains: command.search, mode: "insensitive" } } },
      { sourceRectificationPurchaseInvoice: { supplierInvoiceNumber: { contains: command.search, mode: "insensitive" } } }
    ] } : {}) } satisfies Prisma.SupplierCreditWhereInput;
  const matching: SupplierCreditDetail[] = []; let scanCursor = command.cursor; let exhausted = !companyId;
  while (!exhausted && matching.length <= command.limit) {
    const batch = await prisma.supplierCredit.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], cursor: scanCursor ? { id: scanCursor } : undefined, skip: scanCursor ? 1 : 0, take: 100, select: creditSelect });
    const mapped = await Promise.all(batch.map((record) => mapCredit(prisma, record, actor.permissions.includes("Accounting.View"))));
    matching.push(...mapped.filter((credit) => command.status === "ALL" || (command.status === "EXHAUSTED" ? credit.status === "EXHAUSTED" : credit.status !== "EXHAUSTED")));
    exhausted = batch.length < 100; scanCursor = batch.at(-1)?.id;
  }
  const credits = matching.slice(0, command.limit);
  const summary = credits.reduce((total, credit) => ({ count: total.count + 1, original: total.original.plus(credit.originalAmount), applied: total.applied.plus(credit.appliedAmount), refunded: total.refunded.plus(credit.postedRefundAmount), available: total.available.plus(credit.availableAmount) }), { count: 0, original: new Prisma.Decimal(0), applied: new Prisma.Decimal(0), refunded: new Prisma.Decimal(0), available: new Prisma.Decimal(0) });
  await prisma.auditEvent.create({ data: { eventType: "SUPPLIER_CREDITS_VIEWED", actorType: "USER", payload: { actorUserId: actor.id, companyId, status: command.status, supplierId: command.supplierId ?? null, hasSearch: Boolean(command.search), resultCount: credits.length } } });
  return { credits, summary: { count: summary.count, originalAmount: summary.original.toFixed(2), appliedAmount: summary.applied.toFixed(2), refundedAmount: summary.refunded.toFixed(2), availableAmount: summary.available.toFixed(2) }, nextCursor: matching.length > command.limit ? credits.at(-1)?.id ?? null : null };
}

export async function getSupplierCredit(creditId: string, actor: SessionUser): Promise<SupplierCreditDetail | null> {
  const companyId = await currentCompanyId(prisma);
  const record = companyId ? await prisma.supplierCredit.findFirst({ where: { id: creditId, companyId }, select: creditSelect }) : null;
  return record ? mapCredit(prisma, record, actor.permissions.includes("Accounting.View")) : null;
}

export async function applySupplierCredit(creditId: string, command: ApplySupplierCreditCommand, actor: SessionUser, context: MutationContext): Promise<CreditResult> {
  return runSerializable(async (tx) => {
    const replay = await beginIdempotent(tx, context, "supplierCreditApplicationId");
    if (replay.kind === "conflict") return idempotencyConflict();
    if (replay.kind === "replay") return creditByMovement(tx, replay.id, "application", actor);
    await lockCredit(tx, creditId);
    const credit = await tx.supplierCredit.findUnique({ where: { id: creditId }, select: creditSelect });
    if (!credit || credit.companyId !== await currentCompanyId(tx)) return creditNotFound();
    const amount = new Prisma.Decimal(command.amount); const mapped = await mapCredit(tx, credit, false);
    if (amount.gt(mapped.availableAmount)) return conflict("SUPPLIER_CREDIT_AMOUNT_EXCEEDS_AVAILABLE", "El importe supera el saldo disponible del credito.");
    const dueLink = await tx.purchaseDueDate.findUnique({ where: { id: command.targetDueDateId }, select: { purchaseInvoiceId: true } });
    if (!dueLink) return conflict("SUPPLIER_CREDIT_TARGET_NOT_ELIGIBLE", "El vencimiento destino no esta disponible.");
    await tx.$queryRaw`SELECT "id" FROM "purchase_invoices" WHERE "id" = ${dueLink.purchaseInvoiceId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "purchase_due_dates" WHERE "id" = ${command.targetDueDateId}::uuid FOR UPDATE`;
    const due = await tx.purchaseDueDate.findUnique({ where: { id: command.targetDueDateId }, select: {
      id: true, purchaseInvoiceId: true, amount: true, status: true,
      purchaseInvoice: { select: { id: true, issueDate: true, status: true, documentType: true, companyId: true, supplierId: true } },
      allocations: { where: { supplierPayment: { status: "POSTED" } }, select: { amount: true } }, creditApplications: { select: { amount: true } }
    } });
    if (!due || due.status !== "PENDING" || due.purchaseInvoice.status !== "REGISTERED" || due.purchaseInvoice.documentType !== "STANDARD" || due.purchaseInvoice.companyId !== credit.companyId || due.purchaseInvoice.supplierId !== credit.supplierId) return conflict("SUPPLIER_CREDIT_TARGET_NOT_ELIGIBLE", "El vencimiento destino no esta disponible para compensacion.");
    const pending = due.amount.minus(sum(due.allocations)).minus(sum(due.creditApplications));
    if (amount.gt(pending)) return conflict("SUPPLIER_CREDIT_AMOUNT_EXCEEDS_PENDING", "El importe supera el pendiente del vencimiento.");
    const applicationDate = parseDateOnly(command.applicationDate);
    if (applicationDate < credit.sourceRectificationPurchaseInvoice.issueDate || applicationDate < due.purchaseInvoice.issueDate) return conflict("SUPPLIER_CREDIT_APPLICATION_DATE_INVALID", "La fecha no puede ser anterior a los documentos implicados.");
    const application = await tx.supplierCreditApplication.create({ data: { creditId, companyId: credit.companyId, supplierId: credit.supplierId, targetPurchaseInvoiceId: due.purchaseInvoiceId, targetDueDateId: due.id, applicationDate, amount, notes: command.notes, createdById: actor.id }, select: { id: true } });
    const settled = sum(due.allocations).plus(sum(due.creditApplications)).plus(amount);
    if (settled.equals(due.amount)) await tx.purchaseDueDate.update({ where: { id: due.id }, data: { status: "SETTLED" } });
    await refreshPurchasePaymentStatus(tx, due.purchaseInvoiceId, actor.id);
    await audit(tx, "SUPPLIER_CREDIT_APPLIED", actor, context, { companyId: credit.companyId, supplierId: credit.supplierId, creditId, applicationId: application.id, targetPurchaseInvoiceId: due.purchaseInvoiceId, targetDueDateId: due.id, amount: amount.toFixed(2), applicationDate: command.applicationDate });
    await storeIdempotency(tx, context, 201, { supplierCreditApplicationId: application.id });
    return creditByMovement(tx, application.id, "application", actor, 201);
  });
}

export async function requestSupplierCreditRefund(creditId: string, command: RequestSupplierCreditRefundCommand, actor: SessionUser, context: MutationContext): Promise<CreditResult> {
  return runSerializable(async (tx) => {
    const replay = await beginIdempotent(tx, context, "supplierCreditRefundId");
    if (replay.kind === "conflict") return idempotencyConflict();
    if (replay.kind === "replay") return creditByMovement(tx, replay.id, "refund", actor);
    await lockCredit(tx, creditId);
    const credit = await tx.supplierCredit.findUnique({ where: { id: creditId }, select: creditSelect });
    if (!credit || credit.companyId !== await currentCompanyId(tx)) return creditNotFound();
    const amount = new Prisma.Decimal(command.amount); const mapped = await mapCredit(tx, credit, false);
    if (amount.gt(mapped.availableAmount)) return conflict("SUPPLIER_CREDIT_AMOUNT_EXCEEDS_AVAILABLE", "El importe supera el saldo disponible del credito.");
    const requestedDate = parseDateOnly(command.requestedDate);
    if (requestedDate < credit.sourceRectificationPurchaseInvoice.issueDate) return conflict("SUPPLIER_CREDIT_REFUND_DATE_INVALID", "La fecha no puede ser anterior a la rectificativa.");
    if (!await lockOpenFiscalYearForDatedMutation(tx, credit.companyId, requestedDate)) return conflict("SUPPLIER_CREDIT_REFUND_FISCAL_YEAR_NOT_OPEN", "No hay un ejercicio contable abierto para la fecha de la solicitud.");
    if (command.paymentMethod === "BANK_TRANSFER") {
      const bank = await tx.bankAccount.findFirst({ where: { id: command.bankAccountId!, companyId: credit.companyId, status: "ACTIVE", currency: credit.currency }, select: { id: true } });
      if (!bank) return conflict("SUPPLIER_CREDIT_REFUND_BANK_ACCOUNT_NOT_AVAILABLE", "La cuenta bancaria no esta disponible.");
    }
    const refund = await tx.supplierCreditRefund.create({ data: { creditId, companyId: credit.companyId, supplierId: credit.supplierId, bankAccountId: command.bankAccountId, paymentMethod: command.paymentMethod, requestedDate, amount, reasonCode: command.reasonCode, reference: command.reference, notes: command.notes, requestedById: actor.id }, select: { id: true } });
    await audit(tx, "SUPPLIER_CREDIT_REFUND_REQUESTED", actor, context, { companyId: credit.companyId, supplierId: credit.supplierId, creditId, refundId: refund.id, amount: amount.toFixed(2), requestedDate: command.requestedDate, reasonCode: command.reasonCode, paymentMethod: command.paymentMethod, bankAccountId: command.bankAccountId });
    await storeIdempotency(tx, context, 201, { supplierCreditRefundId: refund.id });
    return creditByMovement(tx, refund.id, "refund", actor, 201);
  });
}

export async function approveSupplierCreditRefund(refundId: string, actor: SessionUser, context: MutationContext): Promise<CreditResult> { return mutateRefund(refundId, "approve", null, actor, context); }
export async function cancelSupplierCreditRefund(refundId: string, actor: SessionUser, context: MutationContext): Promise<CreditResult> { return mutateRefund(refundId, "cancel", null, actor, context); }
export async function postSupplierCreditRefund(refundId: string, command: PostSupplierCreditRefundCommand, actor: SessionUser, context: MutationContext): Promise<CreditResult> { return mutateRefund(refundId, "post", command, actor, context); }

async function mutateRefund(refundId: string, action: "approve" | "cancel" | "post", postCommand: PostSupplierCreditRefundCommand | null, actor: SessionUser, context: MutationContext): Promise<CreditResult> {
  return runSerializable(async (tx) => {
    const replay = await beginIdempotent(tx, context, "supplierCreditRefundId");
    if (replay.kind === "conflict") return idempotencyConflict();
    if (replay.kind === "replay") return creditByMovement(tx, replay.id, "refund", actor);
    const link = await tx.supplierCreditRefund.findUnique({ where: { id: refundId }, select: { creditId: true, companyId: true } });
    if (!link || link.companyId !== await currentCompanyId(tx)) return refundNotFound();
    await lockCredit(tx, link.creditId);
    await tx.$queryRaw`SELECT "id" FROM "supplier_credit_refunds" WHERE "id" = ${refundId}::uuid FOR UPDATE`;
    const refund = await tx.supplierCreditRefund.findUnique({ where: { id: refundId }, select: {
      id: true, creditId: true, status: true, requestedById: true, approvedById: true, requestedDate: true, amount: true, paymentMethod: true,
      bankAccount: { select: { id: true, status: true, currency: true } }, credit: { select: { companyId: true, supplierId: true, currency: true, supplier: { select: { accountingCode: true, code: true } }, sourceRectificationPurchaseInvoice: { select: { supplierInvoiceNumber: true, issueDate: true } } } }
    } });
    if (!refund) return refundNotFound();
    if (action === "approve") {
      if (refund.status !== "REQUESTED") return conflict("SUPPLIER_CREDIT_REFUND_NOT_REQUESTED", "El reembolso ya no esta pendiente de aprobacion.");
      if (refund.requestedById === actor.id) { await audit(tx, "SUPPLIER_CREDIT_REFUND_APPROVAL_DENIED", actor, context, { ...baseRefundAudit(refund), denialReason: "SELF_APPROVAL" }); return conflict("SUPPLIER_CREDIT_REFUND_SELF_APPROVAL_FORBIDDEN", "La persona solicitante no puede aprobar su propio reembolso."); }
      await tx.supplierCreditRefund.update({ where: { id: refund.id }, data: { status: "APPROVED", approvedById: actor.id, approvedAt: new Date() } });
      await audit(tx, "SUPPLIER_CREDIT_REFUND_APPROVED", actor, context, baseRefundAudit(refund));
    } else if (action === "cancel") {
      if (refund.status !== "REQUESTED" || refund.requestedById !== actor.id) { await audit(tx, "SUPPLIER_CREDIT_REFUND_CANCELLATION_DENIED", actor, context, { ...baseRefundAudit(refund), denialReason: refund.status !== "REQUESTED" ? "INVALID_STATUS" : "NOT_REQUESTER" }); return conflict("SUPPLIER_CREDIT_REFUND_NOT_CANCELLABLE", "Solo la persona solicitante puede cancelar una solicitud pendiente."); }
      await tx.supplierCreditRefund.update({ where: { id: refund.id }, data: { status: "CANCELLED", cancelledById: actor.id, cancelledAt: new Date() } });
      await audit(tx, "SUPPLIER_CREDIT_REFUND_CANCELLED", actor, context, baseRefundAudit(refund));
    } else {
      if (refund.status !== "APPROVED" || !refund.approvedById || !postCommand) return conflict("SUPPLIER_CREDIT_REFUND_NOT_APPROVED", "El reembolso debe estar aprobado antes de contabilizarse.");
      if (refund.paymentMethod === "BANK_TRANSFER" && (refund.bankAccount?.status !== "ACTIVE" || refund.bankAccount.currency !== refund.credit.currency)) return conflict("SUPPLIER_CREDIT_REFUND_BANK_ACCOUNT_NOT_AVAILABLE", "La cuenta bancaria ya no esta activa o no usa la moneda del credito.");
      const postingDate = parseDateOnly(postCommand.postingDate);
      if (postingDate < refund.requestedDate || postingDate < refund.credit.sourceRectificationPurchaseInvoice.issueDate) return conflict("SUPPLIER_CREDIT_REFUND_DATE_INVALID", "La fecha contable no puede ser anterior a la solicitud ni a la rectificativa.");
      const fiscalYear = (await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "accounting_fiscal_years" WHERE "companyId" = ${refund.credit.companyId}::uuid AND "status" = 'OPEN' AND "startDate" <= ${postingDate} AND "endDate" >= ${postingDate} FOR UPDATE`))[0];
      if (!fiscalYear) return conflict("SUPPLIER_CREDIT_REFUND_FISCAL_YEAR_NOT_OPEN", "No existe un ejercicio contable abierto para la fecha.");
      const treasuryCode = refund.paymentMethod === "CASH" ? "570000000" : "572000000";
      const codes = [refund.credit.supplier.accountingCode, treasuryCode];
      const accounts = await tx.accountingAccount.findMany({ where: { fiscalYearId: fiscalYear.id, code: { in: codes }, status: "ACTIVE", isPostable: true }, select: { id: true, code: true } });
      if (accounts.length !== 2) return conflict("SUPPLIER_CREDIT_REFUND_ACCOUNTING_ACCOUNT_NOT_AVAILABLE", "Falta la subcuenta del proveedor o de tesoreria.");
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`journal:${fiscalYear.id}`}, 0))`;
      const last = await tx.accountingJournalEntry.findFirst({ where: { fiscalYearId: fiscalYear.id }, orderBy: { sequence: "desc" }, select: { sequence: true } });
      const sequence = (last?.sequence ?? 0) + 1; const year = postingDate.getUTCFullYear(); const number = `${year}/${String(sequence).padStart(6, "0")}`;
      const concept = `Reembolso proveedor ${refund.credit.supplier.code} credito ${refund.credit.sourceRectificationPurchaseInvoice.supplierInvoiceNumber}`.slice(0, 240);
      const accountByCode = new Map(accounts.map((account) => [account.code, account.id]));
      const entry = await tx.accountingJournalEntry.create({ data: { fiscalYearId: fiscalYear.id, supplierCreditRefundId: refund.id, year, sequence, number, accountingDate: postingDate, concept, origin: "SUPPLIER_CREDIT_REFUND", totalDebit: refund.amount, totalCredit: refund.amount, createdById: actor.id, lines: { create: [
        { accountId: accountByCode.get(treasuryCode)!, position: 1, concept, debit: refund.amount, credit: new Prisma.Decimal(0) },
        { accountId: accountByCode.get(refund.credit.supplier.accountingCode)!, position: 2, concept, debit: new Prisma.Decimal(0), credit: refund.amount }
      ] } }, select: { id: true, number: true } });
      await tx.supplierCreditRefund.update({ where: { id: refund.id }, data: { status: "POSTED", postingDate, postedById: actor.id, postedAt: new Date() } });
      await audit(tx, "SUPPLIER_CREDIT_REFUND_POSTED", actor, context, { ...baseRefundAudit(refund), postingDate: postCommand.postingDate, accountingJournalEntryId: entry.id, accountingJournalEntryNumber: entry.number });
    }
    await storeIdempotency(tx, context, 200, { supplierCreditRefundId: refund.id });
    return creditByMovement(tx, refund.id, "refund", actor);
  });
}

async function mapCredit(client: Prisma.TransactionClient | typeof prisma, record: CreditRecord, canViewAccounting: boolean): Promise<SupplierCreditDetail> {
  const applied = sum(record.applications); const reserved = sum(record.refunds.filter((refund) => refund.status === "REQUESTED" || refund.status === "APPROVED")); const posted = sum(record.refunds.filter((refund) => refund.status === "POSTED"));
  const available = Prisma.Decimal.max(0, record.originalAmount.minus(applied).minus(reserved).minus(posted));
  const status = available.isZero() ? "EXHAUSTED" as const : available.equals(record.originalAmount) ? "AVAILABLE" as const : "PARTIALLY_USED" as const;
  return { id: record.id, companyId: record.companyId, supplier: record.supplier, sourcePurchase: { id: record.sourceRectificationPurchaseInvoice.id, supplierInvoiceNumber: record.sourceRectificationPurchaseInvoice.supplierInvoiceNumber, issueDate: formatDateOnly(record.sourceRectificationPurchaseInvoice.issueDate) }, currency: record.currency, originalAmount: record.originalAmount.toFixed(2), appliedAmount: applied.toFixed(2), reservedRefundAmount: reserved.toFixed(2), postedRefundAmount: posted.toFixed(2), availableAmount: available.toFixed(2), status, createdAt: record.createdAt.toISOString(),
    applications: record.applications.map((application) => ({ id: application.id, applicationDate: formatDateOnly(application.applicationDate), amount: application.amount.toFixed(2), targetPurchase: application.targetPurchaseInvoice, targetDueDateId: application.targetDueDateId, createdAt: application.createdAt.toISOString() })),
    refunds: record.refunds.map((refund) => ({ id: refund.id, status: refund.status, paymentMethod: refund.paymentMethod === "CASH" ? "CASH" as const : "BANK_TRANSFER" as const, requestedDate: formatDateOnly(refund.requestedDate), postingDate: refund.postingDate ? formatDateOnly(refund.postingDate) : null, amount: refund.amount.toFixed(2), reasonCode: refund.reasonCode, bankAccount: refund.bankAccount ? { id: refund.bankAccount.id, name: refund.bankAccount.name, maskedIban: maskIban(refund.bankAccount.iban) } : null, accountingEntry: canViewAccounting ? refund.accountingEntry : null, requestedById: refund.requestedById, approvedById: refund.approvedById, createdAt: refund.createdAt.toISOString() })),
    eligibleDueDates: available.gt(0) ? await eligibleDueDatesFor(client, record.companyId, record.supplierId) : [] };
}

async function eligibleDueDatesFor(client: Prisma.TransactionClient | typeof prisma, companyId: string, supplierId: string): Promise<SupplierCreditDetail["eligibleDueDates"]> {
  const rows = await client.purchaseDueDate.findMany({ where: { status: "PENDING", purchaseInvoice: { companyId, supplierId, status: "REGISTERED", documentType: "STANDARD" } }, orderBy: [{ dueDate: "asc" }, { id: "asc" }], take: 100, select: { id: true, purchaseInvoiceId: true, dueDate: true, amount: true, purchaseInvoice: { select: { supplierInvoiceNumber: true } }, allocations: { where: { supplierPayment: { status: "POSTED" } }, select: { amount: true } }, creditApplications: { select: { amount: true } } } });
  return rows.map((row) => ({ id: row.id, purchaseInvoiceId: row.purchaseInvoiceId, supplierInvoiceNumber: row.purchaseInvoice.supplierInvoiceNumber, dueDate: formatDateOnly(row.dueDate), pendingAmount: Prisma.Decimal.max(0, row.amount.minus(sum(row.allocations)).minus(sum(row.creditApplications))).toFixed(2) })).filter((row) => new Prisma.Decimal(row.pendingAmount).gt(0));
}

async function beginIdempotent(tx: Prisma.TransactionClient, context: MutationContext, responseField: string): Promise<{ kind: "new" } | { kind: "conflict" } | { kind: "replay"; id: string }> { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.idempotencyKey}, 0))`; const stored = await tx.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } }); if (!stored) return { kind: "new" }; if (stored.requestHash !== context.requestHash || !stored.responseBody || typeof stored.responseBody !== "object" || Array.isArray(stored.responseBody)) return { kind: "conflict" }; const id = stored.responseBody[responseField]; return typeof id === "string" ? { kind: "replay", id } : { kind: "conflict" }; }
async function storeIdempotency(tx: Prisma.TransactionClient, context: MutationContext, status: number, body: Prisma.InputJsonValue): Promise<void> { await tx.idempotencyRecord.create({ data: { key: context.idempotencyKey, requestHash: context.requestHash, responseStatus: status, responseBody: body } }); }
async function creditByMovement(tx: Prisma.TransactionClient, movementId: string, kind: "application" | "refund", actor: SessionUser, status: 200 | 201 = 200): Promise<CreditResult> { const movement = kind === "application" ? await tx.supplierCreditApplication.findUnique({ where: { id: movementId }, select: { creditId: true } }) : await tx.supplierCreditRefund.findUnique({ where: { id: movementId }, select: { creditId: true } }); if (!movement) return conflict("IDEMPOTENCY_REPLAY_INVALID", "No se pudo recuperar el resultado idempotente."); const companyId = await currentCompanyId(tx); const credit = companyId ? await tx.supplierCredit.findFirst({ where: { id: movement.creditId, companyId }, select: creditSelect }) : null; return credit ? { ok: true, status, value: await mapCredit(tx, credit, actor.permissions.includes("Accounting.View")) } : creditNotFound(); }
async function lockCredit(tx: Prisma.TransactionClient, creditId: string): Promise<void> { await tx.$queryRaw`SELECT "id" FROM "supplier_credits" WHERE "id" = ${creditId}::uuid FOR UPDATE`; }
async function currentCompanyId(client: Prisma.TransactionClient | typeof prisma): Promise<string | null> { return (await client.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId ?? null; }
async function audit(tx: Prisma.TransactionClient, eventType: string, actor: SessionUser, context: MutationContext, payload: Record<string, unknown>): Promise<void> { await tx.auditEvent.create({ data: { eventType, actorType: "USER", payload: { actorUserId: actor.id, ...payload, ...(context.correlationId ? { correlationId: context.correlationId } : {}) } } }); }
async function runSerializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> { for (let attempt = 1; attempt <= 3; attempt += 1) { try { return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); } catch (error) { if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034" || attempt === 3) throw error; } } throw new Error("Unreachable serializable retry state."); }
function baseRefundAudit(refund: { id: string; creditId: string; amount: Prisma.Decimal; credit: { companyId: string; supplierId: string } }): Record<string, unknown> { return { companyId: refund.credit.companyId, supplierId: refund.credit.supplierId, creditId: refund.creditId, refundId: refund.id, amount: refund.amount.toFixed(2) }; }
function sum(items: Array<{ amount: Prisma.Decimal }>): Prisma.Decimal { return items.reduce((total, item) => total.plus(item.amount), new Prisma.Decimal(0)); }
function creditNotFound(): CreditError { return conflict("SUPPLIER_CREDIT_NOT_FOUND", "El credito no existe.", 404); }
function refundNotFound(): CreditError { return conflict("SUPPLIER_CREDIT_REFUND_NOT_FOUND", "El reembolso no existe.", 404); }
function idempotencyConflict(): CreditError { return conflict("IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se utilizo con otra operacion."); }
function conflict(code: string, message: string, status: 404 | 409 = 409): CreditError { return { ok: false, status, error: { code, message } }; }
function parseDateOnly(value: string): Date { return new Date(`${value}T00:00:00.000Z`); }
function formatDateOnly(value: Date): string { return value.toISOString().slice(0, 10); }
function isValidDateOnly(value: string): boolean { const date = parseDateOnly(value); return !Number.isNaN(date.getTime()) && formatDateOnly(date) === value; }
function maskIban(value: string): string { const compact = value.replace(/\s+/g, "").toUpperCase(); return compact.length <= 8 ? "****" : `${compact.slice(0, 4)} **** **** ${compact.slice(-4)}`; }
