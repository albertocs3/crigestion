import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isValidSpanishTaxId, normalizeSpanishTaxId } from "@/modules/customers/application/taxIds";
import type { SessionUser } from "@/modules/platform/application/auth";
import { readSupplierDataProtectorFromEnvironment } from "@/modules/suppliers/infrastructure/supplierDataCipher";

const statusSchema = z.enum(["ACTIVE", "INACTIVE"]);
const paymentMethodSchema = z.enum(["BANK_TRANSFER", "CASH", "DIRECT_DEBIT"]);
const paymentTermsTypeSchema = z.enum(["IMMEDIATE", "DAYS", "FIXED_DAY_OF_MONTH"]);
const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable();
const replacement = (schema: z.ZodType<string>) => z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("keep") }).strict(),
  z.object({ mode: z.literal("clear") }).strict(),
  z.object({ mode: z.literal("replace"), value: schema }).strict()
]);
const taxReplacement = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("keep") }).strict(),
  z.object({ mode: z.literal("replace"), value: z.string().trim().min(3).max(32) }).strict()
]);
const emailSchema = z.string().trim().email().max(254);
const phoneSchema = z.string().trim().min(1).max(40);
const ibanSchema = z.string().trim().transform(normalizeIban).refine(isValidIban, "El IBAN no es valido.");
const bicSchema = z.string().trim().transform((value) => value.toUpperCase()).refine((value) => /^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(value), "El BIC no es valido.");

export const listSuppliersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(500).refine((value) => decodeCursor(value) !== null, "Cursor invalido.").optional(),
  status: statusSchema.optional(),
  search: z.string().trim().min(1).max(120).optional()
});

const publicFields = z.object({
  legalName: z.string().trim().min(2).max(200),
  tradeName: nullableText(160),
  fiscalAddressLine: z.string().trim().min(3).max(240),
  fiscalPostalCode: z.string().trim().min(2).max(20),
  fiscalCity: z.string().trim().min(2).max(120),
  fiscalProvince: nullableText(120),
  fiscalCountry: z.string().trim().length(2).transform((value) => value.toUpperCase()),
  contactName: nullableText(160),
  defaultPaymentMethod: paymentMethodSchema,
  paymentTermsType: paymentTermsTypeSchema,
  paymentDays: z.number().int().min(1).max(365).nullable(),
  paymentFixedDay: z.number().int().min(1).max(31).nullable(),
  notes: nullableText(1000)
}).strict();
type PublicFieldsInput = z.infer<typeof publicFields>;
type CreateValidationInput = PublicFieldsInput & { taxId: string; email: string | null; phone: string | null; bankIban: string | null; bankBic: string | null };
type UpdateValidationInput = PublicFieldsInput & { taxId: { mode: "keep" } | { mode: "replace"; value: string } };

export const createSupplierSchema = publicFields.extend({
  taxId: z.string().trim().min(3).max(32),
  email: emailSchema.nullable(),
  phone: phoneSchema.nullable(),
  bankIban: ibanSchema.nullable(),
  bankBic: bicSchema.nullable()
}).superRefine(validateCreate);

export const updateSupplierSchema = publicFields.extend({
  expectedVersion: z.number().int().positive(),
  taxId: taxReplacement,
  email: replacement(emailSchema),
  phone: replacement(phoneSchema),
  bank: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("keep") }).strict(),
    z.object({ mode: z.literal("clear") }).strict(),
    z.object({ mode: z.literal("replace"), iban: ibanSchema, bic: bicSchema.nullable() }).strict()
  ])
}).superRefine(validateUpdate);

export const updateSupplierStatusSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("deactivate"), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("reactivate"), expectedVersion: z.number().int().positive() }).strict()
]);

export type ListSuppliersCommand = z.infer<typeof listSuppliersSchema>;
export type CreateSupplierCommand = z.infer<typeof createSupplierSchema>;
export type UpdateSupplierCommand = z.infer<typeof updateSupplierSchema>;
export type UpdateSupplierStatusCommand = z.infer<typeof updateSupplierStatusSchema>;
export type MutationContext = { correlationId?: string; idempotencyKey: string; requestHash: string; scope: string };

