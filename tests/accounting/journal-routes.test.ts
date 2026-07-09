import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import {
  GET as accountsGet,
  POST as accountsPost
} from "@/app/api/accounting/accounts/route";
import {
  GET as journalEntriesGet,
  POST as journalEntriesPost
} from "@/app/api/accounting/journal-entries/route";
import { prisma } from "@/lib/prisma";
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

describe("accounting journal HTTP contracts", () => {
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

  it("creates accounts and manual journal entries through accounting contracts", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const bankResponse = await accountsPost(
      jsonRequest(
        "/api/accounting/accounts",
        {
          code: "572000001",
          name: "Banco operativo",
          type: "Activo corriente",
          level: 9,
          isPostable: true
        },
        { csrfToken }
      )
    );
    const revenueResponse = await accountsPost(
      jsonRequest(
        "/api/accounting/accounts",
        {
          code: "700000001",
          name: "Ventas servicios",
          type: "Ingresos",
          level: 9,
          isPostable: true
        },
        { csrfToken }
      )
    );
    const bank = await bankResponse.json();
    const revenue = await revenueResponse.json();
    const entryResponse = await journalEntriesPost(
      jsonRequest(
        "/api/accounting/journal-entries",
        {
          accountingDate: "2026-07-10",
          concept: "Ingreso manual",
          lines: [
            {
              accountId: bank.id,
              concept: "Banco",
              debit: "121.00",
              credit: "0.00"
            },
            {
              accountId: revenue.id,
              concept: "Ingreso",
              debit: "0.00",
              credit: "121.00"
            }
          ]
        },
        { csrfToken }
      )
    );
    const entry = await entryResponse.json();
    const listResponse = await journalEntriesGet(
      apiRequest("/api/accounting/journal-entries?year=2026")
    );
    const list = await listResponse.json();

    expect(bankResponse.status).toBe(201);
    expect(revenueResponse.status).toBe(201);
    expect(entryResponse.status).toBe(201);
    expect(entry).toMatchObject({
      number: "2026/000001",
      totalDebit: "121.00",
      totalCredit: "121.00",
      lines: [
        {
          debit: "121.00",
          account: { code: "572000001" }
        },
        {
          credit: "121.00",
          account: { code: "700000001" }
        }
      ]
    });
    expect(listResponse.status).toBe(200);
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]?.number).toBe("2026/000001");
  });

  it("protects accounting mutations with CSRF, idempotency and permissions", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const missingIdempotencyResponse = await accountsPost(
      jsonRequest(
        "/api/accounting/accounts",
        {
          code: "572000001",
          name: "Banco operativo",
          type: "Activo corriente",
          level: 9,
          isPostable: true
        },
        { csrfToken, idempotencyKey: null }
      )
    );

    cookieMock.reset();
    await createAccountingViewer();
    await loginWith("contabilidad-lectura", limitedPassword);
    const limitedCsrfToken = await getCsrfToken();
    const forbiddenResponse = await accountsPost(
      jsonRequest(
        "/api/accounting/accounts",
        {
          code: "572000001",
          name: "Banco operativo",
          type: "Activo corriente",
          level: 9,
          isPostable: true
        },
        { csrfToken: limitedCsrfToken }
      )
    );

    cookieMock.reset();
    const unauthenticatedResponse = await accountsGet(
      apiRequest("/api/accounting/accounts")
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
}

async function getCsrfToken(): Promise<string> {
  const response = await csrfGet(apiRequest("/api/auth/csrf"));
  const body = (await response.json()) as { csrfToken: string };

  return body.csrfToken;
}

async function createAccountingViewer(): Promise<void> {
  const role = await prisma.role.create({
    data: {
      code: "ConsultaContabilidad",
      name: "Consulta contabilidad",
      isProtected: false,
      permissions: {
        create: {
          permission: {
            connect: {
              code: "Accounting.View"
            }
          }
        }
      }
    }
  });

  await prisma.user.create({
    data: {
      displayName: "Usuario Contabilidad Lectura",
      userName: "contabilidad-lectura",
      normalizedUserName: "contabilidad-lectura",
      passwordHash: await hashPassword(limitedPassword),
      roleId: role.id
    }
  });
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
    prisma.accountingJournalLine.deleteMany(),
    prisma.accountingJournalEntry.deleteMany(),
    prisma.accountingAccount.deleteMany(),
    prisma.platformMaintenanceState.deleteMany(),
    prisma.idempotencyRecord.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.installation.deleteMany(),
    prisma.reservedUserName.deleteMany(),
    prisma.session.deleteMany(),
    prisma.rateLimitBucket.deleteMany(),
    prisma.loginAttempt.deleteMany(),
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
