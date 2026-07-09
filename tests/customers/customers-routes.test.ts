import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import {
  GET as customersGet,
  POST as customersPost
} from "@/app/api/customers/route";
import { PATCH as customerPatch } from "@/app/api/customers/[customerId]/route";
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

describe("customers HTTP contracts", () => {
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

  it("rejects unauthenticated customer listing", async () => {
    const response = await customersGet(apiRequest("/api/customers"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      code: "UNAUTHENTICATED",
      message: "No hay una sesion activa."
    });
  });

  it("requires CSRF before creating customers", async () => {
    await loginAsAdmin();

    const response = await customersPost(
      jsonRequest("/api/customers", createCustomerPayload())
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "CSRF_TOKEN_INVALID",
      message: "Token CSRF invalido."
    });
  });

  it("requires an idempotency key before creating customers", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();

    const response = await customersPost(
      jsonRequest("/api/customers", createCustomerPayload(), {
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

  it("rejects users without customer permissions", async () => {
    await createLimitedUserWithoutCustomers();
    await loginWith("auditor", limitedPassword);
    const csrfToken = await getCsrfToken();

    const listResponse = await customersGet(apiRequest("/api/customers"));
    const listBody = await listResponse.json();
    const createResponse = await customersPost(
      jsonRequest("/api/customers", createCustomerPayload(), { csrfToken })
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

  it("creates, lists and deactivates customers as DTOs", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();

    const createResponse = await customersPost(
      jsonRequest("/api/customers", createCustomerPayload(), { csrfToken })
    );
    const created = await createResponse.json();
    const listResponse = await customersGet(apiRequest("/api/customers?search=demo"));
    const listBody = await listResponse.json();
    const patchResponse = await customerPatch(
      jsonRequest(
        `/api/customers/${created.id}`,
        { action: "deactivate" },
        { csrfToken, method: "PATCH" }
      ),
      { params: Promise.resolve({ customerId: created.id }) }
    );
    const patched = await patchResponse.json();

    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({
      code: "1",
      legalName: "Cliente Demo SL",
      status: "ACTIVE",
      bankAccount: {
        iban: "ES9121000418450200051332",
        sepaMandate: {
          reference: "SEPA-CLIENTE-1",
          status: "ACTIVE",
          signedAt: "2026-07-01",
          revokedAt: null
        }
      }
    });
    expect(listResponse.status).toBe(200);
    expect(listBody.customers).toHaveLength(1);
    expect(JSON.stringify(listBody)).not.toContain("notes");
    expect(patchResponse.status).toBe(200);
    expect(patched.status).toBe("INACTIVE");
  });

  it("returns field details for invalid customer creation payloads", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();

    const response = await customersPost(
      jsonRequest(
        "/api/customers",
        createCustomerPayload({ taxId: "123" }),
        { csrfToken }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "taxId: El NIF, NIE o CIF no es valido.",
      issues: {
        fieldErrors: {
          taxId: ["El NIF, NIE o CIF no es valido."]
        }
      }
    });
  });

  it("updates customer data through PATCH", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const createResponse = await customersPost(
      jsonRequest("/api/customers", createCustomerPayload(), { csrfToken })
    );
    const created = await createResponse.json();

    const response = await customerPatch(
      jsonRequest(
        `/api/customers/${created.id}`,
        {
          action: "update",
          customer: {
            type: "SELF_EMPLOYED",
            legalName: "Cliente Actualizado SL",
            tradeName: null,
            taxId: "B11111119",
            fiscalTreatment: "EU",
            email: "nuevo@example.test",
            phone: null,
            fiscalAddressLine: "Avenida Nueva 2",
            fiscalPostalCode: "08001",
            fiscalCity: "Barcelona",
            fiscalProvince: "Barcelona",
            fiscalCountry: "ES",
            defaultPaymentMethod: "DIRECT_DEBIT",
            paymentTermsType: "FIXED_DAY_OF_MONTH",
            paymentDays: null,
            paymentFixedDay: 15,
            creditLimit: "2500.00",
            bankIban: "ES79 2100 0813 6101 2345 6789",
            sepaMandate: {
              reference: "SEPA-CLIENTE-2",
              signedAt: "2026-07-02"
            }
          }
        },
        { csrfToken, method: "PATCH" }
      ),
      { params: Promise.resolve({ customerId: created.id }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      id: created.id,
      type: "SELF_EMPLOYED",
      legalName: "Cliente Actualizado SL",
      tradeName: null,
      taxId: "B11111119",
      fiscalTreatment: "EU",
      email: "nuevo@example.test",
      phone: null,
      fiscalAddress: {
        line: "Avenida Nueva 2",
        postalCode: "08001",
        city: "Barcelona",
        province: "Barcelona",
        country: "ES"
      },
      commercialTerms: {
        defaultPaymentMethod: "DIRECT_DEBIT",
        paymentTermsType: "FIXED_DAY_OF_MONTH",
        paymentDays: null,
        paymentFixedDay: 15,
        creditLimit: "2500.00"
      },
      bankAccount: {
        iban: "ES7921000813610123456789",
        sepaMandate: {
          reference: "SEPA-CLIENTE-2",
          status: "ACTIVE",
          signedAt: "2026-07-02",
          revokedAt: null
        }
      }
    });
  });

  it("rejects customer tax id changes after issued invoices exist", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const createResponse = await customersPost(
      jsonRequest("/api/customers", createCustomerPayload(), { csrfToken })
    );
    const created = await createResponse.json();
    await createIssuedInvoiceForCustomer(created.id);

    const response = await customerPatch(
      jsonRequest(
        `/api/customers/${created.id}`,
        {
          action: "update",
          customer: updateCustomerPayload({ taxId: "B11111119" })
        },
        { csrfToken, method: "PATCH" }
      ),
      { params: Promise.resolve({ customerId: created.id }) }
    );
    const body = await response.json();
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: created.id },
      select: { taxId: true, normalizedTaxId: true }
    });

    expect(response.status).toBe(409);
    expect(body).toEqual({
      code: "CUSTOMER_TAX_ID_LOCKED_BY_ISSUED_INVOICES",
      message: "El NIF del cliente no puede cambiarse cuando existen facturas emitidas."
    });
    expect(customer).toEqual({
      taxId: "B12345674",
      normalizedTaxId: "B12345674"
    });
  });

  it("requires an idempotency key before updating customers", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const createResponse = await customersPost(
      jsonRequest("/api/customers", createCustomerPayload(), { csrfToken })
    );
    const created = await createResponse.json();

    const response = await customerPatch(
      jsonRequest(
        `/api/customers/${created.id}`,
        { action: "deactivate" },
        { csrfToken, idempotencyKey: null, method: "PATCH" }
      ),
      { params: Promise.resolve({ customerId: created.id }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
  });

  it("rejects duplicate fiscal identifiers with a stable conflict", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();

    await customersPost(
      jsonRequest("/api/customers", createCustomerPayload({ taxId: "B-12345674" }), {
        csrfToken
      })
    );
    const response = await customersPost(
      jsonRequest("/api/customers", createCustomerPayload({ taxId: "B 12345674" }), {
        csrfToken
      })
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      code: "CUSTOMER_TAX_ID_ALREADY_USED",
      message: "El identificador fiscal ya esta asignado a otro cliente."
    });
  });

  it("rejects invalid customer PATCH route params", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();

    const response = await customerPatch(
      jsonRequest(
        "/api/customers/not-a-uuid",
        { action: "deactivate" },
        { csrfToken, method: "PATCH" }
      ),
      { params: Promise.resolve({ customerId: "not-a-uuid" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("rejects unknown fields in customer status PATCH payloads", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const createResponse = await customersPost(
      jsonRequest("/api/customers", createCustomerPayload(), { csrfToken })
    );
    const created = await createResponse.json();

    const response = await customerPatch(
      jsonRequest(
        `/api/customers/${created.id}`,
        {
          action: "deactivate",
          customer: createCustomerPayload()
        },
        { csrfToken, method: "PATCH" }
      ),
      { params: Promise.resolve({ customerId: created.id }) }
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

function createCustomerPayload(overrides: Record<string, unknown> = {}) {
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
    notes: "Observacion interna",
    ...overrides
  };
}

function updateCustomerPayload(overrides: Record<string, unknown> = {}) {
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
    bankIban: "ES9121000418450200051332",
    sepaMandate: {
      reference: "SEPA-CLIENTE-1",
      signedAt: "2026-07-01"
    },
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

async function createIssuedInvoiceForCustomer(customerId: string): Promise<void> {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { normalizedUserName: "admin" },
    select: { id: true }
  });
  const customer = await prisma.customer.findUniqueOrThrow({
    where: { id: customerId }
  });

  await prisma.invoice.create({
    data: {
      status: "ISSUED",
      verifactuStatus: "PENDING",
      series: "F",
      year: 2026,
      numberSequence: 1,
      number: "F2600001",
      customerId: customer.id,
      customerCodeSnapshot: customer.code,
      customerLegalNameSnapshot: customer.legalName,
      customerTaxIdSnapshot: customer.taxId,
      customerFiscalTreatmentSnapshot: customer.fiscalTreatment,
      customerFiscalAddressSnapshot: {
        line1: customer.fiscalAddressLine,
        postalCode: customer.fiscalPostalCode,
        city: customer.fiscalCity,
        province: customer.fiscalProvince,
        country: customer.fiscalCountry
      },
      issueDate: new Date("2026-07-07T00:00:00.000Z"),
      operationDate: new Date("2026-07-07T00:00:00.000Z"),
      issuedAt: new Date("2026-07-07T10:00:00.000Z"),
      total: "0.00",
      createdById: admin.id,
      issuedById: admin.id
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
    prisma.restoreOperation.deleteMany(),
    prisma.backupOperation.deleteMany(),
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

async function resetCustomerCodeSequence(): Promise<void> {
  await prisma.$executeRaw`ALTER SEQUENCE customer_code_seq RESTART WITH 1`;
}
