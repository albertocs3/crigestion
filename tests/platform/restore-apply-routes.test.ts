import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { prisma } from "@/lib/prisma";
import { sessionCookieName } from "@/modules/platform/application/auth";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";
import { hashPassword } from "@/modules/platform/application/passwords";

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

describe("restore apply HTTP contract", () => {
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

  it("requires CSRF before applying a restore", async () => {
    await loginWith("admin", adminPassword);
    const { POST: restoreApplyPost } = await import(
      "@/app/api/platform/restores/apply/route"
    );

    const response = await restoreApplyPost(
      jsonRequest("/api/platform/restores/apply", {})
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "CSRF_TOKEN_INVALID",
      message: "Token CSRF invalido."
    });
  });

  it("rejects users without Platform.ManageMaintenance", async () => {
    await createLimitedUserWithoutMaintenance();
    await loginWith("auditor", limitedPassword);
    const csrfToken = await getCsrfToken();
    const { POST: restoreApplyPost } = await import(
      "@/app/api/platform/restores/apply/route"
    );

    const response = await restoreApplyPost(
      jsonRequest("/api/platform/restores/apply", {}, { csrfToken })
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "FORBIDDEN",
      message: "No tienes permiso para realizar esta accion."
    });
  });

  it("reports when there is no validated restore in maintenance", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();
    const { POST: restoreApplyPost } = await import(
      "@/app/api/platform/restores/apply/route"
    );

    const response = await restoreApplyPost(
      jsonRequest("/api/platform/restores/apply", {}, { csrfToken })
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      code: "NO_VALIDATED_RESTORE_IN_MAINTENANCE",
      message: "No hay una restauracion validada con mantenimiento activo."
    });
  });
});

async function createLimitedUserWithoutMaintenance(): Promise<void> {
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

async function loginWith(userName: string, password: string): Promise<void> {
  const response = await loginPost(
    new Request("http://localhost/api/auth/login", {
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
  return new Request(`http://localhost${path}`);
}

function jsonRequest(
  path: string,
  payload: unknown,
  options: {
    csrfToken?: string;
  } = {}
): Request {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Forwarded-For": uniqueTestIp()
  });

  if (options.csrfToken) {
    headers.set("X-CSRF-Token", options.csrfToken);
  }

  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
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
