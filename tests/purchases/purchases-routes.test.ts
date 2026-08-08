import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { GET as purchasesGet, POST as purchasesPost } from "@/app/api/purchases/route";
import { POST as purchaseRectificationPost } from "@/app/api/purchases/[purchaseId]/rectifications/route";
import { POST as purchaseCorrectionPost } from "@/app/api/purchases/[purchaseId]/corrections/route";
import { GET as supplierDueDatesGet } from "@/app/api/treasury/supplier-due-dates/route";
import { GET as supplierCreditsGet } from "@/app/api/treasury/supplier-credits/route";
import { POST as supplierCreditApplicationPost } from "@/app/api/treasury/supplier-credits/[creditId]/applications/route";
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
    expect((await purchasesGet(request("/api/purchases"))).status).toBe(401); expect((await supplierCreditsGet(request("/api/treasury/supplier-credits"))).status).toBe(401);
    expect([401, 403]).toContain((await purchaseRectificationPost(jsonRequest("/api/purchases/not-a-uuid/rectifications", {}), { params: Promise.resolve({ purchaseId: "not-a-uuid" }) })).status);
    await loginHttp(); const csrf = await csrfToken();
    expect((await purchasesPost(jsonRequest("/api/purchases", {}, { csrf: null }))).status).toBe(403);
    expect((await purchasesPost(new Request("http://localhost/api/purchases", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json", "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() }, body: "{}" }))).status).toBe(403);
    expect((await purchasesPost(jsonRequest("/api/purchases", {}, { csrf, idempotency: null }))).status).toBe(400);
    expect((await purchasesPost(new Request("http://localhost/api/purchases", { method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "text/plain", "X-CSRF-Token": csrf, "Idempotency-Key": randomUUID() }, body: "bad" }))).status).toBe(415);
    expect((await supplierCreditsGet(request("/api/treasury/supplier-credits"))).status).toBe(200);
    const creditId = randomUUID(); const routeContext = { params: Promise.resolve({ creditId }) };
    expect((await supplierCreditApplicationPost(jsonRequest(`/api/treasury/supplier-credits/${creditId}/applications`, {}, { csrf: null }), routeContext)).status).toBe(403);
    expect((await supplierCreditApplicationPost(jsonRequest(`/api/treasury/supplier-credits/${creditId}/applications`, { targetDueDateId: randomUUID(), applicationDate: "2026-07-22", amount: "1.00", notes: null, unexpected: true }, { csrf }), { params: Promise.resolve({ creditId }) })).status).toBe(422);
  });

  it("separates purchase reading from supplier-treasury reading and management", async () => {
    const role = await prisma.role.create({ data: { code: "PurchaseReader", name: "Consulta compras", permissions: { create: { permission: { connect: { code: "Purchases.View" } } } } } });
    await prisma.user.create({ data: { displayName: "Consulta", userName: "purchase-reader", normalizedUserName: "purchase-reader", passwordHash: hashPassword("Cambiar-reader-2026"), roleId: role.id } });
    cookieMock.reset(); await loginHttp("purchase-reader", "Cambiar-reader-2026"); const csrf = await csrfToken();
    expect((await purchasesGet(request("/api/purchases"))).status).toBe(200);
    expect((await supplierDueDatesGet(request("/api/treasury/supplier-due-dates"))).status).toBe(403);
    expect((await purchasesPost(jsonRequest("/api/purchases", {}, { csrf }))).status).toBe(403);
    expect((await purchaseRectificationPost(jsonRequest(`/api/purchases/${randomUUID()}/rectifications`, {}, { csrf }), { params: Promise.resolve({ purchaseId: randomUUID() }) })).status).toBe(403);
    expect((await purchaseCorrectionPost(jsonRequest(`/api/purchases/${randomUUID()}/corrections`, {}, { csrf }), { params: Promise.resolve({ purchaseId: randomUUID() }) })).status).toBe(403);
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

  it("creates a partial supplier return through the protected HTTP contract", async () => {
    const supplierId = await createTestSupplier(); const actor = testActor;
    const tax = await prisma.catalogTaxRate.findUniqueOrThrow({ where: { code: "IVA_21" } });
    const created = await createPurchase({ supplierId, supplierInvoiceNumber: "HTTP-PARTIAL", issueDate: "2026-07-01", receivedDate: "2026-07-01", operationDate: "2026-07-01", accountingDate: "2026-07-01", notes: null }, actor, purchaseContext("http-partial-create", "create", {})); if (!created.ok) throw new Error(created.error.code);
    const lines = { expectedVersion: created.value.version, lines: [{ catalogItemId: null, description: "Servicio retornable", quantity: "4", unitPrice: "25", discountPercent: "0", discountAmount: "0", purchaseAccountCode: "600000000", taxRateId: tax.id }] };
    const withLines = await replacePurchaseLines(created.value.id, lines, actor, purchaseContext("http-partial-lines", "lines", lines)); if (!withLines.ok) throw new Error(withLines.error.code);
    const dues = { expectedVersion: withLines.value.version, dueDates: [{ dueDate: "2026-07-31", amount: withLines.value.total, paymentMethod: "BANK_TRANSFER" as const }] };
    const scheduled = await replacePurchaseDueDates(created.value.id, dues, actor, purchaseContext("http-partial-dues", "dues", dues)); if (!scheduled.ok) throw new Error(scheduled.error.code);
    const registered = await registerPurchase(created.value.id, { expectedVersion: scheduled.value.version }, actor, purchaseContext("http-partial-register", "register", {})); if (!registered.ok) throw new Error(registered.error.code);
    cookieMock.reset(); await loginHttp(); const csrf = await csrfToken(); const key = randomUUID();
    const body = { mode: "PARTIAL", expectedVersion: registered.value.version, supplierInvoiceNumber: "HTTP-PARTIAL-R1", issueDate: "2026-07-20", receivedDate: "2026-07-20", operationDate: "2026-07-20", accountingDate: "2026-07-20", reason: "RETURN", notes: null, confirmation: "PARTIAL_PURCHASE_RETURN_CONFIRMED", lines: [{ sourcePurchaseInvoiceLineId: registered.value.lines[0]!.id, quantity: "1" }] };
    const routeContext = { params: Promise.resolve({ purchaseId: created.value.id }) };
    const response = await purchaseRectificationPost(jsonRequest(`/api/purchases/${created.value.id}/rectifications`, body, { csrf, idempotency: key }), routeContext);
    expect(response.status).toBe(201); const responseValue = await response.json(); expect(responseValue).toMatchObject({ documentType: "RECTIFICATION", rectificationMode: "PARTIAL", total: "-30.25" });
    expect((await purchaseRectificationPost(jsonRequest(`/api/purchases/${created.value.id}/rectifications`, body, { csrf, idempotency: key }), routeContext)).status).toBe(201);
    const replayRecord = await prisma.idempotencyRecord.findFirstOrThrow({ where: { requestHash: purchaseRequestHash(body) } });
    const { total: omittedTotal, ...incompleteReplay } = responseValue; void omittedTotal;
    await prisma.idempotencyRecord.update({ where: { key: replayRecord.key }, data: { responseBody: incompleteReplay } });
    const invalidReplay = await purchaseRectificationPost(jsonRequest(`/api/purchases/${created.value.id}/rectifications`, body, { csrf, idempotency: key }), routeContext);
    expect(invalidReplay.status).toBe(409); expect(await invalidReplay.json()).toMatchObject({ code: "IDEMPOTENCY_REPLAY_INVALID" });
    expect((await purchaseRectificationPost(jsonRequest(`/api/purchases/${created.value.id}/rectifications`, { ...body, confirmation: "WRONG" }, { csrf }), routeContext)).status).toBe(422);
    const original = await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: created.value.id }, include: { dueDates: true } });
    expect(original).toMatchObject({ status: "REGISTERED", paymentStatus: "PARTIALLY_SETTLED" }); expect(original.dueDates[0]).toMatchObject({ status: "PENDING" });
  });

  it("voids and replays an unpaid purchase through the protected correction contract", async () => {
    const supplierId = await createTestSupplier(); const actor = testActor;
    const tax = await prisma.catalogTaxRate.findUniqueOrThrow({ where: { code: "IVA_21" } });
    const created = await createPurchase({ supplierId, supplierInvoiceNumber: "HTTP-VOID", issueDate: "2026-07-01", receivedDate: "2026-07-01", operationDate: "2026-07-01", accountingDate: "2026-07-01", notes: null }, actor, purchaseContext("http-void-create", "create", {})); if (!created.ok) throw new Error(created.error.code);
    const lines = { expectedVersion: created.value.version, lines: [{ catalogItemId: null, description: "Servicio", quantity: "1", unitPrice: "100", discountPercent: "0", discountAmount: "0", purchaseAccountCode: "600000000", taxRateId: tax.id }] };
    const withLines = await replacePurchaseLines(created.value.id, lines, actor, purchaseContext("http-void-lines", "lines", lines)); if (!withLines.ok) throw new Error(withLines.error.code);
    const dues = { expectedVersion: withLines.value.version, dueDates: [{ dueDate: "2026-07-31", amount: withLines.value.total, paymentMethod: "BANK_TRANSFER" as const }] };
    const scheduled = await replacePurchaseDueDates(created.value.id, dues, actor, purchaseContext("http-void-dues", "dues", dues)); if (!scheduled.ok) throw new Error(scheduled.error.code);
    const registered = await registerPurchase(created.value.id, { expectedVersion: scheduled.value.version }, actor, purchaseContext("http-void-register", "register", {})); if (!registered.ok) throw new Error(registered.error.code);
    cookieMock.reset(); await loginHttp(); const csrf = await csrfToken(); const key = randomUUID();
    const body = { mode: "VOID", expectedVersion: registered.value.version, accountingDate: "2026-07-20", reasonCode: "DUPLICATE_DOCUMENT", reason: "Carga duplicada", confirmation: "VOID_PURCHASE_WITHOUT_FINANCIAL_ACTIVITY" };
    const routeContext = { params: Promise.resolve({ purchaseId: created.value.id }) };
    const response = await purchaseCorrectionPost(jsonRequest(`/api/purchases/${created.value.id}/corrections`, body, { csrf, idempotency: key }), routeContext);
    expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ purchaseInvoiceId: created.value.id, mode: "VOID", status: "VOIDED" });
    const replay = await purchaseCorrectionPost(jsonRequest(`/api/purchases/${created.value.id}/corrections`, body, { csrf, idempotency: key }), { params: Promise.resolve({ purchaseId: created.value.id }) });
    expect(replay.status).toBe(201);
    const conflict = await purchaseCorrectionPost(jsonRequest(`/api/purchases/${created.value.id}/corrections`, { ...body, reason: "otro" }, { csrf, idempotency: key }), { params: Promise.resolve({ purchaseId: created.value.id }) });
    expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    const conflictFingerprint = createHash("sha256").update(`purchase-correction:${created.value.id}`).digest("hex");
    const denial = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "PURCHASE_CORRECTION_DENIED", payload: { path: ["targetFingerprint"], equals: conflictFingerprint } } });
    expect(denial.payload).toMatchObject({ stableCode: "IDEMPOTENCY_KEY_REUSED" });
    const invalid = await purchaseCorrectionPost(jsonRequest(`/api/purchases/${created.value.id}/corrections`, { ...body, unexpected: true }, { csrf }), { params: Promise.resolve({ purchaseId: created.value.id }) });
    expect(invalid.status).toBe(422);
    const replacementReason = await purchaseCorrectionPost(jsonRequest(`/api/purchases/${created.value.id}/corrections`, { ...body, reasonCode: "WRONG_AMOUNT" }, { csrf }), { params: Promise.resolve({ purchaseId: created.value.id }) });
    expect(replacementReason.status).toBe(422);
  });

  it("rate limits repeated purchase correction attempts and audits the excess", async () => {
    cookieMock.reset(); await loginHttp(); const csrf = await csrfToken();
    const body = { mode: "VOID", expectedVersion: 1, accountingDate: "2026-07-20", reasonCode: "DUPLICATE_DOCUMENT", reason: null, confirmation: "VOID_PURCHASE_WITHOUT_FINANCIAL_ACTIVITY" };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const purchaseId = randomUUID();
      expect((await purchaseCorrectionPost(jsonRequest(`/api/purchases/${purchaseId}/corrections`, body, { csrf }), { params: Promise.resolve({ purchaseId }) })).status).toBe(404);
    }
    const limitedId = randomUUID();
    const limited = await purchaseCorrectionPost(jsonRequest(`/api/purchases/${limitedId}/corrections`, body, { csrf }), { params: Promise.resolve({ purchaseId: limitedId }) });
    expect(limited.status).toBe(429); expect(limited.headers.get("Retry-After")).toBe("900");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const excessId = randomUUID();
      expect((await purchaseCorrectionPost(jsonRequest(`/api/purchases/${excessId}/corrections`, body, { csrf }), { params: Promise.resolve({ purchaseId: excessId }) })).status).toBe(429);
    }
    const targetFingerprint = createHash("sha256").update(`purchase-correction:${limitedId}`).digest("hex");
    expect(await prisma.auditEvent.count({ where: { eventType: "PURCHASE_CORRECTION_RATE_LIMITED", payload: { path: ["actorUserId"], equals: testActor.id } } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { eventType: "PURCHASE_CORRECTION_RATE_LIMITED", payload: { path: ["targetFingerprint"], equals: targetFingerprint } } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { eventType: "PURCHASE_CORRECTION_RATE_LIMITED", payload: { path: ["purchaseInvoiceId"], equals: limitedId } } })).toBe(0);
  });

  it("rate limits repeated purchase rectification attempts and audits an opaque target", async () => {
    cookieMock.reset(); await loginHttp(); const csrf = await csrfToken();
    const body = { mode: "PARTIAL", expectedVersion: 1, supplierInvoiceNumber: "R-LIMIT", issueDate: "2026-07-20", receivedDate: "2026-07-20", operationDate: "2026-07-20", accountingDate: "2026-07-20", reason: "RETURN", notes: null, confirmation: "PARTIAL_PURCHASE_RETURN_CONFIRMED", lines: [{ sourcePurchaseInvoiceLineId: randomUUID(), quantity: "1" }] };
    for (let attempt = 0; attempt < 5; attempt += 1) { const purchaseId = randomUUID(); expect((await purchaseRectificationPost(jsonRequest(`/api/purchases/${purchaseId}/rectifications`, body, { csrf }), { params: Promise.resolve({ purchaseId }) })).status).toBe(404); }
    const limitedId = randomUUID(); const limited = await purchaseRectificationPost(jsonRequest(`/api/purchases/${limitedId}/rectifications`, body, { csrf }), { params: Promise.resolve({ purchaseId: limitedId }) });
    expect(limited.status).toBe(429); expect(limited.headers.get("Retry-After")).toBe("900");
    const fingerprint = createHash("sha256").update(`purchase-rectification:${limitedId}`).digest("hex");
    expect(await prisma.auditEvent.count({ where: { eventType: "PURCHASE_RECTIFICATION_RATE_LIMITED", payload: { path: ["targetFingerprint"], equals: fingerprint } } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { eventType: "PURCHASE_RECTIFICATION_RATE_LIMITED", payload: { path: ["purchaseInvoiceId"], equals: limitedId } } })).toBe(0);
  });

  it("replaces an unpaid purchase through the protected correction contract", async () => {
    const supplierId = await createTestSupplier(); const actor = testActor; const tax = await prisma.catalogTaxRate.findUniqueOrThrow({ where: { code: "IVA_21" } });
    const created = await createPurchase({ supplierId, supplierInvoiceNumber: "HTTP-REPLACE", issueDate: "2026-07-01", receivedDate: "2026-07-01", operationDate: "2026-07-01", accountingDate: "2026-07-01", notes: null }, actor, purchaseContext("http-replace-create", "create", {})); if (!created.ok) throw new Error(created.error.code);
    const lines = { expectedVersion: created.value.version, lines: [{ catalogItemId: null, description: "Servicio original", quantity: "1", unitPrice: "100", discountPercent: "0", discountAmount: "0", purchaseAccountCode: "600000000", taxRateId: tax.id }] };
    const withLines = await replacePurchaseLines(created.value.id, lines, actor, purchaseContext("http-replace-lines", "lines", lines)); if (!withLines.ok) throw new Error(withLines.error.code);
    const dues = { expectedVersion: withLines.value.version, dueDates: [{ dueDate: "2026-07-31", amount: withLines.value.total, paymentMethod: "BANK_TRANSFER" as const }] };
    const scheduled = await replacePurchaseDueDates(created.value.id, dues, actor, purchaseContext("http-replace-dues", "dues", dues)); if (!scheduled.ok) throw new Error(scheduled.error.code);
    const registered = await registerPurchase(created.value.id, { expectedVersion: scheduled.value.version }, actor, purchaseContext("http-replace-register", "register", {})); if (!registered.ok) throw new Error(registered.error.code);
    cookieMock.reset(); await loginHttp(); const csrf = await csrfToken(); const key = randomUUID();
    const body = { mode: "REPLACE", expectedVersion: registered.value.version, accountingDate: "2026-07-20", reasonCode: "WRONG_AMOUNT", reason: null, confirmation: "REPLACE_PURCHASE_WITHOUT_FINANCIAL_ACTIVITY", replacement: { issueDate: "2026-07-01", receivedDate: "2026-07-01", operationDate: "2026-07-01", accountingDate: "2026-07-20", notes: null, lines: [{ catalogItemId: null, description: "Servicio corregido", quantity: "1", unitPrice: "120", discountPercent: "0", discountAmount: "0", purchaseAccountCode: "600000000", taxRateId: tax.id }], dueDates: [{ dueDate: "2026-08-15", amount: "145.20", paymentMethod: "BANK_TRANSFER" }] } };
    const routeContext = { params: Promise.resolve({ purchaseId: created.value.id }) };
    const response = await purchaseCorrectionPost(jsonRequest(`/api/purchases/${created.value.id}/corrections`, body, { csrf, idempotency: key }), routeContext);
    expect(response.status).toBe(201); const value = await response.json(); expect(value).toMatchObject({ mode: "REPLACE", purchaseInvoiceId: created.value.id, status: "SUPERSEDED", replacementVatRecordCount: 1 });
    expect((await purchaseCorrectionPost(jsonRequest(`/api/purchases/${created.value.id}/corrections`, body, { csrf, idempotency: key }), { params: Promise.resolve({ purchaseId: created.value.id }) })).status).toBe(201);
    expect((await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: value.replacementPurchaseInvoiceId } })).total.toFixed(2)).toBe("145.20");
    expect((await purchaseCorrectionPost(jsonRequest(`/api/purchases/${created.value.id}/corrections`, { ...body, reasonCode: "OTHER", reason: null }, { csrf }), { params: Promise.resolve({ purchaseId: created.value.id }) })).status).toBe(422);
    expect((await purchaseCorrectionPost(jsonRequest(`/api/purchases/${created.value.id}/corrections`, { ...body, confirmation: "WRONG" }, { csrf }), { params: Promise.resolve({ purchaseId: created.value.id }) })).status).toBe(422);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "PURCHASE_CORRECTION_REPLACED", payload: { path: ["operationId"], equals: value.operationId } } });
    expect(JSON.stringify(audit.payload)).not.toContain("Servicio corregido"); expect(JSON.stringify(audit.payload)).not.toContain("145.20");
  });

  it("returns a stable retryable 503 after exhausting serializable correction retries", async () => {
    cookieMock.reset(); await loginHttp(); const csrf = await csrfToken();
    const purchaseId = randomUUID();
    const body = { mode: "REPLACE", expectedVersion: 1, accountingDate: "2026-07-20", reasonCode: "WRONG_AMOUNT", reason: null, confirmation: "REPLACE_PURCHASE_WITHOUT_FINANCIAL_ACTIVITY", replacement: { issueDate: "2026-07-01", receivedDate: "2026-07-01", operationDate: "2026-07-01", accountingDate: "2026-07-20", notes: null, lines: [{ catalogItemId: null, description: "Servicio corregido", quantity: "1", unitPrice: "120", discountPercent: "0", discountAmount: "0", purchaseAccountCode: "600000000", taxRateId: randomUUID() }], dueDates: [{ dueDate: "2026-08-15", amount: "145.20", paymentMethod: "BANK_TRANSFER" }] } };
    const realTransaction = prisma.$transaction.bind(prisma);
    let serializableAttempts = 0;
    const transaction = vi.spyOn(prisma, "$transaction").mockImplementation((async (work: unknown, options?: { isolationLevel?: string }) => {
      if (options?.isolationLevel === Prisma.TransactionIsolationLevel.Serializable) {
        serializableAttempts += 1;
        throw prismaError("P2034");
      }
      return Reflect.apply(realTransaction, prisma, options ? [work, options] : [work]);
    }) as never);

    try {
      const response = await purchaseCorrectionPost(jsonRequest(`/api/purchases/${purchaseId}/corrections`, body, { csrf }), { params: Promise.resolve({ purchaseId }) });
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("3");
      expect(await response.json()).toEqual({ code: "PURCHASE_TRANSACTION_RETRY_EXHAUSTED", message: "La operación no pudo completarse por concurrencia. Reinténtelo en unos segundos." });
      expect(serializableAttempts).toBe(3);
    } finally {
      transaction.mockRestore();
    }
  });

  it("returns a stable retryable 503 after exhausting serializable rectification retries", async () => {
    cookieMock.reset(); await loginHttp(); const csrf = await csrfToken(); const purchaseId = randomUUID();
    const body = { mode: "PARTIAL", expectedVersion: 1, supplierInvoiceNumber: "R-RETRY", issueDate: "2026-07-20", receivedDate: "2026-07-20", operationDate: "2026-07-20", accountingDate: "2026-07-20", reason: "RETURN", notes: null, confirmation: "PARTIAL_PURCHASE_RETURN_CONFIRMED", lines: [{ sourcePurchaseInvoiceLineId: randomUUID(), quantity: "1" }] };
    const realTransaction = prisma.$transaction.bind(prisma); let attempts = 0;
    const transaction = vi.spyOn(prisma, "$transaction").mockImplementation((async (work: unknown, options?: { isolationLevel?: string }) => {
      if (options?.isolationLevel === Prisma.TransactionIsolationLevel.Serializable) { attempts += 1; throw prismaError("P2034"); }
      return Reflect.apply(realTransaction, prisma, options ? [work, options] : [work]);
    }) as never);
    try {
      const response = await purchaseRectificationPost(jsonRequest(`/api/purchases/${purchaseId}/rectifications`, body, { csrf }), { params: Promise.resolve({ purchaseId }) });
      expect(response.status).toBe(503); expect(response.headers.get("Retry-After")).toBe("3");
      expect(await response.json()).toEqual({ code: "PURCHASE_TRANSACTION_RETRY_EXHAUSTED", message: "La operación no pudo completarse por concurrencia. Reinténtelo en unos segundos." }); expect(attempts).toBe(3);
    } finally { transaction.mockRestore(); }
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
function prismaError(code: string) { return new Prisma.PrismaClientKnownRequestError("Database conflict", { code, clientVersion: "test" }); }
