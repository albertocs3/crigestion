import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import {
  GET as backupsGet,
  POST as backupsPost
} from "@/app/api/platform/backups/route";
import {
  GET as maintenanceGet,
  PATCH as maintenancePatch
} from "@/app/api/platform/maintenance/route";
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

describe("maintenance HTTP contracts", () => {
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

  it("rejects unauthenticated maintenance reads", async () => {
    const response = await maintenanceGet(apiRequest("/api/platform/maintenance"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      code: "UNAUTHENTICATED",
      message: "No hay una sesion activa."
    });
  });

  it("requires CSRF before enabling maintenance", async () => {
    await loginWith("admin", adminPassword);
    const restore = await createValidatedRestore();

    const response = await maintenancePatch(
      jsonRequest("/api/platform/maintenance", {
        enabled: true,
        restoreOperationId: restore.id,
        reason: "Ventana de restauracion controlada"
      })
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "CSRF_TOKEN_INVALID",
      message: "Token CSRF invalido."
    });
  });

  it("enables and disables restore maintenance for a validated restore", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();
    const restore = await createValidatedRestore();

    const enableResponse = await maintenancePatch(
      jsonRequest(
        "/api/platform/maintenance",
        {
          enabled: true,
          restoreOperationId: restore.id,
          reason: "Ventana de restauracion controlada"
        },
        { csrfToken }
      )
    );
    const enabledBody = await enableResponse.json();
    const enabledEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "MAINTENANCE_MODE_ENABLED" }
    });
    const stateResponse = await maintenanceGet(apiRequest("/api/platform/maintenance"));
    const stateBody = await stateResponse.json();
    const disableResponse = await maintenancePatch(
      jsonRequest(
        "/api/platform/maintenance",
        { enabled: false },
        { csrfToken }
      )
    );
    const disabledBody = await disableResponse.json();
    const disabledEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "MAINTENANCE_MODE_DISABLED" }
    });

    expect(enableResponse.status).toBe(200);
    expect(enabledBody).toMatchObject({
      enabled: true,
      mode: "RESTORE",
      reason: "Ventana de restauracion controlada",
      restoreOperation: {
        id: restore.id,
        status: "VALIDATED"
      },
      enabledBy: {
        userName: "admin"
      },
      disabledBy: null,
      disabledAt: null
    });
    expect(enabledEvent.payload).toMatchObject({
      mode: "RESTORE",
      restoreOperationId: restore.id,
      reasonLength: "Ventana de restauracion controlada".length
    });
    expect(stateResponse.status).toBe(200);
    expect(stateBody.enabled).toBe(true);
    expect(disableResponse.status).toBe(200);
    expect(disabledBody).toMatchObject({
      enabled: false,
      mode: "RESTORE",
      restoreOperation: {
        id: restore.id
      },
      disabledBy: {
        userName: "admin"
      }
    });
    expect(disabledEvent.payload).toMatchObject({
      mode: "RESTORE",
      restoreOperationId: restore.id
    });
  });

  it("rejects maintenance activation for a restore that is not validated", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();
    const restore = await createRequestedRestore();

    const response = await maintenancePatch(
      jsonRequest(
        "/api/platform/maintenance",
        {
          enabled: true,
          restoreOperationId: restore.id,
          reason: "Ventana de restauracion controlada"
        },
        { csrfToken }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      code: "RESTORE_OPERATION_NOT_VALIDATED",
      message: "La restauracion debe estar validada antes de activar mantenimiento."
    });
  });

  it("blocks normal platform mutations while maintenance is active", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();
    const restore = await createValidatedRestore();
    await enableMaintenance(restore.id, csrfToken);

    const listResponse = await backupsGet(apiRequest("/api/platform/backups"));
    const blockedResponse = await backupsPost(
      jsonRequest("/api/platform/backups", {}, { csrfToken, method: "POST" })
    );
    const blockedBody = await blockedResponse.json();
    const blockedEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "MAINTENANCE_MUTATION_BLOCKED" }
    });

    expect(listResponse.status).toBe(200);
    expect(blockedResponse.status).toBe(423);
    expect(blockedBody).toEqual({
      code: "MAINTENANCE_MODE_ACTIVE",
      message: "La plataforma esta en modo mantenimiento."
    });
    expect(blockedEvent.payload).toMatchObject({
      method: "POST",
      path: "/api/platform/backups",
      mode: "RESTORE",
      restoreOperationId: restore.id
    });
  });
});

async function createValidatedRestore() {
  const restore = await createRequestedRestore();

  return prisma.restoreOperation.update({
    where: { id: restore.id },
    data: {
      status: "VALIDATED",
      validatedAt: new Date("2026-07-02T10:00:00.000Z")
    }
  });
}

async function createRequestedRestore() {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { normalizedUserName: "admin" }
  });
  const backup = await prisma.backupOperation.create({
    data: {
      status: "VERIFIED",
      requestedById: admin.id,
      productVersion: "0.1.0",
      storageKey: "backup.backup",
      sizeBytes: 1234n,
      sha256: "b".repeat(64),
      completedAt: new Date("2026-07-02T09:00:00.000Z")
    }
  });

  return prisma.restoreOperation.create({
    data: {
      status: "REQUESTED",
      backupOperationId: backup.id,
      requestedById: admin.id,
      reason: "Restauracion de prueba controlada"
    }
  });
}

async function enableMaintenance(
  restoreOperationId: string,
  csrfToken: string
): Promise<void> {
  const response = await maintenancePatch(
    jsonRequest(
      "/api/platform/maintenance",
      {
        enabled: true,
        restoreOperationId,
        reason: "Ventana de restauracion controlada"
      },
      { csrfToken }
    )
  );

  expect(response.status).toBe(200);
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
    method?: "PATCH" | "POST";
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
    method: options.method ?? "PATCH",
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
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
