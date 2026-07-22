import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { GET as purchasesGet, POST as purchasesPost } from "@/app/api/purchases/route";
import { POST as purchaseRectificationPost } from "@/app/api/purchases/[purchaseId]/rectifications/route";
import { GET as supplierDueDatesGet } from "@/app/api/treasury/supplier-due-dates/route";
import { prisma } from "@/lib/prisma";
import { createInitialAccountingFiscalYear } from "@/modules/accounting/application/fiscalYears";
import { login } from "@/modules/platform/application/auth";
import { hashRequestBody, initializePlatform, type InitializeCommand } from "@/modules/platform/application/installation";
import { createPurchase, purchaseRequestHash, registerPurchase, replacePurchaseDueDates, replacePurchaseLines } from "@/modules/purchases/application/purchases";
import { createSupplier, supplierRequestHash } from "@/modules/suppliers/application/suppliers";
import { hashPassword } from "@/modules/platform/application/passwords";
import type { SessionUser } from "@/modules/platform/application/auth";

const cookieMock = vi.hoisted(() => { const values = new Map<string, string>(); return { values, store: { get(name: string) { const value = values.get(name); return value ? { name, value } : undefined; }, set(name: string, value: string) { values.set(name, value); }, delete(name: string) { values.delete(name); } }, reset() { values.clear(); } }; });
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieMock.store) }));
const password = "Cambiar-esta-clave-2026"; const initialization: InitializeCommand = { company: { legalName: "CriGestion Test SL", taxId: "B12345678" }, administrator: { displayName: "Administrador", userName: "admin", password } };
let testActor: SessionUser;

describe("purchase HTTP contracts", () => {
  beforeEach(async () => { configure(); cookieMock.reset(); await reset(); testActor = await initialize(); });
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
    expect((await purchaseRectificationPost(jsonRequest(`/api/purchases/${randomUUID()}/rectifications`, {}, { csrf }), { params: Promise.resolve({ purchaseId: randomUUID() }) })).status).toBe(403);
  });

  it("creates and lists a masked supplier purchase draft and rejects unknown input", async () => {
    const supplierId = await createTestSupplier(); cookieMock.reset(); await loginHttp(); const csrf = await csrfToken(); const body = { supplierId, supplierInvoiceNumber: "P-001", issueDate: "2026-07-01", receivedDate: "2026-07-01", operationDate: "2026-07-01", accountingDate: "2026-07-01", notes: null };
    const created = await purchasesPost(jsonRequest("/api/purchases", body, { csrf })); expect(created.status).toBe(201); expect(await created.json()).toMatchObject({ supplierInvoiceNumber: "P-001", status: "DRAFT" });
    const listed = await purchasesGet(request("/api/purchases")); expect(listed.status).toBe(200); const text = await listed.text(); expect(text).toContain("P-001"); expect(text).not.toContain("B12345674");
    expect((await purchasesPost(jsonRequest("/api/purchases", { ...body, unexpected: true }, { csrf }))).status).toBe(422);
  });

  it("creates and replays a full rectification through the protected HTTP contract", async () => {
    const supplierId = await createTestSupplier(); const actor = testActor;
    const tax = await prisma.catalogTaxRate.findUniqueOrThrow({ where: { code: "IVA_21" } });
    const created = await createPurchase({ supplierId, supplierInvoiceNumber: "HTTP-ORIGINAL", issueDate: "2026-07-01", receivedDate: "2026-07-01", operationDate: "2026-07-01", accountingDate: "2026-07-01", notes: null }, actor, purchaseContext("http-create", "create", {})); if (!created.ok) throw new Error(created.error.code);
    const lines = { expectedVersion: created.value.version, lines: [{ catalogItemId: null, description: "Servicio", quantity: "1", unitPrice: "100", discountPercent: "0", discountAmount: "0", purchaseAccountCode: "600000000", taxRateId: tax.id }] };
    const withLines = await replacePurchaseLines(created.value.id, lines, actor, purchaseContext("http-lines", "lines", lines)); if (!withLines.ok) throw new Error(withLines.error.code);
    const dues = { expectedVersion: withLines.value.version, dueDates: [{ dueDate: "2026-07-31", amount: withLines.value.total, paymentMethod: "BANK_TRANSFER" as const }] };
    const scheduled = await replacePurchaseDueDates(created.value.id, dues, actor, purchaseContext("http-dues", "dues", dues)); if (!scheduled.ok) throw new Error(scheduled.error.code);
    const registered = await registerPurchase(created.value.id, { expectedVersion: scheduled.value.version }, actor, purchaseContext("http-register", "register", {})); if (!registered.ok) throw new Error(registered.error.code);
    cookieMock.reset(); await loginHttp(); const csrf = await csrfToken(); const key = randomUUID();
    const body = { mode: "FULL", expectedVersion: registered.value.version, supplierInvoiceNumber: "HTTP-RECT", issueDate: "2026-07-20", receivedDate: "2026-07-20", operationDate: "2026-07-20", accountingDate: "2026-07-20", reason: "RETURN", notes: null };
    const routeContext = { params: Promise.resolve({ purchaseId: created.value.id }) };
    const response = await purchaseRectificationPost(jsonRequest(`/api/purchases/${created.value.id}/rectifications`, body, { csrf, idempotency: key }), routeContext);
    expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ documentType: "RECTIFICATION", status: "REGISTERED", rectifiesPurchaseInvoice: { id: created.value.id } });
    const replay = await purchaseRectificationPost(jsonRequest(`/api/purchases/${created.value.id}/rectifications`, body, { csrf, idempotency: key }), { params: Promise.resolve({ purchaseId: created.value.id }) }); expect(replay.status).toBe(201);
    const conflict = await purchaseRectificationPost(jsonRequest(`/api/purchases/${created.value.id}/rectifications`, { ...body, notes: "otro cuerpo" }, { csrf, idempotency: key }), { params: Promise.resolve({ purchaseId: created.value.id }) }); expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    const invalid = await purchaseRectificationPost(jsonRequest(`/api/purchases/${created.value.id}/rectifications`, { ...body, unexpected: true }, { csrf }), { params: Promise.resolve({ purchaseId: created.value.id }) }); expect(invalid.status).toBe(422);
  });
});