export type SupplierDto = {
  id: string; code: string; accountingCode: string; status: "ACTIVE" | "INACTIVE"; version: number;
  legalName: string; tradeName: string | null; taxIdMasked: string;
  fiscalAddress: { line: string; postalCode: string; city: string; province: string | null; country: string };
  contact: { name: string | null; hasEmail: boolean; hasPhone: boolean };
  banking: { hasBankAccount: boolean; ibanMasked: string | null; hasBic: boolean };
  paymentTerms: { method: "BANK_TRANSFER" | "CASH" | "DIRECT_DEBIT"; type: "IMMEDIATE" | "DAYS" | "FIXED_DAY_OF_MONTH"; days: number | null; fixedDay: number | null };
  notes: string | null; createdAt: string; updatedAt: string;
};
export type SupplierListItem = Pick<SupplierDto, "id" | "code" | "accountingCode" | "status" | "version" | "legalName" | "tradeName" | "taxIdMasked" | "contact" | "banking" | "paymentTerms" | "createdAt" | "updatedAt"> & { fiscalLocation: { city: string; country: string } };

type ErrorCode = "SUPPLIER_NOT_FOUND" | "SUPPLIER_TAX_ID_ALREADY_USED" | "SUPPLIER_ACCOUNTING_FISCAL_YEAR_NOT_OPEN" | "SUPPLIER_CODE_EXHAUSTED" | "SUPPLIER_ACCOUNT_CODE_ALREADY_EXISTS" | "SUPPLIER_STATUS_ALREADY_SET" | "SUPPLIER_VERSION_CONFLICT" | "SUPPLIER_ACCOUNTS_INCOMPLETE" | "IDEMPOTENCY_KEY_REUSED";
type Failure = { ok: false; status: 404 | 409; error: { code: ErrorCode; message: string } };
export type SupplierResult = { ok: true; status: 200 | 201; value: SupplierDto } | Failure;

const select = {
  id: true, companyId: true, code: true, accountingCode: true, status: true, version: true,
  legalName: true, tradeName: true, taxIdLast4: true,
  fiscalAddressLine: true, fiscalPostalCode: true, fiscalCity: true, fiscalProvince: true, fiscalCountry: true,
  contactName: true, emailEncrypted: true, phoneEncrypted: true, bankIbanEncrypted: true, bankIbanLast4: true, bankBicEncrypted: true,
  defaultPaymentMethod: true, paymentTermsType: true, paymentDays: true, paymentFixedDay: true, notes: true,
  createdAt: true, updatedAt: true
} satisfies Prisma.SupplierSelect;
type SupplierRecord = Prisma.SupplierGetPayload<{ select: typeof select }>;
const listSelect = { id: true, code: true, accountingCode: true, status: true, version: true, legalName: true, tradeName: true, taxIdLast4: true, fiscalCity: true, fiscalCountry: true, contactName: true, emailEncrypted: true, phoneEncrypted: true, bankIbanEncrypted: true, bankIbanLast4: true, bankBicEncrypted: true, defaultPaymentMethod: true, paymentTermsType: true, paymentDays: true, paymentFixedDay: true, createdAt: true, updatedAt: true } satisfies Prisma.SupplierSelect;
type SupplierListRecord = Prisma.SupplierGetPayload<{ select: typeof listSelect }>;

export async function listSuppliers(command: ListSuppliersCommand, actor: SessionUser): Promise<{ suppliers: SupplierListItem[]; nextCursor: string | null }> {
  const companyId = await currentCompanyId(prisma);
  if (!companyId) return { suppliers: [], nextCursor: null };
  const cursor = command.cursor ? decodeCursor(command.cursor) : null;
  const rows = await prisma.supplier.findMany({
    where: { companyId, ...(command.status ? { status: command.status } : {}), AND: [
      ...(command.search ? [{ OR: [{ code: { contains: command.search, mode: "insensitive" as const } }, { legalName: { contains: command.search, mode: "insensitive" as const } }, { tradeName: { contains: command.search, mode: "insensitive" as const } }] }] : []),
      ...(cursor ? [{ OR: [{ legalName: { gt: cursor.legalName } }, { legalName: cursor.legalName, id: { gt: cursor.id } }] }] : [])
    ] },
    orderBy: [{ legalName: "asc" }, { id: "asc" }], take: command.limit + 1, select: listSelect
  });
  const page = rows.slice(0, command.limit);
  await prisma.auditEvent.create({ data: { eventType: "SUPPLIERS_VIEWED", actorType: "USER", payload: { actorUserId: actor.id, companyId, hasSearch: Boolean(command.search), resultCount: page.length } } });
  return { suppliers: page.map(mapSupplierListItem), nextCursor: rows.length > command.limit && page.length ? encodeCursor(page[page.length - 1]!) : null };
}

