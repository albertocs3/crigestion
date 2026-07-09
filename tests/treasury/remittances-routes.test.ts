import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import {
  GET as remittancesGet,
  POST as remittancesPost
} from "@/app/api/treasury/customer-remittances/route";
import { prisma } from "@/lib/prisma";
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

describe("customer remittance HTTP contracts", () => {
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

  it("creates and lists draft remittances through treasury contracts", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const dueDate = await createIssuedDirectDebitDueDate();

    const createResponse = await remittancesPost(
      jsonRequest(
        "/api/treasury/customer-remittances",
        {
          chargeDate: "2026-07-15",
          concept: "Remesa julio",
          dueDateIds: [dueDate.id]
        },
        { csrfToken }
      )
    );
    const created = await createResponse.json();
    const listResponse = await remittancesGet(
      apiRequest("/api/treasury/customer-remittances?year=2026")
    );
    const list = await listResponse.json();

    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({
      number: "RC2026/000001",
      status: "DRAFT",
      totalAmount: "121.00"
    });
    expect(listResponse.status).toBe(200);
    expect(list.remittances).toHaveLength(1);
    expect(list.remittances[0]?.number).toBe("RC2026/000001");
  });

  it("protects remittance mutations with CSRF and idempotency", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const dueDate = await createIssuedDirectDebitDueDate();
    const missingIdempotencyResponse = await remittancesPost(
      jsonRequest(
        "/api/treasury/customer-remittances",
        {
          chargeDate: "2026-07-15",
          concept: "Remesa julio",
          dueDateIds: [dueDate.id]
        },
        { csrfToken, idempotencyKey: null }
      )
    );

    cookieMock.reset();
    const unauthenticatedResponse = await remittancesGet(
      apiRequest("/api/treasury/customer-remittances")
    );

    expect(missingIdempotencyResponse.status).toBe(400);
    expect(await missingIdempotencyResponse.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
    expect(unauthenticatedResponse.status).toBe(401);
    expect(await unauthenticatedResponse.json()).toMatchObject({
      code: "UNAUTHENTICATED"
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
}

async function getCsrfToken(): Promise<string> {
  const response = await csrfGet(apiRequest("/api/auth/csrf"));
  const body = (await response.json()) as { csrfToken: string };

  return body.csrfToken;
}

async function createIssuedDirectDebitDueDate() {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { normalizedUserName: "admin" }
  });
  const customer = await prisma.customer.create({
    data: {
      code: "C-REMIT-ROUTE",
      type: "COMPANY",
      legalName: "Cliente Remesa Route SL",
      taxId: "B12345001",
      normalizedTaxId: "B12345001",
      fiscalTreatment: "DOMESTIC",
      fiscalAddressLine: "Calle Prueba 1",
      fiscalPostalCode: "28001",
      fiscalCity: "Madrid",
      fiscalProvince: "Madrid",
      fiscalCountry: "ES",
      defaultPaymentMethod: "DIRECT_DEBIT",
      paymentTermsType: "IMMEDIATE",
      bankIban: "ES9121000418450200051332",
      createdById: admin.id,
      sepaMandates: {
        create: {
          reference: "MANDATO-ROUTE-001",
          referenceNormalized: "MANDATO-ROUTE-001",
          signedAt: new Date("2026-01-01T00:00:00.000Z"),
          createdById: admin.id
        }
      }
    }
  });
  const invoice = await prisma.invoice.create({
    data: {
      status: "ISSUED",
      paymentStatus: "PENDING",
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
        line: customer.fiscalAddressLine,
        postalCode: customer.fiscalPostalCode,
        city: customer.fiscalCity,
        province: customer.fiscalProvince,
        country: customer.fiscalCountry
      },
      issueDate: new Date("2026-07-10T00:00:00.000Z"),
      operationDate: new Date("2026-07-10T00:00:00.000Z"),
      issuedAt: new Date("2026-07-10T09:00:00.000Z"),
      subtotal: "100.00",
      taxableBase: "100.00",
      taxAmount: "21.00",
      total: "121.00",
      createdById: admin.id,
      issuedById: admin.id,
      dueDates: {
        create: {
          position: 1,
          dueDate: new Date("2026-07-15T00:00:00.000Z"),
          amount: "121.00",
          paymentMethod: "DIRECT_DEBIT"
        }
      }
    },
    include: {
      dueDates: true
    }
  });

  return invoice.dueDates[0]!;
}

function apiRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`${appBaseUrl}${path}`, {
    ...init,
    headers: {
      Origin: appBaseUrl,
      ...(init.headers ?? {})
    }
  });
}

function jsonRequest(
  path: string,
  body: unknown,
  options: {
    csrfToken?: string | null;
    idempotencyKey?: string | null;
  } = {}
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: appBaseUrl
  };

  if (options.csrfToken !== null && options.csrfToken) {
    headers["X-CSRF-Token"] = options.csrfToken;
  }

  if (options.idempotencyKey !== null) {
    headers["Idempotency-Key"] = options.idempotencyKey ?? randomUUID();
  }

  return new Request(`${appBaseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
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
    prisma.customerRemittanceLine.deleteMany(),
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
