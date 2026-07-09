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
import { GET as invoicePdfGet } from "@/app/api/invoices/[invoiceId]/pdf/route";
import { GET as customerDueDatesGet } from "@/app/api/treasury/customer-due-dates/route";
import { GET as customerDueDatesExportGet } from "@/app/api/treasury/customer-due-dates/export/route";
import { prisma } from "@/lib/prisma";
import { sessionCookieName } from "@/modules/platform/application/auth";
import { hashPassword } from "@/modules/platform/application/passwords";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";

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

    const returnResponse = await invoicePaymentReturnPost(
      jsonRequest(
        `/api/invoices/${issued.id}/payment-returns`,
        {
          paymentId,
          returnDate: "2026-07-12",
          amount: "21.00",
          reasonCode: "BANK_RETURN",
          notes: "No auditar devolucion completa"
        },
        { csrfToken }
      ),
      routeContext({ invoiceId: issued.id })
    );
    const body = await returnResponse.json();
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_PAYMENT_RETURNED" },
      orderBy: { createdAt: "asc" }
    });

    expect(returnResponse.status).toBe(201);
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
    expect(csv).toContain('"121.00","100.00","21.00","21.00"');
    expect(auditEvent.payload).toMatchObject({
      scope: "OPEN",
      limit: 25,
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

  return prisma.customer.create({
    data: {
      code: `C-${randomUUID().slice(0, 8)}`,
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
}

async function resetPlatformTables(): Promise<void> {
  await prisma.$transaction([
    prisma.invoiceVerifactuRecord.deleteMany(),
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
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
