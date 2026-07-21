import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { login } from "@/modules/platform/application/auth";
import { closeAccountingFiscalYear } from "@/modules/accounting/application/fiscalYears";
import { hashRequestBody, initializePlatform, type InitializeCommand } from "@/modules/platform/application/installation";
import { createSupplier, listSuppliers, supplierRequestHash, updateSupplier, updateSupplierStatus } from "@/modules/suppliers/application/suppliers";

const password = "Cambiar-esta-clave-2026";
const initialization: InitializeCommand = { company: { legalName: "CriGestion Test SL", taxId: "B12345678", email: "admin@example.test" }, administrator: { displayName: "Administrador", userName: "admin", password } };

describe("suppliers application service", () => {
  beforeEach(async () => { configureSecrets(); await reset(); await initialize(); });
  afterAll(async () => { await reset(); await prisma.$disconnect(); });

  it("creates encrypted supplier data and a linked 400 account in every open fiscal year", async () => {
    const actor = await admin(); const command = payload(); const result = await createSupplier(command, actor, context("create-1", command));
    expect(result).toMatchObject({ ok: true, status: 201, value: { code: "PROV00001", accountingCode: "400000001", taxIdMasked: "***5674", contact: { hasEmail: true, hasPhone: true }, banking: { ibanMasked: "****1332" } } });
    const stored = await prisma.supplier.findFirstOrThrow(); const accounts = await prisma.accountingAccount.findMany({ where: { supplierId: stored.id }, orderBy: { fiscalYear: { year: "asc" } } });
    expect(accounts).toHaveLength(1); expect(accounts.every((account) => account.code === "400000001")).toBe(true);
    const raw = Buffer.concat([Buffer.from(stored.taxIdEncrypted), Buffer.from(stored.emailEncrypted!), Buffer.from(stored.phoneEncrypted!), Buffer.from(stored.bankIbanEncrypted!)]).toString("utf8");
    expect(raw).not.toContain("B12345674"); expect(raw).not.toContain("proveedor@example.test"); expect(raw).not.toContain("ES9121000418450200051332");
    const audit = JSON.stringify((await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUPPLIER_CREATED" } })).payload);
    expect(audit).not.toContain("B12345674"); expect(audit).not.toContain("proveedor@example.test"); expect(audit).not.toContain("Calle Mayor");
  });

  it("replays the same idempotent creation and rejects a different payload", async () => {
    const actor = await admin(); const command = payload(); const first = await createSupplier(command, actor, context("same-key", command)); const replay = await createSupplier(command, actor, context("same-key", command)); const changed = payload({ legalName: "Otro proveedor" }); const conflict = await createSupplier(changed, actor, context("same-key", changed));
    expect(replay).toEqual(first); expect(await prisma.supplier.count()).toBe(1); expect(conflict).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_KEY_REUSED" } });
  });

  it("detects duplicate normalized tax identifiers using the keyed lookup hash", async () => {
    const actor = await admin(); const first = payload({ taxId: "B-12345674" }); const second = payload({ taxId: "B 12345674", legalName: "Duplicado" });
    await createSupplier(first, actor, context("one", first)); const result = await createSupplier(second, actor, context("two", second));
    expect(result).toMatchObject({ ok: false, error: { code: "SUPPLIER_TAX_ID_ALREADY_USED" } });
  });

  it("skips a 400 account suffix already reserved manually", async () => {
    const actor = await admin(); const year = await prisma.accountingFiscalYear.findFirstOrThrow();
    await prisma.accountingAccount.create({ data: { fiscalYearId: year.id, code: "400000001", name: "Cuenta manual", type: "PASIVO", level: 9, isPostable: true, createdById: actor.id } });
    const command = payload(); const result = await createSupplier(command, actor, context("skip-manual", command));
    expect(result).toMatchObject({ ok: true, value: { code: "PROV00002", accountingCode: "400000002" } });
  });

  it("paginates the compound name/id cursor without duplicates", async () => {
    const actor = await admin(); for (const [key, taxId] of [["a", "VAT-A"], ["b", "VAT-B"], ["c", "VAT-C"]]) { const command = payload({ legalName: "Mismo nombre SL", taxId, fiscalCountry: "FR" }); await createSupplier(command, actor, context(key, command)); }
    const first = await listSuppliers({ limit: 2 }, actor); const second = await listSuppliers({ limit: 2, cursor: first.nextCursor! }, actor);
    expect(first.suppliers).toHaveLength(2); expect(second.suppliers).toHaveLength(1); expect(new Set([...first.suppliers, ...second.suppliers].map((supplier) => supplier.id)).size).toBe(3);
  });

  it("rejects malformed and cross-company supplier accounts at database level", async () => {
    const actor = await admin(); const command = payload(); const created = await createSupplier(command, actor, context("shape", command)); if (!created.ok) throw new Error(created.error.code); const year = await prisma.accountingFiscalYear.findFirstOrThrow();
    await expect(prisma.accountingAccount.update({ where: { fiscalYearId_code: { fiscalYearId: year.id, code: created.value.accountingCode } }, data: { type: "ACTIVO" } })).rejects.toThrow();
    const other = await prisma.company.create({ data: { legalName: "Otra empresa SL", taxId: "B11111111" } }); const otherYear = await prisma.accountingFiscalYear.create({ data: { companyId: other.id, year: 2026, startDate: new Date("2026-01-01T00:00:00.000Z"), endDate: new Date("2026-12-31T00:00:00.000Z"), planCode: "PGC_PYMES", planVersion: "2021.1", createdById: actor.id } });
    await expect(prisma.accountingAccount.create({ data: { fiscalYearId: otherYear.id, supplierId: created.value.id, code: created.value.accountingCode, name: "Cruce", type: "PASIVO", level: 9, isPostable: true, createdById: actor.id } })).rejects.toThrow("SUPPLIER_ACCOUNT_COMPANY_MISMATCH");
    await expect(prisma.supplier.update({ where: { id: created.value.id }, data: { companyId: other.id } })).rejects.toThrow("SUPPLIER_COMPANY_IMMUTABLE");
    await expect(prisma.accountingFiscalYear.update({ where: { id: year.id }, data: { companyId: other.id } })).rejects.toThrow("SUPPLIER_FISCAL_YEAR_COMPANY_IMMUTABLE");
  });

  it("uses optimistic concurrency and renames only accounts in open years", async () => {
    const actor = await admin(); const command = payload(); const created = await createSupplier(command, actor, context("create", command)); if (!created.ok) throw new Error(created.error.code);
    const firstYear = await prisma.accountingFiscalYear.findFirstOrThrow(); const closed = await closeAccountingFiscalYear(firstYear.id, actor); expect(closed.ok).toBe(true);
    const update = updatePayload(created.value.version, { legalName: "Proveedor Renombrado SL" }); const result = await updateSupplier(created.value.id, update, actor, context("update", update));
    expect(result).toMatchObject({ ok: true, value: { version: 2, legalName: "Proveedor Renombrado SL" } });
    const accounts = await prisma.accountingAccount.findMany({ where: { supplierId: created.value.id }, orderBy: { fiscalYear: { year: "asc" } }, select: { id: true, sourceAccountId: true, code: true, name: true } }); expect(accounts.map((row) => row.name)).toEqual(["Proveedor Demo SL", "Proveedor Renombrado SL"]); expect(accounts[1]).toMatchObject({ sourceAccountId: accounts[0]!.id, code: "400000001" });
    const stale = await updateSupplier(created.value.id, update, actor, context("stale", update)); expect(stale).toMatchObject({ ok: false, error: { code: "SUPPLIER_VERSION_CONFLICT" } });
  });

  it("retains history on deactivation and validates accounts before reactivation", async () => {
    const actor = await admin(); const command = payload(); const created = await createSupplier(command, actor, context("create", command)); if (!created.ok) throw new Error(created.error.code);
    const inactive = await updateSupplierStatus(created.value.id, { action: "deactivate", expectedVersion: 1 }, actor, context("off", { action: "deactivate" })); expect(inactive).toMatchObject({ ok: true, value: { status: "INACTIVE", version: 2 } });
    await prisma.accountingAccount.delete({ where: { fiscalYearId_supplierId: { fiscalYearId: (await prisma.accountingFiscalYear.findFirstOrThrow()).id, supplierId: created.value.id } } });
    const active = await updateSupplierStatus(created.value.id, { action: "reactivate", expectedVersion: 2 }, actor, context("on", { action: "reactivate" })); expect(active).toMatchObject({ ok: false, error: { code: "SUPPLIER_ACCOUNTS_INCOMPLETE" } }); expect(await prisma.supplier.count()).toBe(1);
  });
});

function configureSecrets() { process.env.SENSITIVE_DATA_ACTIVE_KEY_ID = "test-key"; process.env.SENSITIVE_DATA_KEYS = JSON.stringify({ "test-key": Buffer.alloc(32, 7).toString("base64") }); process.env.SENSITIVE_DATA_LOOKUP_SECRET = "supplier-lookup-secret-at-least-32-characters"; }
function payload(overrides: Record<string, unknown> = {}) { return { legalName: "Proveedor Demo SL", tradeName: "Proveedor Demo", taxId: "B12345674", fiscalAddressLine: "Calle Mayor 1", fiscalPostalCode: "28001", fiscalCity: "Madrid", fiscalProvince: "Madrid", fiscalCountry: "ES", contactName: "Compras", email: "proveedor@example.test", phone: "+34910000000", bankIban: "ES9121000418450200051332", bankBic: "CAIXESBBXXX", defaultPaymentMethod: "BANK_TRANSFER" as const, paymentTermsType: "IMMEDIATE" as const, paymentDays: null, paymentFixedDay: null, notes: "Nota interna", ...overrides }; }
function updatePayload(expectedVersion: number, overrides: Record<string, unknown> = {}) { const base = payload(); return { legalName: base.legalName, tradeName: base.tradeName, fiscalAddressLine: base.fiscalAddressLine, fiscalPostalCode: base.fiscalPostalCode, fiscalCity: base.fiscalCity, fiscalProvince: base.fiscalProvince, fiscalCountry: base.fiscalCountry, contactName: base.contactName, defaultPaymentMethod: base.defaultPaymentMethod, paymentTermsType: base.paymentTermsType, paymentDays: null, paymentFixedDay: null, notes: base.notes, expectedVersion, taxId: { mode: "keep" as const }, email: { mode: "keep" as const }, phone: { mode: "keep" as const }, bank: { mode: "keep" as const }, ...overrides }; }
function context(key: string, value: unknown, scope = "create") { return { idempotencyKey: key, requestHash: supplierRequestHash(value), correlationId: `test-${key}`, scope }; }
async function admin() { const result = await login({ userName: "admin", password }); if (!result.ok) throw new Error(result.error.code); return result.value.user; }
async function initialize() { const raw = JSON.stringify(initialization); const result = await initializePlatform(initialization, randomUUID(), hashRequestBody(raw)); if (!result.ok) throw new Error(result.error.code); const installation = await prisma.installation.findFirstOrThrow(); const year = 2026; await prisma.accountingFiscalYear.create({ data: { companyId: installation.companyId!, year, startDate: new Date(`${year}-01-01T00:00:00.000Z`), endDate: new Date(`${year}-12-31T00:00:00.000Z`), planCode: "PGC_PYMES", planVersion: "2021.1", createdById: installation.initialAdministratorId! } }); }
async function reset() { await prisma.$executeRawUnsafe('TRUNCATE TABLE "companies", "roles", "permissions", "reserved_user_names", "idempotency_records" RESTART IDENTITY CASCADE'); }