export async function getSupplier(id: string, actor: SessionUser): Promise<SupplierResult> {
  const companyId = await currentCompanyId(prisma);
  const supplier = companyId ? await prisma.supplier.findFirst({ where: { id, companyId }, select }) : null;
  if (!supplier) return failure(404, "SUPPLIER_NOT_FOUND", "El proveedor no existe.");
  await prisma.auditEvent.create({ data: { eventType: "SUPPLIER_VIEWED", actorType: "USER", payload: { actorUserId: actor.id, companyId, supplierId: id, sensitiveFieldsMasked: true } } });
  return { ok: true, status: 200, value: mapSupplier(supplier) };
}

export async function createSupplier(command: CreateSupplierCommand, actor: SessionUser, context: MutationContext): Promise<SupplierResult> {
  return executeMutation(actor, context, async (tx) => {
    const replayed = await replayMutation(tx, actor, context); if (replayed) return replayed;
    const companyId = await currentCompanyId(tx); if (!companyId) return failure(409, "SUPPLIER_ACCOUNTING_FISCAL_YEAR_NOT_OPEN", "La empresa no esta inicializada.");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`supplier:${companyId}`}, 0))`;
    const fiscalYears = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "accounting_fiscal_years" WHERE "companyId" = ${companyId}::uuid AND "status" = 'OPEN' ORDER BY "year" FOR UPDATE`);
    if (!fiscalYears.length) return failure(409, "SUPPLIER_ACCOUNTING_FISCAL_YEAR_NOT_OPEN", "Debe existir un ejercicio contable abierto para crear el proveedor.");
    const last = await tx.supplier.aggregate({ where: { companyId }, _max: { sequenceNumber: true } });
    let sequenceNumber = (last._max.sequenceNumber ?? 0) + 1;
    const fiscalYearIds = fiscalYears.map((year) => year.id);
    while (sequenceNumber <= 99_999 && await tx.accountingAccount.count({ where: { fiscalYearId: { in: fiscalYearIds }, code: `400${String(sequenceNumber).padStart(6, "0")}` } })) sequenceNumber += 1;
    if (sequenceNumber > 99_999) return failure(409, "SUPPLIER_CODE_EXHAUSTED", "La numeracion de proveedores ha agotado los codigos disponibles.");
    const id = randomUUID(); const normalizedTaxId = normalizeTaxId(command.taxId); const protector = readSupplierDataProtectorFromEnvironment();
    const code = `PROV${String(sequenceNumber).padStart(5, "0")}`; const accountingCode = `400${String(sequenceNumber).padStart(6, "0")}`;
    const supplier = await tx.supplier.create({ data: {
      id, companyId, sequenceNumber, code, accountingCode, status: "ACTIVE", ...publicPersistence(command),
      taxIdEncrypted: protector.encrypt(normalizedTaxId, { companyId, supplierId: id, field: "taxId" }),
      taxIdLookupHash: protector.lookupHash(normalizedTaxId), taxIdLast4: normalizedTaxId.slice(-4),
      emailEncrypted: encryptOptional(protector, command.email, companyId, id, "email"),
      phoneEncrypted: encryptOptional(protector, command.phone, companyId, id, "phone"),
      bankIbanEncrypted: encryptOptional(protector, command.bankIban, companyId, id, "bankIban"), bankIbanLast4: command.bankIban?.slice(-4) ?? null,
      bankBicEncrypted: encryptOptional(protector, command.bankBic, companyId, id, "bankBic"), createdById: actor.id
    }, select });
    for (const year of fiscalYears) {
      const account = await tx.accountingAccount.create({ data: { fiscalYearId: year.id, supplierId: id, code: accountingCode, name: command.legalName.slice(0, 180), type: "PASIVO", level: 9, isPostable: true, createdById: actor.id }, select: { id: true, fiscalYearId: true } });
      await audit(tx, "ACCOUNTING_ACCOUNT_CREATED", actor, context, { companyId, supplierId: id, supplierCode: code, accountId: account.id, accountingCode, fiscalYearId: account.fiscalYearId });
    }
    const value = mapSupplier(supplier);
    await audit(tx, "SUPPLIER_CREATED", actor, context, { companyId, supplierId: id, supplierCode: code, accountingCode, openFiscalYearAccounts: fiscalYears.length });
    await persist(tx, actor, context, 201, value); return { ok: true, status: 201, value };
  }, (error) => isUniqueTarget(error, "taxIdLookupHash") ? failure(409, "SUPPLIER_TAX_ID_ALREADY_USED", "El identificador fiscal ya esta asignado a otro proveedor.") : failure(409, "SUPPLIER_ACCOUNT_CODE_ALREADY_EXISTS", "La subcuenta contable del proveedor ya existe en un ejercicio abierto."));
}

