import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { calculateInvoiceLine, calculateInvoiceTaxSummaries, calculateInvoiceTotals } from "@/modules/billing/application/calculations";
import type { SessionUser } from "@/modules/platform/application/auth";
import { lockOpenFiscalYearForDatedMutation } from "@/modules/accounting/application/fiscalYearMutationBarrier";

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/);
const quantity = z.string().regex(/^\d{1,9}(\.\d{1,3})?$/).refine((value) => new Prisma.Decimal(value).gt(0));
const paymentMethod = z.enum(["BANK_TRANSFER", "CASH", "DIRECT_DEBIT"]);
const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable();

export const listPurchasesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(["DRAFT", "REGISTERED", "RECTIFIED", "VOIDED", "SUPERSEDED"]).optional(),
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
const purchaseDueDateSchema = z.object({ dueDate: dateOnly, amount: money, paymentMethod }).strict();
export const replacePurchaseDueDatesSchema = z.object({ expectedVersion: z.number().int().positive(), dueDates: z.array(purchaseDueDateSchema).min(1).max(60) }).strict();
export const registerPurchaseSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
const createFullPurchaseRectificationSchema = z.object({
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
const createPartialPurchaseRectificationSchema = z.object({
  mode: z.literal("PARTIAL"),
  expectedVersion: z.number().int().positive(),
  supplierInvoiceNumber: z.string().trim().min(1).max(80),
  issueDate: dateOnly,
  receivedDate: dateOnly,
  operationDate: dateOnly,
  accountingDate: dateOnly,
  reason: z.literal("RETURN"),
  notes: nullableText(1000).default(null),
  confirmation: z.literal("PARTIAL_PURCHASE_RETURN_CONFIRMED"),
  lines: z.array(z.object({ sourcePurchaseInvoiceLineId: z.string().uuid(), quantity }).strict()).min(1).max(200)
    .refine((lines) => new Set(lines.map((line) => line.sourcePurchaseInvoiceLineId)).size === lines.length, "No se puede repetir una línea original.")
}).strict();
export const createPurchaseRectificationSchema = z.union([createFullPurchaseRectificationSchema, createPartialPurchaseRectificationSchema]);
const createPurchaseVoidSchema = z.object({
  mode: z.literal("VOID"),
  expectedVersion: z.number().int().positive(),
  accountingDate: dateOnly,
  reasonCode: z.literal("DUPLICATE_DOCUMENT"),
  reason: nullableText(500).default(null),
  confirmation: z.literal("VOID_PURCHASE_WITHOUT_FINANCIAL_ACTIVITY")
}).strict();
const createPurchaseReplacementSchema = z.object({
  mode: z.literal("REPLACE"),
  expectedVersion: z.number().int().positive(),
  accountingDate: dateOnly,
  reasonCode: z.enum(["DATA_ENTRY_ERROR", "WRONG_DATE", "WRONG_AMOUNT", "WRONG_TAX", "OTHER"]),
  reason: nullableText(500).default(null),
  confirmation: z.literal("REPLACE_PURCHASE_WITHOUT_FINANCIAL_ACTIVITY"),
  replacement: z.object({
    issueDate: dateOnly, receivedDate: dateOnly, operationDate: dateOnly, accountingDate: dateOnly,
    notes: nullableText(1000).default(null),
    lines: z.array(purchaseLineSchema).min(1).max(200),
    dueDates: z.array(purchaseDueDateSchema).min(1).max(60)
  }).strict()
}).strict().superRefine((value, context) => {
  if (value.reasonCode === "OTHER" && !value.reason) context.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "El motivo OTHER requiere una explicación." });
  if (value.accountingDate !== value.replacement.accountingDate) context.addIssue({ code: z.ZodIssueCode.custom, path: ["replacement", "accountingDate"], message: "La sustitución y la nueva versión deben contabilizarse en la misma fecha." });
});
export const createPurchaseCorrectionSchema = z.union([createPurchaseVoidSchema, createPurchaseReplacementSchema]);
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
type PurchaseStatus = "DRAFT" | "REGISTERED" | "RECTIFIED" | "VOIDED" | "SUPERSEDED";
type PurchasePaymentStatus = "PENDING" | "PARTIALLY_PAID" | "PAID" | "PARTIALLY_SETTLED" | "SETTLED" | "NOT_APPLICABLE";
type PaymentMethod = "BANK_TRANSFER" | "CASH" | "DIRECT_DEBIT";
type Failure = { ok: false; status: 404 | 409 | 503; error: { code: string; message: string } };
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
  rectificationReason: string | null; rectificationMode: "FULL" | "PARTIAL" | null;
  rectifiesPurchaseInvoice: { id: string; supplierInvoiceNumber: string } | null;
  rectificationInvoices: Array<{ id: string; supplierInvoiceNumber: string; rectificationMode: "FULL" | "PARTIAL" | null }>;
  supersededByPurchaseInvoice: { id: string; supplierInvoiceNumber: string } | null;
  supersedesPurchaseInvoice: { id: string; supplierInvoiceNumber: string } | null;
  lines: Array<{ id: string; position: number; catalogItemId: string | null; catalogItemCode: string | null; description: string; quantity: string; rectifiedQuantity: string; remainingRectifiableQuantity: string; unitPrice: string; discountPercent: string; discountAmount: string; purchaseAccountCode: string; taxRateId: string; taxRateCode: string; taxRate: string; taxableBase: string; taxAmount: string; total: string }>;
  dueDates: Array<{ id: string; position: number; dueDate: string; amount: string; allocatedAmount: string; creditedAmount: string; pendingAmount: string; paymentMethod: PaymentMethod; status: "PENDING" | "PAID" | "SETTLED" | "CANCELLED" }>;
};
export type SupplierDueDateItem = { id: string; purchaseInvoiceId: string; supplierId: string; supplierCode: string; supplierName: string; supplierInvoiceNumber: string; dueDate: string; amount: string; allocatedAmount: string; creditedAmount: string; pendingAmount: string; paymentMethod: PaymentMethod; status: "PENDING" | "PAID" | "SETTLED" | "CANCELLED" };
export type SupplierPaymentDto = { id: string; supplierId: string; paymentDate: string; totalAmount: string; paymentMethod: PaymentMethod; reference: string | null; accountingEntry: { id: string; number: string }; allocations: Array<{ dueDateId: string; purchaseInvoiceId: string; amount: string }> };
export type PurchaseCorrectionDto = { operationId: string; purchaseInvoiceId: string; replacementPurchaseInvoiceId: string | null; mode: "VOID" | "REPLACE"; status: "VOIDED" | "SUPERSEDED"; paymentStatus: "NOT_APPLICABLE"; reversalEntry: { id: string; number: string }; replacementEntry: { id: string; number: string } | null; vatAdjustmentCount: number; stockReversalCount: number; replacementVatRecordCount: number; replacementStockMovementCount: number };
const purchaseCorrectionReplaySchema = z.object({ operationId: z.string().uuid(), purchaseInvoiceId: z.string().uuid(), replacementPurchaseInvoiceId: z.string().uuid().nullable().default(null),
  mode: z.enum(["VOID", "REPLACE"]), status: z.enum(["VOIDED", "SUPERSEDED"]), paymentStatus: z.literal("NOT_APPLICABLE"),
  reversalEntry: z.object({ id: z.string().uuid(), number: z.string() }).strict(), replacementEntry: z.object({ id: z.string().uuid(), number: z.string() }).strict().nullable().default(null),
  vatAdjustmentCount: z.number().int().nonnegative(), stockReversalCount: z.number().int().nonnegative(), replacementVatRecordCount: z.number().int().nonnegative().default(0),
  replacementStockMovementCount: z.number().int().nonnegative().default(0) }).strict().superRefine((value, context) => {
    if (value.mode === "VOID" && (value.status !== "VOIDED" || value.replacementPurchaseInvoiceId || value.replacementEntry)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Replay VOID incompatible." });
    if (value.mode === "REPLACE" && (value.status !== "SUPERSEDED" || !value.replacementPurchaseInvoiceId || !value.replacementEntry)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Replay REPLACE incompatible." });
  });

const replayPurchaseLinkSchema = z.object({ id: z.string().uuid(), supplierInvoiceNumber: z.string() }).strict();
const purchaseDetailReplaySchema = z.object({
  id: z.string().uuid(), supplierInvoiceNumber: z.string(), supplierCode: z.string(), supplierName: z.string(),
  documentType: z.enum(["STANDARD", "RECTIFICATION"]), status: z.enum(["DRAFT", "REGISTERED", "RECTIFIED", "VOIDED", "SUPERSEDED"]),
  paymentStatus: z.enum(["PENDING", "PARTIALLY_PAID", "PAID", "PARTIALLY_SETTLED", "SETTLED", "NOT_APPLICABLE"]),
  issueDate: dateOnly, accountingDate: dateOnly, total: z.string(), version: z.number().int().positive(), supplierId: z.string().uuid(), receivedDate: dateOnly, operationDate: dateOnly,
  notes: z.string().nullable(), subtotal: z.string(), discountTotal: z.string(), taxableBase: z.string(), taxAmount: z.string(), registeredAt: z.string().datetime().nullable(),
  accountingEntry: z.object({ id: z.string().uuid(), number: z.string() }).strict().nullable(), rectificationReason: z.string().nullable(), rectificationMode: z.enum(["FULL", "PARTIAL"]).nullable().default(null),
  rectifiesPurchaseInvoice: replayPurchaseLinkSchema.nullable(),
  rectificationInvoices: z.array(replayPurchaseLinkSchema.extend({ rectificationMode: z.enum(["FULL", "PARTIAL"]).nullable().default(null) }).strict()),
  supersededByPurchaseInvoice: replayPurchaseLinkSchema.nullable(), supersedesPurchaseInvoice: replayPurchaseLinkSchema.nullable(),
  lines: z.array(z.object({
    id: z.string().uuid(), position: z.number().int().positive(), catalogItemId: z.string().uuid().nullable(), catalogItemCode: z.string().nullable(), description: z.string(), quantity: z.string(),
    rectifiedQuantity: z.string().default("0.000"), remainingRectifiableQuantity: z.string().optional(), unitPrice: z.string(), discountPercent: z.string(), discountAmount: z.string(),
    purchaseAccountCode: z.string(), taxRateId: z.string().uuid(), taxRateCode: z.string(), taxRate: z.string(), taxableBase: z.string(), taxAmount: z.string(), total: z.string()
  }).strict().transform((line) => ({ ...line, remainingRectifiableQuantity: line.remainingRectifiableQuantity ?? line.quantity }))),
  dueDates: z.array(z.object({ id: z.string().uuid(), position: z.number().int().positive(), dueDate: dateOnly, amount: z.string(), allocatedAmount: z.string(), creditedAmount: z.string(), pendingAmount: z.string(), paymentMethod, status: z.enum(["PENDING", "PAID", "SETTLED", "CANCELLED"]) }).strict())
}).strict();

const detailInclude = {
  lines: { orderBy: { position: "asc" as const }, include: { rectificationLines: { where: { purchaseInvoice: { status: "REGISTERED" as const, rectificationMode: "PARTIAL" as const } }, select: { quantity: true } } } },
  dueDates: { orderBy: { position: "asc" as const }, include: { allocations: { where: { supplierPayment: { status: "POSTED" as const } }, select: { amount: true } }, creditApplications: { select: { amount: true } } } },
  accountingEntry: { select: { id: true, number: true } },
  rectifiesPurchaseInvoice: { select: { id: true, supplierInvoiceNumber: true } },
  rectificationInvoices: { select: { id: true, supplierInvoiceNumber: true, rectificationMode: true }, orderBy: { createdAt: "asc" as const } },
  sourceCorrectionOperation: { select: { replacementPurchaseInvoice: { select: { id: true, supplierInvoiceNumber: true } } } },
  replacementCorrectionOperation: { select: { sourcePurchaseInvoice: { select: { id: true, supplierInvoiceNumber: true } } } }
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
    if (!await lockOpenFiscalYearForDatedMutation(tx, companyId, dates.value.accountingDate)) return failure(409, "PURCHASE_ACCOUNTING_FISCAL_YEAR_NOT_OPEN", "No hay un ejercicio contable abierto para la fecha contable.");
    const normalizedNumber = normalizeInvoiceNumber(command.supplierInvoiceNumber);
    const identity = await tx.purchaseSupplierDocumentIdentity.create({ data: { companyId, supplierId: supplier.id, supplierInvoiceNumberNormalized: normalizedNumber }, select: { id: true } });
    const row = await tx.purchaseInvoice.create({ data: { companyId, supplierId: supplier.id, documentIdentityId: identity.id, supplierCodeSnapshot: supplier.code, supplierAccountingCodeSnapshot: supplier.accountingCode, supplierLegalNameSnapshot: supplier.legalName, supplierTaxIdLast4Snapshot: supplier.taxIdLast4, supplierTaxIdEncryptedSnapshot: supplier.taxIdEncrypted, supplierInvoiceNumber: command.supplierInvoiceNumber, supplierInvoiceNumberNormalized: normalizedNumber, ...dates.value, notes: command.notes, createdById: actor.id }, include: detailInclude });
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
    if (!companyId || !await lockOpenFiscalYearForDatedMutation(tx, companyId, dates.value.accountingDate)) return failure(409, "PURCHASE_ACCOUNTING_FISCAL_YEAR_NOT_OPEN", "No hay un ejercicio contable abierto para la fecha contable.");
    const normalizedNumber = normalizeInvoiceNumber(command.supplierInvoiceNumber);
    await tx.purchaseSupplierDocumentIdentity.update({ where: { id: locked.documentIdentityId }, data: { supplierInvoiceNumberNormalized: normalizedNumber } });
    const changed = await tx.purchaseInvoice.updateMany({ where: { id, version: command.expectedVersion, status: "DRAFT" }, data: { supplierInvoiceNumber: command.supplierInvoiceNumber, supplierInvoiceNumberNormalized: normalizedNumber, ...dates.value, notes: command.notes, updatedById: actor.id, version: { increment: 1 } } });
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
  return command.mode === "PARTIAL"
    ? createPartialPurchaseRectification(id, command, actor, context)
    : createFullPurchaseRectification(id, command, actor, context);
}

async function createFullPurchaseRectification(id: string, command: z.infer<typeof createFullPurchaseRectificationSchema>, actor: SessionUser, context: MutationContext): Promise<PurchaseResult> {
  return mutate(actor, context, async (tx) => {
    const replay = await replayMutation<unknown>(tx, actor, context); if (replay) return validatePurchaseDetailReplay(replay);
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
    const rectificationNumber = normalizeInvoiceNumber(command.supplierInvoiceNumber);
    const rectificationIdentity = await tx.purchaseSupplierDocumentIdentity.create({ data: { companyId: companyId!, supplierId: original.supplierId,
      supplierInvoiceNumberNormalized: rectificationNumber }, select: { id: true } });

    const rectification = await tx.purchaseInvoice.create({ data: {
      companyId: companyId!, supplierId: original.supplierId, documentIdentityId: rectificationIdentity.id,
      supplierCodeSnapshot: original.supplierCodeSnapshot, supplierAccountingCodeSnapshot: original.supplierAccountingCodeSnapshot,
      supplierLegalNameSnapshot: original.supplierLegalNameSnapshot, supplierTaxIdLast4Snapshot: original.supplierTaxIdLast4Snapshot,
      supplierTaxIdEncryptedSnapshot: original.supplierTaxIdEncryptedSnapshot,
      supplierInvoiceNumber: command.supplierInvoiceNumber, supplierInvoiceNumberNormalized: rectificationNumber,
      documentType: "RECTIFICATION", paymentStatus: "NOT_APPLICABLE", ...dates.value,
      subtotal: original.subtotal.neg(), discountTotal: original.discountTotal.neg(), taxableBase: original.taxableBase.neg(), taxAmount: original.taxAmount.neg(), total: original.total.neg(),
      notes: command.notes, rectificationReason: command.reason, rectificationMode: "FULL", rectifiesPurchaseInvoiceId: original.id, createdById: actor.id, updatedById: actor.id
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

async function createPartialPurchaseRectification(id: string, command: z.infer<typeof createPartialPurchaseRectificationSchema>, actor: SessionUser, context: MutationContext): Promise<PurchaseResult> {
  return mutate(actor, context, async (tx) => {
    const replay = await replayMutation<unknown>(tx, actor, context); if (replay) return validatePurchaseDetailReplay(replay);
    const locked = await lockPurchase(tx, id); const companyId = await currentCompanyId(tx);
    if (!locked || locked.companyId !== companyId) return failure(404, "PURCHASE_NOT_FOUND", "La factura de compra no existe.");
    if (locked.status !== "REGISTERED" || locked.documentType !== "STANDARD") return failure(409, "PURCHASE_NOT_RECTIFIABLE", "La compra no está disponible para rectificación parcial.");
    if (locked.version !== command.expectedVersion) return failure(409, "PURCHASE_VERSION_CONFLICT", "La compra ha cambiado. Recarga antes de rectificarla.");
    const dates = parsePurchaseDates(command); if (!dates.ok) return dates.failure;

    const original = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id }, include: {
      lines: { orderBy: { position: "asc" }, include: { stockMovement: { select: { id: true, itemId: true, quantity: true } } } },
      dueDates: { orderBy: { position: "asc" }, include: { allocations: { where: { supplierPayment: { status: "POSTED" } }, select: { amount: true } }, creditApplications: { select: { amount: true } } } },
      rectificationInvoices: { where: { status: "REGISTERED" }, select: { id: true, rectificationMode: true, total: true } },
      accountingEntry: { select: { id: true, fiscalYearId: true, status: true } }
    } });
    if (original.rectificationInvoices.some((invoice) => invoice.rectificationMode === "FULL")) return failure(409, "PURCHASE_ALREADY_RECTIFIED", "La compra ya tiene una rectificación total.");
    if (!original.accountingEntry || original.accountingEntry.status !== "POSTED") return failure(409, "PURCHASE_ORIGINAL_ENTRY_NOT_REVERSIBLE", "El asiento original no está disponible para rectificación.");
    if (dates.value.issueDate < original.issueDate || dates.value.accountingDate < original.accountingDate) return failure(409, "PURCHASE_RECTIFICATION_DATES_INVALID", "La rectificación no puede ser anterior a la compra original.");

    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = ${id}::uuid ORDER BY "position", "id" FOR UPDATE`);
    const requestedIds = command.lines.map((line) => line.sourcePurchaseInvoiceLineId).sort();
    const selected = original.lines.filter((line) => requestedIds.includes(line.id));
    if (selected.length !== requestedIds.length) return failure(409, "PURCHASE_RECTIFICATION_LINE_NOT_FOUND", "Alguna línea original no está disponible.");
    const previousLines = await tx.purchaseInvoiceLine.findMany({ where: { sourcePurchaseInvoiceLineId: { in: requestedIds }, purchaseInvoice: { status: "REGISTERED", rectificationMode: "PARTIAL" } } });
    const previousBySource = new Map<string, typeof previousLines>();
    for (const line of previousLines) previousBySource.set(line.sourcePurchaseInvoiceLineId!, [...(previousBySource.get(line.sourcePurchaseInvoiceLineId!) ?? []), line]);
    const commandBySource = new Map(command.lines.map((line) => [line.sourcePurchaseInvoiceLineId, new Prisma.Decimal(line.quantity)]));
    let roundingConflict = false;
    const calculated = selected.map((source) => {
      const previous = previousBySource.get(source.id) ?? []; const selectedQuantity = commandBySource.get(source.id)!;
      const returnedQuantity = previous.reduce((sum, line) => sum.plus(line.quantity.abs()), new Prisma.Decimal(0));
      const remainingQuantity = source.quantity.minus(returnedQuantity);
      if (remainingQuantity.lte(0) || selectedQuantity.gt(remainingQuantity)) return null;
      const already = { discountAmount: previous.reduce((sum, line) => sum.plus(line.discountAmount), new Prisma.Decimal(0)),
        lineSubtotal: previous.reduce((sum, line) => sum.plus(line.lineSubtotal.abs()), new Prisma.Decimal(0)), lineDiscountTotal: previous.reduce((sum, line) => sum.plus(line.lineDiscountTotal.abs()), new Prisma.Decimal(0)),
        lineTaxableBase: previous.reduce((sum, line) => sum.plus(line.lineTaxableBase.abs()), new Prisma.Decimal(0)), lineTaxAmount: previous.reduce((sum, line) => sum.plus(line.lineTaxAmount.abs()), new Prisma.Decimal(0)),
        lineTotal: previous.reduce((sum, line) => sum.plus(line.lineTotal.abs()), new Prisma.Decimal(0)) };
      const allocate = (sourceAmount: Prisma.Decimal, allocated: Prisma.Decimal) => selectedQuantity.equals(remainingQuantity) ? sourceAmount.minus(allocated) : sourceAmount.mul(selectedQuantity).div(source.quantity).toDecimalPlaces(2);
      const amounts = { discountAmount: allocate(source.discountAmount, already.discountAmount), lineSubtotal: allocate(source.lineSubtotal, already.lineSubtotal),
        lineDiscountTotal: allocate(source.lineDiscountTotal, already.lineDiscountTotal), lineTaxableBase: allocate(source.lineTaxableBase, already.lineTaxableBase),
        lineTaxAmount: allocate(source.lineTaxAmount, already.lineTaxAmount), lineTotal: allocate(source.lineTotal, already.lineTotal) };
      if (amounts.lineTotal.lte(0) || (!selectedQuantity.equals(remainingQuantity) && (
        amounts.discountAmount.gt(source.discountAmount.minus(already.discountAmount)) || amounts.lineSubtotal.gt(source.lineSubtotal.minus(already.lineSubtotal))
        || amounts.lineDiscountTotal.gt(source.lineDiscountTotal.minus(already.lineDiscountTotal)) || amounts.lineTaxableBase.gt(source.lineTaxableBase.minus(already.lineTaxableBase))
        || amounts.lineTaxAmount.gt(source.lineTaxAmount.minus(already.lineTaxAmount)) || amounts.lineTotal.gte(source.lineTotal.minus(already.lineTotal))
      ))) { roundingConflict = true; return null; }
      return { source, quantity: selectedQuantity.neg(), discountAmount: amounts.discountAmount, lineSubtotal: amounts.lineSubtotal.neg(), lineDiscountTotal: amounts.lineDiscountTotal.neg(),
        lineTaxableBase: amounts.lineTaxableBase.neg(), lineTaxAmount: amounts.lineTaxAmount.neg(), lineTotal: amounts.lineTotal.neg() };
    });
    if (roundingConflict) return failure(409, "PURCHASE_RECTIFICATION_ROUNDING_CONFLICT", "El prorrateo redondeado agotaría importes antes que la cantidad original.");
    if (calculated.some((line) => !line)) return failure(409, "PURCHASE_RECTIFICATION_QUANTITY_EXCEEDS_REMAINING", "La cantidad supera el remanente rectificable de una línea.");
    const lines = calculated.filter((line): line is NonNullable<typeof line> => Boolean(line));
    const totals = { subtotal: lines.reduce((sum, line) => sum.plus(line.lineSubtotal), new Prisma.Decimal(0)), discountTotal: lines.reduce((sum, line) => sum.plus(line.lineDiscountTotal), new Prisma.Decimal(0)),
      taxableBase: lines.reduce((sum, line) => sum.plus(line.lineTaxableBase), new Prisma.Decimal(0)), taxAmount: lines.reduce((sum, line) => sum.plus(line.lineTaxAmount), new Prisma.Decimal(0)), total: lines.reduce((sum, line) => sum.plus(line.lineTotal), new Prisma.Decimal(0)) };
    if (!totals.total.isNegative()) return failure(409, "PURCHASE_RECTIFICATION_ROUNDING_CONFLICT", "La rectificación parcial no produce un importe negativo válido.");

    const stockSources = lines.filter((line) => line.source.stockMovement).sort((a, b) => a.source.stockMovement!.itemId.localeCompare(b.source.stockMovement!.itemId));
    const itemIds = [...new Set(stockSources.map((line) => line.source.stockMovement!.itemId))];
    const lockedItems = itemIds.length ? await tx.$queryRaw<Array<{ id: string; stockCurrent: Prisma.Decimal }>>(Prisma.sql`SELECT "id", "stockCurrent" FROM "catalog_items" WHERE "id" IN (${Prisma.join(itemIds.map((itemId) => Prisma.sql`${itemId}::uuid`))}) ORDER BY "id" FOR UPDATE`) : [];
    const itemById = new Map(lockedItems.map((item) => [item.id, item]));
    if (lockedItems.length !== itemIds.length) throw new Error("PURCHASE_STOCK_ITEM_MISSING");
    const fiscalYear = await lockFiscalYear(tx, companyId!, dates.value.accountingDate); if (!fiscalYear) return failure(409, "PURCHASE_FISCAL_YEAR_NOT_OPEN", "No hay un ejercicio abierto para la fecha contable.");
    if (fiscalYear.id !== original.accountingEntry.fiscalYearId) return failure(409, "PURCHASE_RECTIFICATION_FISCAL_YEAR_MISMATCH", "La compra original y su rectificación deben contabilizarse en el mismo ejercicio abierto.");
    const requiredCodes = [...new Set([...lines.map((line) => line.source.purchaseAccountCode), original.supplierAccountingCodeSnapshot, ...(totals.taxAmount.isZero() ? [] : ["472000000"])])];
    const accounts = await tx.accountingAccount.findMany({ where: { fiscalYearId: fiscalYear.id, code: { in: requiredCodes }, status: "ACTIVE", isPostable: true }, select: { id: true, code: true } });
    if (accounts.length !== requiredCodes.length) return failure(409, "PURCHASE_ACCOUNT_NOT_AVAILABLE", "Falta alguna subcuenta activa e imputable para contabilizar la rectificación.");
    const accountByCode = new Map(accounts.map((account) => [account.code, account.id]));
    const normalizedNumber = normalizeInvoiceNumber(command.supplierInvoiceNumber);
    if (await tx.purchaseInvoice.findFirst({ where: { companyId: companyId!, supplierId: original.supplierId, supplierInvoiceNumberNormalized: normalizedNumber }, select: { id: true } })) return failure(409, "PURCHASE_NUMBER_ALREADY_USED", "Ese número de factura ya existe para el proveedor.");
    const identity = await tx.purchaseSupplierDocumentIdentity.create({ data: { companyId: companyId!, supplierId: original.supplierId, supplierInvoiceNumberNormalized: normalizedNumber }, select: { id: true } });
    const rectification = await tx.purchaseInvoice.create({ data: { companyId: companyId!, supplierId: original.supplierId, documentIdentityId: identity.id,
      supplierCodeSnapshot: original.supplierCodeSnapshot, supplierAccountingCodeSnapshot: original.supplierAccountingCodeSnapshot, supplierLegalNameSnapshot: original.supplierLegalNameSnapshot,
      supplierTaxIdLast4Snapshot: original.supplierTaxIdLast4Snapshot, supplierTaxIdEncryptedSnapshot: original.supplierTaxIdEncryptedSnapshot,
      supplierInvoiceNumber: command.supplierInvoiceNumber, supplierInvoiceNumberNormalized: normalizedNumber, documentType: "RECTIFICATION", rectificationMode: "PARTIAL",
      rectifiesPurchaseVersion: locked.version, paymentStatus: "NOT_APPLICABLE", ...dates.value, ...totals, notes: command.notes, rectificationReason: command.reason, rectifiesPurchaseInvoiceId: original.id,
      createdById: actor.id, updatedById: actor.id }, select: { id: true } });
    await tx.purchaseInvoiceLine.createMany({ data: lines.map((line) => ({ purchaseInvoiceId: rectification.id, sourcePurchaseInvoiceLineId: line.source.id, position: line.source.position,
      catalogItemId: line.source.catalogItemId, catalogItemCodeSnapshot: line.source.catalogItemCodeSnapshot, catalogItemKindSnapshot: line.source.catalogItemKindSnapshot,
      description: line.source.description, quantity: line.quantity, unitPrice: line.source.unitPrice, discountPercent: line.source.discountPercent, discountAmount: line.discountAmount,
      purchaseAccountCode: line.source.purchaseAccountCode, taxRateId: line.source.taxRateId, taxRateCodeSnapshot: line.source.taxRateCodeSnapshot,
      taxRateNameSnapshot: line.source.taxRateNameSnapshot, taxRateSnapshot: line.source.taxRateSnapshot, lineSubtotal: line.lineSubtotal,
      lineDiscountTotal: line.lineDiscountTotal, lineTaxableBase: line.lineTaxableBase, lineTaxAmount: line.lineTaxAmount, lineTotal: line.lineTotal })) });
    const summaryMap = new Map<string, { taxRateCode: string; taxRate: Prisma.Decimal; taxableBase: Prisma.Decimal; taxAmount: Prisma.Decimal; total: Prisma.Decimal }>();
    for (const line of lines) { const key = `${line.source.taxRateCodeSnapshot}:${line.source.taxRateSnapshot.toFixed(2)}`; const current = summaryMap.get(key) ?? { taxRateCode: line.source.taxRateCodeSnapshot, taxRate: line.source.taxRateSnapshot, taxableBase: new Prisma.Decimal(0), taxAmount: new Prisma.Decimal(0), total: new Prisma.Decimal(0) }; current.taxableBase = current.taxableBase.plus(line.lineTaxableBase); current.taxAmount = current.taxAmount.plus(line.lineTaxAmount); current.total = current.total.plus(line.lineTotal); summaryMap.set(key, current); }
    await tx.purchaseInvoiceTaxSummary.createMany({ data: [...summaryMap.values()].map((summary) => ({ purchaseInvoiceId: rectification.id, ...summary })) });

    const sequence = await nextJournalSequence(tx, fiscalYear.id); const year = dates.value.accountingDate.getUTCFullYear(); const concept = `Rectificativa parcial ${command.supplierInvoiceNumber} de ${original.supplierInvoiceNumber}`.slice(0, 240);
    const creditsByCode = new Map<string, Prisma.Decimal>(); for (const line of lines) creditsByCode.set(line.source.purchaseAccountCode, (creditsByCode.get(line.source.purchaseAccountCode) ?? new Prisma.Decimal(0)).plus(line.lineTaxableBase.abs()));
    const creditLines = [...creditsByCode].map(([code, amount]) => ({ code, amount })); if (!totals.taxAmount.isZero()) creditLines.push({ code: "472000000", amount: totals.taxAmount.abs() });
    const entry = await tx.accountingJournalEntry.create({ data: { fiscalYearId: fiscalYear.id, purchaseInvoiceId: rectification.id, adjustsEntryId: original.accountingEntry.id,
      year, sequence, number: `${year}/${String(sequence).padStart(6, "0")}`, accountingDate: dates.value.accountingDate, concept, origin: "PURCHASE_RECTIFICATION",
      totalDebit: totals.total.abs(), totalCredit: totals.total.abs(), createdById: actor.id, lines: { create: [{ accountId: accountByCode.get(original.supplierAccountingCodeSnapshot)!, position: 1, concept, debit: totals.total.abs(), credit: new Prisma.Decimal(0) },
        ...creditLines.map((line, index) => ({ accountId: accountByCode.get(line.code)!, position: index + 2, concept, debit: new Prisma.Decimal(0), credit: line.amount }))] } }, select: { id: true, number: true } });
    const summaries = await tx.purchaseInvoiceTaxSummary.findMany({ where: { purchaseInvoiceId: rectification.id } });
    await tx.purchaseVatRecord.createMany({ data: summaries.map((summary) => ({ companyId: companyId!, supplierId: original.supplierId, purchaseInvoiceId: rectification.id, taxSummaryId: summary.id, accountingEntryId: entry.id,
      supplierInvoiceNumberSnapshot: command.supplierInvoiceNumber, supplierCodeSnapshot: original.supplierCodeSnapshot, supplierLegalNameSnapshot: original.supplierLegalNameSnapshot,
      supplierTaxIdLast4Snapshot: original.supplierTaxIdLast4Snapshot, supplierTaxIdEncryptedSnapshot: original.supplierTaxIdEncryptedSnapshot, issueDate: dates.value.issueDate,
      accountingDate: dates.value.accountingDate, taxRateCode: summary.taxRateCode, taxRate: summary.taxRate, taxableBase: summary.taxableBase, taxAmount: summary.taxAmount, total: summary.total })) });
    const createdLines = await tx.purchaseInvoiceLine.findMany({ where: { purchaseInvoiceId: rectification.id }, select: { id: true, sourcePurchaseInvoiceLineId: true } });
    const createdBySource = new Map(createdLines.map((line) => [line.sourcePurchaseInvoiceLineId!, line.id])); let negativeStockCount = 0;
    for (const line of stockSources) { const sourceMovement = line.source.stockMovement!; const item = itemById.get(sourceMovement.itemId)!; const next = item.stockCurrent.plus(line.quantity); if (next.isNegative()) negativeStockCount += 1;
      await tx.catalogStockMovement.create({ data: { itemId: item.id, purchaseInvoiceLineId: createdBySource.get(line.source.id)!, sourceMovementId: sourceMovement.id, type: "PURCHASE_RETURN", quantity: line.quantity,
        previousStock: item.stockCurrent, newStock: next, reason: `Salida por rectificativa parcial ${command.supplierInvoiceNumber}`.slice(0, 500), createdById: actor.id } });
      await tx.catalogItem.update({ where: { id: item.id }, data: { stockCurrent: next, updatedById: actor.id } }); item.stockCurrent = next; }
    await tx.purchaseInvoice.update({ where: { id: rectification.id }, data: { status: "REGISTERED", registeredAt: new Date(), registeredById: actor.id, updatedById: actor.id, version: { increment: 1 } } });
    const credit = await tx.supplierCredit.create({ data: { companyId: companyId!, supplierId: original.supplierId, sourceRectificationPurchaseInvoiceId: rectification.id, originalAmount: totals.total.abs(), createdById: actor.id }, select: { id: true } });
    let available = totals.total.abs(); let applicationCount = 0;
    for (const due of [...original.dueDates].sort((a, b) => b.position - a.position)) { const settled = due.allocations.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0)).plus(due.creditApplications.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0))); const pending = Prisma.Decimal.max(due.amount.minus(settled), 0); const amount = Prisma.Decimal.min(pending, available); if (amount.lte(0)) continue;
      await tx.supplierCreditApplication.create({ data: { creditId: credit.id, companyId: companyId!, supplierId: original.supplierId, targetPurchaseInvoiceId: original.id, targetDueDateId: due.id,
        applicationDate: dates.value.accountingDate, amount, notes: null, createdById: actor.id } }); available = available.minus(amount); applicationCount += 1;
      await tx.purchaseDueDate.update({ where: { id: due.id }, data: { status: settled.plus(amount).equals(due.amount) ? "SETTLED" : "PENDING" } }); if (available.isZero()) break; }
    await refreshPurchasePaymentStatus(tx, original.id, actor.id);
    const previousQuantityBySource = new Map<string, Prisma.Decimal>(); for (const line of previousLines) previousQuantityBySource.set(line.sourcePurchaseInvoiceLineId!, (previousQuantityBySource.get(line.sourcePurchaseInvoiceLineId!) ?? new Prisma.Decimal(0)).plus(line.quantity.abs()));
    const allQuantitiesExhausted = original.lines.every((line) => (previousQuantityBySource.get(line.id) ?? new Prisma.Decimal(0)).plus(commandBySource.get(line.id) ?? 0).equals(line.quantity));
    await tx.purchaseInvoice.update({ where: { id: original.id }, data: { ...(allQuantitiesExhausted ? { status: "RECTIFIED" as const } : {}), version: { increment: 1 }, updatedById: actor.id } });
    const value = mapDetail(await findDetail(tx, rectification.id));
    await audit(tx, "PURCHASE_PARTIAL_RECTIFICATION_CREATED", actor, context, { companyId, originalPurchaseInvoiceId: original.id, rectificationPurchaseInvoiceId: rectification.id, supplierCreditId: credit.id,
      supplierId: original.supplierId, accountingJournalEntryId: entry.id, lineCount: lines.length, stockMovementCount: stockSources.length, negativeStockCount, creditApplicationCount: applicationCount, hasAvailableCredit: available.gt(0) });
    await persist(tx, actor, context, 201, value); return { ok: true, status: 201, value };
  }, () => failure(409, "PURCHASE_RECTIFICATION_CONFLICT", "La compra o el número de la rectificativa ha cambiado concurrentemente."));
}

export async function createPurchaseCorrection(id: string, command: z.infer<typeof createPurchaseCorrectionSchema>, actor: SessionUser, context: MutationContext): Promise<PurchaseResult<PurchaseCorrectionDto>> {
  return command.mode === "REPLACE" ? createPurchaseReplacement(id, command, actor, context) : createPurchaseVoid(id, command, actor, context);
}

async function createPurchaseVoid(id: string, command: Extract<z.infer<typeof createPurchaseCorrectionSchema>, { mode: "VOID" }>, actor: SessionUser, context: MutationContext): Promise<PurchaseResult<PurchaseCorrectionDto>> {
  return mutate(actor, context, async (tx) => {
    const replay = await replayMutation<PurchaseCorrectionDto>(tx, actor, context); if (replay) return replay;
    const locked = await lockPurchase(tx, id); const companyId = await currentCompanyId(tx);
    if (!locked || locked.companyId !== companyId) return failure(404, "PURCHASE_NOT_FOUND", "La factura de compra no existe.");
    if (locked.version !== command.expectedVersion) return failure(409, "PURCHASE_VERSION_CONFLICT", "La compra ha cambiado. Recarga antes de anularla.");
    if (locked.documentType !== "STANDARD" || locked.status !== "REGISTERED") return failure(409, "PURCHASE_CORRECTION_NOT_ALLOWED", "Solo se puede anular una compra ordinaria registrada.");
    const accountingDate = parseDate(command.accountingDate);
    if (!accountingDate || accountingDate < locked.issueDate) return failure(409, "PURCHASE_CORRECTION_DATE_INVALID", "La fecha de anulación no puede ser anterior a la factura.");
    const source = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id }, include: {
      accountingEntry: { include: { fiscalYear: true, lines: { orderBy: { position: "asc" } } } },
      sourceCorrectionOperation: { select: { id: true } }, rectificationInvoices: { select: { id: true }, take: 1 },
      dueDates: { include: { allocations: { select: { id: true } }, creditApplications: { select: { id: true } } } },
      vatRecords: { where: { kind: "DOCUMENT" }, orderBy: { id: "asc" } },
      lines: { orderBy: { position: "asc" }, include: { stockMovement: true } }
    } });
    if (accountingDate < source.accountingDate) return failure(409, "PURCHASE_CORRECTION_DATE_INVALID", "La fecha de anulación no puede ser anterior a la fecha contable original.");
    if (source.sourceCorrectionOperation) return failure(409, "PURCHASE_CORRECTION_ALREADY_COMPLETED", "La compra ya tiene una corrección interna.");
    if (source.rectificationInvoices.length) return failure(409, "PURCHASE_CORRECTION_HAS_RECTIFICATION", "La compra ya tiene una rectificativa del proveedor.");
    const hasFinancialActivity = source.paymentStatus !== "PENDING" || source.dueDates.some((due) => due.status !== "PENDING" || due.allocations.length > 0 || due.creditApplications.length > 0);
    if (hasFinancialActivity) return failure(409, "PURCHASE_CORRECTION_FINANCIAL_ACTIVITY", "La compra tiene actividad financiera y debe regularizarse mediante rectificativa.");
    const originalEntry = source.accountingEntry;
    if (!originalEntry || originalEntry.origin !== "PURCHASE_INVOICE" || originalEntry.status !== "POSTED" || !originalEntry.lines.length || !originalEntry.totalDebit.equals(originalEntry.totalCredit)) {
      return failure(409, "PURCHASE_CORRECTION_ACCOUNTING_INVALID", "El asiento original no permite crear un contraasiento seguro.");
    }
    const fiscalYear = await lockFiscalYear(tx, companyId!, accountingDate);
    if (!fiscalYear || fiscalYear.id !== originalEntry.fiscalYearId) return failure(409, "PURCHASE_CORRECTION_FISCAL_YEAR_NOT_OPEN", "La fecha debe pertenecer al mismo ejercicio abierto que la compra.");
    const operation = await tx.purchaseCorrectionOperation.create({ data: { companyId: companyId!, sourcePurchaseInvoiceId: id, mode: command.mode, accountingDate, reasonCode: command.reasonCode, reason: command.reason, sourceVersion: command.expectedVersion, createdById: actor.id }, select: { id: true } });
    const sequence = await nextJournalSequence(tx, fiscalYear.id); const year = accountingDate.getUTCFullYear();
    const concept = `Contraasiento anulación compra ${source.supplierInvoiceNumber}`.slice(0, 240);
    const reversalEntry = await tx.accountingJournalEntry.create({ data: {
      fiscalYearId: fiscalYear.id, purchaseCorrectionOperationId: operation.id, reversesEntryId: originalEntry.id,
      year, sequence, number: `${year}/${String(sequence).padStart(6, "0")}`, accountingDate, concept,
      origin: "PURCHASE_CORRECTION_REVERSAL", totalDebit: originalEntry.totalCredit, totalCredit: originalEntry.totalDebit, createdById: actor.id,
      lines: { create: originalEntry.lines.map((line) => ({ accountId: line.accountId, position: line.position, concept, debit: line.credit, credit: line.debit })) }
    }, select: { id: true, number: true } });
    if (source.vatRecords.length) await tx.purchaseVatRecord.createMany({ data: source.vatRecords.map((vat) => ({
      companyId: vat.companyId, supplierId: vat.supplierId, purchaseInvoiceId: vat.purchaseInvoiceId, taxSummaryId: null,
      accountingEntryId: reversalEntry.id, correctionOperationId: operation.id, reversesVatRecordId: vat.id, kind: "INTERNAL_CORRECTION_REVERSAL",
      supplierInvoiceNumberSnapshot: vat.supplierInvoiceNumberSnapshot, supplierCodeSnapshot: vat.supplierCodeSnapshot,
      supplierLegalNameSnapshot: vat.supplierLegalNameSnapshot, supplierTaxIdLast4Snapshot: vat.supplierTaxIdLast4Snapshot,
      supplierTaxIdEncryptedSnapshot: vat.supplierTaxIdEncryptedSnapshot, issueDate: vat.issueDate, accountingDate,
      taxRateCode: vat.taxRateCode, taxRate: vat.taxRate, taxableBase: vat.taxableBase.negated(), taxAmount: vat.taxAmount.negated(), total: vat.total.negated()
    })) });
    const stockLines = source.lines.filter((line) => line.stockMovement).sort((a, b) => a.stockMovement!.itemId.localeCompare(b.stockMovement!.itemId));
    let negativeStockCount = 0;
    for (const line of stockLines) {
      const movement = line.stockMovement!;
      await tx.$queryRaw`SELECT "id" FROM "catalog_items" WHERE "id" = ${movement.itemId}::uuid FOR UPDATE`;
      const item = await tx.catalogItem.findUniqueOrThrow({ where: { id: movement.itemId }, select: { stockCurrent: true } });
      const quantity = movement.quantity.negated(); const next = item.stockCurrent.plus(quantity); if (next.isNegative()) negativeStockCount += 1;
      await tx.catalogStockMovement.create({ data: { itemId: movement.itemId, purchaseCorrectionOperationId: operation.id, reversesMovementId: movement.id,
        type: "PURCHASE_INTERNAL_REVERSAL", quantity, previousStock: item.stockCurrent, newStock: next,
        reason: `Anulación interna compra ${source.supplierInvoiceNumber}`.slice(0, 500), createdById: actor.id } });
      await tx.catalogItem.update({ where: { id: movement.itemId }, data: { stockCurrent: next, updatedById: actor.id } });
    }
    await tx.purchaseDueDate.updateMany({ where: { purchaseInvoiceId: id }, data: { status: "CANCELLED" } });
    await tx.purchaseInvoice.update({ where: { id }, data: { status: "VOIDED", paymentStatus: "NOT_APPLICABLE", updatedById: actor.id, version: { increment: 1 } } });
    const value: PurchaseCorrectionDto = { operationId: operation.id, purchaseInvoiceId: id, replacementPurchaseInvoiceId: null, mode: "VOID", status: "VOIDED", paymentStatus: "NOT_APPLICABLE", reversalEntry, replacementEntry: null, vatAdjustmentCount: source.vatRecords.length, stockReversalCount: stockLines.length, replacementVatRecordCount: 0, replacementStockMovementCount: 0 };
    await audit(tx, "PURCHASE_CORRECTION_VOIDED", actor, context, { companyId, purchaseInvoiceId: id, operationId: operation.id, reasonCode: command.reasonCode, reversalAccountingEntryId: reversalEntry.id, vatAdjustmentCount: source.vatRecords.length, stockReversalCount: stockLines.length, negativeStockCount });
    await persist(tx, actor, context, 201, value); return { ok: true, status: 201, value };
  }, () => failure(409, "PURCHASE_CORRECTION_CONFLICT", "La compra ha cambiado durante la anulación. Revise su estado y reintente."));
}

async function createPurchaseReplacement(id: string, command: Extract<z.infer<typeof createPurchaseCorrectionSchema>, { mode: "REPLACE" }>, actor: SessionUser, context: MutationContext): Promise<PurchaseResult<PurchaseCorrectionDto>> {
  return mutate(actor, context, async (tx) => {
    const replay = await replayMutation<PurchaseCorrectionDto>(tx, actor, context); if (replay) return replay;
    const locked = await lockPurchase(tx, id); const companyId = await currentCompanyId(tx);
    if (!locked || locked.companyId !== companyId) return failure(404, "PURCHASE_NOT_FOUND", "La factura de compra no existe.");
    if (locked.version !== command.expectedVersion) return failure(409, "PURCHASE_VERSION_CONFLICT", "La compra ha cambiado. Recarga antes de sustituirla.");
    if (locked.documentType !== "STANDARD" || locked.status !== "REGISTERED") return failure(409, "PURCHASE_CORRECTION_NOT_ALLOWED", "Solo se puede sustituir una compra ordinaria registrada.");
    const accountingDate = parseDate(command.accountingDate); const replacementDates = parsePurchaseDates(command.replacement);
    if (!accountingDate || !replacementDates.ok || accountingDate < locked.issueDate) return failure(409, "PURCHASE_CORRECTION_DATE_INVALID", "Las fechas de la sustitución no son válidas.");
    const source = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id }, include: {
      accountingEntry: { include: { fiscalYear: true, lines: { orderBy: { position: "asc" } } } },
      sourceCorrectionOperation: { select: { id: true } }, rectificationInvoices: { select: { id: true }, take: 1 },
      dueDates: { include: { allocations: { select: { id: true } }, creditApplications: { select: { id: true } } } },
      vatRecords: { where: { kind: "DOCUMENT" }, orderBy: { id: "asc" } },
      lines: { orderBy: { position: "asc" }, include: { stockMovement: true } }
    } });
    if (accountingDate < source.accountingDate) return failure(409, "PURCHASE_CORRECTION_DATE_INVALID", "La fecha de sustitución no puede ser anterior a la fecha contable original.");
    if (source.sourceCorrectionOperation) return failure(409, "PURCHASE_CORRECTION_ALREADY_COMPLETED", "La compra ya tiene una corrección interna.");
    if (source.rectificationInvoices.length) return failure(409, "PURCHASE_CORRECTION_HAS_RECTIFICATION", "La compra ya tiene una rectificativa del proveedor.");
    if (source.paymentStatus !== "PENDING" || source.dueDates.some((due) => due.status !== "PENDING" || due.allocations.length || due.creditApplications.length)) return failure(409, "PURCHASE_CORRECTION_FINANCIAL_ACTIVITY", "La compra tiene actividad financiera y no puede sustituirse.");
    const originalEntry = source.accountingEntry;
    if (!originalEntry || originalEntry.origin !== "PURCHASE_INVOICE" || originalEntry.status !== "POSTED" || !originalEntry.lines.length || !originalEntry.totalDebit.equals(originalEntry.totalCredit)) return failure(409, "PURCHASE_CORRECTION_ACCOUNTING_INVALID", "El asiento original no permite una sustitución segura.");
    const fiscalYear = await lockFiscalYear(tx, companyId!, accountingDate);
    if (!fiscalYear || fiscalYear.id !== originalEntry.fiscalYearId) return failure(409, "PURCHASE_CORRECTION_FISCAL_YEAR_NOT_OPEN", "La sustitución debe pertenecer al mismo ejercicio abierto que la compra.");
    const supplier = await tx.supplier.findFirst({ where: { id: source.supplierId, companyId: companyId! }, select: { id: true } });
    if (!supplier) return failure(409, "PURCHASE_SUPPLIER_NOT_AVAILABLE", "El proveedor histórico ya no pertenece a la empresa.");

    const taxIds = [...new Set(command.replacement.lines.map((line) => line.taxRateId))];
    const itemIds = [...new Set(command.replacement.lines.flatMap((line) => line.catalogItemId ? [line.catalogItemId] : []))];
    const sourceStockItemIds = source.lines.flatMap((line) => line.stockMovement ? [line.stockMovement.itemId] : []);
    const itemIdsForLock = [...new Set([...sourceStockItemIds, ...itemIds])].sort();
    if (itemIdsForLock.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "catalog_items" WHERE "id" IN (${Prisma.join(itemIdsForLock.map((itemId) => Prisma.sql`${itemId}::uuid`))}) ORDER BY "id" FOR UPDATE`);
    const [taxRates, items] = await Promise.all([tx.catalogTaxRate.findMany({ where: { id: { in: taxIds }, status: "ACTIVE" } }), tx.catalogItem.findMany({ where: { id: { in: itemIds }, status: "ACTIVE" } })]);
    if (taxRates.length !== taxIds.length) return failure(409, "PURCHASE_TAX_RATE_NOT_AVAILABLE", "Algún tipo de IVA no está activo.");
    if (items.length !== itemIds.length) return failure(409, "PURCHASE_CATALOG_ITEM_NOT_AVAILABLE", "Algún elemento de catálogo no está activo.");
    const taxes = new Map(taxRates.map((tax) => [tax.id, tax])); const catalog = new Map(items.map((item) => [item.id, item]));
    const candidateRows = command.replacement.lines.map((line, index) => {
      const tax = taxes.get(line.taxRateId)!; const item = line.catalogItemId ? catalog.get(line.catalogItemId)! : null; const accountCode = line.purchaseAccountCode ?? item?.purchaseAccountCode;
      if (!accountCode) return null; const calculated = calculateInvoiceLine({ ...line, taxRate: tax.rate });
      return { position: index + 1, catalogItemId: item?.id ?? null, catalogItemCodeSnapshot: item?.code ?? null, catalogItemKindSnapshot: item?.kind ?? null,
        description: line.description, quantity: new Prisma.Decimal(line.quantity), unitPrice: new Prisma.Decimal(line.unitPrice), discountPercent: new Prisma.Decimal(line.discountPercent),
        discountAmount: new Prisma.Decimal(line.discountAmount), purchaseAccountCode: accountCode, taxRateId: tax.id, taxRateCodeSnapshot: tax.code,
        taxRateNameSnapshot: tax.name, taxRateSnapshot: tax.rate, ...calculated };
    });
    if (candidateRows.some((row) => !row)) return failure(409, "PURCHASE_ACCOUNT_REQUIRED", "Cada línea necesita una subcuenta de compra.");
    const replacementRows = candidateRows as NonNullable<(typeof candidateRows)[number]>[];
    const totals = calculateInvoiceTotals(replacementRows.map((row) => ({ taxRateCode: row.taxRateCodeSnapshot, taxRate: row.taxRateSnapshot, ...row })));
    const summaries = calculateInvoiceTaxSummaries(replacementRows.map((row) => ({ taxRateCode: row.taxRateCodeSnapshot, taxRate: row.taxRateSnapshot, ...row })));
    const replacementDues = command.replacement.dueDates.map((due) => ({ ...due, dueDate: parseDate(due.dueDate), amount: new Prisma.Decimal(due.amount) }));
    if (replacementDues.some((due) => !due.dueDate || due.dueDate < replacementDates.value.issueDate)) return failure(409, "PURCHASE_DUE_DATE_INVALID", "Los vencimientos de la nueva versión no son válidos.");
    if (!replacementDues.reduce((sum, due) => sum.plus(due.amount), new Prisma.Decimal(0)).equals(totals.total)) return failure(409, "PURCHASE_DUE_DATES_TOTAL_MISMATCH", "Los vencimientos de la nueva versión deben sumar su total.");
    const requiredCodes = [...new Set([...replacementRows.map((row) => row.purchaseAccountCode), source.supplierAccountingCodeSnapshot, ...(totals.taxAmount.isZero() ? [] : ["472000000"])])];
    const accounts = await tx.accountingAccount.findMany({ where: { fiscalYearId: fiscalYear.id, code: { in: requiredCodes }, status: "ACTIVE", isPostable: true }, select: { id: true, code: true } });
    if (accounts.length !== requiredCodes.length) return failure(409, "PURCHASE_ACCOUNT_NOT_AVAILABLE", "Falta alguna subcuenta activa e imputable para contabilizar la nueva versión.");
    const accountByCode = new Map(accounts.map((account) => [account.code, account.id]));
    const operationId = randomUUID(); const replacementId = randomUUID();
    await tx.purchaseCorrectionOperation.create({ data: { id: operationId, companyId: companyId!, sourcePurchaseInvoiceId: id, replacementPurchaseInvoiceId: replacementId,
      mode: "REPLACE", accountingDate, reasonCode: command.reasonCode, reason: command.reason, sourceVersion: command.expectedVersion, createdById: actor.id } });
    const reversalSequence = await nextJournalSequence(tx, fiscalYear.id); const year = accountingDate.getUTCFullYear(); const reversalConcept = `Contraasiento sustitución compra ${source.supplierInvoiceNumber}`.slice(0, 240);
    const reversalEntry = await tx.accountingJournalEntry.create({ data: { fiscalYearId: fiscalYear.id, purchaseCorrectionOperationId: operationId, reversesEntryId: originalEntry.id,
      year, sequence: reversalSequence, number: `${year}/${String(reversalSequence).padStart(6, "0")}`, accountingDate, concept: reversalConcept, origin: "PURCHASE_CORRECTION_REVERSAL",
      totalDebit: originalEntry.totalCredit, totalCredit: originalEntry.totalDebit, createdById: actor.id, lines: { create: originalEntry.lines.map((line) => ({ accountId: line.accountId,
        position: line.position, concept: reversalConcept, debit: line.credit, credit: line.debit })) } }, select: { id: true, number: true } });
    if (source.vatRecords.length) await tx.purchaseVatRecord.createMany({ data: source.vatRecords.map((vat) => ({ companyId: vat.companyId, supplierId: vat.supplierId,
      purchaseInvoiceId: vat.purchaseInvoiceId, taxSummaryId: null, accountingEntryId: reversalEntry.id, correctionOperationId: operationId, reversesVatRecordId: vat.id,
      kind: "INTERNAL_CORRECTION_REVERSAL", supplierInvoiceNumberSnapshot: vat.supplierInvoiceNumberSnapshot, supplierCodeSnapshot: vat.supplierCodeSnapshot,
      supplierLegalNameSnapshot: vat.supplierLegalNameSnapshot, supplierTaxIdLast4Snapshot: vat.supplierTaxIdLast4Snapshot, supplierTaxIdEncryptedSnapshot: vat.supplierTaxIdEncryptedSnapshot,
      issueDate: vat.issueDate, accountingDate, taxRateCode: vat.taxRateCode, taxRate: vat.taxRate, taxableBase: vat.taxableBase.negated(), taxAmount: vat.taxAmount.negated(), total: vat.total.negated() })) });

    await tx.purchaseDueDate.updateMany({ where: { purchaseInvoiceId: id }, data: { status: "CANCELLED" } });
    await tx.purchaseInvoice.update({ where: { id }, data: { status: "SUPERSEDED", paymentStatus: "NOT_APPLICABLE", updatedById: actor.id, version: { increment: 1 } } });
    await tx.purchaseInvoice.create({ data: { id: replacementId, companyId: companyId!, supplierId: source.supplierId, documentIdentityId: source.documentIdentityId,
      supplierCodeSnapshot: source.supplierCodeSnapshot, supplierAccountingCodeSnapshot: source.supplierAccountingCodeSnapshot, supplierLegalNameSnapshot: source.supplierLegalNameSnapshot,
      supplierTaxIdLast4Snapshot: source.supplierTaxIdLast4Snapshot, supplierTaxIdEncryptedSnapshot: source.supplierTaxIdEncryptedSnapshot,
      supplierInvoiceNumber: source.supplierInvoiceNumber, supplierInvoiceNumberNormalized: source.supplierInvoiceNumberNormalized, ...replacementDates.value, ...totals,
      notes: command.replacement.notes, createdById: actor.id, updatedById: actor.id } });
    await tx.purchaseInvoiceLine.createMany({ data: replacementRows.map((row) => ({ purchaseInvoiceId: replacementId, ...row })) });
    await tx.purchaseInvoiceTaxSummary.createMany({ data: summaries.map((summary) => ({ purchaseInvoiceId: replacementId, ...summary })) });
    await tx.purchaseDueDate.createMany({ data: replacementDues.map((due, index) => ({ purchaseInvoiceId: replacementId, position: index + 1, dueDate: due.dueDate!, amount: due.amount, paymentMethod: due.paymentMethod })) });
    const replacementLines = await tx.purchaseInvoiceLine.findMany({ where: { purchaseInvoiceId: replacementId }, orderBy: { position: "asc" } });
    const replacementSummaries = await tx.purchaseInvoiceTaxSummary.findMany({ where: { purchaseInvoiceId: replacementId } });
    const grouped = new Map<string, Prisma.Decimal>(); for (const line of replacementLines) grouped.set(line.purchaseAccountCode, (grouped.get(line.purchaseAccountCode) ?? new Prisma.Decimal(0)).plus(line.lineTaxableBase));
    const replacementSequence = await nextJournalSequence(tx, fiscalYear.id); const replacementConcept = `Compra sustituida ${source.supplierInvoiceNumber} - ${source.supplierLegalNameSnapshot}`.slice(0, 240);
    const debitLines = [...grouped].map(([code, amount]) => ({ code, amount })); if (!totals.taxAmount.isZero()) debitLines.push({ code: "472000000", amount: totals.taxAmount });
    const replacementEntry = await tx.accountingJournalEntry.create({ data: { fiscalYearId: fiscalYear.id, purchaseInvoiceId: replacementId, year, sequence: replacementSequence,
      number: `${year}/${String(replacementSequence).padStart(6, "0")}`, accountingDate, concept: replacementConcept, origin: "PURCHASE_INVOICE", totalDebit: totals.total, totalCredit: totals.total,
      createdById: actor.id, lines: { create: [...debitLines.map((line, index) => ({ accountId: accountByCode.get(line.code)!, position: index + 1, concept: replacementConcept,
        debit: line.amount, credit: new Prisma.Decimal(0) })), { accountId: accountByCode.get(source.supplierAccountingCodeSnapshot)!, position: debitLines.length + 1,
        concept: replacementConcept, debit: new Prisma.Decimal(0), credit: totals.total }] } }, select: { id: true, number: true } });
    if (replacementSummaries.length) await tx.purchaseVatRecord.createMany({ data: replacementSummaries.map((summary) => ({ companyId: companyId!, supplierId: source.supplierId,
      purchaseInvoiceId: replacementId, taxSummaryId: summary.id, accountingEntryId: replacementEntry.id, supplierInvoiceNumberSnapshot: source.supplierInvoiceNumber,
      supplierCodeSnapshot: source.supplierCodeSnapshot, supplierLegalNameSnapshot: source.supplierLegalNameSnapshot, supplierTaxIdLast4Snapshot: source.supplierTaxIdLast4Snapshot,
      supplierTaxIdEncryptedSnapshot: source.supplierTaxIdEncryptedSnapshot, issueDate: replacementDates.value.issueDate, accountingDate, taxRateCode: summary.taxRateCode,
      taxRate: summary.taxRate, taxableBase: summary.taxableBase, taxAmount: summary.taxAmount, total: summary.total })) });

    const sourceStockLines = source.lines.filter((line) => line.stockMovement); const replacementStockLines = replacementLines.filter((line) => line.catalogItemId);
    let negativeStockCount = 0; let replacementStockMovementCount = 0;
    for (const line of sourceStockLines.sort((a, b) => a.stockMovement!.itemId.localeCompare(b.stockMovement!.itemId))) {
      const movement = line.stockMovement!; const item = await tx.catalogItem.findUniqueOrThrow({ where: { id: movement.itemId }, select: { stockCurrent: true } });
      const quantity = movement.quantity.negated(); const next = item.stockCurrent.plus(quantity); if (next.isNegative()) negativeStockCount += 1;
      await tx.catalogStockMovement.create({ data: { itemId: movement.itemId, purchaseCorrectionOperationId: operationId, reversesMovementId: movement.id, type: "PURCHASE_INTERNAL_REVERSAL",
        quantity, previousStock: item.stockCurrent, newStock: next, reason: `Reversión por sustitución ${source.supplierInvoiceNumber}`.slice(0, 500), createdById: actor.id } });
      await tx.catalogItem.update({ where: { id: movement.itemId }, data: { stockCurrent: next, updatedById: actor.id } });
    }
    for (const line of replacementStockLines.sort((a, b) => a.catalogItemId!.localeCompare(b.catalogItemId!))) {
      const item = await tx.catalogItem.findUniqueOrThrow({ where: { id: line.catalogItemId! } }); if (item.kind !== "PRODUCT" || !item.stockTracked) continue;
      const next = item.stockCurrent.plus(line.quantity); const unitCost = line.lineTaxableBase.div(line.quantity).toDecimalPlaces(2);
      await tx.catalogStockMovement.create({ data: { itemId: item.id, purchaseInvoiceLineId: line.id, type: "PURCHASE_RECEIPT", quantity: line.quantity, previousStock: item.stockCurrent,
        newStock: next, reason: `Entrada por sustitución ${source.supplierInvoiceNumber}`.slice(0, 500), createdById: actor.id } });
      await tx.catalogItem.update({ where: { id: item.id }, data: { stockCurrent: next, costPrice: unitCost, updatedById: actor.id } }); replacementStockMovementCount += 1;
    }
    await tx.purchaseInvoice.update({ where: { id: replacementId }, data: { status: "REGISTERED", registeredAt: new Date(), registeredById: actor.id, updatedById: actor.id, version: { increment: 1 } } });
    const value: PurchaseCorrectionDto = { operationId, purchaseInvoiceId: id, replacementPurchaseInvoiceId: replacementId, mode: "REPLACE", status: "SUPERSEDED",
      paymentStatus: "NOT_APPLICABLE", reversalEntry, replacementEntry, vatAdjustmentCount: source.vatRecords.length, stockReversalCount: sourceStockLines.length,
      replacementVatRecordCount: replacementSummaries.length, replacementStockMovementCount };
    await audit(tx, "PURCHASE_CORRECTION_REPLACED", actor, context, { companyId, purchaseInvoiceId: id, replacementPurchaseInvoiceId: replacementId, operationId,
      reasonCode: command.reasonCode, reversalAccountingEntryId: reversalEntry.id, replacementAccountingEntryId: replacementEntry.id, vatAdjustmentCount: source.vatRecords.length,
      stockReversalCount: sourceStockLines.length, replacementVatRecordCount: replacementSummaries.length, replacementStockMovementCount, negativeStockCount });
    await persist(tx, actor, context, 201, value); return { ok: true, status: 201, value };
  }, () => failure(409, "PURCHASE_CORRECTION_CONFLICT", "La compra ha cambiado durante la sustitución. Revise su estado y reintente."));
}

export async function readPurchaseCorrectionReplay(actor: SessionUser, context: MutationContext): Promise<PurchaseResult<PurchaseCorrectionDto> | null> {
  const replay = await prisma.$transaction((tx) => replayMutation<unknown>(tx, actor, context));
  if (!replay || !replay.ok) return replay;
  const parsed = purchaseCorrectionReplaySchema.safeParse(replay.value);
  return parsed.success ? { ...replay, value: parsed.data } : failure(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es compatible con el contrato actual.");
}

export async function readPurchaseRectificationReplay(actor: SessionUser, context: MutationContext): Promise<PurchaseResult | null> {
  const replay = await prisma.$transaction((tx) => replayMutation<unknown>(tx, actor, context));
  return replay ? validatePurchaseDetailReplay(replay) : null;
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
async function lockPurchase(tx: Prisma.TransactionClient, id: string): Promise<{ id: string; companyId: string; documentIdentityId: string; documentType: "STANDARD" | "RECTIFICATION"; status: PurchaseStatus; version: number; total: Prisma.Decimal; issueDate: Date } | null> { const rows = await tx.$queryRaw<Array<{ id: string; companyId: string; documentIdentityId: string; documentType: "STANDARD" | "RECTIFICATION"; status: PurchaseStatus; version: number; total: Prisma.Decimal; issueDate: Date }>>(Prisma.sql`SELECT "id", "companyId", "documentIdentityId", "documentType", "status", "version", "total", "issueDate" FROM "purchase_invoices" WHERE "id" = ${id}::uuid FOR UPDATE`); return rows[0] ?? null; }
async function lockFiscalYear(tx: Prisma.TransactionClient, companyId: string, date: Date): Promise<{ id: string } | null> { const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "accounting_fiscal_years" WHERE "companyId" = ${companyId}::uuid AND "status" = 'OPEN' AND "startDate" <= ${date} AND "endDate" >= ${date} FOR UPDATE`); return rows.length === 1 ? rows[0]! : null; }
async function nextJournalSequence(tx: Prisma.TransactionClient, fiscalYearId: string): Promise<number> { const last = await tx.accountingJournalEntry.findFirst({ where: { fiscalYearId }, orderBy: { sequence: "desc" }, select: { sequence: true } }); return (last?.sequence ?? 0) + 1; }
async function currentCompanyId(client: Prisma.TransactionClient | typeof prisma): Promise<string | null> { return (await client.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId ?? null; }
async function findDetail(tx: Prisma.TransactionClient, id: string): Promise<PurchaseRecord> { return tx.purchaseInvoice.findUniqueOrThrow({ where: { id }, include: detailInclude }); }
function parsePurchaseDates(command: { issueDate: string; receivedDate: string; operationDate: string; accountingDate: string }): { ok: true; value: { issueDate: Date; receivedDate: Date; operationDate: Date; accountingDate: Date } } | { ok: false; failure: Failure } { const issueDate = parseDate(command.issueDate); const receivedDate = parseDate(command.receivedDate); const operationDate = parseDate(command.operationDate); const accountingDate = parseDate(command.accountingDate); if (!issueDate || !receivedDate || !operationDate || !accountingDate || receivedDate < issueDate || accountingDate < issueDate) return { ok: false, failure: failure(409, "PURCHASE_DATES_INVALID", "Revisa las fechas: recepción y contabilización no pueden ser anteriores a la emisión.") }; return { ok: true, value: { issueDate, receivedDate, operationDate, accountingDate } }; }
function parseDate(value: string): Date | null { const date = new Date(`${value}T00:00:00.000Z`); return Number.isNaN(date.getTime()) || formatDate(date) !== value ? null : date; }
function formatDate(value: Date): string { return value.toISOString().slice(0, 10); }
function normalizeInvoiceNumber(value: string): string { return value.trim().toLocaleUpperCase("es-ES").replace(/\s+/g, " "); }
function mapListItem(row: { id: string; supplierInvoiceNumber: string; supplierCodeSnapshot: string; supplierLegalNameSnapshot: string; documentType: "STANDARD" | "RECTIFICATION"; status: PurchaseStatus; paymentStatus: PurchasePaymentStatus; issueDate: Date; accountingDate: Date; total: Prisma.Decimal; version: number }): PurchaseListItem { return { id: row.id, supplierInvoiceNumber: row.supplierInvoiceNumber, supplierCode: row.supplierCodeSnapshot, supplierName: row.supplierLegalNameSnapshot, documentType: row.documentType, status: row.status, paymentStatus: row.paymentStatus, issueDate: formatDate(row.issueDate), accountingDate: formatDate(row.accountingDate), total: row.total.toFixed(2), version: row.version }; }
function mapDetail(row: PurchaseRecord): PurchaseDetail { return { ...mapListItem(row), supplierId: row.supplierId, receivedDate: formatDate(row.receivedDate), operationDate: formatDate(row.operationDate), notes: row.notes, subtotal: row.subtotal.toFixed(2), discountTotal: row.discountTotal.toFixed(2), taxableBase: row.taxableBase.toFixed(2), taxAmount: row.taxAmount.toFixed(2), registeredAt: row.registeredAt?.toISOString() ?? null, accountingEntry: row.accountingEntry, rectificationReason: row.rectificationReason, rectificationMode: row.rectificationMode, rectifiesPurchaseInvoice: row.rectifiesPurchaseInvoice, rectificationInvoices: row.rectificationInvoices, supersededByPurchaseInvoice: row.sourceCorrectionOperation?.replacementPurchaseInvoice ?? null, supersedesPurchaseInvoice: row.replacementCorrectionOperation?.sourcePurchaseInvoice ?? null, lines: row.lines.map((line) => { const rectifiedQuantity = line.rectificationLines.reduce((sum, item) => sum.plus(item.quantity.abs()), new Prisma.Decimal(0)); return { id: line.id, position: line.position, catalogItemId: line.catalogItemId, catalogItemCode: line.catalogItemCodeSnapshot, description: line.description, quantity: line.quantity.toFixed(3), rectifiedQuantity: rectifiedQuantity.toFixed(3), remainingRectifiableQuantity: Prisma.Decimal.max(line.quantity.minus(rectifiedQuantity), 0).toFixed(3), unitPrice: line.unitPrice.toFixed(2), discountPercent: line.discountPercent.toFixed(2), discountAmount: line.discountAmount.toFixed(2), purchaseAccountCode: line.purchaseAccountCode, taxRateId: line.taxRateId, taxRateCode: line.taxRateCodeSnapshot, taxRate: line.taxRateSnapshot.toFixed(2), taxableBase: line.lineTaxableBase.toFixed(2), taxAmount: line.lineTaxAmount.toFixed(2), total: line.lineTotal.toFixed(2) }; }), dueDates: row.dueDates.map((due) => { const allocated = due.allocations.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0)); const credited = due.creditApplications.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0)); return { id: due.id, position: due.position, dueDate: formatDate(due.dueDate), amount: due.amount.toFixed(2), allocatedAmount: allocated.toFixed(2), creditedAmount: credited.toFixed(2), pendingAmount: Prisma.Decimal.max(due.amount.minus(allocated).minus(credited), 0).toFixed(2), paymentMethod: due.paymentMethod, status: due.status }; }) }; }
function mapDueDate(row: Prisma.PurchaseDueDateGetPayload<{ include: { purchaseInvoice: true; allocations: { select: { amount: true } }; creditApplications: { select: { amount: true } } } }>): SupplierDueDateItem { const allocated = row.allocations.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0)); const credited = row.creditApplications.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0)); return { id: row.id, purchaseInvoiceId: row.purchaseInvoiceId, supplierId: row.purchaseInvoice.supplierId, supplierCode: row.purchaseInvoice.supplierCodeSnapshot, supplierName: row.purchaseInvoice.supplierLegalNameSnapshot, supplierInvoiceNumber: row.purchaseInvoice.supplierInvoiceNumber, dueDate: formatDate(row.dueDate), amount: row.amount.toFixed(2), allocatedAmount: allocated.toFixed(2), creditedAmount: credited.toFixed(2), pendingAmount: Prisma.Decimal.max(row.amount.minus(allocated).minus(credited), 0).toFixed(2), paymentMethod: row.paymentMethod, status: row.status }; }
function failure(status: 404 | 409 | 503, code: string, message: string): Failure { return { ok: false, status, error: { code, message } }; }
function scopedKey(actor: SessionUser, context: MutationContext, companyId: string | null): string { return `v2:purchases:${createHash("sha256").update(`${companyId ?? "uninitialized"}:${actor.id}:${context.scope}:${context.idempotencyKey}`).digest("hex")}`; }
async function replayMutation<T>(tx: Prisma.TransactionClient, actor: SessionUser, context: MutationContext): Promise<PurchaseResult<T> | null> { const key = scopedKey(actor, context, await currentCompanyId(tx)); await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`; const row = await tx.idempotencyRecord.findUnique({ where: { key } }); if (!row) return null; return row.requestHash === context.requestHash ? { ok: true, status: row.responseStatus as 200 | 201, value: row.responseBody as unknown as T } : failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra petición."); }
function validatePurchaseDetailReplay(replay: PurchaseResult<unknown>): PurchaseResult {
  if (!replay.ok) return replay;
  const parsed = purchaseDetailReplaySchema.safeParse(replay.value);
  return parsed.success ? { ...replay, value: parsed.data as unknown as PurchaseDetail } : failure(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es compatible con el contrato actual.");
}
async function persist<T>(tx: Prisma.TransactionClient, actor: SessionUser, context: MutationContext, status: number, value: T): Promise<void> { const key = scopedKey(actor, context, await currentCompanyId(tx)); await tx.idempotencyRecord.create({ data: { key, requestHash: context.requestHash, responseStatus: status, responseBody: value as unknown as Prisma.InputJsonValue } }); }
async function mutate<T>(actor: SessionUser, context: MutationContext, work: (tx: Prisma.TransactionClient) => Promise<PurchaseResult<T>>, uniqueConflict?: () => PurchaseResult<T>): Promise<PurchaseResult<T>> { for (let attempt = 0; attempt < 3; attempt++) { try { return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); } catch (error) { if (isSerializationConflict(error)) { if (attempt < 2) continue; return failure(503, "PURCHASE_TRANSACTION_RETRY_EXHAUSTED", "La operación no pudo completarse por concurrencia. Reinténtelo en unos segundos."); } if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { const key = scopedKey(actor, context, await currentCompanyId(prisma)); const replay = await prisma.idempotencyRecord.findUnique({ where: { key } }); if (replay) return replay.requestHash === context.requestHash ? { ok: true, status: replay.responseStatus as 200 | 201, value: replay.responseBody as unknown as T } : failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra petición."); if (uniqueConflict) return uniqueConflict(); } throw error; } } return failure(503, "PURCHASE_TRANSACTION_RETRY_EXHAUSTED", "La operación no pudo completarse por concurrencia. Reinténtelo en unos segundos."); }
function isSerializationConflict(error: unknown): boolean { if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false; if (error.code === "P2034") return true; if (error.code !== "P2010" || !error.meta || typeof error.meta !== "object") return false; return "code" in error.meta && error.meta.code === "40001"; }
async function audit(client: Prisma.TransactionClient | typeof prisma, eventType: string, actor: SessionUser, context: Pick<MutationContext, "correlationId">, payload: Record<string, unknown>): Promise<void> { await client.auditEvent.create({ data: { eventType, actorType: "USER", payload: { actorUserId: actor.id, ...payload, ...(context.correlationId ? { correlationId: context.correlationId } : {}) } } }); }
