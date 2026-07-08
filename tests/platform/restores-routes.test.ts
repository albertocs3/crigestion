import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import {
  GET as restoresGet,
  POST as restoresPost
} from "@/app/api/platform/restores/route";
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

describe("restore HTTP contracts", () => {
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

  it("rejects unauthenticated restore listing", async () => {
    const response = await restoresGet(apiRequest("/api/platform/restores"));
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

    const response = await restoresGet(apiRequest("/api/platform/restores"));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "FORBIDDEN",
      message: "No tienes permiso para realizar esta accion."
    });
  });

  it("requires CSRF before requesting a restore", async () => {
    await loginWith("admin", adminPassword);
    const backup = await createVerifiedBackup();

    const response = await restoresPost(
      jsonRequest("/api/platform/restores", {
        backupOperationId: backup.id,
        reason: "Restauracion de prueba controlada"
      })
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "CSRF_TOKEN_INVALID",
      message: "Token CSRF invalido."
    });
  });

  it("requires an idempotency key before requesting a restore", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();
    const backup = await createVerifiedBackup();

    const response = await restoresPost(
      jsonRequest(
        "/api/platform/restores",
        {
          backupOperationId: backup.id,
          reason: "Restauracion de prueba controlada"
        },
        { csrfToken, idempotencyKey: null }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
  });

  it("requests a restore for a verified compatible backup", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();
    const backup = await createVerifiedBackup();

    const response = await restoresPost(
      jsonRequest(
        "/api/platform/restores",
        {
          backupOperationId: backup.id,
          reason: "Restauracion de prueba controlada"
        },
        { csrfToken }
      )
    );
    const body = await response.json();
    const restore = await prisma.restoreOperation.findFirstOrThrow({
      where: { status: "REQUESTED" }
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "RESTORE_REQUESTED" }
    });

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      id: restore.id,
      status: "REQUESTED",
      reason: "Restauracion de prueba controlada",
      backup: {
        id: backup.id,
        productVersion: "0.1.0",
        sizeBytes: "1234",
        sha256: "b".repeat(64)
      },
      requestedBy: {
        displayName: "Administrador",
        userName: "admin"
      }
    });
    expect(JSON.stringify(body)).not.toContain("storageKey");
    expect(auditEvent.payload).toMatchObject({
      restoreOperationId: restore.id,
      backupOperationId: backup.id,
      status: "REQUESTED",
      reasonLength: "Restauracion de prueba controlada".length
    });
  });

  it("rejects backups that are not verified or compatible", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();
    const requestedBackup = await createBackup({ status: "REQUESTED" });
    const incompatibleBackup = await createBackup({
      status: "VERIFIED",
      productVersion: "9.9.9",
      storageKey: "backup.backup",
      sizeBytes: 1234n,
      sha256: "b".repeat(64)
    });

    const notRestorableResponse = await restoresPost(
      jsonRequest(
        "/api/platform/restores",
        {
          backupOperationId: requestedBackup.id,
          reason: "Restauracion de prueba controlada"
        },
        { csrfToken }
      )
    );
    const notRestorableBody = await notRestorableResponse.json();
    await prisma.backupOperation.update({
      where: { id: requestedBackup.id },
      data: { status: "FAILED" }
    });
    const incompatibleResponse = await restoresPost(
      jsonRequest(
        "/api/platform/restores",
        {
          backupOperationId: incompatibleBackup.id,
          reason: "Restauracion de prueba controlada"
        },
        { csrfToken }
      )
    );
    const incompatibleBody = await incompatibleResponse.json();

    expect(notRestorableResponse.status).toBe(409);
    expect(notRestorableBody.code).toBe("RESTORE_OPERATION_ALREADY_ACTIVE");
    expect(incompatibleResponse.status).toBe(409);
    expect(incompatibleBody.code).toBe("BACKUP_VERSION_INCOMPATIBLE");
  });

  it("rejects a new restore while another restore is validated", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();
    const admin = await prisma.user.findUniqueOrThrow({
      where: { normalizedUserName: "admin" }
    });
    const firstBackup = await createVerifiedBackup();
    const secondBackup = await createVerifiedBackup();
    await prisma.restoreOperation.create({
      data: {
        status: "VALIDATED",
        backupOperationId: firstBackup.id,
        requestedById: admin.id,
        reason: "Restauracion de prueba controlada",
        startedAt: new Date("2026-07-02T10:02:00.000Z"),
        validatedAt: new Date("2026-07-02T10:03:00.000Z")
      }
    });

    const response = await restoresPost(
      jsonRequest(
        "/api/platform/restores",
        {
          backupOperationId: secondBackup.id,
          reason: "Restauracion posterior que debe esperar"
        },
        { csrfToken }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      code: "RESTORE_OPERATION_ALREADY_ACTIVE",
      message: "Ya existe una operacion de copia o restauracion en curso."
    });
  });

  it("lists restore operations without exposing backup storage keys", async () => {
    await loginWith("admin", adminPassword);
    const admin = await prisma.user.findUniqueOrThrow({
      where: { normalizedUserName: "admin" }
    });
    const backup = await createVerifiedBackup();
    const restore = await prisma.restoreOperation.create({
      data: {
        status: "REQUESTED",
        backupOperationId: backup.id,
        requestedById: admin.id,
        reason: "Restauracion de prueba controlada"
      }
    });

    const response = await restoresGet(
      apiRequest("/api/platform/restores?status=REQUESTED")
    );
    const body = await response.json();
    const viewedEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "RESTORE_OPERATIONS_VIEWED" }
    });

    expect(response.status).toBe(200);
    expect(body.restores[0]).toMatchObject({
      id: restore.id,
      status: "REQUESTED",
      reason: "Restauracion de prueba controlada",
      backup: {
        id: backup.id,
        sha256: "b".repeat(64)
      }
    });
    expect(body.nextCursor).toBeNull();
    expect(JSON.stringify(body)).not.toContain("storageKey");
    expect(viewedEvent.payload).toMatchObject({
      actorUserId: admin.id,
      status: "REQUESTED",
      resultCount: 1
    });
  });

  it("validates restore request payloads with stable errors", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();

    const response = await restoresPost(
      jsonRequest(
        "/api/platform/restores",
        {
          backupOperationId: "not-a-uuid",
          reason: "corto"
        },
        { csrfToken }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("rejects restore request payloads with unknown fields", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();
    const backup = await createVerifiedBackup();

    const response = await restoresPost(
      jsonRequest(
        "/api/platform/restores",
        {
          backupOperationId: backup.id,
          reason: "Restauracion de prueba controlada",
          storageKey: "backup.backup"
        },
        { csrfToken }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe("VALIDATION_ERROR");
  });
});

async function createVerifiedBackup() {
  return createBackup({
    status: "VERIFIED",
    storageKey: "backup.backup",
    sizeBytes: 1234n,
    sha256: "b".repeat(64),
    completedAt: new Date("2026-07-02T10:01:00.000Z")
  });
}

async function createBackup(data: {
  status: "REQUESTED" | "RUNNING" | "VERIFIED" | "FAILED";
  productVersion?: string;
  storageKey?: string;
  sizeBytes?: bigint;
  sha256?: string;
  completedAt?: Date;
}) {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { normalizedUserName: "admin" }
  });

  return prisma.backupOperation.create({
    data: {
      status: data.status,
      requestedById: admin.id,
      productVersion: data.productVersion ?? "0.1.0",
      storageKey: data.storageKey,
      sizeBytes: data.sizeBytes,
      sha256: data.sha256,
      completedAt: data.completedAt
    }
  });
}

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