export async function updateSupplier(id: string, command: UpdateSupplierCommand, actor: SessionUser, context: MutationContext): Promise<SupplierResult> {
  return executeMutation(actor, context, async (tx) => {
    const replayed = await replayMutation(tx, actor, context); if (replayed) return replayed;
    const companyId = await currentCompanyId(tx);
    if (!companyId) return failure(404, "SUPPLIER_NOT_FOUND", "El proveedor no existe.");
    const existing = await tx.supplier.findFirst({ where: { id, companyId }, select: { ...select, taxIdEncrypted: true, taxIdLookupHash: true } });
    if (!existing) return failure(404, "SUPPLIER_NOT_FOUND", "El proveedor no existe.");
    if (existing.version !== command.expectedVersion) return failure(409, "SUPPLIER_VERSION_CONFLICT", "El proveedor ha cambiado. Recarga antes de guardar.");
    const protector = readSupplierDataProtectorFromEnvironment();
    const data: Prisma.SupplierUncheckedUpdateManyInput = { ...publicPersistence(command), updatedById: actor.id, version: { increment: 1 } };
    if (command.taxId.mode === "replace") { const normalized = normalizeTaxId(command.taxId.value); data.taxIdEncrypted = protector.encrypt(normalized, { companyId, supplierId: id, field: "taxId" }); data.taxIdLookupHash = protector.lookupHash(normalized); data.taxIdLast4 = normalized.slice(-4); }
    applyOptionalChange(data, "emailEncrypted", command.email, protector, companyId, id, "email");
    applyOptionalChange(data, "phoneEncrypted", command.phone, protector, companyId, id, "phone");
    if (command.bank.mode === "clear") { data.bankIbanEncrypted = null; data.bankIbanLast4 = null; data.bankBicEncrypted = null; }
    if (command.bank.mode === "replace") { data.bankIbanEncrypted = protector.encrypt(command.bank.iban, { companyId, supplierId: id, field: "bankIban" }); data.bankIbanLast4 = command.bank.iban.slice(-4); data.bankBicEncrypted = encryptOptional(protector, command.bank.bic, companyId, id, "bankBic"); }
    const updated = await tx.supplier.updateMany({ where: { id, companyId, version: command.expectedVersion }, data });
    if (updated.count !== 1) return failure(409, "SUPPLIER_VERSION_CONFLICT", "El proveedor ha cambiado. Recarga antes de guardar.");
    if (existing.legalName !== command.legalName) await tx.accountingAccount.updateMany({ where: { supplierId: id, fiscalYear: { status: "OPEN", companyId } }, data: { name: command.legalName.slice(0, 180) } });
    const supplier = await tx.supplier.findUniqueOrThrow({ where: { id }, select }); const value = mapSupplier(supplier);
    await audit(tx, "SUPPLIER_UPDATED", actor, context, { companyId, supplierId: id, supplierCode: existing.code, changedFields: changedFields(existing, command), sensitiveFieldsChanged: sensitiveChanges(command) });
    await persist(tx, actor, context, 200, value); return { ok: true, status: 200, value };
  }, () => failure(409, "SUPPLIER_TAX_ID_ALREADY_USED", "El identificador fiscal ya esta asignado a otro proveedor."));
}

