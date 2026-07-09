import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as changePasswordPost } from "@/app/api/auth/change-password/route";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { POST as logoutPost } from "@/app/api/auth/logout/route";
import { GET as sessionGet } from "@/app/api/auth/session/route";
import { prisma } from "@/lib/prisma";
import {
  hashSessionToken,
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
  const setCalls: Array<{
    name: string;
    value: string;
    options: CookieSetOptions;
  }> = [];
  const deleteCalls: string[] = [];

  return {
    values,
    setCalls,
    deleteCalls,
    store: {
      get(name: string) {
        const value = values.get(name);
        return value ? { name, value } : undefined;
      },
      set(name: string, value: string, options: CookieSetOptions) {
        values.set(name, value);
        setCalls.push({ name, value, options });
      },
      delete(name: string) {
        values.delete(name);
        deleteCalls.push(name);
      }
    },
    reset() {
      values.clear();
      setCalls.length = 0;
      deleteCalls.length = 0;
    }
  };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieMock.store)
}));

const appBaseUrl = "http://localhost:3000";
const initialPassword = "Cambiar-esta-clave-2026";
const baseCommand: InitializeCommand = {
  company: {
    legalName: "CriGestion Test SL",
    taxId: "B12345678",
    email: "admin@example.test"
  },
  administrator: {
    displayName: "Administrador",
    userName: "admin",
    password: initialPassword
  }
};

