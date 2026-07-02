import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import {
  GET as backupsGet,
  POST as backupsPost
} from "@/app/api/platform/backups/route";
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

describe("backup HTTP contracts", () => {
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

  it("rejects unauthenticated backup listing", async () => {
    const response = await backupsGet(apiRequest("/api/platform/backups"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      code: "UNAUTHENTICATED",
      message: "No hay una sesion activa."
    });
  });

  it("rejects users without Platform.ManageBackups", async () => {
    await createLimitedUserWithoutBackups();
    await loginWith("auditor", limitedPassword);

    const response = await backupsGet(apiRequest("/api/platform/backups"));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "FORBIDDEN",
      message: "No tienes permiso para realizar esta accion."
    });
  });

  it("lists backup operations without exposing storage keys", async () => {
    await loginWith("admin", adminPassword);
    const admin = await prisma.user.findUniqueOrThrow({
      where: { normalizedUserName: "admin" }
    });

    await prisma.backupOperation.create({
      data: {
        status: "VERIFIED",
        requestedById: admin.id,
        startedAt: new Date("2026-07-02T10:00:00.000Z"),
        completedAt: new Date("2026-07-02T10:01:00.000Z"),
        productVersion: "0.1.0",
        storageKey: "protected/backups/backup.enc",
        sizeBytes: 1234567890123456789n,
        sha256: "a".repeat(64)
      }
    });

    const response = await backupsGet(
      apiRequest("/api/platform/backups?status=VERIFIED")
    );
    const body = await response.json();
    const viewedEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "BACKUP_OPERATIONS_VIEWED" }
    });

    expect(response.status).toBe(200);
    expect(body).toEqual({
      backups: [
        {
          id: expect.any(String),
          status: "VERIFIED",
          requestedBy: {
            id: admin.id,
            displayName: "Administrador",
            userName: "admin"
          },
          requestedAt: expect.any(String),
          startedAt: "2026-07-02T10:00:00.000Z",
          completedAt: "2026-07-02T10:01:00.000Z",
          productVersion: "0.1.0",
          sizeBytes: "1234567890123456789",
          sha256: "a".repeat(64),
          errorCode: null
        }
      ],
      nextCursor: null
    });
    expect(JSON.stringify(body)).not.toContain("storageKey");
    expect(viewedEvent.payload).toMatchObject({
      actorUserId: admin.id,
      status: "VERIFIED",
      resultCount: 1
    });
  });

  it("requires CSRF before requesting a manual backup", async () => {
    await loginWith("admin", adminPassword);

    const response = await backupsPost(jsonRequest("/api/platform/backups", {}));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "CSRF_TOKEN_INVALID",
      message: "Token CSRF invalido."
    });
  });

  it("requests a manual backup and audits the request", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();

    const response = await backupsPost(
      jsonRequest("/api/platform/backups", {}, { csrfToken })
    );
    const body = await response.json();
    const operation = await prisma.backupOperation.findFirstOrThrow({
      where: { status: "REQUESTED" }
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "BACKUP_REQUESTED" }
    });

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      id: operation.id,
      status: "REQUESTED",
      requestedBy: {
        displayName: "Administrador",
        userName: "admin"
      },
      productVersion: "0.1.0",
      startedAt: null,
      completedAt: null,
      sizeBytes: null,
      sha256: null,
      errorCode: null
    });
    expect(auditEvent.payload).toMatchObject({
      backupOperationId: operation.id,
      status: "REQUESTED"
    });
  });

  it("rejects a second active manual backup request", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();

    await backupsPost(jsonRequest("/api/platform/backups", {}, { csrfToken }));
    const response = await backupsPost(
      jsonRequest("/api/platform/backups", {}, { csrfToken })
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      code: "BACKUP_OPERATION_ALREADY_ACTIVE",
      message: "Ya existe una operacion de copia en curso."
    });
  });

  it("validates query parameters with stable errors", async () => {
    await loginWith("admin", adminPassword);

    const response = await backupsGet(
      apiRequest("/api/platform/backups?status=UNKNOWN")
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe("VALIDATION_ERROR");
  });
});

async function createLimitedUserWithoutBackups(): Promise<void> {
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
    origin?: string;
    csrfToken?: string;
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
    prisma.backupOperation.deleteMany(),
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