export async function updateSupplierStatus(id: string, command: UpdateSupplierStatusCommand, actor: SessionUser, context: MutationContext): Promise<SupplierResult> {
  return executeMutation(actor, context, async (tx) => {
    const replayed = await replayMutation(tx, actor, context); if (replayed) return replayed;
    const companyId = await currentCompanyId(tx);
    if (!companyId) return failure(404, "SUPPLIER_NOT_FOUND", "El proveedor no existe.");
    const existing = await tx.supplier.findFirst({ where: { id, companyId }, select });
    if (!existing) return failure(404, "SUPPLIER_NOT_FOUND", "El proveedor no existe.");
    if (existing.version !== command.expectedVersion) return failure(409, "SUPPLIER_VERSION_CONFLICT", "El proveedor ha cambiado. Recarga antes de continuar.");
    const nextStatus = command.action === "deactivate" ? "INACTIVE" : "ACTIVE";
    if (existing.status === nextStatus) return failure(409, "SUPPLIER_STATUS_ALREADY_SET", "El proveedor ya esta en ese estado.");
    if (nextStatus === "ACTIVE") {
      const [years, accounts] = await Promise.all([tx.accountingFiscalYear.count({ where: { companyId, status: "OPEN" } }), tx.accountingAccount.count({ where: { supplierId: id, fiscalYear: { companyId, status: "OPEN" } } })]);
      if (years === 0 || years !== accounts) return failure(409, "SUPPLIER_ACCOUNTS_INCOMPLETE", "Falta un ejercicio abierto o la subcuenta del proveedor.");
    }
    const updated = await tx.supplier.updateMany({ where: { id, companyId, version: command.expectedVersion }, data: { status: nextStatus, updatedById: actor.id, version: { increment: 1 } } });
    if (updated.count !== 1) return failure(409, "SUPPLIER_VERSION_CONFLICT", "El proveedor ha cambiado. Recarga antes de continuar.");
    const supplier = await tx.supplier.findUniqueOrThrow({ where: { id }, select }); const value = mapSupplier(supplier);
    await audit(tx, nextStatus === "ACTIVE" ? "SUPPLIER_REACTIVATED" : "SUPPLIER_DEACTIVATED", actor, context, { companyId, supplierId: id, supplierCode: existing.code, previousStatus: existing.status, newStatus: nextStatus });
    await persist(tx, actor, context, 200, value); return { ok: true, status: 200, value };
  });
}

