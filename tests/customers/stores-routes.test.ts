import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { POST as customersPost } from "@/app/api/customers/route";
import {
  GET as storesGet,
  POST as storesPost
} from "@/app/api/customers/[customerId]/stores/route";
import { PATCH as storePatch } from "@/app/api/customers/[customerId]/stores/[storeId]/route";
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

describe("customer stores HTTP contracts", () => {
  beforeEach(async () => {
    process.env.APP_BASE_URL = appBaseUrl;
    process.env.AUTH_COOKIE_SECURE = "false";
    cookieMock.reset();
    await resetPlatformTables();
    await resetSequences();
    await initializeForRoutes();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("rejects unauthenticated store listing", async () => {
    const response = await storesGet(apiRequest("/api/customers/not-a-uuid/stores"), {
      params: Promise.resolve({ customerId: "not-a-uuid" })
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      code: "UNAUTHENTICATED",
      message: "No hay una sesion activa."
    });
  });

  it("creates, lists, updates and deactivates stores", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const customer = await createCustomerThroughHttp(csrfToken);

    const createResponse = await storesPost(
      jsonRequest(`/api/customers/${customer.id}/stores`, storePayload(), { csrfToken }),
      { params: Promise.resolve({ customerId: customer.id }) }
    );
    const created = await createResponse.json();
    const listResponse = await storesGet(
      apiRequest(`/api/customers/${customer.id}/stores`),
      { params: Promise.resolve({ customerId: customer.id }) }
    );
    const listBody = await listResponse.json();
    const updateResponse = await storePatch(
      jsonRequest(
        `/api/customers/${customer.id}/stores/${created.id}`,
        {
          action: "update",
          store: storePayload({
            name: "Tienda Actualizada",
            isPrimary: false,
            email: "actualizada@example.test"
          })
        },
        { csrfToken, method: "PATCH" }
      ),
      { params: Promise.resolve({ customerId: customer.id, storeId: created.id }) }
    );
    const updated = await updateResponse.json();
    const statusResponse = await storePatch(
      jsonRequest(
        `/api/customers/${customer.id}/stores/${created.id}`,
        { action: "deactivate" },
        { csrfToken, method: "PATCH" }
      ),
      { params: Promise.resolve({ customerId: customer.id, storeId: created.id }) }
    );
    const deactivated = await statusResponse.json();

    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({
      code: "1",
      name: "Tienda Centro",
      status: "ACTIVE"
    });
    expect(listResponse.status).toBe(200);
    expect(listBody.stores).toHaveLength(1);
    expect(JSON.stringify(listBody)).not.toContain("notes");
    expect(updateResponse.status).toBe(200);
    expect(updated).toMatchObject({
      id: created.id,
      name: "Tienda Actualizada",
      email: "actualizada@example.test"
    });
    expect(statusResponse.status).toBe(200);
    expect(deactivated.status).toBe("INACTIVE");
  });

  it("requires CSRF before creating stores", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const customer = await createCustomerThroughHttp(csrfToken);

    const response = await storesPost(
      jsonRequest(`/api/customers/${customer.id}/stores`, storePayload()),
      { params: Promise.resolve({ customerId: customer.id }) }
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "CSRF_TOKEN_INVALID",
      message: "Token CSRF invalido."
    });
  });

  it("rejects users without customer permissions on store endpoints", async () => {
    await loginAsAdmin();
    const adminCsrfToken = await getCsrfToken();
    const customer = await createCustomerThroughHttp(adminCsrfToken);

    cookieMock.reset();
    await createLimitedUserWithoutCustomers();
    await loginWith("auditor", limitedPassword);
    const limitedCsrfToken = await getCsrfToken();

    const listResponse = await storesGet(
      apiRequest(`/api/customers/${customer.id}/stores`),
      { params: Promise.resolve({ customerId: customer.id }) }
    );
    const listBody = await listResponse.json();
    const createResponse = await storesPost(
      jsonRequest(`/api/customers/${customer.id}/stores`, storePayload(), {
        csrfToken: limitedCsrfToken
      }),
      { params: Promise.resolve({ customerId: customer.id }) }
    );
    const createBody = await createResponse.json();

    expect(listResponse.status).toBe(403);
    expect(listBody).toEqual({
      code: "FORBIDDEN",
      message: "No tienes permiso para realizar esta accion."
    });
    expect(createResponse.status).toBe(403);
    expect(createBody).toEqual({
      code: "FORBIDDEN",
      message: "No tienes permiso para realizar esta accion."
    });
  });

  it("rejects unknown fields in store status PATCH payloads", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const customer = await createCustomerThroughHttp(csrfToken);
    const createResponse = await storesPost(
      jsonRequest(`/api/customers/${customer.id}/stores`, storePayload(), { csrfToken }),
      { params: Promise.resolve({ customerId: customer.id }) }
    );
    const created = await createResponse.json();

    const response = await storePatch(
      jsonRequest(
        `/api/customers/${customer.id}/stores/${created.id}`,
        {
          action: "deactivate",
          store: storePayload()
        },
        { csrfToken, method: "PATCH" }
      ),
      { params: Promise.resolve({ customerId: customer.id, storeId: created.id }) }
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe("VALIDATION_ERROR");
  });
});

async function loginAsAdmin(): Promise<void> {
  await loginWith("admin", adminPassword);
}

async function loginWith(userName: string, password: string): Promise<void> {
  const response = await loginPost(
    jsonRequest("/api/auth/login", {
      userName,
      password
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
  const body = (await response.json()) as { id?: string };

  expect(response.status).toBe(201);

  if (!body.id) {
    throw new Error("Customer creation did not return an id.");
  }

  return { id: body.id };
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
    notes: "Observacion interna"
  };
}

function storePayload(overrides: Record<string, unknown> = {}) {
  return {
    name: "Tienda Centro",
    isPrimary: true,
    addressLine: "Calle Tienda 1",
    postalCode: "28001",
    city: "Madrid",
    province: "Madrid",
    country: "ES",
    email: "tienda@example.test",
    phone: "+34910000001",
    whatsapp: "+34910000002",
    contactName: "Contacto Tienda",
    contactRole: "Gerencia",
    contactPhone: "+34910000003",
    contactMobile: "+34600000001",
    contactWhatsapp: "+34600000002",
    contactEmail: "contacto@example.test",
    notes: "Observacion tienda",
    ...overrides
  };
}

function jsonRequest(
  path: string,
  payload: unknown,
  options: {
    origin?: string;
    csrfToken?: string;
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

async function createLimitedUserWithoutCustomers(): Promise<void> {
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
    prisma.invoiceVerifactuRecord.deleteMany(),
    prisma.invoiceDueDate.deleteMany(),
    prisma.invoiceTaxSummary.deleteMany(),
    prisma.invoiceLine.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.customerSepaMandate.deleteMany(),
    prisma.customerAddress.deleteMany(),

    prisma.customerStore.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.catalogItem.deleteMany(),

    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}

async function resetSequences(): Promise<void> {
  await prisma.$executeRaw`ALTER SEQUENCE customer_code_seq RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE customer_store_code_seq RESTART WITH 1`;
}