function configure() { process.env.APP_BASE_URL = "http://localhost:3000"; process.env.AUTH_COOKIE_SECURE = "false"; process.env.SENSITIVE_DATA_ACTIVE_KEY_ID = "test-key"; process.env.SENSITIVE_DATA_KEYS = JSON.stringify({ "test-key": Buffer.alloc(32, 5).toString("base64") }); process.env.SENSITIVE_DATA_LOOKUP_SECRET = "supplier-lookup-secret-at-least-32-characters"; }
function request(path: string) { return new Request(`http://localhost${path}`); }
function jsonRequest(path: string, body: unknown, options: { csrf?: string | null; idempotency?: string | null } = {}) { const headers = new Headers({ Origin: "http://localhost:3000", "Content-Type": "application/json" }); if (options.csrf) headers.set("X-CSRF-Token", options.csrf); if (options.idempotency !== null) headers.set("Idempotency-Key", options.idempotency ?? randomUUID()); return new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) }); }
async function loginHttp(userName = "admin", loginPassword = password) { expect((await loginPost(jsonRequest("/api/auth/login", { userName, password: loginPassword }))).status).toBe(200); }
async function csrfToken() { return ((await (await csrfGet(request("/api/auth/csrf"))).json()) as { csrfToken: string }).csrfToken; }
async function initialize() { const raw = JSON.stringify(initialization); const result = await initializePlatform(initialization, randomUUID(), hashRequestBody(raw)); if (!result.ok) throw new Error(result.error.code); const session = await login({ userName: "admin", password }); if (!session.ok) throw new Error(session.error.code); const year = await createInitialAccountingFiscalYear(2026, session.value.user); if (!year.ok) throw new Error(year.error.code); await prisma.session.deleteMany(); return session.value.user; }
async function createTestSupplier() { const command = { legalName: "Proveedor Demo SL", tradeName: null, taxId: "B12345674", fiscalAddressLine: "Calle Mayor 1", fiscalPostalCode: "28001", fiscalCity: "Madrid", fiscalProvince: null, fiscalCountry: "ES", contactName: null, email: null, phone: null, bankIban: null, bankBic: null, defaultPaymentMethod: "BANK_TRANSFER" as const, paymentTermsType: "IMMEDIATE" as const, paymentDays: null, paymentFixedDay: null, notes: null }; const supplier = await createSupplier(command, testActor, { idempotencyKey: randomUUID(), requestHash: supplierRequestHash(command), scope: "create" }); if (!supplier.ok) throw new Error(supplier.error.code); return supplier.value.id; }
function purchaseContext(key: string, scope: string, value: unknown) { return { idempotencyKey: key, requestHash: purchaseRequestHash(value), correlationId: `route-${key}`, scope }; }
async function reset() { await prisma.$executeRawUnsafe('TRUNCATE TABLE "companies", "roles", "permissions", "reserved_user_names", "idempotency_records" RESTART IDENTITY CASCADE'); }