describe("authentication HTTP contracts", () => {
  beforeEach(async () => {
    process.env.APP_BASE_URL = appBaseUrl;
    process.env.AUTH_COOKIE_SECURE = "false";
    cookieMock.reset();
    await resetPlatformTables();
    await initializeForAuth();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("returns an anonymous session DTO when no cookie exists", async () => {
    const response = await sessionGet(apiRequest("/api/auth/session"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ authenticated: false });
  });

  it("rejects login requests from a disallowed origin", async () => {
    const response = await loginPost(
      jsonRequest("/api/auth/login", credentials(), {
        origin: "http://evil.example"
      })
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "ORIGIN_NOT_ALLOWED",
      message: "Origen no permitido."
    });
  });

  it("rejects malformed login JSON with a stable error", async () => {
    const response = await loginPost(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: "{"
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      code: "INVALID_JSON",
      message: "El cuerpo de la peticion no es JSON valido."
    });
  });

  it("rate limits repeated login requests by IP", async () => {
    const ipAddress = "198.51.100.42";

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await loginPost(
        jsonRequest(
          "/api/auth/login",
          {
            userName: `desconocido-${attempt}`,
            password: "Clave-incorrecta-2026"
          },
          { ipAddress }
        )
      );
    }

    const response = await loginPost(
      jsonRequest(
        "/api/auth/login",
        {
          userName: "otro-desconocido",
          password: "Clave-incorrecta-2026"
        },
        { ipAddress }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toEqual(expect.stringMatching(/^\d+$/));
    expect(body).toEqual({
      code: "LOGIN_RATE_LIMITED",
      message: "Demasiados intentos de acceso. Espera antes de reintentar.",
      retryAfterSeconds: expect.any(Number)
    });
  });

  it("logs in with an HttpOnly cookie and never returns token material", async () => {
    const response = await loginPost(jsonRequest("/api/auth/login", credentials()));
    const body = await response.json();
    const cookie = cookieMock.setCalls.at(-1);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      authenticated: true,
      user: {
        displayName: "Administrador",
        userName: "admin",
        role: {
          code: "Administrador",
          name: "Administrador"
        }
      },
      expiresAt: expect.any(String)
    });
    expect(body.user.permissions).toContain("Platform.ManageUsers");
    expect(JSON.stringify(body)).not.toContain("passwordHash");
    expect(JSON.stringify(body)).not.toContain(initialPassword);
    expect(cookie).toEqual({
      name: sessionCookieName,
      value: expect.any(String),
      options: {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        expires: expect.any(Date)
      }
    });
    expect(JSON.stringify(body)).not.toContain(cookie?.value);
  });

  it("returns the authenticated session from the session cookie", async () => {
    await loginAsAdmin();

    const response = await sessionGet(apiRequest("/api/auth/session"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      authenticated: true,
      user: {
        userName: "admin",
        role: {
          code: "Administrador"
        }
      },
      expiresAt: expect.any(String)
    });
    expect(JSON.stringify(body)).not.toContain(cookieMock.values.get(sessionCookieName));
  });

  it("requires a valid session before issuing a CSRF token", async () => {
    const response = await csrfGet(apiRequest("/api/auth/csrf"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      code: "UNAUTHENTICATED",
      message: "No hay una sesion activa."
    });
  });

  it("rejects logout without a CSRF token", async () => {
    await loginAsAdmin();

    const response = await logoutPost(
      new Request("http://localhost/api/auth/logout", {
        method: "POST"
      })
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "CSRF_TOKEN_INVALID",
      message: "Token CSRF invalido."
    });
    expect(cookieMock.deleteCalls).toHaveLength(0);
  });

  it("logs out with a CSRF token, revokes the session, and deletes the cookie", async () => {
    const token = await loginAsAdmin();
    const csrfToken = await getCsrfToken();

    const response = await logoutPost(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: {
          "Idempotency-Key": randomUUID(),
          "X-CSRF-Token": csrfToken
        }
      })
    );
    const body = await response.json();
    const session = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashSessionToken(token) }
    });

    expect(response.status).toBe(200);
    expect(body).toEqual({ authenticated: false });
    expect(session.revokedAt).toBeInstanceOf(Date);
    expect(session.revokeReason).toBe("USER_LOGOUT");
    expect(cookieMock.values.has(sessionCookieName)).toBe(false);
    expect(cookieMock.deleteCalls).toContain(sessionCookieName);
  });

  it("rejects logout without an idempotency key", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();

    const response = await logoutPost(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: {
          "X-CSRF-Token": csrfToken
        }
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
    expect(cookieMock.deleteCalls).toHaveLength(0);
  });

  it("rejects password change without a CSRF token", async () => {
    await loginAsAdmin();

    const response = await changePasswordPost(
      jsonRequest("/api/auth/change-password", {
        currentPassword: initialPassword,
        newPassword: "Nueva-clave-segura-2026"
      })
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "CSRF_TOKEN_INVALID",
      message: "Token CSRF invalido."
    });
  });

  it("rejects password change without an idempotency key", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();

    const response = await changePasswordPost(
      jsonRequest(
        "/api/auth/change-password",
        {
          currentPassword: initialPassword,
          newPassword: "Nueva-clave-segura-2026"
        },
        {
          csrfToken,
          idempotencyKey: null
        }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
  });

  it("changes password with CSRF, revokes sessions, and does not return secrets", async () => {
    const token = await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const newPassword = "Nueva-clave-segura-2026";

    const response = await changePasswordPost(
      jsonRequest(
        "/api/auth/change-password",
        {
          currentPassword: initialPassword,
          newPassword
        },
        {
          csrfToken
        }
      )
    );
    const body = await response.json();
    const session = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashSessionToken(token) }
    });

    expect(response.status).toBe(200);
    expect(body).toEqual({ passwordChanged: true });
    expect(JSON.stringify(body)).not.toContain(initialPassword);
    expect(JSON.stringify(body)).not.toContain(newPassword);
    expect(session.revokedAt).toBeInstanceOf(Date);
    expect(session.revokeReason).toBe("USER_PASSWORD_CHANGED");
    expect(cookieMock.values.has(sessionCookieName)).toBe(false);
  });
});

function credentials() {
  return {
    userName: "admin",
    password: initialPassword
  };
}

async function loginAsAdmin(): Promise<string> {
  const response = await loginPost(jsonRequest("/api/auth/login", credentials()));

  expect(response.status).toBe(200);

  const token = cookieMock.values.get(sessionCookieName);

  if (!token) {
    throw new Error("Login did not set the session cookie.");
  }

  return token;
}

async function getCsrfToken(): Promise<string> {
  const response = await csrfGet(apiRequest("/api/auth/csrf"));
  const body = (await response.json()) as { csrfToken?: string };

  expect(response.status).toBe(200);
  expect(body.csrfToken).toEqual(expect.any(String));

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
    ipAddress?: string;
  } = {}
): Request {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Forwarded-For": options.ipAddress ?? uniqueTestIp()
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
    method: "POST",
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

async function initializeForAuth(): Promise<void> {
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