export function supplierRequestHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function scopedKey(actor: SessionUser, context: MutationContext): string { return `v1:supplier:${createHash("sha256").update(`${actor.id}:${context.scope}:${context.idempotencyKey}`).digest("hex")}`; }
async function replayMutation(tx: Prisma.TransactionClient, actor: SessionUser, context: MutationContext): Promise<SupplierResult | null> { const row = await tx.idempotencyRecord.findUnique({ where: { key: scopedKey(actor, context) } }); if (!row) return null; return row.requestHash === context.requestHash ? { ok: true, status: row.responseStatus as 200 | 201, value: row.responseBody as unknown as SupplierDto } : failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion."); }
async function persist(tx: Prisma.TransactionClient, actor: SessionUser, context: MutationContext, status: number, value: SupplierDto) { await tx.idempotencyRecord.create({ data: { key: scopedKey(actor, context), requestHash: context.requestHash, responseStatus: status, responseBody: value as unknown as Prisma.InputJsonValue } }); }
async function executeMutation(actor: SessionUser, context: MutationContext, work: (tx: Prisma.TransactionClient) => Promise<SupplierResult>, uniqueConflict?: (error: Prisma.PrismaClientKnownRequestError) => SupplierResult): Promise<SupplierResult> { for (let attempt = 0; attempt < 3; attempt++) try { return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); } catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && attempt < 2) continue; if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { const row = await prisma.idempotencyRecord.findUnique({ where: { key: scopedKey(actor, context) } }); if (row) return row.requestHash === context.requestHash ? { ok: true, status: row.responseStatus as 200 | 201, value: row.responseBody as unknown as SupplierDto } : failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion."); if (uniqueConflict) return uniqueConflict(error); } throw error; } throw new Error("SUPPLIER_TRANSACTION_RETRY_EXHAUSTED"); }
async function currentCompanyId(client: Pick<Prisma.TransactionClient, "installation">): Promise<string | null> { return (await client.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId ?? null; }
async function audit(tx: Prisma.TransactionClient, eventType: string, actor: SessionUser, context: MutationContext, payload: Record<string, unknown>) { await tx.auditEvent.create({ data: { eventType, actorType: "USER", payload: { actorUserId: actor.id, ...payload, ...(context.correlationId ? { correlationId: context.correlationId } : {}) } } }); }
function publicPersistence(command: z.infer<typeof publicFields>) { const { legalName, tradeName, fiscalAddressLine, fiscalPostalCode, fiscalCity, fiscalProvince, fiscalCountry, contactName, defaultPaymentMethod, paymentTermsType, paymentDays, paymentFixedDay, notes } = command; return { legalName, tradeName, fiscalAddressLine, fiscalPostalCode, fiscalCity, fiscalProvince, fiscalCountry, contactName, defaultPaymentMethod, paymentTermsType, paymentDays, paymentFixedDay, notes }; }
function encryptOptional(protector: ReturnType<typeof readSupplierDataProtectorFromEnvironment>, value: string | null, companyId: string, supplierId: string, field: "email" | "phone" | "bankIban" | "bankBic") { return value ? protector.encrypt(value, { companyId, supplierId, field }) : null; }
function applyOptionalChange(data: Prisma.SupplierUncheckedUpdateManyInput, key: "emailEncrypted" | "phoneEncrypted", change: { mode: "keep" } | { mode: "clear" } | { mode: "replace"; value: string }, protector: ReturnType<typeof readSupplierDataProtectorFromEnvironment>, companyId: string, supplierId: string, field: "email" | "phone") { if (change.mode === "clear") data[key] = null; if (change.mode === "replace") data[key] = protector.encrypt(change.value, { companyId, supplierId, field }); }
function mapSupplier(row: SupplierRecord): SupplierDto { return { id: row.id, code: row.code, accountingCode: row.accountingCode, status: row.status, version: row.version, legalName: row.legalName, tradeName: row.tradeName, taxIdMasked: `***${row.taxIdLast4}`, fiscalAddress: { line: row.fiscalAddressLine, postalCode: row.fiscalPostalCode, city: row.fiscalCity, province: row.fiscalProvince, country: row.fiscalCountry }, contact: { name: row.contactName, hasEmail: Boolean(row.emailEncrypted), hasPhone: Boolean(row.phoneEncrypted) }, banking: { hasBankAccount: Boolean(row.bankIbanEncrypted), ibanMasked: row.bankIbanLast4 ? `****${row.bankIbanLast4}` : null, hasBic: Boolean(row.bankBicEncrypted) }, paymentTerms: { method: row.defaultPaymentMethod, type: row.paymentTermsType, days: row.paymentDays, fixedDay: row.paymentFixedDay }, notes: row.notes, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }; }
function mapSupplierListItem(row: SupplierListRecord): SupplierListItem { return { id: row.id, code: row.code, accountingCode: row.accountingCode, status: row.status, version: row.version, legalName: row.legalName, tradeName: row.tradeName, taxIdMasked: `***${row.taxIdLast4}`, fiscalLocation: { city: row.fiscalCity, country: row.fiscalCountry }, contact: { name: row.contactName, hasEmail: Boolean(row.emailEncrypted), hasPhone: Boolean(row.phoneEncrypted) }, banking: { hasBankAccount: Boolean(row.bankIbanEncrypted), ibanMasked: row.bankIbanLast4 ? `****${row.bankIbanLast4}` : null, hasBic: Boolean(row.bankBicEncrypted) }, paymentTerms: { method: row.defaultPaymentMethod, type: row.paymentTermsType, days: row.paymentDays, fixedDay: row.paymentFixedDay }, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }; }
function normalizeTaxId(value: string) { return normalizeSpanishTaxId(value).replace(/[^A-Z0-9]/g, ""); }
function normalizeIban(value: string) { return value.replace(/\s+/g, "").toUpperCase(); }
function isValidIban(value: string) { const normalized = normalizeIban(value); if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(normalized)) return false; const numeric = `${normalized.slice(4)}${normalized.slice(0, 4)}`.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55)); let remainder = 0; for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97; return remainder === 1; }
function validateTerms(value: z.infer<typeof publicFields>, ctx: z.RefinementCtx) { if (value.paymentTermsType === "IMMEDIATE" && (value.paymentDays !== null || value.paymentFixedDay !== null)) ctx.addIssue({ code: "custom", path: ["paymentTermsType"], message: "El pago inmediato no admite plazos." }); if (value.paymentTermsType === "DAYS" && (value.paymentDays === null || value.paymentFixedDay !== null)) ctx.addIssue({ code: "custom", path: ["paymentDays"], message: "Indica solo los dias de pago." }); if (value.paymentTermsType === "FIXED_DAY_OF_MONTH" && (value.paymentFixedDay === null || value.paymentDays !== null)) ctx.addIssue({ code: "custom", path: ["paymentFixedDay"], message: "Indica solo el dia fijo." }); }
function validateCreate(value: CreateValidationInput, ctx: z.RefinementCtx) { validateTerms(value, ctx); if (value.fiscalCountry === "ES" && !isValidSpanishTaxId(value.taxId)) ctx.addIssue({ code: "custom", path: ["taxId"], message: "El NIF del proveedor no es valido." }); if (!value.bankIban && value.bankBic) ctx.addIssue({ code: "custom", path: ["bankBic"], message: "El BIC requiere un IBAN." }); }
function validateUpdate(value: UpdateValidationInput, ctx: z.RefinementCtx) { validateTerms(value, ctx); if (value.taxId.mode === "replace" && value.fiscalCountry === "ES" && !isValidSpanishTaxId(value.taxId.value)) ctx.addIssue({ code: "custom", path: ["taxId"], message: "El NIF del proveedor no es valido." }); }
function failure(status: 404 | 409, code: ErrorCode, message: string): Failure { return { ok: false, status, error: { code, message } }; }
function encodeCursor(row: Pick<SupplierRecord, "legalName" | "id">) { return Buffer.from(JSON.stringify([row.legalName, row.id]), "utf8").toString("base64url"); }
function decodeCursor(value: string): { legalName: string; id: string } | null { try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); return Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && z.string().uuid().safeParse(parsed[1]).success ? { legalName: parsed[0], id: parsed[1] } : null; } catch { return null; } }
function changedFields(existing: SupplierRecord, command: UpdateSupplierCommand) { const fields: string[] = []; for (const key of ["legalName", "tradeName", "fiscalAddressLine", "fiscalPostalCode", "fiscalCity", "fiscalProvince", "fiscalCountry", "contactName", "defaultPaymentMethod", "paymentTermsType", "paymentDays", "paymentFixedDay", "notes"] as const) if (existing[key] !== command[key]) fields.push(key); return fields; }
function sensitiveChanges(command: UpdateSupplierCommand) { return [command.taxId.mode !== "keep" ? "taxId" : null, command.email.mode !== "keep" ? "email" : null, command.phone.mode !== "keep" ? "phone" : null, command.bank.mode !== "keep" ? "bankDetails" : null].filter(Boolean); }
function isUniqueTarget(error: Prisma.PrismaClientKnownRequestError, field: string) { const target = error.meta?.target; return Array.isArray(target) ? target.some((value) => String(value).includes(field)) : String(target ?? "").includes(field); }
