import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import {
  GET as invoicesGet,
  POST as invoicesPost
} from "@/app/api/invoices/route";
import { GET as invoiceDetailGet } from "@/app/api/invoices/[invoiceId]/route";
import { POST as invoiceLinePost } from "@/app/api/invoices/[invoiceId]/lines/route";
import { POST as invoiceIssuePost } from "@/app/api/invoices/[invoiceId]/issue/route";
import { POST as invoiceRectificationPost } from "@/app/api/invoices/[invoiceId]/rectifications/route";
import { POST as invoicePaymentReturnPost } from "@/app/api/invoices/[invoiceId]/payment-returns/route";
import { POST as invoicePaymentPost } from "@/app/api/invoices/[invoiceId]/payments/route";
import { POST as invoiceTechnicalVoidingPost } from "@/app/api/invoices/[invoiceId]/technical-voiding/route";
import { POST as invoiceUnpaidDueDatePost } from "@/app/api/invoices/[invoiceId]/unpaid-due-dates/route";
import { GET as invoicePdfGet } from "@/app/api/invoices/[invoiceId]/pdf/route";
import { POST as invoiceVerifactuCancellationPost } from "@/app/api/invoices/[invoiceId]/verifactu-cancellation/route";
import { GET as customerDueDatesGet } from "@/app/api/treasury/customer-due-dates/route";
import { GET as customerDueDatesExportGet } from "@/app/api/treasury/customer-due-dates/export/route";
import { GET as customerCollectionForecastGet } from "@/app/api/treasury/customer-collection-forecast/route";
import { GET as customerCollectionForecastExportGet } from "@/app/api/treasury/customer-collection-forecast/export/route";
import { prisma } from "@/lib/prisma";
import { sessionCookieName } from "@/modules/platform/application/auth";
import { hashVerifactuCancellationBody } from "@/modules/billing/application/verifactuCancellations";
import { hashInvoiceTechnicalVoidingBody } from "@/modules/billing/application/invoiceTechnicalVoiding";
import { idempotencyStorageKey } from "@/modules/platform/application/http";
import { hashPassword } from "@/modules/platform/application/passwords";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";
import { assertDisposableTestDatabase } from "@/tests/helpers/disposableTestDatabase";

type CookieSetOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  path?: string;
  expires?: Date;
};

const cookieMock = vi.hoisted(() => {
  const values = new Map<string, string>();

  return {
    values,
    store: {
      get(name: string) {
        const value = values.get(name);
        return value ? { name, value } : undefined;
      },
      set(name: string, value: string, options: CookieSetOptions) {
        void options;
        values.set(name, value);
      },
      delete(name: string) {
        values.delete(name);
      }
    },
    reset() {
      values.clear();
    }
  };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieMock.store)
}));

const appBaseUrl = "http://localhost:3000";
const adminPassword = "Cambiar-esta-clave-2026";
const limitedPassword = "Cambiar-auditor-2026";
const baseCommand: InitializeCommand = {
  company: {
    legalName: "CriGestion Test SL",
    taxId: "B12345678",
    email: "admin@example.test"
  },
  administrator: {
    displayName: "Administrador",
    userName: "admin",
    password: adminPassword
  }
};

