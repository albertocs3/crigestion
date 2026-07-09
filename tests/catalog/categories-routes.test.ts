import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import {
  GET as categoriesGet,
  POST as categoriesPost
} from "@/app/api/catalog/categories/route";
import { PATCH as categoriesPatch } from "@/app/api/catalog/categories/[categoryId]/route";
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

describe("catalog categories HTTP contracts", () => {
  beforeEach(async () => {
    process.env.APP_BASE_URL = appBaseUrl;
    process.env.AUTH_COOKIE_SECURE = "false";
    cookieMock.reset();
    await resetPlatformTables();
    await resetCatalogCategoryCodeSequence();
    await initializeForRoutes();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("creates, lists, deactivates and reactivates catalog categories", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();

    const createResponse = await categoriesPost(
      jsonRequest(
        "/api/catalog/categories",
        {
          name: "Servicios recurrentes",
          description: "Cuotas y mantenimientos"
        },
        { csrfToken }
      )
    );
    const created = await createResponse.json();
    const listResponse = await categoriesGet(
      apiRequest("/api/catalog/categories?includeInactive=true")
    );
    const deactivateResponse = await categoriesPatch(
      jsonRequest(
        `/api/catalog/categories/${created.id}`,
        { action: "deactivate" },
        { csrfToken, method: "PATCH" }
      ),
      { params: Promise.resolve({ categoryId: created.id }) }
    );
    const reactivateResponse = await categoriesPatch(
      jsonRequest(
        `/api/catalog/categories/${created.id}`,
        { action: "reactivate" },
        { csrfToken, method: "PATCH" }
      ),
      { params: Promise.resolve({ categoryId: created.id }) }
    );

    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({
      code: "1",
      name: "Servicios recurrentes",
      status: "ACTIVE"
    });
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({
      items: [expect.objectContaining({ code: "1" })]
    });
    expect(deactivateResponse.status).toBe(200);
    expect(await deactivateResponse.json()).toMatchObject({
      status: "INACTIVE"
    });
    expect(reactivateResponse.status).toBe(200);
    expect(await reactivateResponse.json()).toMatchObject({
      status: "ACTIVE"
    });
  });

  it("requires an idempotency key before creating categories", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();

    const response = await categoriesPost(
      jsonRequest(
        "/api/catalog/categories",
        {
          name: "Servicios recurrentes",
          description: "Cuotas y mantenimientos"
        },
        { csrfToken, idempotencyKey: null }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("requires an idempotency key before updating categories", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const createResponse = await categoriesPost(
      jsonRequest(
        "/api/catalog/categories",
        {
          name: "Servicios recurrentes",
          description: "Cuotas y mantenimientos"
        },
        { csrfToken }
      )
    );
    const created = await createResponse.json();

    const response = await categoriesPatch(
      jsonRequest(
        `/api/catalog/categories/${created.id}`,
        { action: "deactivate" },
        { csrfToken, idempotencyKey: null, method: "PATCH" }
      ),
      { params: Promise.resolve({ categoryId: created.id }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
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
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}

async function resetCatalogCategoryCodeSequence(): Promise<void> {
  await prisma.$executeRaw`ALTER SEQUENCE catalog_category_code_seq RESTART WITH 1`;
}
