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
  changeUserRole,
  createUser,
  deactivateUser,
  listUsers,
  reactivateUser,
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

const newUserCommand: CreateUserCommand = {
  displayName: "Usuario Gestion",
  userName: "gestion",
  password: "Cambiar-esta-clave-2026",
  roleCode: "Administrador"
};

describe("platform users", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await initializeForUsers();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("creates a user without exposing or auditing passwords", async () => {
    const actor = await getAdminActor();
    const result = await createUser(newUserCommand, actor);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.value).toMatchObject({
      displayName: "Usuario Gestion",
      userName: "gestion",
      status: "ACTIVE",
      role: {
        code: "Administrador"
      }
    });

    const user = await prisma.user.findUniqueOrThrow({
      where: { normalizedUserName: "gestion" }
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "USER_CREATED" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(user.passwordHash).not.toBe(newUserCommand.password);
    expect(auditPayload).not.toContain(newUserCommand.password);
    expect(auditPayload).not.toContain(user.passwordHash);
  });

  it("lists users as DTOs without password hashes", async () => {
    const actor = await getAdminActor();
    await createUser(newUserCommand, actor);

    const users = await listUsers();
    const serializedUsers = JSON.stringify(users);

    expect(users).toHaveLength(2);
    expect(serializedUsers).not.toContain("passwordHash");
    expect(users.map((user) => user.userName)).toEqual(["admin", "gestion"]);
  });

  it("rejects duplicate or reserved user names", async () => {
    const actor = await getAdminActor();

    await createUser(newUserCommand, actor);
    const duplicate = await createUser(newUserCommand, actor);

    expect(duplicate).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "USER_NAME_ALREADY_USED",
        message: "El nombre de usuario ya esta reservado."
      }
    });
  });

  it("denies user management without Platform.ManageUsers", async () => {
    const role = await prisma.role.create({
      data: {
        code: "SinPermisos",
        name: "Sin permisos",
        isProtected: false
      }
    });
    const actor = await getAdminActor();

    await createUser(
      {
        displayName: "Usuario Sin Permisos",
        userName: "sinpermisos",
        password: "Cambiar-esta-clave-2026",
        roleCode: role.code
      },
      actor
    );

    const loginResult = await login({
      userName: "sinpermisos",
      password: "Cambiar-esta-clave-2026"
    });

    expect(loginResult.ok).toBe(true);

    if (!loginResult.ok) {
      return;
    }

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

  it("deactivates a user and revokes active sessions", async () => {
    const actor = await getAdminActor();

    await createUser(newUserCommand, actor);
    const loginResult = await login({
      userName: "gestion",
      password: newUserCommand.password
    });

    expect(loginResult.ok).toBe(true);

    if (!loginResult.ok) {
      return;
    }

    const user = await prisma.user.findUniqueOrThrow({
      where: { normalizedUserName: "gestion" }
    });
    const result = await deactivateUser(user.id, actor);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    const session = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashSessionToken(loginResult.value.token) }
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "USER_DEACTIVATED" }
    });

    expect(result.value.status).toBe("INACTIVE");
    expect(session.revokedAt).toBeInstanceOf(Date);
    expect(session.revokeReason).toBe("USER_DEACTIVATED");
    expect(JSON.stringify(auditEvent.payload)).toContain(user.id);
  });

  it("reactivates a deactivated user", async () => {
    const actor = await getAdminActor();

    await createUser(newUserCommand, actor);
    const user = await prisma.user.findUniqueOrThrow({
      where: { normalizedUserName: "gestion" }
    });

    await deactivateUser(user.id, actor);
    const result = await reactivateUser(user.id, actor);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.value.status).toBe("ACTIVE");
    expect(result.value.lockedUntil).toBeNull();
  });

  it("changes a user role and revokes active sessions", async () => {
    const actor = await getAdminActor();
    const role = await prisma.role.create({
      data: {
        code: "ConsultaAuditoria",
        name: "Consulta auditoria",
        isProtected: false
      }
    });

    await createUser(newUserCommand, actor);
    const loginResult = await login({
      userName: "gestion",
      password: newUserCommand.password
    });

    expect(loginResult.ok).toBe(true);

    if (!loginResult.ok) {
      return;
    }

    const user = await prisma.user.findUniqueOrThrow({
      where: { normalizedUserName: "gestion" }
    });
    const result = await changeUserRole(user.id, role.code, actor);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    const session = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashSessionToken(loginResult.value.token) }
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "USER_ROLE_CHANGED" }
    });
    const persistedUser = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { role: true }
    });

    expect(result.value.role.code).toBe(role.code);
    expect(persistedUser.role.code).toBe(role.code);
    expect(persistedUser.securityVersion).toBeGreaterThan(user.securityVersion);
    expect(session.revokedAt).toBeInstanceOf(Date);
    expect(session.revokeReason).toBe("USER_ROLE_CHANGED");
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      userId: user.id,
      previousRoleCode: "Administrador",
      newRoleCode: role.code
    });
  });

  it("does not allow changing your own status", async () => {
    const actor = await getAdminActor();
    const result = await deactivateUser(actor.id, actor);

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "SELF_STATUS_CHANGE_NOT_ALLOWED",
        message: "No puedes cambiar tu propio estado."
      }
    });
  });

  it("does not allow changing your own role", async () => {
    const actor = await getAdminActor();
    const result = await changeUserRole(actor.id, "Administrador", actor);

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "SELF_ROLE_CHANGE_NOT_ALLOWED",
        message: "No puedes cambiar tu propio rol."
      }
    });
  });
});

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
    "Platform.ManageUsers"
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

async function initializeForUsers(): Promise<void> {
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
