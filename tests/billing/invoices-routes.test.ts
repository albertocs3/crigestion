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
import { GET as invoicePdfGet } from "@/app/api/invoices/[invoiceId]/pdf/route";
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

async function createIssuedInvoice(csrfToken: string): Promise<{ id: string }> {
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