describe("billing invoice HTTP contracts", () => {
  beforeEach(async () => {
    process.env.APP_BASE_URL = appBaseUrl;
    process.env.AUTH_COOKIE_SECURE = "false";
    cookieMock.reset();
    await resetPlatformTables();
    await initializeForRoutes();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("rejects unauthenticated invoice listing", async () => {
    const response = await invoicesGet(apiRequest("/api/invoices"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.code).toBe("UNAUTHENTICATED");
  });

  it("requires CSRF before creating invoice drafts", async () => {
    await loginAsAdmin();
    const customer = await createCustomer();

    const response = await invoicesPost(
      jsonRequest("/api/invoices", draftPayload(customer.id))
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.code).toBe("CSRF_TOKEN_INVALID");
  });

  it("requires an idempotency key before creating invoice drafts", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const customer = await createCustomer();

    const response = await invoicesPost(
      jsonRequest("/api/invoices", draftPayload(customer.id), {
        csrfToken,
        idempotencyKey: null
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
  });

  it("rejects users without billing permissions", async () => {
    await createLimitedUserWithoutBilling();
    await loginWith("auditor", limitedPassword);
    const csrfToken = await getCsrfToken();
    const customer = await createCustomer();

    const listResponse = await invoicesGet(apiRequest("/api/invoices"));
    const createResponse = await invoicesPost(
      jsonRequest("/api/invoices", draftPayload(customer.id), { csrfToken })
    );

    expect(listResponse.status).toBe(403);
    expect((await listResponse.json()).code).toBe("FORBIDDEN");
    expect(createResponse.status).toBe(403);
    expect((await createResponse.json()).code).toBe("FORBIDDEN");
  });

  it("creates, reads, lists, adds a line and issues an invoice", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const customer = await createCustomer();
    const taxRate = await defaultTaxRate();

    const createResponse = await invoicesPost(
      jsonRequest("/api/invoices", draftPayload(customer.id), { csrfToken })
    );
    const created = await createResponse.json();
    const lineResponse = await invoiceLinePost(
      jsonRequest(
        `/api/invoices/${created.id}/lines`,
        {
          description: "Servicio mensual",
          quantity: "1.000",
          unitPrice: "100.00",
          discountPercent: "0.00",
          discountAmount: "0.00",
          taxRateId: taxRate.id
        },
        { csrfToken }
      ),
      routeContext({ invoiceId: created.id })
    );
    const withLine = await lineResponse.json();
    const issueResponse = await invoiceIssuePost(
      jsonRequest(
        `/api/invoices/${created.id}/issue`,
        { issueDate: "2026-07-07" },
        { csrfToken }
      ),
      routeContext({ invoiceId: created.id })
    );
    const issued = await issueResponse.json();
    const detailResponse = await invoiceDetailGet(
      apiRequest(`/api/invoices/${created.id}`),
      routeContext({ invoiceId: created.id })
    );
    const detail = await detailResponse.json();
    const listResponse = await invoicesGet(apiRequest("/api/invoices?status=ISSUED"));
    const list = await listResponse.json();

    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({
      status: "DRAFT",
      customerId: customer.id
    });
    expect(lineResponse.status).toBe(201);
    expect(withLine).toMatchObject({
      totals: {
        total: "121.00"
      }
    });
    expect(issueResponse.status).toBe(200);
    expect(issued).toMatchObject({
      status: "ISSUED",
      number: "F2600001"
    });
    expect(detailResponse.status).toBe(200);
    expect(detail.number).toBe("F2600001");
    expect(listResponse.status).toBe(200);
    expect(list.invoices).toHaveLength(1);
    expect(list.invoices[0]).toMatchObject({
      id: created.id,
      number: "F2600001",
      total: "121.00"
    });
  });

  it("requires an idempotency key before issuing invoices", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const customer = await createCustomer();
    const taxRate = await defaultTaxRate();

    const createResponse = await invoicesPost(
      jsonRequest("/api/invoices", draftPayload(customer.id), { csrfToken })
    );
    const created = await createResponse.json();
    await invoiceLinePost(
      jsonRequest(
        `/api/invoices/${created.id}/lines`,
        {
          description: "Servicio mensual",
          quantity: "1.000",
          unitPrice: "100.00",
          discountPercent: "0.00",
          discountAmount: "0.00",
          taxRateId: taxRate.id
        },
        { csrfToken }
      ),
      routeContext({ invoiceId: created.id })
    );

    const response = await invoiceIssuePost(
      jsonRequest(
        `/api/invoices/${created.id}/issue`,
        { issueDate: "2026-07-07" },
        { csrfToken, idempotencyKey: null }
      ),
      routeContext({ invoiceId: created.id })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
  });

  it("rejects invoice issuing for users without Billing.Issue", async () => {
    await loginAsAdmin();
    const adminCsrfToken = await getCsrfToken();
    const draft = await createDraftWithLine(adminCsrfToken);
    await createBillingUserWithoutIssue();
    cookieMock.reset();
    await loginWith("facturacion", limitedPassword);
    const limitedCsrfToken = await getCsrfToken();

    const response = await invoiceIssuePost(
      jsonRequest(
        `/api/invoices/${draft.id}/issue`,
        { issueDate: "2026-07-07" },
        { csrfToken: limitedCsrfToken }
      ),
      routeContext({ invoiceId: draft.id })
    );
    const body = await response.json();
    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: draft.id },
      select: { status: true, number: true }
    });
    const deniedAudit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "ACCESS_DENIED" }
    });

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "FORBIDDEN",
      message: "No tienes permiso para realizar esta accion."
    });
    expect(invoice).toEqual({
      status: "DRAFT",
      number: null
    });
    expect(deniedAudit.payload).toMatchObject({
      permission: "Billing.Issue"
    });
  });

  it("requires an idempotency key before adding invoice lines", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const customer = await createCustomer();
    const taxRate = await defaultTaxRate();

    const createResponse = await invoicesPost(
      jsonRequest("/api/invoices", draftPayload(customer.id), { csrfToken })
    );
    const created = await createResponse.json();
    const response = await invoiceLinePost(
      jsonRequest(
        `/api/invoices/${created.id}/lines`,
        {
          description: "Servicio mensual",
          quantity: "1.000",
          unitPrice: "100.00",
          discountPercent: "0.00",
          discountAmount: "0.00",
          taxRateId: taxRate.id
        },
        { csrfToken, idempotencyKey: null }
      ),
      routeContext({ invoiceId: created.id })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
  });

  it("rejects adding lines to issued invoices", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const issued = await createIssuedInvoice(csrfToken);
    const taxRate = await defaultTaxRate();

    const response = await invoiceLinePost(
      jsonRequest(
        `/api/invoices/${issued.id}/lines`,
        {
          description: "Linea tardia",
          quantity: "1.000",
          unitPrice: "10.00",
          discountPercent: "0.00",
          discountAmount: "0.00",
          taxRateId: taxRate.id
        },
        { csrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );
    const body = await response.json();
    const lineCount = await prisma.invoiceLine.count({
      where: { invoiceId: issued.id }
    });

    expect(response.status).toBe(409);
    expect(body).toEqual({
      code: "INVOICE_NOT_EDITABLE",
      message: "La factura no esta en borrador."
    });
    expect(lineCount).toBe(1);
  });

  it("creates invoice rectifications through the invoice contract", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const issued = await createIssuedInvoice(csrfToken);
    const response = await invoiceRectificationPost(
      jsonRequest(
        `/api/invoices/${issued.id}/rectifications`,
        {
          issueDate: "2026-07-08",
          reason: "AMOUNT_ERROR",
          notes: "No auditar literal completo"
        },
        { csrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );
    const body = await response.json();
    const original = await prisma.invoice.findUniqueOrThrow({
      where: { id: issued.id },
      select: { status: true }
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "INVOICE_RECTIFICATION_CREATED" }
    });

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      documentType: "RECTIFICATION",
      status: "ISSUED",
      series: "R",
      number: "R2600001",
      rectificationReason: "AMOUNT_ERROR",
      rectifiesInvoice: {
        id: issued.id,
        number: "F2600001"
      },
      totals: {
        total: "-121.00"
      }
    });
    expect(original.status).toBe("RECTIFIED");
    expect(auditEvent.payload).toMatchObject({
      rectifiesInvoiceId: issued.id,
      number: "R2600001",
      total: "-121.00",
      reason: "AMOUNT_ERROR"
    });
    expect(JSON.stringify(auditEvent.payload)).not.toContain("No auditar");
  });

  it("fails closed when rectifying a pending VeriFactu invoice", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const issued = await createIssuedInvoice(csrfToken);
    await prisma.invoice.update({
      where: { id: issued.id },
      data: { verifactuStatus: "PENDING" }
    });

    const response = await invoiceRectificationPost(
      jsonRequest(
        `/api/invoices/${issued.id}/rectifications`,
        { issueDate: "2026-07-08", reason: "AMOUNT_ERROR" },
        { csrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "INVOICE_RECTIFICATION_VERIFACTU_UNAVAILABLE"
    });
    expect(await prisma.invoice.count({ where: { rectifiesInvoiceId: issued.id } })).toBe(0);
  });

  it("protects invoice rectification creation with CSRF, idempotency and permissions", async () => {
    await loginAsAdmin();
    const adminCsrfToken = await getCsrfToken();
    const issued = await createIssuedInvoice(adminCsrfToken);

    const missingIdempotencyResponse = await invoiceRectificationPost(
      jsonRequest(
        `/api/invoices/${issued.id}/rectifications`,
        {
          issueDate: "2026-07-08",
          reason: "OTHER",
          notes: null
        },
        { csrfToken: adminCsrfToken, idempotencyKey: null }
      ),
      routeContext({ invoiceId: issued.id })
    );

    cookieMock.reset();
    await createBillingUserWithoutIssue();
    await loginWith("facturacion", limitedPassword);
    const limitedCsrfToken = await getCsrfToken();
    const forbiddenResponse = await invoiceRectificationPost(
      jsonRequest(
        `/api/invoices/${issued.id}/rectifications`,
        {
          issueDate: "2026-07-08",
          reason: "OTHER",
          notes: null
        },
        { csrfToken: limitedCsrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );
    cookieMock.reset();
    const unauthenticatedResponse = await invoiceRectificationPost(
      jsonRequest(
        `/api/invoices/${issued.id}/rectifications`,
        {
          issueDate: "2026-07-08",
          reason: "OTHER",
          notes: null
        },
        { csrfToken: adminCsrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );

    expect(missingIdempotencyResponse.status).toBe(400);
    expect(await missingIdempotencyResponse.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
    expect(forbiddenResponse.status).toBe(403);
    expect(await forbiddenResponse.json()).toMatchObject({
      code: "FORBIDDEN"
    });
    expect(unauthenticatedResponse.status).toBe(401);
    expect(await unauthenticatedResponse.json()).toMatchObject({
      code: "UNAUTHENTICATED"
    });
  });

  it("blocks invoice mutations while maintenance is active", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const customer = await createCustomer();
    const taxRate = await defaultTaxRate();
    const createResponse = await invoicesPost(
      jsonRequest("/api/invoices", draftPayload(customer.id), { csrfToken })
    );
    const created = (await createResponse.json()) as { id: string };
    await invoiceLinePost(
      jsonRequest(
        `/api/invoices/${created.id}/lines`,
        {
          description: "Servicio mensual",
          quantity: "1.000",
          unitPrice: "100.00",
          discountPercent: "0.00",
          discountAmount: "0.00",
          taxRateId: taxRate.id
        },
        { csrfToken }
      ),
      routeContext({ invoiceId: created.id })
    );
    const restore = await enableMaintenance();

    const blockedCreateResponse = await invoicesPost(
      jsonRequest("/api/invoices", draftPayload(customer.id), { csrfToken })
    );
    const blockedLineResponse = await invoiceLinePost(
      jsonRequest(
        `/api/invoices/${created.id}/lines`,
        {
          description: "Linea en mantenimiento",
          quantity: "1.000",
          unitPrice: "10.00",
          discountPercent: "0.00",
          discountAmount: "0.00",
          taxRateId: taxRate.id
        },
        { csrfToken }
      ),
      routeContext({ invoiceId: created.id })
    );
    const blockedIssueResponse = await invoiceIssuePost(
      jsonRequest(
        `/api/invoices/${created.id}/issue`,
        { issueDate: "2026-07-07" },
        { csrfToken }
      ),
      routeContext({ invoiceId: created.id })
    );
    const blockedCreateBody = await blockedCreateResponse.json();
    const blockedLineBody = await blockedLineResponse.json();
    const blockedIssueBody = await blockedIssueResponse.json();
    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: created.id },
      select: { status: true, lines: { select: { id: true } } }
    });
    const blockedEvents = await prisma.auditEvent.findMany({
      where: { eventType: "MAINTENANCE_MUTATION_BLOCKED" },
      orderBy: { createdAt: "asc" }
    });

    expect(blockedCreateResponse.status).toBe(423);
    expect(blockedLineResponse.status).toBe(423);
    expect(blockedIssueResponse.status).toBe(423);
    expect(blockedCreateBody).toEqual(maintenanceModeActiveBody());
    expect(blockedLineBody).toEqual(maintenanceModeActiveBody());
    expect(blockedIssueBody).toEqual(maintenanceModeActiveBody());
    expect(invoice.status).toBe("DRAFT");
    expect(invoice.lines).toHaveLength(1);
    expect(blockedEvents).toHaveLength(3);
    expect(blockedEvents.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/api/invoices",
        mode: "RESTORE",
        restoreOperationId: restore.id
      }),
      expect.objectContaining({
        method: "POST",
        path: `/api/invoices/${created.id}/lines`,
        mode: "RESTORE",
        restoreOperationId: restore.id
      }),
      expect.objectContaining({
        method: "POST",
        path: `/api/invoices/${created.id}/issue`,
        mode: "RESTORE",
        restoreOperationId: restore.id
      })
    ]);
  });

  it("returns an authenticated VeriFactu cancellation replay during maintenance without a new mutation", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const admin = await prisma.user.findUniqueOrThrow({ where: { normalizedUserName: "admin" }, select: { id: true } });
    const invoiceId = randomUUID();
    const clientKey = randomUUID();
    const payload = { reasonCode: "ISSUED_BY_MISTAKE" as const };
    const responseBody = { invoiceId, cancelledRecordId: randomUUID(), cancellationRecordId: randomUUID(),
      chainPosition: "2", status: "PENDING" };
    const storageKey = idempotencyStorageKey(admin.id, "verifactu-cancellation", invoiceId, clientKey);
    await prisma.idempotencyRecord.create({ data: {
      key: storageKey, requestHash: hashVerifactuCancellationBody(payload), responseStatus: 202, responseBody
    } });
    await enableMaintenance();

    const response = await invoiceVerifactuCancellationPost(
      jsonRequest(`/api/invoices/${invoiceId}/verifactu-cancellation`, payload, { csrfToken, idempotencyKey: clientKey }),
      routeContext({ invoiceId })
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(responseBody);
    expect(await prisma.idempotencyRecord.count({ where: { key: storageKey } })).toBe(1);
    expect(await prisma.rateLimitBucket.count({ where: { key: `verifactu-cancellation:${admin.id}` } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { eventType: "MAINTENANCE_MUTATION_BLOCKED" } })).toBe(0);

    const reused = await invoiceVerifactuCancellationPost(
      jsonRequest(`/api/invoices/${invoiceId}/verifactu-cancellation`, { reasonCode: "DUPLICATE_INVOICE" },
        { csrfToken, idempotencyKey: clientKey }),
      routeContext({ invoiceId })
    );
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("protects and validates the technical voiding contract", async () => {
    const invoiceId = randomUUID();
    const payload = {
      voidDate: "2026-07-14",
      reasonCode: "ISSUED_BY_MISTAKE",
      confirmation: "VOID_AFTER_ACCEPTED_VERIFACTU_CANCELLATION"
    };

    await createLimitedUserWithoutBilling();
    await loginWith("auditor", limitedPassword);
    const limitedCsrf = await getCsrfToken();
    const forbidden = await invoiceTechnicalVoidingPost(
      jsonRequest(`/api/invoices/${invoiceId}/technical-voiding`, payload, { csrfToken: limitedCsrf }),
      routeContext({ invoiceId })
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: "FORBIDDEN" });

    cookieMock.reset();
    await loginAsAdmin();
    const adminCsrf = await getCsrfToken();
    const missingIdempotency = await invoiceTechnicalVoidingPost(
      jsonRequest(`/api/invoices/${invoiceId}/technical-voiding`, payload, {
        csrfToken: adminCsrf,
        idempotencyKey: null
      }),
      routeContext({ invoiceId })
    );
    expect(missingIdempotency.status).toBe(400);
    expect(await missingIdempotency.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });

    const invalidConfirmation = await invoiceTechnicalVoidingPost(
      jsonRequest(`/api/invoices/${invoiceId}/technical-voiding`, { ...payload, confirmation: "VOID" }, {
        csrfToken: adminCsrf
      }),
      routeContext({ invoiceId })
    );
    expect(invalidConfirmation.status).toBe(422);
    expect(await invalidConfirmation.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("returns a technical voiding replay during maintenance without consuming rate limit", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const admin = await prisma.user.findUniqueOrThrow({ where: { normalizedUserName: "admin" }, select: { id: true } });
    const invoiceId = randomUUID();
    const clientKey = randomUUID();
    const payload = {
      voidDate: "2026-07-14",
      reasonCode: "ISSUED_BY_MISTAKE" as const,
      confirmation: "VOID_AFTER_ACCEPTED_VERIFACTU_CANCELLATION" as const
    };
    const responseBody = {
      invoiceId,
      status: "VOIDED",
      paymentStatus: "CANCELLED",
      cancellationRecordId: randomUUID(),
      reversalEntry: { id: randomUUID(), number: "2026/000002" }
    };
    const storageKey = idempotencyStorageKey(admin.id, "invoice-technical-voiding", invoiceId, clientKey);
    await prisma.idempotencyRecord.create({ data: {
      key: storageKey,
      requestHash: hashInvoiceTechnicalVoidingBody(payload),
      responseStatus: 201,
      responseBody
    } });
    await enableMaintenance();

    const response = await invoiceTechnicalVoidingPost(
      jsonRequest(`/api/invoices/${invoiceId}/technical-voiding`, payload, { csrfToken, idempotencyKey: clientKey }),
      routeContext({ invoiceId })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(responseBody);
    expect(await prisma.rateLimitBucket.count({ where: { key: `invoice-technical-voiding:${admin.id}` } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { eventType: "MAINTENANCE_MUTATION_BLOCKED" } })).toBe(0);
  });

  it("returns functional errors for invalid invoice operations", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const missingId = randomUUID();

    const response = await invoiceLinePost(
      jsonRequest(
        `/api/invoices/${missingId}/lines`,
        {
          description: "Servicio mensual",
          quantity: "1.000",
          unitPrice: "100.00",
          taxRateId: randomUUID()
        },
        { csrfToken }
      ),
      routeContext({ invoiceId: missingId })
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({
      code: "INVOICE_NOT_FOUND"
    });
  });

  it("rejects unauthenticated invoice PDF downloads", async () => {
    const response = await invoicePdfGet(
      apiRequest(`/api/invoices/${randomUUID()}/pdf`),
      routeContext({ invoiceId: randomUUID() })
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.code).toBe("UNAUTHENTICATED");
  });

  it("rejects invoice PDF downloads for users without billing view permission", async () => {
    await createLimitedUserWithoutBilling();
    await loginWith("auditor", limitedPassword);

    const response = await invoicePdfGet(
      apiRequest(`/api/invoices/${randomUUID()}/pdf`),
      routeContext({ invoiceId: randomUUID() })
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.code).toBe("FORBIDDEN");
  });

  it("does not generate PDFs for draft invoices", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const customer = await createCustomer();
    const createResponse = await invoicesPost(
      jsonRequest("/api/invoices", draftPayload(customer.id), { csrfToken })
    );
    const created = await createResponse.json();

    const response = await invoicePdfGet(
      apiRequest(`/api/invoices/${created.id}/pdf`),
      routeContext({ invoiceId: created.id })
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      code: "INVOICE_PDF_NOT_AVAILABLE"
    });
  });

  it("downloads issued invoice PDFs and audits the download", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const issued = await createIssuedInvoice(csrfToken);
    const response = await invoicePdfGet(
      apiRequest(`/api/invoices/${issued.id}/pdf`),
      routeContext({ invoiceId: issued.id })
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "INVOICE_PDF_DOWNLOADED" }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe(
      'inline; filename="F2600001.pdf"'
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(Buffer.from(bytes.slice(0, 5)).toString("ascii")).toBe("%PDF-");
    expect(auditEvent.payload).toMatchObject({
      invoiceId: issued.id,
      number: "F2600001"
    });
    expect(JSON.stringify(auditEvent.payload)).not.toContain(adminPassword);
  });

  it("embeds the persisted VeriFactu URL as a real monochrome QR in the invoice PDF", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const issued = await createIssuedInvoice(csrfToken);
    const qrUrl = "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=B12345678&numserie=F2600001&fecha=07-07-2026&importe=121.00";
    await attachVerifactuQr(issued.id, qrUrl);

    const response = await invoicePdfGet(
      apiRequest(`/api/invoices/${issued.id}/pdf`),
      routeContext({ invoiceId: issued.id })
    );
    const pdf = Buffer.from(await response.arrayBuffer()).toString("binary");

    expect(response.status).toBe(200);
    expect(pdf).toContain("(Factura verificable en la sede electronica de la AEAT)");
    expect(pdf).not.toContain("(QR)");
    expect(pdf).toContain("/ColorSpace /DeviceGray /BitsPerComponent 1 /Interpolate false");
  });

  it("registers customer payments through the invoice contract", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const issued = await createIssuedInvoice(csrfToken);
    const dueDate = await prisma.invoiceDueDate.findFirstOrThrow({
      where: { invoiceId: issued.id },
      select: { id: true }
    });

    const partialResponse = await invoicePaymentPost(
      jsonRequest(
        `/api/invoices/${issued.id}/payments`,
        {
          dueDateId: dueDate.id,
          paymentDate: "2026-07-10",
          amount: "60.00",
          reference: "Transferencia 001",
          notes: "No auditar completo"
        },
        { csrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );
    const partial = await partialResponse.json();
    const fullResponse = await invoicePaymentPost(
      jsonRequest(
        `/api/invoices/${issued.id}/payments`,
        {
          dueDateId: dueDate.id,
          paymentDate: "2026-07-11",
          amount: "61.00",
          reference: "Transferencia 002",
          notes: null
        },
        { csrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );
    const full = await fullResponse.json();
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_PAYMENT_REGISTERED" },
      orderBy: { createdAt: "asc" }
    });

    expect(partialResponse.status).toBe(201);
    expect(partial).toMatchObject({
      paymentStatus: "PARTIALLY_PAID",
      dueDates: [
        {
          id: dueDate.id,
          status: "PENDING"
        }
      ]
    });
    expect(fullResponse.status).toBe(201);
    expect(full).toMatchObject({
      paymentStatus: "PAID",
      dueDates: [
        {
          id: dueDate.id,
          status: "PAID"
        }
      ]
    });
    expect(auditEvent.payload).toMatchObject({
      invoiceId: issued.id,
      dueDateId: dueDate.id,
      amount: "60.00",
      resultingPaymentStatus: "PARTIALLY_PAID"
    });
    expect(JSON.stringify(auditEvent.payload)).not.toContain("No auditar");
  });

  it("registers customer payment returns through the invoice contract", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const issued = await createIssuedInvoice(csrfToken);
    const dueDate = await prisma.invoiceDueDate.findFirstOrThrow({
      where: { invoiceId: issued.id },
      select: { id: true }
    });
    const paymentResponse = await invoicePaymentPost(
      jsonRequest(
        `/api/invoices/${issued.id}/payments`,
        {
          dueDateId: dueDate.id,
          paymentDate: "2026-07-10",
          amount: "121.00",
          reference: "Transferencia 003",
          notes: null
        },
        { csrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );
    const paymentBody = await paymentResponse.json();
    const paymentId = paymentBody.payments[0]?.id;

    if (!paymentId) {
      throw new Error("Missing payment.");
    }

    const returnIdempotencyKey = randomUUID();
    const returnPayload = {
      paymentId,
      returnDate: "2026-07-12",
      amount: "21.00",
      reasonCode: "BANK_RETURN",
      notes: "No auditar devolucion completa"
    };
    const returnResponse = await invoicePaymentReturnPost(
      jsonRequest(
        `/api/invoices/${issued.id}/payment-returns`,
        returnPayload,
        { csrfToken, idempotencyKey: returnIdempotencyKey }
      ),
      routeContext({ invoiceId: issued.id })
    );
    const body = await returnResponse.json();
    const replayResponse = await invoicePaymentReturnPost(
      jsonRequest(
        `/api/invoices/${issued.id}/payment-returns`,
        returnPayload,
        { csrfToken, idempotencyKey: returnIdempotencyKey }
      ),
      routeContext({ invoiceId: issued.id })
    );
    const replayed = await replayResponse.json();
    const reusedResponse = await invoicePaymentReturnPost(
      jsonRequest(
        `/api/invoices/${issued.id}/payment-returns`,
        { ...returnPayload, amount: "20.00" },
        { csrfToken, idempotencyKey: returnIdempotencyKey }
      ),
      routeContext({ invoiceId: issued.id })
    );
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_PAYMENT_RETURNED" },
      orderBy: { createdAt: "asc" }
    });

    expect(returnResponse.status).toBe(201);
    expect(replayResponse.status).toBe(201);
    expect(replayed).toEqual(body);
    expect(reusedResponse.status).toBe(409);
    expect(await reusedResponse.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(await prisma.customerPaymentReturn.count({ where: { paymentId } })).toBe(1);
    expect(body).toMatchObject({
      paymentStatus: "PARTIALLY_PAID",
      dueDates: [
        {
          id: dueDate.id,
          paidAmount: "100.00",
          pendingAmount: "21.00",
          status: "PENDING"
        }
      ],
      payments: [
        {
          id: paymentId,
          amount: "121.00",
          returnedAmount: "21.00",
          netAmount: "100.00"
        }
      ],
      paymentReturns: [
        {
          paymentId,
          dueDateId: dueDate.id,
          returnDate: "2026-07-12",
          amount: "21.00",
          reasonCode: "BANK_RETURN"
        }
      ]
    });
    expect(auditEvent.payload).toMatchObject({
      invoiceId: issued.id,
      dueDateId: dueDate.id,
      paymentId,
      amount: "21.00",
      resultingPaymentStatus: "PARTIALLY_PAID"
    });
    expect(JSON.stringify(auditEvent.payload)).not.toContain("No auditar");
  });

  it("marks customer due dates unpaid through the invoice contract", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const issued = await createIssuedInvoice(csrfToken);
    const dueDate = await prisma.invoiceDueDate.findFirstOrThrow({
      where: { invoiceId: issued.id },
      select: { id: true }
    });
    await invoicePaymentPost(
      jsonRequest(
        `/api/invoices/${issued.id}/payments`,
        {
          dueDateId: dueDate.id,
          paymentDate: "2026-07-10",
          amount: "40.00",
          reference: null,
          notes: null
        },
        { csrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );

    const unpaidResponse = await invoiceUnpaidDueDatePost(
      jsonRequest(
        `/api/invoices/${issued.id}/unpaid-due-dates`,
        {
          dueDateId: dueDate.id,
          unpaidDate: "2026-07-20",
          reasonCode: "BANK_DEFAULT",
          notes: "No auditar impago completo"
        },
        { csrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );
    const body = await unpaidResponse.json();
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_DUE_DATE_MARKED_UNPAID" }
    });

    expect(unpaidResponse.status).toBe(201);
    expect(body).toMatchObject({
      paymentStatus: "UNPAID",
      dueDates: [
        {
          id: dueDate.id,
          paidAmount: "40.00",
          pendingAmount: "81.00",
          status: "UNPAID"
        }
      ]
    });
    expect(auditEvent.payload).toMatchObject({
      invoiceId: issued.id,
      dueDateId: dueDate.id,
      unpaidDate: "2026-07-20",
      reasonCode: "BANK_DEFAULT",
      pendingAmount: "81.00",
      resultingPaymentStatus: "UNPAID"
    });
    expect(JSON.stringify(auditEvent.payload)).not.toContain("No auditar");
  });

  it("lists customer due dates through the treasury contract", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const issued = await createIssuedInvoice(csrfToken);
    const dueDate = await prisma.invoiceDueDate.findFirstOrThrow({
      where: { invoiceId: issued.id },
      select: { id: true }
    });
    const paymentResponse = await invoicePaymentPost(
      jsonRequest(
        `/api/invoices/${issued.id}/payments`,
        {
          dueDateId: dueDate.id,
          paymentDate: "2026-07-10",
          amount: "121.00",
          reference: null,
          notes: null
        },
        { csrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );
    const paymentBody = await paymentResponse.json();
    const paymentId = paymentBody.payments[0]?.id;

    if (!paymentId) {
      throw new Error("Missing payment.");
    }

    await invoicePaymentReturnPost(
      jsonRequest(
        `/api/invoices/${issued.id}/payment-returns`,
        {
          paymentId,
          returnDate: "2026-07-12",
          amount: "21.00",
          reasonCode: "BANK_RETURN",
          notes: null
        },
        { csrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );

    const response = await customerDueDatesGet(
      apiRequest("/api/treasury/customer-due-dates?scope=OPEN")
    );
    const body = await response.json();
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_DUE_DATES_VIEWED" }
    });

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      summary: {
        count: 1,
        totalAmount: "121.00",
        paidAmount: "100.00",
        returnedAmount: "21.00",
        pendingAmount: "21.00"
      },
      dueDates: [
        {
          id: dueDate.id,
          invoiceId: issued.id,
          amount: "121.00",
          paidAmount: "100.00",
          returnedAmount: "21.00",
          pendingAmount: "21.00",
          status: "PENDING",
          paymentStatus: "PARTIALLY_PAID"
        }
      ],
      nextCursor: null
    });
    expect(auditEvent.payload).toMatchObject({
      scope: "OPEN",
      resultCount: 1
    });
  });

  it("exports customer due dates as CSV through the treasury contract", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const issued = await createIssuedInvoice(csrfToken);
    const dueDate = await prisma.invoiceDueDate.findFirstOrThrow({
      where: { invoiceId: issued.id },
      select: { id: true }
    });
    const paymentResponse = await invoicePaymentPost(
      jsonRequest(
        `/api/invoices/${issued.id}/payments`,
        {
          dueDateId: dueDate.id,
          paymentDate: "2026-07-10",
          amount: "121.00",
          reference: null,
          notes: null
        },
        { csrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );
    const paymentBody = await paymentResponse.json();
    const paymentId = paymentBody.payments[0]?.id;

    if (!paymentId) {
      throw new Error("Missing payment.");
    }

    await invoicePaymentReturnPost(
      jsonRequest(
        `/api/invoices/${issued.id}/payment-returns`,
        {
          paymentId,
          returnDate: "2026-07-12",
          amount: "21.00",
          reasonCode: "BANK_RETURN",
          notes: null
        },
        { csrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );

    const response = await customerDueDatesExportGet(
      apiRequest("/api/treasury/customer-due-dates/export?scope=OPEN&limit=25")
    );
    const csv = await response.text();
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_DUE_DATES_EXPORTED" }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="vencimientos-clientes-\d{4}-\d{2}-\d{2}\.csv"$/
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(csv).toContain(
      '"vencimiento","fecha_emision","factura","serie","ejercicio","cliente_codigo","cliente_nombre"'
    );
    expect(csv).toContain('"121.00","100.00","0.00","21.00","21.00"');
    expect(auditEvent.payload).toMatchObject({
      scope: "OPEN",
      limit: 25,
      resultCount: 1
    });
  });

  it("returns customer collection forecast through the treasury contract", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const issued = await createIssuedInvoice(csrfToken);
    const response = await customerCollectionForecastGet(
      apiRequest("/api/treasury/customer-collection-forecast?year=2026&asOf=2026-07-10")
    );
    const body = await response.json();
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_COLLECTION_FORECAST_VIEWED" }
    });

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      year: 2026,
      asOf: "2026-07-10",
      summary: {
        itemCount: 1,
        expectedAmount: "121.00",
        overdueAmount: "121.00"
      },
      items: [
        {
          invoiceId: issued.id,
          invoiceNumber: "F2600001",
          forecastMonth: 7,
          pendingAmount: "121.00",
          overdue: true
        }
      ]
    });
    expect(body.months[6]).toMatchObject({
      month: 7,
      itemCount: 1,
      expectedAmount: "121.00",
      overdueAmount: "121.00"
    });
    expect(auditEvent.payload).toMatchObject({
      year: 2026,
      asOf: "2026-07-10",
      resultCount: 1
    });
  });

  it("exports customer collection forecast as CSV through the treasury contract", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    await createIssuedInvoice(csrfToken);

    const response = await customerCollectionForecastExportGet(
      apiRequest(
        "/api/treasury/customer-collection-forecast/export?year=2026&asOf=2026-07-10"
      )
    );
    const csv = await response.text();
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_COLLECTION_FORECAST_EXPORTED" }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="prevision-cobros-clientes-2026-2026-07-10.csv"'
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(csv).toContain(
      '"ejercicio","referencia","mes_previsto","vencimiento","factura","cliente_codigo","cliente_nombre"'
    );
    expect(csv).toContain('"2026","2026-07-10","7","2026-07-07","F2600001"');
    expect(csv).toContain('"121.00","0.00","121.00","SI"');
    expect(csv).not.toContain("B12345678");
    expect(auditEvent.payload).toMatchObject({
      year: 2026,
      asOf: "2026-07-10",
      resultCount: 1
    });
  });

  it("protects customer due date listing with authentication, permissions and validation", async () => {
    const unauthenticatedResponse = await customerDueDatesGet(
      apiRequest("/api/treasury/customer-due-dates")
    );

    await loginAsAdmin();
    const invalidResponse = await customerDueDatesGet(
      apiRequest("/api/treasury/customer-due-dates?scope=INVALID")
    );

    cookieMock.reset();
    await createBillingUserWithoutIssue();
    await loginWith("facturacion", limitedPassword);
    const forbiddenResponse = await customerDueDatesGet(
      apiRequest("/api/treasury/customer-due-dates")
    );

    expect(unauthenticatedResponse.status).toBe(401);
    expect(await unauthenticatedResponse.json()).toMatchObject({
      code: "UNAUTHENTICATED"
    });
    expect(invalidResponse.status).toBe(422);
    expect(await invalidResponse.json()).toMatchObject({
      code: "VALIDATION_ERROR"
    });
    expect(forbiddenResponse.status).toBe(403);
    expect(await forbiddenResponse.json()).toMatchObject({
      code: "FORBIDDEN"
    });
  });

  it("protects customer collection forecast with authentication, permissions and validation", async () => {
    const unauthenticatedResponse = await customerCollectionForecastGet(
      apiRequest("/api/treasury/customer-collection-forecast")
    );
    const unauthenticatedExportResponse = await customerCollectionForecastExportGet(
      apiRequest("/api/treasury/customer-collection-forecast/export")
    );

    await loginAsAdmin();
    const invalidResponse = await customerCollectionForecastGet(
      apiRequest("/api/treasury/customer-collection-forecast?year=1999")
    );
    const invalidExportResponse = await customerCollectionForecastExportGet(
      apiRequest("/api/treasury/customer-collection-forecast/export?year=1999")
    );

    cookieMock.reset();
    await createBillingUserWithoutIssue();
    await loginWith("facturacion", limitedPassword);
    const forbiddenResponse = await customerCollectionForecastGet(
      apiRequest("/api/treasury/customer-collection-forecast")
    );
    const forbiddenExportResponse = await customerCollectionForecastExportGet(
      apiRequest("/api/treasury/customer-collection-forecast/export")
    );

    expect(unauthenticatedResponse.status).toBe(401);
    expect(await unauthenticatedResponse.json()).toMatchObject({
      code: "UNAUTHENTICATED"
    });
    expect(unauthenticatedExportResponse.status).toBe(401);
    expect(await unauthenticatedExportResponse.json()).toMatchObject({
      code: "UNAUTHENTICATED"
    });
    expect(invalidResponse.status).toBe(422);
    expect(await invalidResponse.json()).toMatchObject({
      code: "VALIDATION_ERROR"
    });
    expect(invalidExportResponse.status).toBe(422);
    expect(await invalidExportResponse.json()).toMatchObject({
      code: "VALIDATION_ERROR"
    });
    expect(forbiddenResponse.status).toBe(403);
    expect(await forbiddenResponse.json()).toMatchObject({
      code: "FORBIDDEN"
    });
    expect(forbiddenExportResponse.status).toBe(403);
    expect(await forbiddenExportResponse.json()).toMatchObject({
      code: "FORBIDDEN"
    });
  });

  it("protects customer payment registration with CSRF, idempotency and permissions", async () => {
    await loginAsAdmin();
    const adminCsrfToken = await getCsrfToken();
    const issued = await createIssuedInvoice(adminCsrfToken);
    const dueDate = await prisma.invoiceDueDate.findFirstOrThrow({
      where: { invoiceId: issued.id },
      select: { id: true }
    });
    const missingIdempotencyResponse = await invoicePaymentPost(
      jsonRequest(
        `/api/invoices/${issued.id}/payments`,
        {
          dueDateId: dueDate.id,
          paymentDate: "2026-07-10",
          amount: "10.00",
          reference: null,
          notes: null
        },
        { csrfToken: adminCsrfToken, idempotencyKey: null }
      ),
      routeContext({ invoiceId: issued.id })
    );
    const missingUnpaidIdempotencyResponse = await invoiceUnpaidDueDatePost(
      jsonRequest(
        `/api/invoices/${issued.id}/unpaid-due-dates`,
        {
          dueDateId: dueDate.id,
          unpaidDate: "2026-07-20",
          reasonCode: null,
          notes: null
        },
        { csrfToken: adminCsrfToken, idempotencyKey: null }
      ),
      routeContext({ invoiceId: issued.id })
    );

    cookieMock.reset();
    await createBillingUserWithoutIssue();
    await loginWith("facturacion", limitedPassword);
    const limitedCsrfToken = await getCsrfToken();
    const forbiddenResponse = await invoicePaymentPost(
      jsonRequest(
        `/api/invoices/${issued.id}/payments`,
        {
          dueDateId: dueDate.id,
          paymentDate: "2026-07-10",
          amount: "10.00",
          reference: null,
          notes: null
        },
        { csrfToken: limitedCsrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );
    const forbiddenUnpaidResponse = await invoiceUnpaidDueDatePost(
      jsonRequest(
        `/api/invoices/${issued.id}/unpaid-due-dates`,
        {
          dueDateId: dueDate.id,
          unpaidDate: "2026-07-20",
          reasonCode: null,
          notes: null
        },
        { csrfToken: limitedCsrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );
    cookieMock.reset();
    const unauthenticatedResponse = await invoicePaymentPost(
      jsonRequest(
        `/api/invoices/${issued.id}/payments`,
        {
          dueDateId: dueDate.id,
          paymentDate: "2026-07-10",
          amount: "10.00",
          reference: null,
          notes: null
        },
        { csrfToken: adminCsrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );
    const unauthenticatedUnpaidResponse = await invoiceUnpaidDueDatePost(
      jsonRequest(
        `/api/invoices/${issued.id}/unpaid-due-dates`,
        {
          dueDateId: dueDate.id,
          unpaidDate: "2026-07-20",
          reasonCode: null,
          notes: null
        },
        { csrfToken: adminCsrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );

    expect(missingIdempotencyResponse.status).toBe(400);
    expect(await missingIdempotencyResponse.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
    expect(missingUnpaidIdempotencyResponse.status).toBe(400);
    expect(await missingUnpaidIdempotencyResponse.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
    expect(forbiddenResponse.status).toBe(403);
    expect(await forbiddenResponse.json()).toMatchObject({
      code: "FORBIDDEN"
    });
    expect(forbiddenUnpaidResponse.status).toBe(403);
    expect(await forbiddenUnpaidResponse.json()).toMatchObject({
      code: "FORBIDDEN"
    });
    expect(unauthenticatedResponse.status).toBe(401);
    expect(await unauthenticatedResponse.json()).toMatchObject({
      code: "UNAUTHENTICATED"
    });
    expect(unauthenticatedUnpaidResponse.status).toBe(401);
    expect(await unauthenticatedUnpaidResponse.json()).toMatchObject({
      code: "UNAUTHENTICATED"
    });
  });
});

async function createLimitedUserWithoutBilling(): Promise<void> {
  const role = await prisma.role.create({
    data: {
      code: "ConsultaAuditoria",
      name: "Consulta auditoria",
      isProtected: false,
      permissions: {
        create: {
          permission: {
            connect: {
              code: "Platform.ViewAudit"
            }
          }
        }
      }
    }
  });

  await prisma.user.create({
    data: {
      displayName: "Usuario Auditor",
      userName: "auditor",
      normalizedUserName: "auditor",
      passwordHash: hashPassword(limitedPassword),
      status: "ACTIVE",
      roleId: role.id
    }
  });
}

async function createBillingUserWithoutIssue(): Promise<void> {
  const role = await prisma.role.create({
    data: {
      code: "GestionFacturacion",
      name: "Gestion facturacion",
      isProtected: false,
      permissions: {
        create: [
          {
            permission: {
              connect: {
                code: "Billing.View"
              }
            }
          },
          {
            permission: {
              connect: {
                code: "Billing.ManageDrafts"
              }
            }
          }
        ]
      }
    }
  });

  await prisma.user.create({
    data: {
      displayName: "Usuario Facturacion",
      userName: "facturacion",
      normalizedUserName: "facturacion",
      passwordHash: hashPassword(limitedPassword),
      status: "ACTIVE",
      roleId: role.id
    }
  });
}

async function createCustomer() {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { normalizedUserName: "admin" },
    select: { id: true }
  });

  const fiscalYear = await prisma.accountingFiscalYear.findFirstOrThrow({ where: { year: 2026 } });
  const code = ((await prisma.customer.count()) + 1).toString();
  const customer = await prisma.customer.create({
    data: {
      code,
      type: "COMPANY",
      legalName: "Cliente Facturacion SL",
      taxId: `B${Math.floor(Math.random() * 100000000)
        .toString()
        .padStart(8, "0")}`,
      normalizedTaxId: `BILLING-${randomUUID()}`,
      fiscalTreatment: "DOMESTIC",
      fiscalAddressLine: "Calle Factura 1",
      fiscalPostalCode: "28001",
      fiscalCity: "Madrid",
      fiscalProvince: "Madrid",
      fiscalCountry: "ES",
      createdById: admin.id
    }
  });
  await prisma.accountingAccount.create({
    data: { fiscalYearId: fiscalYear.id, code: `430${code.padStart(6, "0")}`, name: `Cliente ${code}`, type: "ASSET", level: 4, isPostable: true, createdById: admin.id }
  });
  return customer;
}

async function defaultTaxRate() {
  return prisma.catalogTaxRate.findFirstOrThrow({
    where: { code: "IVA_21" },
    select: { id: true }
  });
}

async function createDraftWithLine(csrfToken: string): Promise<{ id: string }> {
  const customer = await createCustomer();
  const taxRate = await defaultTaxRate();
  const createResponse = await invoicesPost(
    jsonRequest("/api/invoices", draftPayload(customer.id), { csrfToken })
  );
  const created = (await createResponse.json()) as { id: string };

  await invoiceLinePost(
    jsonRequest(
      `/api/invoices/${created.id}/lines`,
      {
        description: "Servicio mensual",
        quantity: "1.000",
        unitPrice: "100.00",
        discountPercent: "0.00",
        discountAmount: "0.00",
        taxRateId: taxRate.id
      },
      { csrfToken }
    ),
    routeContext({ invoiceId: created.id })
  );

  return created;
}

async function createIssuedInvoice(csrfToken: string): Promise<{ id: string }> {
  const created = await createDraftWithLine(csrfToken);
  await invoiceIssuePost(
    jsonRequest(
      `/api/invoices/${created.id}/issue`,
      { issueDate: "2026-07-07" },
      { csrfToken }
    ),
    routeContext({ invoiceId: created.id })
  );

  return created;
}

async function enableMaintenance(): Promise<{ id: string }> {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { normalizedUserName: "admin" },
    select: { id: true }
  });
  const backup = await prisma.backupOperation.create({
    data: {
      status: "VERIFIED",
      requestedById: admin.id,
      productVersion: "0.1.0",
      storageKey: "billing-maintenance.backup",
      sizeBytes: 2048n,
      sha256: "d".repeat(64),
      completedAt: new Date("2026-07-07T09:00:00.000Z")
    }
  });
  const restore = await prisma.restoreOperation.create({
    data: {
      status: "VALIDATED",
      backupOperationId: backup.id,
      requestedById: admin.id,
      reason: "Restauracion de prueba para facturacion",
      validatedAt: new Date("2026-07-07T10:00:00.000Z")
    }
  });

  await prisma.platformMaintenanceState.create({
    data: {
      singletonKey: 1,
      enabled: true,
      mode: "RESTORE",
      reason: "Ventana de mantenimiento para facturacion",
      restoreOperationId: restore.id,
      enabledById: admin.id,
      enabledAt: new Date("2026-07-07T10:30:00.000Z")
    }
  });

  return restore;
}

function maintenanceModeActiveBody() {
  return {
    code: "MAINTENANCE_MODE_ACTIVE",
    message: "La plataforma esta en modo mantenimiento."
  };
}

function draftPayload(customerId: string) {
  return {
    customerId,
    issueDate: "2026-07-07",
    operationDate: "2026-07-07",
    notes: null
  };
}

async function loginAsAdmin(): Promise<void> {
  await loginWith("admin", adminPassword);
}

async function loginWith(userName: string, password: string): Promise<void> {
  const response = await loginPost(
    new Request(`${appBaseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": uniqueTestIp()
      },
      body: JSON.stringify({ userName, password })
    })
  );

  expect(response.status).toBe(200);
  expect(cookieMock.values.has(sessionCookieName)).toBe(true);
}

async function getCsrfToken(): Promise<string> {
  const response = await csrfGet(apiRequest("/api/auth/csrf"));
  const body = (await response.json()) as { csrfToken?: string };

  expect(response.status).toBe(200);

  if (!body.csrfToken) {
    throw new Error("CSRF endpoint did not return a token.");
  }

  return body.csrfToken;
}

function uniqueTestIp(): string {
  return `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
}

function apiRequest(path: string): Request {
  return new Request(`${appBaseUrl}${path}`);
}

function jsonRequest(
  path: string,
  payload: unknown,
  options: {
    csrfToken?: string;
    idempotencyKey?: string | null;
  } = {}
): Request {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Forwarded-For": uniqueTestIp()
  });

  if (options.csrfToken) {
    headers.set("X-CSRF-Token", options.csrfToken);
  }

  if (options.idempotencyKey !== null) {
    headers.set("Idempotency-Key", options.idempotencyKey ?? randomUUID());
  }

  return new Request(`${appBaseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
}

function routeContext<TParams extends Record<string, string>>(params: TParams) {
  return {
    params: Promise.resolve(params)
  };
}

async function initializeForRoutes(): Promise<void> {
  const rawBody = JSON.stringify(baseCommand);
  const result = await initializePlatform(
    baseCommand,
    randomUUID(),
    hashRequestBody(rawBody)
  );

  if (!result.ok) {
    throw new Error(result.error.code);
  }
  const installation = await prisma.installation.findFirstOrThrow({ select: { companyId: true } });
  const admin = await prisma.user.findFirstOrThrow({ where: { normalizedUserName: "admin" }, select: { id: true } });
  const fiscalYear = await prisma.accountingFiscalYear.create({
    data: { companyId: installation.companyId!, year: 2026, startDate: new Date("2026-01-01T00:00:00.000Z"), endDate: new Date("2026-12-31T00:00:00.000Z"), planCode: "PGC_PYMES", planVersion: "2007", createdById: admin.id }
  });
  await prisma.accountingAccount.createMany({ data: [
    { fiscalYearId: fiscalYear.id, code: "700000000", name: "Ventas de mercaderias", type: "INCOME", level: 4, isPostable: true, createdById: admin.id },
    { fiscalYearId: fiscalYear.id, code: "705000000", name: "Prestaciones de servicios", type: "INCOME", level: 4, isPostable: true, createdById: admin.id },
    { fiscalYearId: fiscalYear.id, code: "477000000", name: "Hacienda Publica, IVA repercutido", type: "LIABILITY", level: 4, isPostable: true, createdById: admin.id }
    ,{ fiscalYearId: fiscalYear.id, code: "570000000", name: "Caja", type: "ASSET", level: 4, isPostable: true, createdById: admin.id }
    ,{ fiscalYearId: fiscalYear.id, code: "572000000", name: "Bancos", type: "ASSET", level: 4, isPostable: true, createdById: admin.id }
  ] });
}

async function resetPlatformTables(): Promise<void> {
  await assertDisposableTestDatabase();
  await prisma.$executeRaw`TRUNCATE TABLE "verifactu_worker_runs", "verifactu_submission_attempts", "verifactu_outbox_messages", "verifactu_fiscal_records", "verifactu_sif_installations", "verifactu_mtls_credential_versions", "verifactu_mtls_credentials" CASCADE`;
  await prisma.$transaction([
    prisma.invoiceVerifactuRecord.deleteMany(),
    prisma.customerRemittanceLine.deleteMany(),
    prisma.accountingJournalLine.deleteMany(),
    prisma.accountingJournalEntry.deleteMany(),

    prisma.customerPaymentReturn.deleteMany(),
    prisma.customerPayment.deleteMany(),
    prisma.invoiceDueDate.deleteMany(),
    prisma.invoiceTaxSummary.deleteMany(),
    prisma.invoiceLine.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.invoiceNumberSequence.deleteMany(),
    prisma.platformMaintenanceState.deleteMany(),
    prisma.restoreOperation.deleteMany(),
    prisma.backupOperation.deleteMany(),
    prisma.idempotencyRecord.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.installation.deleteMany(),
    prisma.reservedUserName.deleteMany(),
    prisma.session.deleteMany(),
    prisma.rateLimitBucket.deleteMany(),
    prisma.loginAttempt.deleteMany(),
    prisma.customerAddress.deleteMany(),
    prisma.customerSepaMandate.deleteMany(),
    prisma.customerStore.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.catalogStockMovement.deleteMany(),
    prisma.catalogItem.deleteMany(),
    prisma.catalogCategory.deleteMany(),
    prisma.catalogTaxRate.deleteMany(),
    prisma.accountingAccount.deleteMany(),
    prisma.accountingFiscalYear.deleteMany(),
    prisma.customerRemittance.deleteMany(),

    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}

async function attachVerifactuQr(invoiceId: string, qrUrl: string): Promise<void> {
  const installation = await prisma.installation.findUniqueOrThrow({
    where: { singletonKey: 1 },
    select: { companyId: true }
  });
  if (!installation.companyId) throw new Error("COMPANY_NOT_AVAILABLE");
  const sif = await prisma.verifactuSifInstallation.create({
    data: {
      companyId: installation.companyId,
      installationCode: "PDF-TEST-SIF",
      environment: "TEST",
      contractVersion: "VF_V1",
      schemaVersion: "tikeV1.0",
      artifactManifestVersion: "AEAT_VERIFACTU_ARTIFACTS_V1",
      artifactManifestSha256: "a".repeat(64),
      producerTaxId: "B12345678",
      producerName: "CriGestion Test SL",
      systemName: "CriGestion",
      systemId: "CG",
      systemVersion: "0.1.0",
      installationNumber: "PDF-TEST-1",
      activatedAt: new Date("2026-07-07T09:00:00.000Z")
    }
  });
  await prisma.verifactuFiscalRecord.create({
    data: {
      companyId: installation.companyId,
      sifInstallationId: sif.id,
      invoiceId,
      recordType: "ALTA",
      chainPosition: 1n,
      issuerTaxId: "B12345678",
      issuerName: "CriGestion Test SL",
      invoiceSeries: "F",
      invoiceNumber: "F2600001",
      invoiceIssueDate: new Date("2026-07-07T00:00:00.000Z"),
      generatedAt: new Date("2026-07-07T09:00:00.000Z"),
      contractVersion: "VF_V1",
      schemaVersion: "tikeV1.0",
      canonicalizationVersion: "AEAT_HASH_0.1.2",
      recordHash: "A".repeat(64),
      fiscalSnapshot: { recordType: "ALTA", fixture: "PDF_QR" },
      payloadCiphertext: Buffer.from("encrypted-pdf-fixture"),
      encryptionKeyId: "pdf-test-key",
      payloadSha256: "b".repeat(64),
      qrUrl,
      preparationKey: `pdf-qr:${randomUUID()}`
    }
  });
  await prisma.invoice.update({ where: { id: invoiceId }, data: { verifactuStatus: "ACCEPTED" } });
}
