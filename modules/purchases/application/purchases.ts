import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { calculateInvoiceLine, calculateInvoiceTaxSummaries, calculateInvoiceTotals } from "@/modules/billing/application/calculations";
import type { SessionUser } from "@/modules/platform/application/auth";

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/);
const quantity = z.string().regex(/^\d{1,9}(\.\d{1,3})?$/).refine((value) => new Prisma.Decimal(value).gt(0));
const paymentMethod = z.enum(["BANK_TRANSFER", "CASH", "DIRECT_DEBIT"]);
const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable();

export const listPurchasesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(["DRAFT", "REGISTERED", "RECTIFIED", "VOIDED"]).optional(),
  paymentStatus: z.enum(["PENDING", "PARTIALLY_PAID", "PAID", "PARTIALLY_SETTLED", "SETTLED", "NOT_APPLICABLE"]).optional(),
  supplierId: z.string().uuid().optional(),
  search: z.string().trim().min(1).max(120).optional()
}).strict();

export const createPurchaseSchema = z.object({
  supplierId: z.string().uuid(),
  supplierInvoiceNumber: z.string().trim().min(1).max(80),
  issueDate: dateOnly,
  receivedDate: dateOnly,
  operationDate: dateOnly,
  accountingDate: dateOnly,
  notes: nullableText(1000).default(null)
}).strict();

export const updatePurchaseSchema = createPurchaseSchema.omit({ supplierId: true }).extend({
  expectedVersion: z.number().int().positive()
}).strict();

const purchaseLineSchema = z.object({
  catalogItemId: z.string().uuid().nullable().default(null),
  description: z.string().trim().min(1).max(500),
  quantity,
  unitPrice: money,
  discountPercent: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).refine((value) => new Prisma.Decimal(value).lte(100)).default("0"),
  discountAmount: money.default("0"),
  purchaseAccountCode: z.string().regex(/^\d{9}$/).nullable().default(null),
  taxRateId: z.string().uuid()
}).strict();

export const replacePurchaseLinesSchema = z.object({ expectedVersion: z.number().int().positive(), lines: z.array(purchaseLineSchema).min(1).max(200) }).strict();
export const replacePurchaseDueDatesSchema = z.object({ expectedVersion: z.number().int().positive(), dueDates: z.array(z.object({ dueDate: dateOnly, amount: money, paymentMethod }).strict()).min(1).max(60) }).strict();
export const registerPurchaseSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
export const createPurchaseRectificationSchema = z.object({
  mode: z.literal("FULL"),
  expectedVersion: z.number().int().positive(),
  supplierInvoiceNumber: z.string().trim().min(1).max(80),
  issueDate: dateOnly,
  receivedDate: dateOnly,
  operationDate: dateOnly,
  accountingDate: dateOnly,
  reason: z.enum(["RETURN", "OPERATION_CANCELLED"]),
  notes: nullableText(1000).default(null)
}).strict();
export const listSupplierDueDatesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  supplierId: z.string().uuid().optional(),
  status: z.enum(["PENDING", "PAID", "SETTLED", "CANCELLED"]).optional(),
  dueBefore: dateOnly.optional()
}).strict();
export const registerSupplierPaymentSchema = z.object({
  supplierId: z.string().uuid(),
  paymentDate: dateOnly,
  paymentMethod,
  reference: nullableText(120).default(null),
  notes: nullableText(500).default(null),
  allocations: z.array(z.object({ dueDateId: z.string().uuid(), amount: money }).strict()).min(1).max(100)
    .refine((rows) => new Set(rows.map((row) => row.dueDateId)).size === rows.length, "No se puede repetir un vencimiento.")
}).strict();

export type MutationContext = { correlationId?: string; idempotencyKey: string; requestHash: string; scope: string };
type PurchaseStatus = "DRAFT" | "REGISTERED" | "RECTIFIED" | "VOIDED";
type PurchasePaymentStatus = "PENDING" | "PARTIALLY_PAID" | "PAID" | "PARTIALLY_SETTLED" | "SETTLED" | "NOT_APPLICABLE";
type PaymentMethod = "BANK_TRANSFER" | "CASH" | "DIRECT_DEBIT";
type Failure = { ok: false; status: 404 | 409; error: { code: string; message: string } };
type Success<T> = { ok: true; status: 200 | 201; value: T };
export type PurchaseResult<T = PurchaseDetail> = Success<T> | Failure;

export type PurchaseListItem = {
  id: string; supplierInvoiceNumber: string; supplierCode: string; supplierName: string;
  documentType: "STANDARD" | "RECTIFICATION";
  status: PurchaseStatus; paymentStatus: PurchasePaymentStatus; issueDate: string; accountingDate: string;
  total: string; version: number;
};
export type PurchaseDetail = PurchaseListItem & {
  supplierId: string; receivedDate: string; operationDate: string; notes: string | null;
  subtotal: string; discountTotal: string; taxableBase: string; taxAmount: string;
  registeredAt: string | null; accountingEntry: { id: string; number: string } | null;
  rectificationReason: string | null;
  rectifiesPurchaseInvoice: { id: string; supplierInvoiceNumber: string } | null;
  rectificationInvoices: Array<{ id: string; supplierInvoiceNumber: string }>;
  lines: Array<{ id: string; position: number; catalogItemId: string | null; catalogItemCode: string | null; description: string; quantity: string; unitPrice: string; discountPercent: string; discountAmount: string; purchaseAccountCode: string; taxRateId: string; taxRateCode: string; taxRate: string; taxableBase: string; taxAmount: string; total: string }>;
  dueDates: Array<{ id: string; position: number; dueDate: string; amount: string; allocatedAmount: string; creditedAmount: string; pendingAmount: string; paymentMethod: PaymentMethod; status: "PENDING" | "PAID" | "SETTLED" | "CANCELLED" }>;
};
export type SupplierDueDateItem = { id: string; purchaseInvoiceId: string; supplierId: string; supplierCode: string; supplierName: string; supplierInvoiceNumber: string; dueDate: string; amount: string; allocatedAmount: string; creditedAmount: string; pendingAmount: string; paymentMethod: PaymentMethod; status: "PENDING" | "PAID" | "SETTLED" | "CANCELLED" };
export type SupplierPaymentDto = { id: string; supplierId: string; paymentDate: string; totalAmount: string; paymentMethod: PaymentMethod; reference: string | null; accountingEntry: { id: string; number: string }; allocations: Array<{ dueDateId: string; purchaseInvoiceId: string; amount: string }> };

const detailInclude = {
  lines: { orderBy: { position: "asc" as const } },
  dueDates: { orderBy: { position: "asc" as const }, include: { allocations: { where: { supplierPayment: { status: "POSTED" as const } }, select: { amount: true } }, creditApplications: { select: { amount: true } } } },
  accountingEntry: { select: { id: true, number: true } },
  rectifiesPurchaseInvoice: { select: { id: true, supplierInvoiceNumber: true } },
  rectificationInvoices: { select: { id: true, supplierInvoiceNumber: true }, orderBy: { createdAt: "asc" as const } }
} satisfies Prisma.PurchaseInvoiceInclude;
type PurchaseRecord = Prisma.PurchaseInvoiceGetPayload<{ include: typeof detailInclude }>;

