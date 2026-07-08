import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import {
  GET as taxRatesGet,
  POST as taxRatesPost
} from "@/app/api/catalog/tax-rates/route";
import { PATCH as taxRatesPatch } from "@/app/api/catalog/tax-rates/[taxRateId]/route";
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

describe("catalog tax rates HTTP contracts", () => {
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

  it("creates, lists, sets default and deactivates tax rates", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();

    const createResponse = await taxRatesPost(
      jsonRequest(
        "/api/catalog/tax-rates",
        {
          code: "IVA_23",
          name: "IVA general 23%",
          rate: "23.00",
          isDefault: true
        },
        { csrfToken }
      )
    );
    const created = await createResponse.json();
    const listResponse = await taxRatesGet(
      apiRequest("/api/catalog/tax-rates?includeInactive=true")
    );
    const listBody = await listResponse.json();
    const iva10 = listBody.items.find(
      (taxRate: { code: string }) => taxRate.code === "IVA_10"
    );
    const defaultResponse = await taxRatesPatch(
      jsonRequest(
        `/api/catalog/tax-rates/${iva10.id}`,
        { action: "setDefault" },
        { csrfToken, method: "PATCH" }
      ),
      { params: Promise.resolve({ taxRateId: iva10.id }) }
    );
    const deactivateResponse = await taxRatesPatch(
      jsonRequest(
        `/api/catalog/tax-rates/${created.id}`,
        { action: "deactivate" },
        { csrfToken, method: "PATCH" }
      ),
      { params: Promise.resolve({ taxRateId: created.id }) }
    );

    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({
      code: "IVA_23",
      rate: "23.00",
      status: "ACTIVE",
      isDefault: true
    });
    expect(listResponse.status).toBe(200);
    expect(listBody.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "IVA_23" }),
        expect.objectContaining({ code: "IVA_10" })
      ])
    );
    expect(defaultResponse.status).toBe(200);
    expect(await defaultResponse.json()).toMatchObject({
      code: "IVA_10",
      isDefault: true
    });
    expect(deactivateResponse.status).toBe(200);
    expect(await deactivateResponse.json()).toMatchObject({
      code: "IVA_23",
      status: "INACTIVE"
    });
  });

  it("requires CSRF before creating tax rates", async () => {
    await loginAsAdmin();

    const response = await taxRatesPost(
      jsonRequest("/api/catalog/tax-rates", {
        code: "IVA_23",
        name: "IVA general 23%",
        rate: "23.00",
        isDefault: false
      })
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.code).toBe("CSRF_TOKEN_INVALID");
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
    prisma.customerAddress.deleteMany(),
    prisma.customerSepaMandate.deleteMany(),
    prisma.customerStore.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.catalogStockMovement.deleteMany(),
    prisma.catalogItem.deleteMany(),
    prisma.catalogTaxRate.deleteMany(),
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
