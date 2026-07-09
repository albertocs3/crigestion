import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { POST as customersPost } from "@/app/api/customers/route";
import {
  GET as addressesGet,
  POST as addressesPost
} from "@/app/api/customers/[customerId]/addresses/route";
import { PATCH as addressPatch } from "@/app/api/customers/[customerId]/addresses/[addressId]/route";
import { prisma } from "@/lib/prisma";
import { sessionCookieName } from "@/modules/platform/application/auth";
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

describe("customer addresses HTTP contracts", () => {
  beforeEach(async () => {
    process.env.APP_BASE_URL = appBaseUrl;
    process.env.AUTH_COOKIE_SECURE = "false";
    cookieMock.reset();
    await resetPlatformTables();
    await resetCustomerCodeSequence();
    await initializeForRoutes();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("requires authentication for listing addresses", async () => {
    const response = await addressesGet(apiRequest("/api/customers/not-a-uuid/addresses"), {
      params: Promise.resolve({ customerId: "not-a-uuid" })
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.code).toBe("UNAUTHENTICATED");
  });

  it("requires CSRF before creating addresses", async () => {
    await loginAsAdmin();
    const customer = await createCustomerThroughHttp(await getCsrfToken());

    const response = await addressesPost(
      jsonRequest(`/api/customers/${customer.id}/addresses`, addressPayload()),
      { params: Promise.resolve({ customerId: customer.id }) }
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.code).toBe("CSRF_TOKEN_INVALID");
  });

  it("requires an idempotency key before creating addresses", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const customer = await createCustomerThroughHttp(csrfToken);

    const response = await addressesPost(
      jsonRequest(`/api/customers/${customer.id}/addresses`, addressPayload(), {
        csrfToken,
        idempotencyKey: null
      }),
      { params: Promise.resolve({ customerId: customer.id }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
  });

  it("creates, lists, updates and deactivates customer addresses", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const customer = await createCustomerThroughHttp(csrfToken);

    const createResponse = await addressesPost(
      jsonRequest(`/api/customers/${customer.id}/addresses`, addressPayload(), {
        csrfToken
      }),
      { params: Promise.resolve({ customerId: customer.id }) }
    );
    const created = await createResponse.json();
    const listResponse = await addressesGet(
      apiRequest(`/api/customers/${customer.id}/addresses?type=SHIPPING`),
      { params: Promise.resolve({ customerId: customer.id }) }
    );
    const listBody = await listResponse.json();
    const updateResponse = await addressPatch(
      jsonRequest(
        `/api/customers/${customer.id}/addresses/${created.id}`,
        {
          action: "update",
          address: addressPayload({
            label: "Facturacion central",
            type: "BILLING",
            city: "Barcelona"
          })
        },
        { csrfToken, method: "PATCH" }
      ),
      { params: Promise.resolve({ customerId: customer.id, addressId: created.id }) }
    );
    const updated = await updateResponse.json();
    const deactivateResponse = await addressPatch(
      jsonRequest(
        `/api/customers/${customer.id}/addresses/${created.id}`,
        { action: "deactivate" },
        { csrfToken, method: "PATCH" }
      ),
      { params: Promise.resolve({ customerId: customer.id, addressId: created.id }) }
    );
    const deactivated = await deactivateResponse.json();

    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({
      label: "Almacen principal",
      type: "SHIPPING",
      status: "ACTIVE",
      isPrimary: true,
      address: {
        line: "Calle Envio 1",
        city: "Madrid"
      }
    });
    expect(listResponse.status).toBe(200);
    expect(listBody.addresses).toHaveLength(1);
    expect(JSON.stringify(listBody)).not.toContain("notes");
    expect(updateResponse.status).toBe(200);
    expect(updated).toMatchObject({
      label: "Facturacion central",
      type: "BILLING",
      address: {
        city: "Barcelona"
      }
    });
    expect(deactivateResponse.status).toBe(200);
    expect(deactivated).toMatchObject({
      status: "INACTIVE",
      isPrimary: false
    });
  });

  it("requires an idempotency key before updating addresses", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const customer = await createCustomerThroughHttp(csrfToken);
    const createResponse = await addressesPost(
      jsonRequest(`/api/customers/${customer.id}/addresses`, addressPayload(), {
        csrfToken
      }),
      { params: Promise.resolve({ customerId: customer.id }) }
    );
    const created = await createResponse.json();

    const response = await addressPatch(
      jsonRequest(
        `/api/customers/${customer.id}/addresses/${created.id}`,
        { action: "deactivate" },
        { csrfToken, idempotencyKey: null, method: "PATCH" }
      ),
      { params: Promise.resolve({ customerId: customer.id, addressId: created.id }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
  });
});

async function loginAsAdmin(): Promise<void> {
  const response = await loginPost(
    jsonRequest("/api/auth/login", {
      userName: "admin",
      password: adminPassword
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

async function createCustomerThroughHttp(csrfToken: string): Promise<{ id: string }> {
  const response = await customersPost(
    jsonRequest("/api/customers", customerPayload(), { csrfToken })
  );
  const body = await response.json();

  expect(response.status).toBe(201);

  return body as { id: string };
}

function customerPayload() {
  return {
    type: "COMPANY",
    legalName: "Cliente Demo SL",
    tradeName: "Cliente Demo",
    taxId: "B12345674",
    fiscalTreatment: "DOMESTIC",
    email: "cliente@example.test",
    phone: "+34910000000",
    fiscalAddressLine: "Calle Mayor 1",
    fiscalPostalCode: "28001",
    fiscalCity: "Madrid",
    fiscalProvince: "Madrid",
    fiscalCountry: "ES",
    defaultPaymentMethod: "BANK_TRANSFER",
    paymentTermsType: "IMMEDIATE",
    paymentDays: null,
    paymentFixedDay: null,
    creditLimit: null,
    bankIban: "ES91 2100 0418 4502 0005 1332",
    sepaMandate: {
      reference: "SEPA-CLIENTE-1",
      signedAt: "2026-07-01"
    },
    notes: "Observacion interna"
  };
}

function addressPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "SHIPPING",
    label: "Almacen principal",
    isPrimary: true,
    addressLine: "Calle Envio 1",
    postalCode: "28001",
    city: "Madrid",
    province: "Madrid",
    country: "ES",
    contactName: "Contacto Envio",
    phone: "+34910000010",
    email: "contacto@example.test",
    notes: "Observacion interna",
    ...overrides
  };
}

function jsonRequest(
  path: string,
  payload: unknown,
  options: {
    origin?: string;
    csrfToken?: string;
    idempotencyKey?: string | null;
    method?: string;
  } = {}
): Request {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Forwarded-For": uniqueTestIp()
  });

  if (options.origin) {
    headers.set("Origin", options.origin);
  }

  if (options.csrfToken) {
    headers.set("X-CSRF-Token", options.csrfToken);
  }

  if (options.idempotencyKey !== null) {
    headers.set("Idempotency-Key", options.idempotencyKey ?? randomUUID());
  }

  return new Request(`http://localhost${path}`, {
    method: options.method ?? "POST",
    headers,
    body: JSON.stringify(payload)
  });
}

function apiRequest(path: string): Request {
  return new Request(`http://localhost${path}`);
}

function uniqueTestIp(): string {
  return `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
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
    prisma.platformMaintenanceState.deleteMany(),
    prisma.idempotencyRecord.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.installation.deleteMany(),
    prisma.reservedUserName.deleteMany(),
    prisma.session.deleteMany(),
    prisma.rateLimitBucket.deleteMany(),
    prisma.loginAttempt.deleteMany(),
    prisma.restoreOperation.deleteMany(),
    prisma.backupOperation.deleteMany(),
    prisma.invoiceVerifactuRecord.deleteMany(),
    prisma.customerRemittanceLine.deleteMany(),

    prisma.customerPaymentReturn.deleteMany(),
    prisma.customerPayment.deleteMany(),
    prisma.invoiceDueDate.deleteMany(),
    prisma.invoiceTaxSummary.deleteMany(),
    prisma.invoiceLine.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.customerAddress.deleteMany(),
    prisma.customerSepaMandate.deleteMany(),
    prisma.customerStore.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.catalogItem.deleteMany(),

    prisma.accountingJournalLine.deleteMany(),
    prisma.accountingJournalEntry.deleteMany(),
    prisma.accountingAccount.deleteMany(),
    prisma.customerRemittance.deleteMany(),

    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}

async function resetCustomerCodeSequence(): Promise<void> {
  await prisma.$executeRaw`ALTER SEQUENCE customer_code_seq RESTART WITH 1`;
}
