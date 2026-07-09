import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import {
  GET as catalogGet,
  POST as catalogPost
} from "@/app/api/catalog/items/route";
import { PATCH as catalogPatch } from "@/app/api/catalog/items/[itemId]/route";
import { POST as stockMovementsPost } from "@/app/api/catalog/items/[itemId]/stock-movements/route";
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
let defaultCatalogTaxRateId = "";

describe("catalog items HTTP contracts", () => {
  beforeEach(async () => {
    process.env.APP_BASE_URL = appBaseUrl;
    process.env.AUTH_COOKIE_SECURE = "false";
    cookieMock.reset();
    await resetPlatformTables();
    await resetCatalogItemCodeSequence();
    await initializeForRoutes();
    defaultCatalogTaxRateId = await findDefaultCatalogTaxRateId();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("rejects unauthenticated catalog listing", async () => {
    const response = await catalogGet(apiRequest("/api/catalog/items"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.code).toBe("UNAUTHENTICATED");
  });

  it("requires CSRF before creating catalog items", async () => {
    await loginAsAdmin();

    const response = await catalogPost(
      jsonRequest("/api/catalog/items", catalogPayload())
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.code).toBe("CSRF_TOKEN_INVALID");
  });

  it("requires an idempotency key before creating catalog items", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();

    const response = await catalogPost(
      jsonRequest("/api/catalog/items", catalogPayload(), {
        csrfToken,
        idempotencyKey: null
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("rejects users without catalog permissions", async () => {
    await createLimitedUserWithoutCatalog();
    await loginWith("auditor", limitedPassword);
    const csrfToken = await getCsrfToken();

    const listResponse = await catalogGet(apiRequest("/api/catalog/items"));
    const createResponse = await catalogPost(
      jsonRequest("/api/catalog/items", catalogPayload(), { csrfToken })
    );

    expect(listResponse.status).toBe(403);
    expect((await listResponse.json()).code).toBe("FORBIDDEN");
    expect(createResponse.status).toBe(403);
    expect((await createResponse.json()).code).toBe("FORBIDDEN");
  });

  it("creates, lists, updates and deactivates catalog items", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const category = await prisma.catalogCategory.create({
      data: {
        code: "1",
        name: "Servicios recurrentes",
        status: "ACTIVE"
      }
    });

    const createResponse = await catalogPost(
      jsonRequest(
        "/api/catalog/items",
        catalogPayload({ categoryId: category.id }),
        { csrfToken }
      )
    );
    const created = await createResponse.json();
    const listResponse = await catalogGet(
      apiRequest(`/api/catalog/items?kind=SERVICE&categoryId=${category.id}`)
    );
    const listBody = await listResponse.json();
    const updateResponse = await catalogPatch(
      jsonRequest(
        `/api/catalog/items/${created.id}`,
        {
          action: "update",
          item: catalogPayload({
            kind: "PRODUCT",
            name: "Producto fisico",
            salePrice: "99.00",
            stockTracked: true,
            stockCurrent: "5.000",
            stockMinimum: "1.000"
          })
        },
        { csrfToken, method: "PATCH" }
      ),
      { params: Promise.resolve({ itemId: created.id }) }
    );
    const updated = await updateResponse.json();
    const deactivateResponse = await catalogPatch(
      jsonRequest(
        `/api/catalog/items/${created.id}`,
        { action: "deactivate" },
        { csrfToken, method: "PATCH" }
      ),
      { params: Promise.resolve({ itemId: created.id }) }
    );
    const deactivated = await deactivateResponse.json();

    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({
      code: "1",
      kind: "SERVICE",
      name: "Servicio mensual",
      salePrice: "49.90",
      tax: {
        code: "IVA_21",
        name: "IVA general 21%",
        rate: "21.00"
      }
    });
    expect(listResponse.status).toBe(200);
    expect(listBody.items).toHaveLength(1);
    expect(updateResponse.status).toBe(200);
    expect(updated).toMatchObject({
      kind: "PRODUCT",
      name: "Producto fisico",
      stock: {
        tracked: true,
        current: "5.000"
      }
    });
    expect(deactivateResponse.status).toBe(200);
    expect(deactivated.status).toBe("INACTIVE");
  });

  it("requires an idempotency key before updating catalog items", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const createResponse = await catalogPost(
      jsonRequest("/api/catalog/items", catalogPayload(), { csrfToken })
    );
    const created = await createResponse.json();

    const response = await catalogPatch(
      jsonRequest(
        `/api/catalog/items/${created.id}`,
        { action: "deactivate" },
        { csrfToken, idempotencyKey: null, method: "PATCH" }
      ),
      { params: Promise.resolve({ itemId: created.id }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("registers stock adjustments through the item endpoint", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();

    const createResponse = await catalogPost(
      jsonRequest(
        "/api/catalog/items",
        catalogPayload({
          kind: "PRODUCT",
          name: "Producto inventariable",
          stockTracked: true,
          stockCurrent: "10.000",
          stockMinimum: "2.000"
        }),
        { csrfToken }
      )
    );
    const created = await createResponse.json();
    const adjustmentResponse = await stockMovementsPost(
      jsonRequest(
        `/api/catalog/items/${created.id}/stock-movements`,
        {
          quantity: "-2.500",
          reason: "Regularizacion de inventario"
        },
        { csrfToken }
      ),
      { params: Promise.resolve({ itemId: created.id }) }
    );
    const adjustment = await adjustmentResponse.json();

    expect(adjustmentResponse.status).toBe(201);
    expect(adjustment).toMatchObject({
      itemId: created.id,
      itemCode: "1",
      quantity: "-2.500",
      previousStock: "10.000",
      newStock: "7.500"
    });
  });

  it("requires an idempotency key before registering stock adjustments", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const createResponse = await catalogPost(
      jsonRequest(
        "/api/catalog/items",
        catalogPayload({
          kind: "PRODUCT",
          name: "Producto inventariable",
          stockTracked: true,
          stockCurrent: "10.000",
          stockMinimum: "2.000"
        }),
        { csrfToken }
      )
    );
    const created = await createResponse.json();

    const response = await stockMovementsPost(
      jsonRequest(
        `/api/catalog/items/${created.id}/stock-movements`,
        {
          quantity: "-2.500",
          reason: "Regularizacion de inventario"
        },
        { csrfToken, idempotencyKey: null }
      ),
      { params: Promise.resolve({ itemId: created.id }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
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

function catalogPayload(overrides: Record<string, unknown> = {}) {
  return {
    kind: "SERVICE",
    name: "Servicio mensual",
    description: "Cuota mensual de soporte",
    unitName: "Unidades",
    salePrice: "49.90",
    costPrice: "10.00",
    taxRateId: defaultCatalogTaxRateId,
    stockTracked: false,
    stockCurrent: "0.000",
    stockMinimum: "0.000",
    ...overrides
  };
}

async function findDefaultCatalogTaxRateId(): Promise<string> {
  const taxRate = await prisma.catalogTaxRate.findFirstOrThrow({
    where: {
      code: "IVA_21",
      status: "ACTIVE"
    },
    select: {
      id: true
    }
  });

  return taxRate.id;
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

async function createLimitedUserWithoutCatalog(): Promise<void> {
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
    prisma.restoreOperation.deleteMany(),
    prisma.backupOperation.deleteMany(),
    prisma.invoiceVerifactuRecord.deleteMany(),
    prisma.customerPaymentReturn.deleteMany(),
    prisma.customerPayment.deleteMany(),
    prisma.invoiceDueDate.deleteMany(),
    prisma.invoiceTaxSummary.deleteMany(),
    prisma.invoiceLine.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.invoiceNumberSequence.deleteMany(),
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
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}

async function resetCatalogItemCodeSequence(): Promise<void> {
  await prisma.$executeRaw`ALTER SEQUENCE catalog_item_code_seq RESTART WITH 1`;
}
