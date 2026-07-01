import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  hashSessionToken,
  login,
  requirePermission
} from "@/modules/platform/application/auth";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";
import {
  createRole,
  listRoles,
  type CreateRoleCommand
} from "@/modules/platform/application/roles";
import {
  createUser,
  type CreateUserCommand
} from "@/modules/platform/application/users";

const baseCommand: InitializeCommand = {
  company: {
    legalName: "CriGestion Test SL",
    taxId: "B12345678",
    email: "admin@example.test"
  },
  administrator: {
    displayName: "Administrador",
    userName: "admin",
    password: "Cambiar-esta-clave-2026"
  }
};

const limitedRoleCommand: CreateRoleCommand = {
  code: "ConsultaAuditoria",
  name: "Consulta auditoria",
  permissionCodes: ["Platform.ViewAudit"]
};

describe("platform roles", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await initializeForRoles();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("creates a custom role with selected permissions", async () => {
    const actor = await getAdminActor();
    const result = await createRole(limitedRoleCommand, actor);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.value).toMatchObject({
      code: "ConsultaAuditoria",
      name: "Consulta auditoria",
      isProtected: false,
      permissions: [{ code: "Platform.ViewAudit", name: "Consultar auditoria" }]
    });

    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "ROLE_CREATED" }
    });

    expect(JSON.stringify(auditEvent.payload)).toContain("ConsultaAuditoria");
  });

  it("rejects duplicate role codes", async () => {
    const actor = await getAdminActor();

    await createRole(limitedRoleCommand, actor);
    const duplicate = await createRole(limitedRoleCommand, actor);

    expect(duplicate).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "ROLE_CODE_ALREADY_USED",
        message: "El codigo de rol ya existe."
      }
    });
  });

  it("lists roles as DTOs with user counts", async () => {
    const actor = await getAdminActor();

    await createRole(limitedRoleCommand, actor);

    const roles = await listRoles();
    const customRole = roles.find((role) => role.code === "ConsultaAuditoria");

    expect(customRole).toBeDefined();
    expect(customRole?.userCount).toBe(0);
    expect(JSON.stringify(roles)).not.toContain("passwordHash");
  });

  it("lets a limited role sign in but denies user management", async () => {
    const actor = await getAdminActor();

    await createRole(limitedRoleCommand, actor);
    await createUser(createLimitedUserCommand(), actor);

    const loginResult = await login({
      userName: "auditor",
      password: "Cambiar-auditor-2026"
    });

    expect(loginResult.ok).toBe(true);

    if (!loginResult.ok) {
      return;
    }

    expect(loginResult.value.user.permissions).toEqual(["Platform.ViewAudit"]);

    const authorization = await requirePermission(
      loginResult.value.token,
      "Platform.ManageUsers"
    );

    expect(authorization).toEqual({
      ok: false,
      status: 403,
      error: {
        code: "FORBIDDEN",
        message: "No tienes permiso para realizar esta accion."
      }
    });
  });
});

function createLimitedUserCommand(): CreateUserCommand {
  return {
    displayName: "Usuario Auditor",
    userName: "auditor",
    password: "Cambiar-auditor-2026",
    roleCode: "ConsultaAuditoria"
  };
}

async function getAdminActor() {
  const loginResult = await login({
    userName: "admin",
    password: baseCommand.administrator.password
  });

  if (!loginResult.ok) {
    throw new Error(loginResult.error.code);
  }

  const authorization = await requirePermission(
    loginResult.value.token,
    "Platform.ManageRoles"
  );

  if (!authorization.ok) {
    throw new Error(authorization.error.code);
  }

  await prisma.session.update({
    where: { tokenHash: hashSessionToken(loginResult.value.token) },
    data: { revokedAt: new Date(), revokeReason: "TEST_RESET" }
  });

  return authorization.user;
}

async function initializeForRoles(): Promise<void> {
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
