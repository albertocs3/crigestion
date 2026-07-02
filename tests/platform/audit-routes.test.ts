import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as auditGet } from "@/app/api/platform/audit/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
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

describe("audit HTTP contracts", () => {
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

  it("rejects unauthenticated audit listing", async () => {
    const response = await auditGet(new Request("http://localhost/api/platform/audit"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      code: "UNAUTHENTICATED",
      message: "No hay una sesion activa."
    });
  });

  it("rejects users without Platform.ViewAudit", async () => {
    await createLimitedUserWithoutAudit();
    await loginWith("gestion", limitedPassword);

    const response = await auditGet(new Request("http://localhost/api/platform/audit"));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "FORBIDDEN",
      message: "No tienes permiso para realizar esta accion."
    });
  });

  it("lists audit events for authorized users without exposing sensitive payload keys", async () => {
    await loginWith("admin", adminPassword);
    await prisma.auditEvent.create({
      data: {
        eventType: "ROUTE_SENSITIVE_TEST",
        actorType: "USER",
        payload: {
          password: "No-debe-salir-2026",
          safeValue: "visible"
        }
      }
    });

    const response = await auditGet(
      new Request("http://localhost/api/platform/audit?eventType=ROUTE_SENSITIVE_TEST")
    );
    const body = await response.json();
    const viewedEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "AUDIT_VIEWED" }
    });

    expect(response.status).toBe(200);
    expect(body).toEqual({
      events: [
        {
          id: expect.any(String),
          eventType: "ROUTE_SENSITIVE_TEST",
          actorType: "USER",
          payload: {
            password: "[REDACTED]",
            safeValue: "visible"
          },
          createdAt: expect.any(String)
        }
      ],
      nextCursor: null
    });
    expect(JSON.stringify(body)).not.toContain("No-debe-salir-2026");
    expect(viewedEvent.payload).toMatchObject({
      eventType: "ROUTE_SENSITIVE_TEST",
      resultCount: 1
    });
  });

  it("validates query parameters with stable errors", async () => {
    await loginWith("admin", adminPassword);

    const response = await auditGet(
      new Request("http://localhost/api/platform/audit?limit=1000")
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe("VALIDATION_ERROR");
  });
});

async function createLimitedUserWithoutAudit(): Promise<void> {
  const role = await prisma.role.create({
    data: {
      code: "GestionUsuarios",
      name: "Gestion usuarios",
      isProtected: false,
      permissions: {
        create: {
          permission: {
            connect: {
              code: "Platform.ManageUsers"
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
    prisma.idempotencyRecord.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.installation.deleteMany(),
    prisma.reservedUserName.deleteMany(),
    prisma.session.deleteMany(),
    prisma.loginAttempt.deleteMany(),
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