export function purchaseRequestHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export async function listPurchases(command: z.infer<typeof listPurchasesSchema>, actor: SessionUser): Promise<{ purchases: PurchaseListItem[] }> {
  const companyId = await currentCompanyId(prisma);
  const rows = companyId ? await prisma.purchaseInvoice.findMany({
    where: { companyId, ...(command.status ? { status: command.status } : {}), ...(command.paymentStatus ? { paymentStatus: command.paymentStatus } : {}), ...(command.supplierId ? { supplierId: command.supplierId } : {}), ...(command.search ? { OR: [{ supplierInvoiceNumber: { contains: command.search, mode: "insensitive" } }, { supplierLegalNameSnapshot: { contains: command.search, mode: "insensitive" } }, { supplierCodeSnapshot: { contains: command.search, mode: "insensitive" } }] } : {}) },
    orderBy: [{ accountingDate: "desc" }, { id: "desc" }], take: command.limit
  }) : [];
  await audit(prisma, "PURCHASES_VIEWED", actor, {}, { companyId, resultCount: rows.length, hasSearch: Boolean(command.search) });
  return { purchases: rows.map(mapListItem) };
}

export async function getPurchase(id: string, actor: SessionUser): Promise<PurchaseResult> {
  const companyId = await currentCompanyId(prisma);
  const row = companyId ? await prisma.purchaseInvoice.findFirst({ where: { id, companyId }, include: detailInclude }) : null;
  if (!row) return failure(404, "PURCHASE_NOT_FOUND", "La factura de compra no existe.");
  await audit(prisma, "PURCHASE_VIEWED", actor, {}, { companyId, purchaseInvoiceId: id });
  return { ok: true, status: 200, value: mapDetail(row) };
}

export async function createPurchase(command: z.infer<typeof createPurchaseSchema>, actor: SessionUser, context: MutationContext): Promise<PurchaseResult> {
  return mutate(actor, context, async (tx) => {
    const replay = await replayMutation<PurchaseDetail>(tx, actor, context); if (replay) return replay;
    const companyId = await currentCompanyId(tx); if (!companyId) return failure(409, "COMPANY_NOT_INITIALIZED", "La empresa no esta inicializada.");
    const supplier = await tx.supplier.findFirst({ where: { id: command.supplierId, companyId, status: "ACTIVE" } });
    if (!supplier) return failure(404, "SUPPLIER_NOT_FOUND", "El proveedor activo no existe.");
    const dates = parsePurchaseDates(command); if (!dates.ok) return dates.failure;
    const row = await tx.purchaseInvoice.create({ data: { companyId, supplierId: supplier.id, supplierCodeSnapshot: supplier.code, supplierAccountingCodeSnapshot: supplier.accountingCode, supplierLegalNameSnapshot: supplier.legalName, supplierTaxIdLast4Snapshot: supplier.taxIdLast4, supplierTaxIdEncryptedSnapshot: supplier.taxIdEncrypted, supplierInvoiceNumber: command.supplierInvoiceNumber, supplierInvoiceNumberNormalized: normalizeInvoiceNumber(command.supplierInvoiceNumber), ...dates.value, notes: command.notes, createdById: actor.id }, include: detailInclude });
    const value = mapDetail(row); await audit(tx, "PURCHASE_DRAFT_CREATED", actor, context, { companyId, purchaseInvoiceId: row.id, supplierId: supplier.id }); await persist(tx, actor, context, 201, value);
    return { ok: true, status: 201, value };
  }, () => failure(409, "PURCHASE_NUMBER_ALREADY_USED", "Ese numero de factura ya existe para el proveedor."));
}

export async function updatePurchase(id: string, command: z.infer<typeof updatePurchaseSchema>, actor: SessionUser, context: MutationContext): Promise<PurchaseResult> {
  return mutate(actor, context, async (tx) => {
    const replay = await replayMutation<PurchaseDetail>(tx, actor, context); if (replay) return replay;
    const locked = await lockPurchase(tx, id); if (!locked) return failure(404, "PURCHASE_NOT_FOUND", "La factura de compra no existe.");
    const companyId = await currentCompanyId(tx); if (locked.companyId !== companyId) return failure(404, "PURCHASE_NOT_FOUND", "La factura de compra no existe.");
    if (locked.status !== "DRAFT") return failure(409, "PURCHASE_NOT_DRAFT", "La compra registrada no se puede modificar.");
    if (locked.version !== command.expectedVersion) return failure(409, "PURCHASE_VERSION_CONFLICT", "La compra ha cambiado. Recarga antes de guardar.");
    const dates = parsePurchaseDates(command); if (!dates.ok) return dates.failure;
    const changed = await tx.purchaseInvoice.updateMany({ where: { id, version: command.expectedVersion, status: "DRAFT" }, data: { supplierInvoiceNumber: command.supplierInvoiceNumber, supplierInvoiceNumberNormalized: normalizeInvoiceNumber(command.supplierInvoiceNumber), ...dates.value, notes: command.notes, updatedById: actor.id, version: { increment: 1 } } });
    if (changed.count !== 1) return failure(409, "PURCHASE_VERSION_CONFLICT", "La compra ha cambiado. Recarga antes de guardar.");
    const value = mapDetail(await findDetail(tx, id)); await audit(tx, "PURCHASE_DRAFT_UPDATED", actor, context, { companyId, purchaseInvoiceId: id }); await persist(tx, actor, context, 200, value); return { ok: true, status: 200, value };
  }, () => failure(409, "PURCHASE_NUMBER_ALREADY_USED", "Ese numero de factura ya existe para el proveedor."));
}

