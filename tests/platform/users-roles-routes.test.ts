import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { PATCH as rolePatch } from "@/app/api/platform/roles/[roleId]/route";
import { GET as rolesGet, POST as rolesPost } from "@/app/api/platform/roles/route";
import { PATCH as userPatch } from "@/app/api/platform/users/[userId]/route";
import { GET as usersGet, POST as usersPost } from "@/app/api/platform/users/route";
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

describe("users and roles HTTP contracts", () => {
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

  it("rejects unauthenticated user listing", async () => {
    const response = await usersGet(apiRequest("/api/platform/users"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      code: "UNAUTHENTICATED",
      message: "No hay una sesion activa."
    });
  });

  it("lists users as DTOs for an authorized administrator", async () => {
    await loginAsAdmin();

    const response = await usersGet(apiRequest("/api/platform/users"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.users).toHaveLength(1);
    expect(body.users[0]).toMatchObject({
      displayName: "Administrador",
      userName: "admin",
      status: "ACTIVE",
      role: {
        code: "Administrador"
      }
    });
    expect(JSON.stringify(body)).not.toContain("passwordHash");
    expect(JSON.stringify(body)).not.toContain(adminPassword);
  });

  it("requires CSRF before creating users", async () => {
    await loginAsAdmin();

    const response = await usersPost(
      jsonRequest("/api/platform/users", createUserPayload())
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "CSRF_TOKEN_INVALID",
      message: "Token CSRF invalido."
    });
  });

  it("requires an idempotency key before creating users", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();

    const response = await usersPost(
      jsonRequest("/api/platform/users", createUserPayload(), {
        csrfToken,
        idempotencyKey: null
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
  });

  it("creates a user without exposing password material", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();

    const response = await usersPost(
      jsonRequest("/api/platform/users", createUserPayload(), { csrfToken })
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      displayName: "Usuario Gestion",
      userName: "gestion",
      status: "ACTIVE",
      role: {
        code: "Administrador"
      }
    });
    expect(JSON.stringify(body)).not.toContain(createUserPayload().password);
    expect(JSON.stringify(body)).not.toContain("passwordHash");
  });

  it("rejects duplicate user names with a stable conflict", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();

    await usersPost(jsonRequest("/api/platform/users", createUserPayload(), { csrfToken }));
    const response = await usersPost(
      jsonRequest("/api/platform/users", createUserPayload(), { csrfToken })
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      code: "USER_NAME_ALREADY_USED",
      message: "El nombre de usuario ya esta reservado."
    });
  });

  it("deactivates a user through PATCH and rejects self status changes", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const user = await createUserThroughHttp(csrfToken);

    const response = await userPatch(
      jsonRequest(`/api/platform/users/${user.id}`, { action: "deactivate" }, { csrfToken }),
      { params: Promise.resolve({ userId: user.id }) }
    );
    const body = await response.json();
    const admin = await prisma.user.findUniqueOrThrow({
      where: { normalizedUserName: "admin" }
    });
    const selfResponse = await userPatch(
      jsonRequest(`/api/platform/users/${admin.id}`, { action: "deactivate" }, { csrfToken }),
      { params: Promise.resolve({ userId: admin.id }) }
    );
    const selfBody = await selfResponse.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("INACTIVE");
    expect(selfResponse.status).toBe(409);
    expect(selfBody).toEqual({
      code: "SELF_STATUS_CHANGE_NOT_ALLOWED",
      message: "No puedes cambiar tu propio estado."
    });
  });

  it("requires an idempotency key before changing users", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const user = await createUserThroughHttp(csrfToken);

    const response = await userPatch(
      jsonRequest(
        `/api/platform/users/${user.id}`,
        { action: "deactivate" },
        { csrfToken, idempotencyKey: null }
      ),
      { params: Promise.resolve({ userId: user.id }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
  });

  it("rejects user PATCH with invalid route params", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();

    const response = await userPatch(
      jsonRequest("/api/platform/users/not-a-uuid", { action: "deactivate" }, { csrfToken }),
      { params: Promise.resolve({ userId: "not-a-uuid" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("lists roles and permissions for an authorized administrator", async () => {
    await loginAsAdmin();

    const response = await rolesGet(apiRequest("/api/platform/roles"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.roles[0]).toMatchObject({
      code: "Administrador",
      isProtected: true
    });
    expect(body.permissions).toEqual(
      expect.arrayContaining([
        {
          code: "Platform.ManageUsers",
          name: "Gestionar usuarios"
        }
      ])
    );
    expect(JSON.stringify(body)).not.toContain("passwordHash");
  });

  it("requires an idempotency key before creating roles", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();

    const response = await rolesPost(
      jsonRequest(
        "/api/platform/roles",
        {
          code: "ConsultaAuditoria",
          name: "Consulta auditoria",
          permissionCodes: ["Platform.ViewAudit"]
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

  it("creates a role and rejects duplicate codes", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const payload = {
      code: "ConsultaAuditoria",
      name: "Consulta auditoria",
      permissionCodes: ["Platform.ViewAudit"]
    };

    const response = await rolesPost(
      jsonRequest("/api/platform/roles", payload, { csrfToken })
    );
    const body = await response.json();
    const duplicateResponse = await rolesPost(
      jsonRequest("/api/platform/roles", payload, { csrfToken })
    );
    const duplicateBody = await duplicateResponse.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      code: "ConsultaAuditoria",
      name: "Consulta auditoria",
      isProtected: false,
      permissions: [
        {
          code: "Platform.ViewAudit",
          name: "Consultar auditoria"
        }
      ]
    });
    expect(duplicateResponse.status).toBe(409);
    expect(duplicateBody).toEqual({
      code: "ROLE_CODE_ALREADY_USED",
      message: "El codigo de rol ya existe."
    });
  });

  it("updates role permissions and revokes affected sessions through PATCH", async () => {
    const adminToken = await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const createRoleResponse = await rolesPost(
      jsonRequest(
        "/api/platform/roles",
        {
          code: "ConsultaAuditoria",
          name: "Consulta auditoria",
          permissionCodes: ["Platform.ViewAudit"]
        },
        { csrfToken }
      )
    );
    const role = (await createRoleResponse.json()) as { id: string };

    await usersPost(
      jsonRequest(
        "/api/platform/users",
        {
          ...createUserPayload(),
          userName: "auditor",
          roleCode: "ConsultaAuditoria"
        },
        { csrfToken }
      )
    );

    cookieMock.reset();
    await loginWith("auditor", createUserPayload().password);

    const auditorSession = await prisma.session.findFirstOrThrow({
      where: {
        user: {
          normalizedUserName: "auditor"
        },
        revokedAt: null
      }
    });

    cookieMock.values.set(sessionCookieName, adminToken);
    const response = await rolePatch(
      jsonRequest(
        `/api/platform/roles/${role.id}`,
        { permissionCodes: ["Platform.ManageUsers"] },
        { csrfToken }
      ),
      { params: Promise.resolve({ roleId: role.id }) }
    );
    const body = await response.json();
    const revokedSession = await prisma.session.findUniqueOrThrow({
      where: { id: auditorSession.id }
    });

    expect(response.status).toBe(200);
    expect(body.permissions).toEqual([
      {
        code: "Platform.ManageUsers",
        name: "Gestionar usuarios"
      }
    ]);
    expect(revokedSession.revokedAt).toBeInstanceOf(Date);
    expect(revokedSession.revokeReason).toBe("ROLE_PERMISSIONS_CHANGED");
  });

  it("requires an idempotency key before updating role permissions", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const createRoleResponse = await rolesPost(
      jsonRequest(
        "/api/platform/roles",
        {
          code: "ConsultaAuditoria",
          name: "Consulta auditoria",
          permissionCodes: ["Platform.ViewAudit"]
        },
        { csrfToken }
      )
    );
    const role = (await createRoleResponse.json()) as { id: string };

    const response = await rolePatch(
      jsonRequest(
        `/api/platform/roles/${role.id}`,
        { permissionCodes: ["Platform.ManageUsers"] },
        { csrfToken, idempotencyKey: null }
      ),
      { params: Promise.resolve({ roleId: role.id }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
  });

  it("rejects role permission PATCH for protected roles", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const administrator = await prisma.role.findUniqueOrThrow({
      where: { code: "Administrador" }
    });

    const response = await rolePatch(
      jsonRequest(
        `/api/platform/roles/${administrator.id}`,
        { permissionCodes: ["Platform.ViewAudit"] },
        { csrfToken }
      ),
      { params: Promise.resolve({ roleId: administrator.id }) }
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      code: "ROLE_PROTECTED",
      message: "No se pueden modificar permisos de un rol protegido."
    });
  });

  it("denies users and roles endpoints without the required permission", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    await rolesPost(
      jsonRequest(
        "/api/platform/roles",
        {
          code: "ConsultaAuditoria",
          name: "Consulta auditoria",
          permissionCodes: ["Platform.ViewAudit"]
        },
        { csrfToken }
      )
    );
    await usersPost(
      jsonRequest(
        "/api/platform/users",
        {
          ...createUserPayload(),
          userName: "auditor",
          roleCode: "ConsultaAuditoria"
        },
        { csrfToken }
      )
    );
    cookieMock.reset();
    await loginWith("auditor", createUserPayload().password);

    const usersResponse = await usersGet(apiRequest("/api/platform/users"));
    const rolesResponse = await rolesGet(apiRequest("/api/platform/roles"));
    const usersBody = await usersResponse.json();
    const rolesBody = await rolesResponse.json();

    expect(usersResponse.status).toBe(403);
    expect(rolesResponse.status).toBe(403);
    expect(usersBody).toEqual({
      code: "FORBIDDEN",
      message: "No tienes permiso para realizar esta accion."
    });
    expect(rolesBody).toEqual({
      code: "FORBIDDEN",
      message: "No tienes permiso para realizar esta accion."
    });
  });

  it("propagates correlation id in forbidden user responses and audit events", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const correlationId = "test-correlation-001";

    await rolesPost(
      jsonRequest(
        "/api/platform/roles",
        {
          code: "ConsultaAuditoria",
          name: "Consulta auditoria",
          permissionCodes: ["Platform.ViewAudit"]
        },
        { csrfToken }
      )
    );
    await usersPost(
      jsonRequest(
        "/api/platform/users",
        {
          ...createUserPayload(),
          userName: "auditor",
          roleCode: "ConsultaAuditoria"
        },
        { csrfToken }
      )
    );
    cookieMock.reset();
    await loginWith("auditor", createUserPayload().password);

    const response = await usersGet(
      new Request("http://localhost/api/platform/users", {
        headers: {
          "X-Correlation-ID": correlationId
        }
      })
    );
    const body = await response.json();
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: {
        eventType: "ACCESS_DENIED",
        payload: {
          path: ["correlationId"],
          equals: correlationId
        }
      }
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("X-Correlation-ID")).toBe(correlationId);
    expect(body).toEqual({
      code: "FORBIDDEN",
      message: "No tienes permiso para realizar esta accion.",
      correlationId
    });
    expect(auditEvent.payload).toMatchObject({
      permission: "Platform.ManageUsers",
      correlationId
    });
  });
});

function createUserPayload() {
  return {
    displayName: "Usuario Gestion",
    userName: "gestion",
    password: "Cambiar-esta-clave-2026",
    roleCode: "Administrador"
  };
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

async function createUserThroughHttp(csrfToken: string): Promise<{ id: string }> {
  const response = await usersPost(
    jsonRequest("/api/platform/users", createUserPayload(), { csrfToken })
  );
  const body = (await response.json()) as { id?: string };

  expect(response.status).toBe(201);

  if (!body.id) {
    throw new Error("User creation did not return an id.");
  }

  return { id: body.id };
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

    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
