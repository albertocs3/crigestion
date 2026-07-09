import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { PATCH as billingPatch } from "@/app/api/platform/configuration/billing/route";
import { PATCH as companyPatch } from "@/app/api/platform/configuration/company/route";
import { GET as configurationGet } from "@/app/api/platform/configuration/route";
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

const adminPassword = "Cambiar-esta-clave-2026";
const limitedPassword = "Cambiar-gestion-2026";
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

describe("configuration HTTP contracts", () => {
  beforeEach(async () => {
    process.env.APP_BASE_URL = "http://localhost:3000";
    process.env.AUTH_COOKIE_SECURE = "false";
    cookieMock.reset();
    await resetPlatformTables();
    await initializeForRoutes();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("rejects unauthenticated configuration reads", async () => {
    const response = await configurationGet(apiRequest("/api/platform/configuration"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      code: "UNAUTHENTICATED",
      message: "No hay una sesion activa."
    });
  });

  it("rejects users without Platform.ManageConfiguration", async () => {
    await createLimitedUserWithoutConfigurationPermission();
    await loginWith("gestion", limitedPassword);

    const response = await configurationGet(apiRequest("/api/platform/configuration"));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "FORBIDDEN",
      message: "No tienes permiso para realizar esta accion."
    });
  });

  it("returns configuration DTOs for authorized administrators", async () => {
    await loginWith("admin", adminPassword);

    const response = await configurationGet(apiRequest("/api/platform/configuration"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      company: {
        legalName: "CriGestion Test SL",
        taxId: "B12345678",
        email: "admin@example.test"
      },
      installation: {
        status: "INITIALIZED",
        productVersion: "0.1.0"
      }
    });
    expect(JSON.stringify(body)).not.toContain("passwordHash");
  });

  it("requires CSRF before updating company configuration", async () => {
    await loginWith("admin", adminPassword);

    const response = await companyPatch(
      jsonRequest("/api/platform/configuration/company", updatePayload())
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "CSRF_TOKEN_INVALID",
      message: "Token CSRF invalido."
    });
  });

  it("requires an idempotency key before updating company configuration", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();

    const response = await companyPatch(
      jsonRequest("/api/platform/configuration/company", updatePayload(), {
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

  it("updates company configuration and does not audit submitted values", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();

    const response = await companyPatch(
      jsonRequest("/api/platform/configuration/company", updatePayload(), { csrfToken })
    );
    const body = await response.json();
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "COMPANY_CONFIGURATION_UPDATED" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(response.status).toBe(200);
    expect(body).toMatchObject(updatePayload());
    expect(auditEvent.payload).toMatchObject({
      changedFields: ["legalName", "taxId", "email"]
    });
    expect(auditPayload).not.toContain(updatePayload().legalName);
    expect(auditPayload).not.toContain(updatePayload().taxId);
    expect(auditPayload).not.toContain(updatePayload().email);
  });

  it("rejects company tax id changes after issued invoices exist", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();
    await createIssuedInvoice();

    const response = await companyPatch(
      jsonRequest("/api/platform/configuration/company", updatePayload(), { csrfToken })
    );
    const body = await response.json();
    const company = await prisma.company.findUniqueOrThrow({
      where: { taxId: baseCommand.company.taxId }
    });

    expect(response.status).toBe(409);
    expect(body).toEqual({
      code: "COMPANY_TAX_ID_LOCKED_BY_ISSUED_INVOICES",
      message: "El NIF de la empresa no puede cambiarse cuando existen facturas emitidas."
    });
    expect(company.taxId).toBe(baseCommand.company.taxId);
  });

  it("validates malformed update payloads", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();

    const response = await companyPatch(
      jsonRequest(
        "/api/platform/configuration/company",
        { ...updatePayload(), email: "not-email" },
        { csrfToken }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("requires an idempotency key before updating billing configuration", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();

    const response = await billingPatch(
      jsonRequest("/api/platform/configuration/billing", billingPayload(), {
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

  it("updates billing configuration and audits only changed field names", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();

    const response = await billingPatch(
      jsonRequest("/api/platform/configuration/billing", billingPayload(), { csrfToken })
    );
    const body = await response.json();
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "BILLING_CONFIGURATION_UPDATED" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(response.status).toBe(200);
    expect(body).toMatchObject(billingPayload());
    expect(auditEvent.payload).toMatchObject({
      changedFields: ["invoiceLegalFooter", "invoiceAccentColor"]
    });
    expect(auditPayload).not.toContain(billingPayload().invoiceLegalFooter);
    expect(auditPayload).not.toContain(billingPayload().invoiceAccentColor);
  });
});

function updatePayload() {
  return {
    legalName: "CriGestion Actualizada SL",
    taxId: "B87654321",
    email: "contabilidad@example.test"
  };
}

function billingPayload() {
  return {
    invoiceLegalFooter: "Texto legal visible solo en factura.",
    invoiceAccentColor: "#123abc"
  };
}

async function createLimitedUserWithoutConfigurationPermission(): Promise<void> {
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
      displayName: "Usuario Gestion",
      userName: "gestion",
      normalizedUserName: "gestion",
      passwordHash: hashPassword(limitedPassword),
      status: "ACTIVE",
      roleId: role.id
    }
  });
}

async function loginWith(userName: string, password: string): Promise<void> {
  const response = await loginPost(
    jsonRequest("/api/auth/login", { userName, password }, { method: "POST" })
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

function jsonRequest(
  path: string,
  payload: unknown,
  options: {
    csrfToken?: string;
    idempotencyKey?: string | null;
    method?: "POST" | "PATCH";
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

  return new Request(`http://localhost${path}`, {
    method: options.method ?? "PATCH",
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

async function createIssuedInvoice(): Promise<void> {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { normalizedUserName: "admin" },
    select: { id: true }
  });
  const customer = await prisma.customer.create({
    data: {
      code: "C-FISCAL",
      type: "COMPANY",
      legalName: "Cliente Fiscal SL",
      taxId: "B12345674",
      normalizedTaxId: "B12345674",
      fiscalTreatment: "DOMESTIC",
      fiscalAddressLine: "Calle Fiscal 1",
      fiscalPostalCode: "28001",
      fiscalCity: "Madrid",
      fiscalProvince: "Madrid",
      fiscalCountry: "ES",
      createdById: admin.id
    }
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
    prisma.invoiceVerifactuRecord.deleteMany(),
    prisma.customerPaymentReturn.deleteMany(),
    prisma.customerPayment.deleteMany(),
    prisma.invoiceDueDate.deleteMany(),
    prisma.invoiceTaxSummary.deleteMany(),
    prisma.invoiceLine.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.invoiceNumberSequence.deleteMany(),
    prisma.platformMaintenanceState.deleteMany(),
    prisma.billingConfiguration.deleteMany(),
    prisma.idempotencyRecord.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.installation.deleteMany(),
    prisma.reservedUserName.deleteMany(),
    prisma.session.deleteMany(),
    prisma.rateLimitBucket.deleteMany(),
    prisma.loginAttempt.deleteMany(),
    prisma.restoreOperation.deleteMany(),
    prisma.backupOperation.deleteMany(),
    prisma.customerAddress.deleteMany(),

    prisma.customerStore.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.catalogItem.deleteMany(),

    prisma.accountingJournalLine.deleteMany(),
    prisma.accountingJournalEntry.deleteMany(),
    prisma.accountingAccount.deleteMany(),
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