export async function replacePurchaseLines(id: string, command: z.infer<typeof replacePurchaseLinesSchema>, actor: SessionUser, context: MutationContext): Promise<PurchaseResult> {
  return mutate(actor, context, async (tx) => {
    const replay = await replayMutation<PurchaseDetail>(tx, actor, context); if (replay) return replay;
    const locked = await lockPurchase(tx, id); const companyId = await currentCompanyId(tx);
    if (!locked || locked.companyId !== companyId) return failure(404, "PURCHASE_NOT_FOUND", "La factura de compra no existe.");
    if (locked.status !== "DRAFT") return failure(409, "PURCHASE_NOT_DRAFT", "La compra registrada no se puede modificar.");
    if (locked.version !== command.expectedVersion) return failure(409, "PURCHASE_VERSION_CONFLICT", "La compra ha cambiado. Recarga antes de guardar las líneas.");
    const taxIds = [...new Set(command.lines.map((line) => line.taxRateId))];
    const itemIds = [...new Set(command.lines.flatMap((line) => line.catalogItemId ? [line.catalogItemId] : []))];
    const [taxRates, items] = await Promise.all([
      tx.catalogTaxRate.findMany({ where: { id: { in: taxIds }, status: "ACTIVE" } }),
      tx.catalogItem.findMany({ where: { id: { in: itemIds }, status: "ACTIVE" } })
    ]);
    if (taxRates.length !== taxIds.length) return failure(409, "PURCHASE_TAX_RATE_NOT_AVAILABLE", "Algún tipo de IVA no esta activo.");
    if (items.length !== itemIds.length) return failure(409, "PURCHASE_CATALOG_ITEM_NOT_AVAILABLE", "Algún elemento de catálogo no esta activo.");
    const taxes = new Map(taxRates.map((tax) => [tax.id, tax])); const catalog = new Map(items.map((item) => [item.id, item]));
    const rows = command.lines.map((line, index) => {
      const tax = taxes.get(line.taxRateId)!; const item = line.catalogItemId ? catalog.get(line.catalogItemId)! : null;
      const accountCode = line.purchaseAccountCode ?? item?.purchaseAccountCode;
      if (!accountCode) return null;
      const calc = calculateInvoiceLine({ ...line, taxRate: tax.rate });
      return { position: index + 1, catalogItemId: item?.id ?? null, catalogItemCodeSnapshot: item?.code ?? null, catalogItemKindSnapshot: item?.kind ?? null, description: line.description, quantity: new Prisma.Decimal(line.quantity), unitPrice: new Prisma.Decimal(line.unitPrice), discountPercent: new Prisma.Decimal(line.discountPercent), discountAmount: new Prisma.Decimal(line.discountAmount), purchaseAccountCode: accountCode, taxRateId: tax.id, taxRateCodeSnapshot: tax.code, taxRateNameSnapshot: tax.name, taxRateSnapshot: tax.rate, ...calc };
    });
    if (rows.some((row) => !row)) return failure(409, "PURCHASE_ACCOUNT_REQUIRED", "Cada línea necesita una subcuenta de compra.");
    const calculated = rows as NonNullable<(typeof rows)[number]>[];
    const totals = calculateInvoiceTotals(calculated.map((row) => ({ taxRateCode: row.taxRateCodeSnapshot, taxRate: row.taxRateSnapshot, ...row })));
    const summaries = calculateInvoiceTaxSummaries(calculated.map((row) => ({ taxRateCode: row.taxRateCodeSnapshot, taxRate: row.taxRateSnapshot, ...row })));
    await tx.purchaseInvoiceTaxSummary.deleteMany({ where: { purchaseInvoiceId: id } }); await tx.purchaseInvoiceLine.deleteMany({ where: { purchaseInvoiceId: id } });
    await tx.purchaseInvoiceLine.createMany({ data: calculated.map((row) => ({ purchaseInvoiceId: id, ...row })) });
    await tx.purchaseInvoiceTaxSummary.createMany({ data: summaries.map((summary) => ({ purchaseInvoiceId: id, ...summary })) });
    const updated = await tx.purchaseInvoice.updateMany({ where: { id, version: command.expectedVersion, status: "DRAFT" }, data: { ...totals, updatedById: actor.id, version: { increment: 1 } } });
    if (updated.count !== 1) return failure(409, "PURCHASE_VERSION_CONFLICT", "La compra ha cambiado. Recarga antes de guardar las líneas.");
    const value = mapDetail(await findDetail(tx, id)); await audit(tx, "PURCHASE_LINES_REPLACED", actor, context, { companyId, purchaseInvoiceId: id, lineCount: calculated.length }); await persist(tx, actor, context, 200, value); return { ok: true, status: 200, value };
  });
}

export async function replacePurchaseDueDates(id: string, command: z.infer<typeof replacePurchaseDueDatesSchema>, actor: SessionUser, context: MutationContext): Promise<PurchaseResult> {
  return mutate(actor, context, async (tx) => {
    const replay = await replayMutation<PurchaseDetail>(tx, actor, context); if (replay) return replay;
    const locked = await lockPurchase(tx, id); const companyId = await currentCompanyId(tx);
    if (!locked || locked.companyId !== companyId) return failure(404, "PURCHASE_NOT_FOUND", "La factura de compra no existe.");
    if (locked.status !== "DRAFT") return failure(409, "PURCHASE_NOT_DRAFT", "La compra registrada no se puede modificar.");
    if (locked.version !== command.expectedVersion) return failure(409, "PURCHASE_VERSION_CONFLICT", "La compra ha cambiado. Recarga antes de guardar los vencimientos.");
    const parsed = command.dueDates.map((row) => ({ ...row, dueDate: parseDate(row.dueDate), amount: new Prisma.Decimal(row.amount) }));
    if (parsed.some((row) => !row.dueDate || row.dueDate < locked.issueDate)) return failure(409, "PURCHASE_DUE_DATE_INVALID", "Los vencimientos no pueden ser anteriores a la factura.");
    const total = parsed.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0));
    if (!total.equals(locked.total)) return failure(409, "PURCHASE_DUE_DATES_TOTAL_MISMATCH", "La suma de vencimientos debe coincidir con el total.");
    await tx.purchaseDueDate.deleteMany({ where: { purchaseInvoiceId: id } }); await tx.purchaseDueDate.createMany({ data: parsed.map((row, index) => ({ purchaseInvoiceId: id, position: index + 1, dueDate: row.dueDate!, amount: row.amount, paymentMethod: row.paymentMethod })) });
    const updated = await tx.purchaseInvoice.updateMany({ where: { id, version: command.expectedVersion, status: "DRAFT" }, data: { updatedById: actor.id, version: { increment: 1 } } });
    if (updated.count !== 1) return failure(409, "PURCHASE_VERSION_CONFLICT", "La compra ha cambiado. Recarga antes de guardar los vencimientos.");
    const value = mapDetail(await findDetail(tx, id)); await audit(tx, "PURCHASE_DUE_DATES_REPLACED", actor, context, { companyId, purchaseInvoiceId: id, dueDateCount: parsed.length }); await persist(tx, actor, context, 200, value); return { ok: true, status: 200, value };
  });
}

