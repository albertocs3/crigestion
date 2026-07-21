import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { GET as suppliersGet, POST as suppliersPost } from "@/app/api/suppliers/route";
import { PATCH as supplierPatch } from "@/app/api/suppliers/[supplierId]/route";
import { prisma } from "@/lib/prisma";
import { sessionCookieName } from "@/modules/platform/application/auth";
import { hashRequestBody, initializePlatform, type InitializeCommand } from "@/modules/platform/application/installation";
import { hashPassword } from "@/modules/platform/application/passwords";

const cookieMock = vi.hoisted(() => { const values = new Map<string, string>(); return { values, store: { get(name: string) { const value = values.get(name); return value ? { name, value } : undefined; }, set(name: string, value: string) { values.set(name, value); }, delete(name: string) { values.delete(name); } }, reset() { values.clear(); } }; });
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieMock.store) }));
const password = "Cambiar-esta-clave-2026";
const initialization: InitializeCommand = { company: { legalName: "CriGestion Test SL", taxId: "B12345678", email: "admin@example.test" }, administrator: { displayName: "Administrador", userName: "admin", password } };

describe("supplier HTTP contracts", () => {
  beforeEach(async () => { process.env.APP_BASE_URL = "http://localhost:3000"; process.env.AUTH_COOKIE_SECURE = "false"; process.env.SENSITIVE_DATA_ACTIVE_KEY_ID = "test-key"; process.env.SENSITIVE_DATA_KEYS = JSON.stringify({ "test-key": Buffer.alloc(32, 8).toString("base64") }); process.env.SENSITIVE_DATA_LOOKUP_SECRET = "supplier-lookup-secret-at-least-32-characters"; cookieMock.reset(); await reset(); await initialize(); });
  afterAll(async () => { await reset(); await prisma.$disconnect(); });

  it("requires authentication, CSRF and idempotency", async () => {
    expect((await suppliersGet(apiRequest("/api/suppliers"))).status).toBe(401); await login();
    expect((await suppliersPost(jsonRequest("/api/suppliers", payload()))).status).toBe(403);
    const csrf = await csrfToken(); expect((await suppliersPost(jsonRequest("/api/suppliers", payload(), { csrf, idempotency: null }))).status).toBe(400);
  });

  it("creates, lists and updates without returning full sensitive values", async () => {
    await login(); const csrf = await csrfToken(); const create = await suppliersPost(jsonRequest("/api/suppliers", payload(), { csrf })); const created = await create.json() as { id: string; version: number };
    expect(create.status).toBe(201); const list = await suppliersGet(apiRequest("/api/suppliers")); const text = await list.text(); expect(list.status).toBe(200); expect(text).toContain("***5674"); expect(text).not.toContain("B12345674"); expect(text).not.toContain("proveedor@example.test"); expect(text).not.toContain("ES9121000418450200051332");
    const patch = await supplierPatch(jsonRequest(`/api/suppliers/${created.id}`, { action: "deactivate", expectedVersion: created.version }, { csrf, method: "PATCH" }), { params: Promise.resolve({ supplierId: created.id }) }); expect(patch.status).toBe(200); expect(await patch.json()).toMatchObject({ status: "INACTIVE", version: 2 });
  });

  it("returns the stored response for an idempotent replay", async () => {
    await login(); const csrf = await csrfToken(); const key = randomUUID(); const first = await suppliersPost(jsonRequest("/api/suppliers", payload(), { csrf, idempotency: key })); const replay = await suppliersPost(jsonRequest("/api/suppliers", payload(), { csrf, idempotency: key })); expect(replay.status).toBe(201); expect(await replay.json()).toEqual(await first.json()); expect(await prisma.supplier.count()).toBe(1);
  });

  it("scopes the same idempotency key to each supplier resource", async () => {
    await login(); const csrf = await csrfToken(); const first = await (await suppliersPost(jsonRequest("/api/suppliers", payload(), { csrf }))).json() as { id: string; version: number }; const secondPayload = { ...payload(), legalName: "Segundo proveedor", taxId: "B00000000" }; const second = await (await suppliersPost(jsonRequest("/api/suppliers", secondPayload, { csrf }))).json() as { id: string; version: number }; const key = randomUUID();
    for (const supplier of [first, second]) { const response = await supplierPatch(jsonRequest(`/api/suppliers/${supplier.id}`, { action: "deactivate", expectedVersion: supplier.version }, { csrf, idempotency: key, method: "PATCH" }), { params: Promise.resolve({ supplierId: supplier.id }) }); expect(response.status).toBe(200); }
    expect(await prisma.supplier.count({ where: { status: "INACTIVE" } })).toBe(2);
  });

  it("rejects invalid origin, media type, JSON, UUID and unknown fields", async () => {
    await login(); const csrf = await csrfToken();
    expect((await suppliersPost(new Request("http://localhost/api/suppliers", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json", "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() }, body: JSON.stringify(payload()) }))).status).toBe(403);
    expect((await suppliersPost(new Request("http://localhost/api/suppliers", { method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "text/plain", "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() }, body: "bad" }))).status).toBe(415);
    expect((await suppliersPost(new Request("http://localhost/api/suppliers", { method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json", "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() }, body: "{" }))).status).toBe(400);
    expect((await suppliersPost(jsonRequest("/api/suppliers", { ...payload(), unexpected: true }, { csrf }))).status).toBe(422);
    expect((await supplierPatch(jsonRequest("/api/suppliers/not-a-uuid", { action: "deactivate", expectedVersion: 1 }, { csrf, method: "PATCH" }), { params: Promise.resolve({ supplierId: "not-a-uuid" }) })).status).toBe(422);
  });

  it("allows Suppliers.View to list but denies management", async () => {
    await createViewOnlyUser(); cookieMock.reset(); await login("viewer", "Cambiar-viewer-2026"); const csrf = await csrfToken();
    expect((await suppliersGet(apiRequest("/api/suppliers"))).status).toBe(200); expect((await suppliersPost(jsonRequest("/api/suppliers", payload(), { csrf }))).status).toBe(403);
  });
});

function payload() { return { legalName: "Proveedor Demo SL", tradeName: "Proveedor Demo", taxId: "B12345674", fiscalAddressLine: "Calle Mayor 1", fiscalPostalCode: "28001", fiscalCity: "Madrid", fiscalProvince: "Madrid", fiscalCountry: "ES", contactName: "Compras", email: "proveedor@example.test", phone: "+34910000000", bankIban: "ES9121000418450200051332", bankBic: "CAIXESBBXXX", defaultPaymentMethod: "BANK_TRANSFER", paymentTermsType: "IMMEDIATE", paymentDays: null, paymentFixedDay: null, notes: "Nota interna" }; }
function apiRequest(path: string) { return new Request(`http://localhost${path}`); }
function jsonRequest(path: string, body: unknown, options: { csrf?: string; idempotency?: string | null; method?: string } = {}) { const headers = new Headers({ "Content-Type": "application/json", Origin: "http://localhost:3000", "X-Forwarded-For": `203.0.113.${Math.floor(Math.random() * 200) + 1}` }); if (options.csrf) headers.set("X-CSRF-Token", options.csrf); if (options.idempotency !== null) headers.set("Idempotency-Key", options.idempotency ?? randomUUID()); return new Request(`http://localhost${path}`, { method: options.method ?? "POST", headers, body: JSON.stringify(body) }); }
async function login(userName = "admin", loginPassword = password) { const response = await loginPost(jsonRequest("/api/auth/login", { userName, password: loginPassword })); expect(response.status).toBe(200); expect(cookieMock.values.has(sessionCookieName)).toBe(true); }
async function csrfToken() { const response = await csrfGet(apiRequest("/api/auth/csrf")); const body = await response.json() as { csrfToken: string }; return body.csrfToken; }
async function initialize() { const raw = JSON.stringify(initialization); const result = await initializePlatform(initialization, randomUUID(), hashRequestBody(raw)); if (!result.ok) throw new Error(result.error.code); const installation = await prisma.installation.findFirstOrThrow(); await prisma.accountingFiscalYear.create({ data: { companyId: installation.companyId!, year: 2026, startDate: new Date("2026-01-01T00:00:00.000Z"), endDate: new Date("2026-12-31T00:00:00.000Z"), planCode: "PGC_PYMES", planVersion: "2021.1", createdById: installation.initialAdministratorId! } }); }
async function createViewOnlyUser() { const role = await prisma.role.create({ data: { code: "SupplierViewer", name: "Consulta proveedores", permissions: { create: { permission: { connect: { code: "Suppliers.View" } } } } } }); await prisma.user.create({ data: { displayName: "Consulta", userName: "viewer", normalizedUserName: "viewer", passwordHash: hashPassword("Cambiar-viewer-2026"), roleId: role.id } }); }
async function reset() { await prisma.$executeRawUnsafe('TRUNCATE TABLE "companies", "roles", "permissions", "reserved_user_names", "idempotency_records" RESTART IDENTITY CASCADE'); }
