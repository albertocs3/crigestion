import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { GET as purchasesGet, POST as purchasesPost } from "@/app/api/purchases/route";
import { GET as supplierDueDatesGet } from "@/app/api/treasury/supplier-due-dates/route";
import { prisma } from "@/lib/prisma";
import { createInitialAccountingFiscalYear } from "@/modules/accounting/application/fiscalYears";
import { login } from "@/modules/platform/application/auth";
import { hashRequestBody, initializePlatform, type InitializeCommand } from "@/modules/platform/application/installation";
import { createSupplier, supplierRequestHash } from "@/modules/suppliers/application/suppliers";
import { hashPassword } from "@/modules/platform/application/passwords";

const cookieMock = vi.hoisted(() => { const values = new Map<string, string>(); return { values, store: { get(name: string) { const value = values.get(name); return value ? { name, value } : undefined; }, set(name: string, value: string) { values.set(name, value); }, delete(name: string) { values.delete(name); } }, reset() { values.clear(); } }; });
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieMock.store) }));
const password = "Cambiar-esta-clave-2026"; const initialization: InitializeCommand = { company: { legalName: "CriGestion Test SL", taxId: "B12345678" }, administrator: { displayName: "Administrador", userName: "admin", password } };

describe("purchase HTTP contracts", () => {
  beforeEach(async () => { configure(); cookieMock.reset(); await reset(); await initialize(); });
  afterAll(async () => { await reset(); await prisma.$disconnect(); });

  it("requires authentication, origin, CSRF, JSON and idempotency", async () => {
    expect((await purchasesGet(request("/api/purchases"))).status).toBe(401); await loginHttp(); const csrf = await csrfToken();
    expect((await purchasesPost(jsonRequest("/api/purchases", {}, { csrf: null }))).status).toBe(403);
    expect((await purchasesPost(new Request("http://localhost/api/purchases", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json", "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() }, body: "{}" }))).status).toBe(403);
    expect((await purchasesPost(jsonRequest("/api/purchases", {}, { csrf, idempotency: null }))).status).toBe(400);
    expect((await purchasesPost(new Request("http://localhost/api/purchases", { method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "text/plain", "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() }, body: "bad" }))).status).toBe(415);
  });

  it("separates purchase reading from supplier-treasury reading and management", async () => {
    const role = await prisma.role.create({ data: { code: "PurchaseReader", name: "Consulta compras", permissions: { create: { permission: { connect: { code: "Purchases.View" } } } } } });
    await prisma.user.create({ data: { displayName: "Consulta", userName: "purchase-reader", normalizedUserName: "purchase-reader", passwordHash: hashPassword("Cambiar-reader-2026"), roleId: role.id } });
    cookieMock.reset(); await loginHttp("purchase-reader", "Cambiar-reader-2026"); const csrf = await csrfToken();
    expect((await purchasesGet(request("/api/purchases"))).status).toBe(200);
    expect((await supplierDueDatesGet(request("/api/treasury/supplier-due-dates"))).status).toBe(403);
    expect((await purchasesPost(jsonRequest("/api/purchases", {}, { csrf }))).status).toBe(403);
  });

  it("creates and lists a masked supplier purchase draft and rejects unknown input", async () => {
    const supplierId = await createTestSupplier(); cookieMock.reset(); await loginHttp(); const csrf = await csrfToken(); const body = { supplierId, supplierInvoiceNumber: "P-001", issueDate: "2026-07-01", receivedDate: "2026-07-01", operationDate: "2026-07-01", accountingDate: "2026-07-01", notes: null };
    const created = await purchasesPost(jsonRequest("/api/purchases", body, { csrf })); expect(created.status).toBe(201); expect(await created.json()).toMatchObject({ supplierInvoiceNumber: "P-001", status: "DRAFT" });
    const listed = await purchasesGet(request("/api/purchases")); expect(listed.status).toBe(200); const text = await listed.text(); expect(text).toContain("P-001"); expect(text).not.toContain("B12345674");
    expect((await purchasesPost(jsonRequest("/api/purchases", { ...body, unexpected: true }, { csrf }))).status).toBe(422);
  });
});

function configure() { process.env.APP_BASE_URL = "http://localhost:3000"; process.env.AUTH_COOKIE_SECURE = "false"; process.env.SENSITIVE_DATA_ACTIVE_KEY_ID = "test-key"; process.env.SENSITIVE_DATA_KEYS = JSON.stringify({ "test-key": Buffer.alloc(32, 5).toString("base64") }); process.env.SENSITIVE_DATA_LOOKUP_SECRET = "supplier-lookup-secret-at-least-32-characters"; }
function request(path: string) { return new Request(`http://localhost${path}`); }
function jsonRequest(path: string, body: unknown, options: { csrf?: string | null; idempotency?: string | null } = {}) { const headers = new Headers({ Origin: "http://localhost:3000", "Content-Type": "application/json" }); if (options.csrf) headers.set("X-CSRF-Token", options.csrf); if (options.idempotency !== null) headers.set("Idempotency-Key", options.idempotency ?? randomUUID()); return new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) }); }
async function loginHttp(userName = "admin", loginPassword = password) { expect((await loginPost(jsonRequest("/api/auth/login", { userName, password: loginPassword }))).status).toBe(200); }
async function csrfToken() { return ((await (await csrfGet(request("/api/auth/csrf"))).json()) as { csrfToken: string }).csrfToken; }
async function initialize() { const raw = JSON.stringify(initialization); const result = await initializePlatform(initialization, randomUUID(), hashRequestBody(raw)); if (!result.ok) throw new Error(result.error.code); const session = await login({ userName: "admin", password }); if (!session.ok) throw new Error(session.error.code); const year = await createInitialAccountingFiscalYear(2026, session.value.user); if (!year.ok) throw new Error(year.error.code); await prisma.session.deleteMany(); }
async function createTestSupplier() { const session = await login({ userName: "admin", password }); if (!session.ok) throw new Error(session.error.code); const command = { legalName: "Proveedor Demo SL", tradeName: null, taxId: "B12345674", fiscalAddressLine: "Calle Mayor 1", fiscalPostalCode: "28001", fiscalCity: "Madrid", fiscalProvince: null, fiscalCountry: "ES", contactName: null, email: null, phone: null, bankIban: null, bankBic: null, defaultPaymentMethod: "BANK_TRANSFER" as const, paymentTermsType: "IMMEDIATE" as const, paymentDays: null, paymentFixedDay: null, notes: null }; const supplier = await createSupplier(command, session.value.user, { idempotencyKey: randomUUID(), requestHash: supplierRequestHash(command), scope: "create" }); if (!supplier.ok) throw new Error(supplier.error.code); await prisma.session.deleteMany(); return supplier.value.id; }
async function reset() { await prisma.$executeRawUnsafe('TRUNCATE TABLE "companies", "roles", "permissions", "reserved_user_names", "idempotency_records" RESTART IDENTITY CASCADE'); }