export async function registerPurchase(id: string, command: z.infer<typeof registerPurchaseSchema>, actor: SessionUser, context: MutationContext): Promise<PurchaseResult> {
  return mutate(actor, context, async (tx) => {
    const replay = await replayMutation<PurchaseDetail>(tx, actor, context); if (replay) return replay;
    const locked = await lockPurchase(tx, id); const companyId = await currentCompanyId(tx);
    if (!locked || locked.companyId !== companyId) return failure(404, "PURCHASE_NOT_FOUND", "La factura de compra no existe.");
    if (locked.status !== "DRAFT") return failure(409, "PURCHASE_NOT_DRAFT", "La factura de compra ya no es un borrador.");
    if (locked.version !== command.expectedVersion) return failure(409, "PURCHASE_VERSION_CONFLICT", "La compra ha cambiado. Recarga antes de registrarla.");
    const invoice = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { position: "asc" } }, taxSummaries: true, dueDates: true } });
    const activeSupplier = await tx.supplier.findFirst({ where: { id: invoice.supplierId, companyId, status: "ACTIVE" }, select: { id: true } });
    if (!activeSupplier) return failure(409, "PURCHASE_SUPPLIER_INACTIVE", "El proveedor debe seguir activo para registrar la compra.");
    if (!invoice.lines.length) return failure(409, "PURCHASE_EMPTY", "Añade al menos una línea.");
    const dueTotal = invoice.dueDates.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0));
    if (!invoice.dueDates.length || !dueTotal.equals(invoice.total)) return failure(409, "PURCHASE_DUE_DATES_TOTAL_MISMATCH", "Los vencimientos deben sumar el total.");
    const fiscalYear = await lockFiscalYear(tx, companyId!, invoice.accountingDate); if (!fiscalYear) return failure(409, "PURCHASE_FISCAL_YEAR_NOT_OPEN", "No hay un ejercicio abierto para la fecha contable.");
    const requiredCodes = [...new Set([...invoice.lines.map((line) => line.purchaseAccountCode), invoice.supplierAccountingCodeSnapshot, ...(invoice.taxAmount.isZero() ? [] : ["472000000"])])];
    const accounts = await tx.accountingAccount.findMany({ where: { fiscalYearId: fiscalYear.id, code: { in: requiredCodes }, status: "ACTIVE", isPostable: true }, select: { id: true, code: true } });
    if (accounts.length !== requiredCodes.length) return failure(409, "PURCHASE_ACCOUNT_NOT_AVAILABLE", "Falta alguna subcuenta activa e imputable para contabilizar la compra.");
    const accountByCode = new Map(accounts.map((account) => [account.code, account.id]));
    const grouped = new Map<string, Prisma.Decimal>(); for (const line of invoice.lines) grouped.set(line.purchaseAccountCode, (grouped.get(line.purchaseAccountCode) ?? new Prisma.Decimal(0)).plus(line.lineTaxableBase));
    const sequence = await nextJournalSequence(tx, fiscalYear.id); const year = invoice.accountingDate.getUTCFullYear(); const concept = `Compra ${invoice.supplierInvoiceNumber} - ${invoice.supplierLegalNameSnapshot}`.slice(0, 240);
    const debitLines = [...grouped].map(([code, amount]) => ({ code, amount })); if (!invoice.taxAmount.isZero()) debitLines.push({ code: "472000000", amount: invoice.taxAmount });
    const entry = await tx.accountingJournalEntry.create({ data: { fiscalYearId: fiscalYear.id, purchaseInvoiceId: id, year, sequence, number: `${year}/${String(sequence).padStart(6, "0")}`, accountingDate: invoice.accountingDate, concept, origin: "PURCHASE_INVOICE", totalDebit: invoice.total, totalCredit: invoice.total, createdById: actor.id, lines: { create: [...debitLines.map((line, index) => ({ accountId: accountByCode.get(line.code)!, position: index + 1, concept, debit: line.amount, credit: new Prisma.Decimal(0) })), { accountId: accountByCode.get(invoice.supplierAccountingCodeSnapshot)!, position: debitLines.length + 1, concept, debit: new Prisma.Decimal(0), credit: invoice.total }] } }, select: { id: true, number: true } });
    await tx.purchaseVatRecord.createMany({ data: invoice.taxSummaries.map((summary) => ({ companyId: companyId!, supplierId: invoice.supplierId, purchaseInvoiceId: id, taxSummaryId: summary.id, accountingEntryId: entry.id, supplierInvoiceNumberSnapshot: invoice.supplierInvoiceNumber, supplierCodeSnapshot: invoice.supplierCodeSnapshot, supplierLegalNameSnapshot: invoice.supplierLegalNameSnapshot, supplierTaxIdLast4Snapshot: invoice.supplierTaxIdLast4Snapshot, supplierTaxIdEncryptedSnapshot: invoice.supplierTaxIdEncryptedSnapshot, issueDate: invoice.issueDate, accountingDate: invoice.accountingDate, taxRateCode: summary.taxRateCode, taxRate: summary.taxRate, taxableBase: summary.taxableBase, taxAmount: summary.taxAmount, total: summary.total })) });
    const stockLines = invoice.lines.filter((line) => line.catalogItemId).sort((a, b) => a.catalogItemId!.localeCompare(b.catalogItemId!));
    for (const line of stockLines) {
      const items = await tx.$queryRaw<Array<{ id: string; code: string; kind: string; stockTracked: boolean; stockCurrent: Prisma.Decimal }>>(Prisma.sql`SELECT "id", "code", "kind", "stockTracked", "stockCurrent" FROM "catalog_items" WHERE "id" = ${line.catalogItemId}::uuid FOR UPDATE`);
      const item = items[0]; if (!item || item.kind !== "PRODUCT" || !item.stockTracked) continue;
      const next = item.stockCurrent.plus(line.quantity); const unitCost = line.lineTaxableBase.div(line.quantity).toDecimalPlaces(2); await tx.catalogStockMovement.create({ data: { itemId: item.id, purchaseInvoiceLineId: line.id, type: "PURCHASE_RECEIPT", quantity: line.quantity, previousStock: item.stockCurrent, newStock: next, reason: `Entrada por compra ${invoice.supplierInvoiceNumber}`.slice(0, 500), createdById: actor.id } }); await tx.catalogItem.update({ where: { id: item.id }, data: { stockCurrent: next, costPrice: unitCost, updatedById: actor.id } });
    }
    await tx.purchaseInvoice.update({ where: { id }, data: { status: "REGISTERED", registeredAt: new Date(), registeredById: actor.id, updatedById: actor.id, version: { increment: 1 } } });
    const value = mapDetail(await findDetail(tx, id)); await audit(tx, "PURCHASE_REGISTERED", actor, context, { companyId, purchaseInvoiceId: id, supplierId: invoice.supplierId, accountingJournalEntryId: entry.id, accountingJournalEntryNumber: entry.number, stockMovementCount: stockLines.length }); await persist(tx, actor, context, 200, value); return { ok: true, status: 200, value };
  });
}

