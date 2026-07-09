import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { PATCH as sessionPatch } from "@/app/api/platform/sessions/[sessionId]/route";
import { GET as sessionsGet } from "@/app/api/platform/sessions/route";
import { prisma } from "@/lib/prisma";
import {
  sessionCookieName
} from "@/modules/platform/application/auth";
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
const managedPassword = "Cambiar-gestion-2026";
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

describe("sessions HTTP contracts", () => {
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

  it("rejects unauthenticated session listing", async () => {
    const response = await sessionsGet(apiRequest("/api/platform/sessions"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      code: "UNAUTHENTICATED",
      message: "No hay una sesion activa."
    });
  });

  it("lists active sessions for an authorized administrator without token material", async () => {
    await loginAsAdmin();

    const response = await sessionsGet(apiRequest("/api/platform/sessions"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      user: {
        userName: "admin",
        role: {
          code: "Administrador"
        }
      },
      isCurrentSession: true
    });
    expect(JSON.stringify(body)).not.toContain("tokenHash");
  });

  it("requires CSRF before revoking a session", async () => {
    const adminToken = await loginAsAdmin();
    const targetSessionId = await createManagedUserAndSession(adminToken);
    cookieMock.values.set(sessionCookieName, adminToken);

    const response = await sessionPatch(
      jsonRequest(`/api/platform/sessions/${targetSessionId}`, { action: "revoke" }),
      { params: Promise.resolve({ sessionId: targetSessionId }) }
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "CSRF_TOKEN_INVALID",
      message: "Token CSRF invalido."
    });
  });

  it("requires an idempotency key before revoking a session", async () => {
    const adminToken = await loginAsAdmin();
    const targetSessionId = await createManagedUserAndSession(adminToken);
    cookieMock.values.set(sessionCookieName, adminToken);
    const csrfToken = await getCsrfToken();

    const response = await sessionPatch(
      jsonRequest(
        `/api/platform/sessions/${targetSessionId}`,
        { action: "revoke" },
        { csrfToken, idempotencyKey: null }
      ),
      { params: Promise.resolve({ sessionId: targetSessionId }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
  });

  it("revokes a remote session and rejects self revocation", async () => {
    const adminToken = await loginAsAdmin();
    const targetSessionId = await createManagedUserAndSession(adminToken);
    cookieMock.values.set(sessionCookieName, adminToken);
    const csrfToken = await getCsrfToken();
    const adminSession = await prisma.session.findFirstOrThrow({
      where: {
        user: {
          normalizedUserName: "admin"
        },
        revokedAt: null
      }
    });

    const response = await sessionPatch(
      jsonRequest(
        `/api/platform/sessions/${targetSessionId}`,
        { action: "revoke" },
        { csrfToken }
      ),
      { params: Promise.resolve({ sessionId: targetSessionId }) }
    );
    const body = await response.json();
    const selfResponse = await sessionPatch(
      jsonRequest(
        `/api/platform/sessions/${adminSession.id}`,
        { action: "revoke" },
        { csrfToken }
      ),
      { params: Promise.resolve({ sessionId: adminSession.id }) }
    );
    const selfBody = await selfResponse.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ revoked: true });
    expect(selfResponse.status).toBe(409);
    expect(selfBody).toEqual({
      code: "SELF_SESSION_REVOKE_NOT_ALLOWED",
      message: "Usa cerrar sesion para finalizar tu sesion actual."
    });
  });

  it("denies sessions endpoints without Platform.ManageSessions", async () => {
    await createLimitedUser();
    cookieMock.reset();
    await loginWith("auditor", managedPassword);

    const response = await sessionsGet(apiRequest("/api/platform/sessions"));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "FORBIDDEN",
      message: "No tienes permiso para realizar esta accion."
    });
  });
});

async function createManagedUserAndSession(adminToken: string): Promise<string> {
  await prisma.user.create({
    data: {
      displayName: "Usuario Gestion",
      userName: "gestion",
      normalizedUserName: "gestion",
      passwordHash: await import("@/modules/platform/application/passwords").then(
        ({ hashPassword }) => hashPassword(managedPassword)
      ),
      status: "ACTIVE",
      role: {
        connect: {
          code: "Administrador"
        }
      }
    }
  });

  cookieMock.values.set(sessionCookieName, adminToken);
  await loginWith("gestion", managedPassword);

  const session = await prisma.session.findFirstOrThrow({
    where: {
      user: {
        normalizedUserName: "gestion"
      },
      revokedAt: null
    }
  });

  return session.id;
}

async function createLimitedUser(): Promise<void> {
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
      passwordHash: await import("@/modules/platform/application/passwords").then(
        ({ hashPassword }) => hashPassword(managedPassword)
      ),
      status: "ACTIVE",
      roleId: role.id
    }
  });
}

async function loginAsAdmin(): Promise<string> {
  await loginWith("admin", adminPassword);
  const token = cookieMock.values.get(sessionCookieName);

  if (!token) {
    throw new Error("Admin login did not set a session cookie.");
  }

  return token;
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

function jsonRequest(
  path: string,
  payload: unknown,
  options: {
    origin?: string;
    csrfToken?: string;
    idempotencyKey?: string | null;
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
    method: "PATCH",
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