export async function createPurchaseRectification(id: string, command: z.infer<typeof createPurchaseRectificationSchema>, actor: SessionUser, context: MutationContext): Promise<PurchaseResult> {
  return mutate(actor, context, async (tx) => {
    const replay = await replayMutation<PurchaseDetail>(tx, actor, context); if (replay) return replay;
    const locked = await lockPurchase(tx, id); const companyId = await currentCompanyId(tx);
    if (!locked || locked.companyId !== companyId) return failure(404, "PURCHASE_NOT_FOUND", "La factura de compra no existe.");
    if (locked.status !== "REGISTERED") return failure(409, locked.status === "RECTIFIED" ? "PURCHASE_ALREADY_RECTIFIED" : "PURCHASE_NOT_RECTIFIABLE", "La compra no está disponible para rectificación.");
    if (locked.version !== command.expectedVersion) return failure(409, "PURCHASE_VERSION_CONFLICT", "La compra ha cambiado. Recarga antes de rectificarla.");
    const dates = parsePurchaseDates(command); if (!dates.ok) return dates.failure;

    const original = await tx.purchaseInvoice.findUniqueOrThrow({
      where: { id },
      include: {
        lines: { orderBy: { position: "asc" }, include: { stockMovement: { select: { id: true, itemId: true, quantity: true } } } },
        taxSummaries: { orderBy: [{ taxRateCode: "asc" }, { taxRate: "asc" }] },
        dueDates: { orderBy: { position: "asc" }, include: { allocations: { select: { id: true } } } },
        allocations: { select: { id: true, amount: true, supplierPayment: { select: { status: true } } } },
        rectificationInvoices: { select: { id: true }, take: 1 },
        accountingEntry: { include: { lines: { orderBy: { position: "asc" }, include: { account: { select: { code: true } } } }, reversedByEntry: { select: { id: true } } } }
      }
    });
    if (original.documentType !== "STANDARD" || original.rectificationInvoices.length > 0) return failure(409, "PURCHASE_ALREADY_RECTIFIED", "La compra ya tiene una rectificación.");
    const paidAmount = original.allocations
      .filter((allocation) => allocation.supplierPayment.status === "POSTED")
      .reduce((sum, allocation) => sum.plus(allocation.amount), new Prisma.Decimal(0));
    const cleanUnpaid = original.paymentStatus === "PENDING" && original.allocations.length === 0
      && original.dueDates.every((due) => due.status === "PENDING" && due.allocations.length === 0);
    const cleanPaid = original.paymentStatus === "PAID" && original.allocations.length > 0
      && original.allocations.every((allocation) => allocation.supplierPayment.status === "POSTED")
      && paidAmount.equals(original.total) && original.dueDates.every((due) => due.status === "PAID" && due.allocations.length > 0);
    if (!cleanUnpaid && !cleanPaid) {
      const hasPartialPayment = paidAmount.gt(0) && paidAmount.lt(original.total);
      return failure(409, hasPartialPayment ? "PURCHASE_RECTIFICATION_PARTIAL_PAYMENT_UNSUPPORTED" : "PURCHASE_RECTIFICATION_PAYMENT_STATE_INVALID",
        hasPartialPayment ? "La rectificación de compras parcialmente pagadas todavía no está disponible." : "El estado de pago de la compra no es coherente para rectificarla.");
    }
    if (!original.accountingEntry || original.accountingEntry.status !== "POSTED" || original.accountingEntry.reversedByEntry) return failure(409, "PURCHASE_ORIGINAL_ENTRY_NOT_REVERSIBLE", "El asiento original no está disponible para reversión.");
    if (!original.lines.length) return failure(409, "PURCHASE_NOT_RECTIFIABLE", "La compra no contiene líneas rectificables.");
    if (dates.value.issueDate < original.issueDate || dates.value.accountingDate < original.accountingDate) return failure(409, "PURCHASE_RECTIFICATION_DATES_INVALID", "La rectificación no puede ser anterior a la compra original.");

    const duplicateNumber = await tx.purchaseInvoice.findFirst({ where: { companyId: companyId!, supplierId: original.supplierId, supplierInvoiceNumberNormalized: normalizeInvoiceNumber(command.supplierInvoiceNumber) }, select: { id: true } });
    if (duplicateNumber) return failure(409, "PURCHASE_NUMBER_ALREADY_USED", "Ese número de factura ya existe para el proveedor.");
    const fiscalYear = await lockFiscalYear(tx, companyId!, dates.value.accountingDate); if (!fiscalYear) return failure(409, "PURCHASE_FISCAL_YEAR_NOT_OPEN", "No hay un ejercicio abierto para la fecha contable.");
    if (fiscalYear.id !== original.accountingEntry.fiscalYearId) return failure(409, "PURCHASE_RECTIFICATION_FISCAL_YEAR_MISMATCH", "La compra original y su rectificación deben contabilizarse en el mismo ejercicio abierto.");
    const originalCodes = [...new Set(original.accountingEntry.lines.map((line) => line.account.code))];
    const accounts = await tx.accountingAccount.findMany({ where: { fiscalYearId: fiscalYear.id, code: { in: originalCodes }, status: "ACTIVE", isPostable: true }, select: { id: true, code: true } });
    if (accounts.length !== originalCodes.length) return failure(409, "PURCHASE_ACCOUNT_NOT_AVAILABLE", "Falta alguna subcuenta activa e imputable para contabilizar la rectificación.");
    const accountByCode = new Map(accounts.map((account) => [account.code, account.id]));

    const rectification = await tx.purchaseInvoice.create({ data: {
      companyId: companyId!, supplierId: original.supplierId,
      supplierCodeSnapshot: original.supplierCodeSnapshot, supplierAccountingCodeSnapshot: original.supplierAccountingCodeSnapshot,
      supplierLegalNameSnapshot: original.supplierLegalNameSnapshot, supplierTaxIdLast4Snapshot: original.supplierTaxIdLast4Snapshot,
      supplierTaxIdEncryptedSnapshot: original.supplierTaxIdEncryptedSnapshot,
      supplierInvoiceNumber: command.supplierInvoiceNumber, supplierInvoiceNumberNormalized: normalizeInvoiceNumber(command.supplierInvoiceNumber),
      documentType: "RECTIFICATION", paymentStatus: "NOT_APPLICABLE", ...dates.value,
      subtotal: original.subtotal.neg(), discountTotal: original.discountTotal.neg(), taxableBase: original.taxableBase.neg(), taxAmount: original.taxAmount.neg(), total: original.total.neg(),
      notes: command.notes, rectificationReason: command.reason, rectifiesPurchaseInvoiceId: original.id, createdById: actor.id, updatedById: actor.id
    }, select: { id: true } });
    await tx.purchaseInvoiceLine.createMany({ data: original.lines.map((line) => ({
      purchaseInvoiceId: rectification.id, position: line.position, catalogItemId: line.catalogItemId,
      catalogItemCodeSnapshot: line.catalogItemCodeSnapshot, catalogItemKindSnapshot: line.catalogItemKindSnapshot,
      description: line.description, quantity: line.quantity.neg(), unitPrice: line.unitPrice,
      discountPercent: line.discountPercent, discountAmount: line.discountAmount, purchaseAccountCode: line.purchaseAccountCode,
      taxRateId: line.taxRateId, taxRateCodeSnapshot: line.taxRateCodeSnapshot, taxRateNameSnapshot: line.taxRateNameSnapshot,
      taxRateSnapshot: line.taxRateSnapshot, lineSubtotal: line.lineSubtotal.neg(), lineDiscountTotal: line.lineDiscountTotal.neg(),
      lineTaxableBase: line.lineTaxableBase.neg(), lineTaxAmount: line.lineTaxAmount.neg(), lineTotal: line.lineTotal.neg()
    })) });
    await tx.purchaseInvoiceTaxSummary.createMany({ data: original.taxSummaries.map((summary) => ({
      purchaseInvoiceId: rectification.id, taxRateCode: summary.taxRateCode, taxRate: summary.taxRate,
      taxableBase: summary.taxableBase.neg(), taxAmount: summary.taxAmount.neg(), total: summary.total.neg()
    })) });

    const sequence = await nextJournalSequence(tx, fiscalYear.id); const year = dates.value.accountingDate.getUTCFullYear();
    const concept = `Rectificativa compra ${command.supplierInvoiceNumber} de ${original.supplierInvoiceNumber}`.slice(0, 240);
    const entry = await tx.accountingJournalEntry.create({ data: {
      fiscalYearId: fiscalYear.id, purchaseInvoiceId: rectification.id, reversesEntryId: original.accountingEntry.id,
      year, sequence, number: `${year}/${String(sequence).padStart(6, "0")}`, accountingDate: dates.value.accountingDate,
      concept, origin: "PURCHASE_RECTIFICATION", totalDebit: original.accountingEntry.totalCredit, totalCredit: original.accountingEntry.totalDebit,
      createdById: actor.id, lines: { create: original.accountingEntry.lines.map((line) => ({
        accountId: accountByCode.get(line.account.code)!, position: line.position, concept,
        debit: line.credit, credit: line.debit
      })) }
    }, select: { id: true, number: true } });

    const summaries = await tx.purchaseInvoiceTaxSummary.findMany({ where: { purchaseInvoiceId: rectification.id } });
    await tx.purchaseVatRecord.createMany({ data: summaries.map((summary) => ({
      companyId: companyId!, supplierId: original.supplierId, purchaseInvoiceId: rectification.id, taxSummaryId: summary.id, accountingEntryId: entry.id,
      supplierInvoiceNumberSnapshot: command.supplierInvoiceNumber, supplierCodeSnapshot: original.supplierCodeSnapshot,
      supplierLegalNameSnapshot: original.supplierLegalNameSnapshot, supplierTaxIdLast4Snapshot: original.supplierTaxIdLast4Snapshot,
      supplierTaxIdEncryptedSnapshot: original.supplierTaxIdEncryptedSnapshot, issueDate: dates.value.issueDate, accountingDate: dates.value.accountingDate,
      taxRateCode: summary.taxRateCode, taxRate: summary.taxRate, taxableBase: summary.taxableBase, taxAmount: summary.taxAmount, total: summary.total
    })) });

    const rectificationLines = await tx.purchaseInvoiceLine.findMany({ where: { purchaseInvoiceId: rectification.id }, orderBy: { position: "asc" } });
    const rectificationLineByPosition = new Map(rectificationLines.map((line) => [line.position, line]));
    const originalStockLines = original.lines.filter((line) => line.stockMovement).sort((a, b) => a.stockMovement!.itemId.localeCompare(b.stockMovement!.itemId));
    let stockMovementCount = 0; let negativeStockCount = 0;
    for (const originalLine of originalStockLines) {
      const sourceMovement = originalLine.stockMovement!; const line = rectificationLineByPosition.get(originalLine.position)!;
      const items = await tx.$queryRaw<Array<{ id: string; stockCurrent: Prisma.Decimal }>>(Prisma.sql`SELECT "id", "stockCurrent" FROM "catalog_items" WHERE "id" = ${sourceMovement.itemId}::uuid FOR UPDATE`);
      const item = items[0]; if (!item) throw new Error("PURCHASE_STOCK_ITEM_MISSING");
      const movementQuantity = sourceMovement.quantity.neg(); const next = item.stockCurrent.plus(movementQuantity); if (next.isNegative()) negativeStockCount += 1;
      await tx.catalogStockMovement.create({ data: { itemId: item.id, purchaseInvoiceLineId: line.id, reversesMovementId: sourceMovement.id, type: "PURCHASE_RETURN", quantity: movementQuantity, previousStock: item.stockCurrent, newStock: next, reason: `Salida por rectificativa ${command.supplierInvoiceNumber}`.slice(0, 500), createdById: actor.id } });
      await tx.catalogItem.update({ where: { id: item.id }, data: { stockCurrent: next, updatedById: actor.id } }); stockMovementCount += 1;
    }

    await tx.purchaseInvoice.update({ where: { id: rectification.id }, data: { status: "REGISTERED", registeredAt: new Date(), registeredById: actor.id, updatedById: actor.id, version: { increment: 1 } } });
    let supplierCreditId: string | null = null;
    if (cleanPaid) {
      await tx.purchaseInvoice.update({ where: { id: original.id }, data: { status: "RECTIFIED", updatedById: actor.id } });
      const credit = await tx.supplierCredit.create({ data: {
        companyId: companyId!, supplierId: original.supplierId, sourceRectificationPurchaseInvoiceId: rectification.id,
        originalAmount: original.total, createdById: actor.id
      }, select: { id: true } });
      supplierCreditId = credit.id;
    } else {
      await tx.purchaseDueDate.updateMany({ where: { purchaseInvoiceId: original.id, status: "PENDING" }, data: { status: "CANCELLED" } });
      await tx.purchaseInvoice.update({ where: { id: original.id }, data: { status: "RECTIFIED", paymentStatus: "NOT_APPLICABLE", updatedById: actor.id } });
    }
    const value = mapDetail(await findDetail(tx, rectification.id));
    await audit(tx, "PURCHASE_RECTIFICATION_CREATED", actor, context, { companyId, originalPurchaseInvoiceId: original.id, rectificationPurchaseInvoiceId: rectification.id, supplierCreditId, supplierId: original.supplierId, reason: command.reason, accountingJournalEntryId: entry.id, accountingJournalEntryNumber: entry.number, stockMovementCount, negativeStockCount, totalAmount: value.total });
    await persist(tx, actor, context, 201, value); return { ok: true, status: 201, value };
  }, () => failure(409, "PURCHASE_RECTIFICATION_CONFLICT", "La compra ya se ha rectificado o el número del proveedor ya existe."));
}

export async function listSupplierDueDates(command: z.infer<typeof listSupplierDueDatesSchema>, actor: SessionUser): Promise<{ dueDates: SupplierDueDateItem[] }> {
  const companyId = await currentCompanyId(prisma);
  const rows = companyId ? await prisma.purchaseDueDate.findMany({ where: { purchaseInvoice: { companyId, status: "REGISTERED", ...(command.supplierId ? { supplierId: command.supplierId } : {}) }, ...(command.status ? { status: command.status } : {}), ...(command.dueBefore ? { dueDate: { lte: parseDate(command.dueBefore)! } } : {}) }, include: { purchaseInvoice: true, allocations: { where: { supplierPayment: { status: "POSTED" } }, select: { amount: true } }, creditApplications: { select: { amount: true } } }, orderBy: [{ dueDate: "asc" }, { id: "asc" }], take: command.limit }) : [];
  await audit(prisma, "SUPPLIER_DUE_DATES_VIEWED", actor, {}, { companyId, resultCount: rows.length, supplierId: command.supplierId ?? null, status: command.status ?? null, dueBefore: command.dueBefore ?? null });
  return { dueDates: rows.map(mapDueDate) };
}

export async function registerSupplierPayment(command: z.infer<typeof registerSupplierPaymentSchema>, actor: SessionUser, context: MutationContext): Promise<PurchaseResult<SupplierPaymentDto>> {
  return mutate(actor, context, async (tx) => {
    const replay = await replayMutation<SupplierPaymentDto>(tx, actor, context); if (replay) return replay;
    const companyId = await currentCompanyId(tx); if (!companyId) return failure(409, "COMPANY_NOT_INITIALIZED", "La empresa no esta inicializada.");
    const dueIds = [...command.allocations.map((row) => row.dueDateId)].sort();
    const dueReferences = await tx.purchaseDueDate.findMany({ where: { id: { in: dueIds } }, select: { id: true, purchaseInvoiceId: true } });
    if (dueReferences.length !== dueIds.length) return failure(404, "SUPPLIER_DUE_DATE_NOT_FOUND", "Algún vencimiento no existe.");
    const purchaseIds = [...new Set(dueReferences.map((row) => row.purchaseInvoiceId))].sort();
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "purchase_invoices" WHERE "id" IN (${Prisma.join(purchaseIds.map((purchaseId) => Prisma.sql`${purchaseId}::uuid`))}) ORDER BY "id" FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "purchase_due_dates" WHERE "id" IN (${Prisma.join(dueIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "id" FOR UPDATE`);
    const dueDates = await tx.purchaseDueDate.findMany({ where: { id: { in: dueIds } }, include: { purchaseInvoice: true, allocations: { where: { supplierPayment: { status: "POSTED" } }, select: { amount: true } }, creditApplications: { select: { amount: true } } } });
    if (dueDates.length !== dueIds.length) return failure(404, "SUPPLIER_DUE_DATE_NOT_FOUND", "Algún vencimiento no existe.");
    const byId = new Map(dueDates.map((row) => [row.id, row])); const allocations = command.allocations.map((row) => ({ due: byId.get(row.dueDateId)!, amount: new Prisma.Decimal(row.amount) }));
    if (allocations.some(({ due }) => due.purchaseInvoice.companyId !== companyId || due.purchaseInvoice.supplierId !== command.supplierId || due.purchaseInvoice.status !== "REGISTERED" || due.status === "CANCELLED")) return failure(409, "SUPPLIER_PAYMENT_SCOPE_MISMATCH", "Los vencimientos no pertenecen al proveedor y empresa indicados.");
    for (const allocation of allocations) { const used = [...allocation.due.allocations, ...allocation.due.creditApplications].reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0)); if (allocation.due.status !== "PENDING" || used.plus(allocation.amount).gt(allocation.due.amount)) return failure(409, "SUPPLIER_PAYMENT_EXCEEDS_PENDING", "El pago supera el importe pendiente de un vencimiento."); }
    const paymentDate = parseDate(command.paymentDate); if (!paymentDate) return failure(409, "SUPPLIER_PAYMENT_DATE_INVALID", "La fecha de pago no es válida.");
    const fiscalYear = await lockFiscalYear(tx, companyId, paymentDate); if (!fiscalYear) return failure(409, "SUPPLIER_PAYMENT_FISCAL_YEAR_NOT_OPEN", "No hay un ejercicio abierto para la fecha de pago.");
    const supplier = await tx.supplier.findFirst({ where: { id: command.supplierId, companyId }, select: { accountingCode: true, code: true } }); if (!supplier) return failure(404, "SUPPLIER_NOT_FOUND", "El proveedor no existe.");
    const treasuryCode = command.paymentMethod === "CASH" ? "570000000" : "572000000"; const accounts = await tx.accountingAccount.findMany({ where: { fiscalYearId: fiscalYear.id, code: { in: [supplier.accountingCode, treasuryCode] }, status: "ACTIVE", isPostable: true }, select: { id: true, code: true } }); if (accounts.length !== 2) return failure(409, "SUPPLIER_PAYMENT_ACCOUNT_NOT_AVAILABLE", "Falta la subcuenta del proveedor o de tesorería.");
    const total = allocations.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0)); const payment = await tx.supplierPayment.create({ data: { companyId, supplierId: command.supplierId, paymentDate, totalAmount: total, paymentMethod: command.paymentMethod, reference: command.reference, notes: command.notes, createdById: actor.id } });
    await tx.supplierPaymentAllocation.createMany({ data: allocations.map(({ due, amount }) => ({ supplierPaymentId: payment.id, purchaseInvoiceId: due.purchaseInvoiceId, dueDateId: due.id, amount })) });
    const accountByCode = new Map(accounts.map((account) => [account.code, account.id])); const sequence = await nextJournalSequence(tx, fiscalYear.id); const year = paymentDate.getUTCFullYear(); const concept = `Pago proveedor ${supplier.code}${command.reference ? ` - ${command.reference}` : ""}`.slice(0, 240);
    const entry = await tx.accountingJournalEntry.create({ data: { fiscalYearId: fiscalYear.id, supplierPaymentId: payment.id, year, sequence, number: `${year}/${String(sequence).padStart(6, "0")}`, accountingDate: paymentDate, concept, origin: "SUPPLIER_PAYMENT", totalDebit: total, totalCredit: total, createdById: actor.id, lines: { create: [{ accountId: accountByCode.get(supplier.accountingCode)!, position: 1, concept, debit: total, credit: new Prisma.Decimal(0) }, { accountId: accountByCode.get(treasuryCode)!, position: 2, concept, debit: new Prisma.Decimal(0), credit: total }] } }, select: { id: true, number: true } });
    for (const { due, amount } of allocations) { const paid = due.allocations.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0)).plus(amount); const credited = due.creditApplications.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0)); await tx.purchaseDueDate.update({ where: { id: due.id }, data: { status: paid.plus(credited).equals(due.amount) ? (credited.gt(0) ? "SETTLED" : "PAID") : "PENDING" } }); }
    for (const purchaseId of [...new Set(allocations.map(({ due }) => due.purchaseInvoiceId))]) await refreshPurchasePaymentStatus(tx, purchaseId, actor.id);
    const value: SupplierPaymentDto = { id: payment.id, supplierId: payment.supplierId, paymentDate: formatDate(payment.paymentDate), totalAmount: payment.totalAmount.toFixed(2), paymentMethod: payment.paymentMethod, reference: payment.reference, accountingEntry: entry, allocations: allocations.map(({ due, amount }) => ({ dueDateId: due.id, purchaseInvoiceId: due.purchaseInvoiceId, amount: amount.toFixed(2) })) };
    await audit(tx, "SUPPLIER_PAYMENT_REGISTERED", actor, context, { companyId, supplierId: command.supplierId, supplierPaymentId: payment.id, allocationCount: allocations.length, totalAmount: total.toFixed(2), accountingJournalEntryId: entry.id }); await persist(tx, actor, context, 201, value); return { ok: true, status: 201, value };
  });
}

export async function refreshPurchasePaymentStatus(tx: Prisma.TransactionClient, id: string, actorId: string): Promise<void> { const row = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id }, include: { allocations: { where: { supplierPayment: { status: "POSTED" } }, select: { amount: true } }, creditApplications: { select: { amount: true } } } }); const paid = row.allocations.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0)); const credited = row.creditApplications.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0)); const settled = paid.plus(credited); const status: PurchasePaymentStatus = settled.isZero() ? "PENDING" : credited.gt(0) ? (settled.gte(row.total) ? "SETTLED" : "PARTIALLY_SETTLED") : (settled.gte(row.total) ? "PAID" : "PARTIALLY_PAID"); await tx.purchaseInvoice.update({ where: { id }, data: { paymentStatus: status, updatedById: actorId } }); }
async function lockPurchase(tx: Prisma.TransactionClient, id: string): Promise<{ id: string; companyId: string; status: PurchaseStatus; version: number; total: Prisma.Decimal; issueDate: Date } | null> { const rows = await tx.$queryRaw<Array<{ id: string; companyId: string; status: PurchaseStatus; version: number; total: Prisma.Decimal; issueDate: Date }>>(Prisma.sql`SELECT "id", "companyId", "status", "version", "total", "issueDate" FROM "purchase_invoices" WHERE "id" = ${id}::uuid FOR UPDATE`); return rows[0] ?? null; }
async function lockFiscalYear(tx: Prisma.TransactionClient, companyId: string, date: Date): Promise<{ id: string } | null> { const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "accounting_fiscal_years" WHERE "companyId" = ${companyId}::uuid AND "status" = 'OPEN' AND "startDate" <= ${date} AND "endDate" >= ${date} FOR UPDATE`); return rows.length === 1 ? rows[0]! : null; }
async function nextJournalSequence(tx: Prisma.TransactionClient, fiscalYearId: string): Promise<number> { const last = await tx.accountingJournalEntry.findFirst({ where: { fiscalYearId }, orderBy: { sequence: "desc" }, select: { sequence: true } }); return (last?.sequence ?? 0) + 1; }
async function currentCompanyId(client: Prisma.TransactionClient | typeof prisma): Promise<string | null> { return (await client.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId ?? null; }
async function findDetail(tx: Prisma.TransactionClient, id: string): Promise<PurchaseRecord> { return tx.purchaseInvoice.findUniqueOrThrow({ where: { id }, include: detailInclude }); }
function parsePurchaseDates(command: { issueDate: string; receivedDate: string; operationDate: string; accountingDate: string }): { ok: true; value: { issueDate: Date; receivedDate: Date; operationDate: Date; accountingDate: Date } } | { ok: false; failure: Failure } { const issueDate = parseDate(command.issueDate); const receivedDate = parseDate(command.receivedDate); const operationDate = parseDate(command.operationDate); const accountingDate = parseDate(command.accountingDate); if (!issueDate || !receivedDate || !operationDate || !accountingDate || receivedDate < issueDate || accountingDate < issueDate) return { ok: false, failure: failure(409, "PURCHASE_DATES_INVALID", "Revisa las fechas: recepción y contabilización no pueden ser anteriores a la emisión.") }; return { ok: true, value: { issueDate, receivedDate, operationDate, accountingDate } }; }
function parseDate(value: string): Date | null { const date = new Date(`${value}T00:00:00.000Z`); return Number.isNaN(date.getTime()) || formatDate(date) !== value ? null : date; }
function formatDate(value: Date): string { return value.toISOString().slice(0, 10); }
function normalizeInvoiceNumber(value: string): string { return value.trim().toLocaleUpperCase("es-ES").replace(/\s+/g, " "); }
function mapListItem(row: { id: string; supplierInvoiceNumber: string; supplierCodeSnapshot: string; supplierLegalNameSnapshot: string; documentType: "STANDARD" | "RECTIFICATION"; status: PurchaseStatus; paymentStatus: PurchasePaymentStatus; issueDate: Date; accountingDate: Date; total: Prisma.Decimal; version: number }): PurchaseListItem { return { id: row.id, supplierInvoiceNumber: row.supplierInvoiceNumber, supplierCode: row.supplierCodeSnapshot, supplierName: row.supplierLegalNameSnapshot, documentType: row.documentType, status: row.status, paymentStatus: row.paymentStatus, issueDate: formatDate(row.issueDate), accountingDate: formatDate(row.accountingDate), total: row.total.toFixed(2), version: row.version }; }
function mapDetail(row: PurchaseRecord): PurchaseDetail { return { ...mapListItem(row), supplierId: row.supplierId, receivedDate: formatDate(row.receivedDate), operationDate: formatDate(row.operationDate), notes: row.notes, subtotal: row.subtotal.toFixed(2), discountTotal: row.discountTotal.toFixed(2), taxableBase: row.taxableBase.toFixed(2), taxAmount: row.taxAmount.toFixed(2), registeredAt: row.registeredAt?.toISOString() ?? null, accountingEntry: row.accountingEntry, rectificationReason: row.rectificationReason, rectifiesPurchaseInvoice: row.rectifiesPurchaseInvoice, rectificationInvoices: row.rectificationInvoices, lines: row.lines.map((line) => ({ id: line.id, position: line.position, catalogItemId: line.catalogItemId, catalogItemCode: line.catalogItemCodeSnapshot, description: line.description, quantity: line.quantity.toFixed(3), unitPrice: line.unitPrice.toFixed(2), discountPercent: line.discountPercent.toFixed(2), discountAmount: line.discountAmount.toFixed(2), purchaseAccountCode: line.purchaseAccountCode, taxRateId: line.taxRateId, taxRateCode: line.taxRateCodeSnapshot, taxRate: line.taxRateSnapshot.toFixed(2), taxableBase: line.lineTaxableBase.toFixed(2), taxAmount: line.lineTaxAmount.toFixed(2), total: line.lineTotal.toFixed(2) })), dueDates: row.dueDates.map((due) => { const allocated = due.allocations.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0)); const credited = due.creditApplications.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0)); return { id: due.id, position: due.position, dueDate: formatDate(due.dueDate), amount: due.amount.toFixed(2), allocatedAmount: allocated.toFixed(2), creditedAmount: credited.toFixed(2), pendingAmount: Prisma.Decimal.max(due.amount.minus(allocated).minus(credited), 0).toFixed(2), paymentMethod: due.paymentMethod, status: due.status }; }) }; }
function mapDueDate(row: Prisma.PurchaseDueDateGetPayload<{ include: { purchaseInvoice: true; allocations: { select: { amount: true } }; creditApplications: { select: { amount: true } } } }>): SupplierDueDateItem { const allocated = row.allocations.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0)); const credited = row.creditApplications.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0)); return { id: row.id, purchaseInvoiceId: row.purchaseInvoiceId, supplierId: row.purchaseInvoice.supplierId, supplierCode: row.purchaseInvoice.supplierCodeSnapshot, supplierName: row.purchaseInvoice.supplierLegalNameSnapshot, supplierInvoiceNumber: row.purchaseInvoice.supplierInvoiceNumber, dueDate: formatDate(row.dueDate), amount: row.amount.toFixed(2), allocatedAmount: allocated.toFixed(2), creditedAmount: credited.toFixed(2), pendingAmount: Prisma.Decimal.max(row.amount.minus(allocated).minus(credited), 0).toFixed(2), paymentMethod: row.paymentMethod, status: row.status }; }
function failure(status: 404 | 409, code: string, message: string): Failure { return { ok: false, status, error: { code, message } }; }
function scopedKey(actor: SessionUser, context: MutationContext, companyId: string | null): string { return `v2:purchases:${createHash("sha256").update(`${companyId ?? "uninitialized"}:${actor.id}:${context.scope}:${context.idempotencyKey}`).digest("hex")}`; }
async function replayMutation<T>(tx: Prisma.TransactionClient, actor: SessionUser, context: MutationContext): Promise<PurchaseResult<T> | null> { const key = scopedKey(actor, context, await currentCompanyId(tx)); await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`; const row = await tx.idempotencyRecord.findUnique({ where: { key } }); if (!row) return null; return row.requestHash === context.requestHash ? { ok: true, status: row.responseStatus as 200 | 201, value: row.responseBody as unknown as T } : failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra petición."); }
async function persist<T>(tx: Prisma.TransactionClient, actor: SessionUser, context: MutationContext, status: number, value: T): Promise<void> { const key = scopedKey(actor, context, await currentCompanyId(tx)); await tx.idempotencyRecord.create({ data: { key, requestHash: context.requestHash, responseStatus: status, responseBody: value as unknown as Prisma.InputJsonValue } }); }
async function mutate<T>(actor: SessionUser, context: MutationContext, work: (tx: Prisma.TransactionClient) => Promise<PurchaseResult<T>>, uniqueConflict?: () => PurchaseResult<T>): Promise<PurchaseResult<T>> { for (let attempt = 0; attempt < 3; attempt++) { try { return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); } catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && attempt < 2) continue; if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { const key = scopedKey(actor, context, await currentCompanyId(prisma)); const replay = await prisma.idempotencyRecord.findUnique({ where: { key } }); if (replay) return replay.requestHash === context.requestHash ? { ok: true, status: replay.responseStatus as 200 | 201, value: replay.responseBody as unknown as T } : failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra petición."); if (uniqueConflict) return uniqueConflict(); } throw error; } } throw new Error("PURCHASE_TRANSACTION_RETRY_EXHAUSTED"); }
async function audit(client: Prisma.TransactionClient | typeof prisma, eventType: string, actor: SessionUser, context: Pick<MutationContext, "correlationId">, payload: Record<string, unknown>): Promise<void> { await client.auditEvent.create({ data: { eventType, actorType: "USER", payload: { actorUserId: actor.id, ...payload, ...(context.correlationId ? { correlationId: context.correlationId } : {}) } } }); }
