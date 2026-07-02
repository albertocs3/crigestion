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
  listActiveSessions,
  revokeActiveSession
} from "@/modules/platform/application/sessions";
import {
  createUser,
  type CreateUserCommand
} from "@/modules/platform/application/users";

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

const managedUserCommand: CreateUserCommand = {
  displayName: "Usuario Gestion",
  userName: "gestion",
  password: "Cambiar-gestion-2026",
  roleCode: "Administrador"
};

describe("platform sessions", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await initializeForSessions();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("lists active sessions as DTOs without token material", async () => {
    const admin = await loginAsAdminWithPermission();
    await createUser(managedUserCommand, admin.authorization.user);
    await login({
      userName: managedUserCommand.userName,
      password: managedUserCommand.password
    });

    const sessions = await listActiveSessions(admin.authorization.sessionId);
    const serialized = JSON.stringify(sessions);

    expect(sessions).toHaveLength(2);
    expect(sessions.some((session) => session.isCurrentSession)).toBe(true);
    expect(serialized).not.toContain("tokenHash");
    expect(serialized).not.toContain(admin.token);
  });

  it("excludes expired sessions from active session listings", async () => {
    const admin = await loginAsAdminWithPermission();
    await createUser(managedUserCommand, admin.authorization.user);
    const managedLogin = await login({
      userName: managedUserCommand.userName,
      password: managedUserCommand.password
    });

    expect(managedLogin.ok).toBe(true);

    if (!managedLogin.ok) {
      return;
    }

    await prisma.session.update({
      where: { tokenHash: hashSessionToken(managedLogin.value.token) },
      data: {
        expiresAt: new Date(Date.now() - 1_000)
      }
    });

    const sessions = await listActiveSessions(admin.authorization.sessionId);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(admin.authorization.sessionId);
  });

  it("revokes a remote active session and audits the action", async () => {
    const admin = await loginAsAdminWithPermission();
    await createUser(managedUserCommand, admin.authorization.user);
    const managedLogin = await login({
      userName: managedUserCommand.userName,
      password: managedUserCommand.password
    });

    expect(managedLogin.ok).toBe(true);

    if (!managedLogin.ok) {
      return;
    }

    const managedSession = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashSessionToken(managedLogin.value.token) }
    });
    const result = await revokeActiveSession(
      managedSession.id,
      admin.authorization.user,
      admin.authorization.sessionId
    );

    expect(result).toEqual({
      ok: true,
      status: 200,
      value: { revoked: true }
    });

    const revokedSession = await prisma.session.findUniqueOrThrow({
      where: { id: managedSession.id }
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "SESSION_REVOKED" }
    });

    expect(revokedSession.revokedAt).toBeInstanceOf(Date);
    expect(revokedSession.revokeReason).toBe("ADMIN_SESSION_REVOKED");
    expect(auditEvent.payload).toMatchObject({
      actorUserId: admin.authorization.user.id,
      sessionId: managedSession.id,
      userId: managedSession.userId,
      reason: "ADMIN_SESSION_REVOKED"
    });
  });

  it("does not allow revoking the current session from the management action", async () => {
    const admin = await loginAsAdminWithPermission();
    const result = await revokeActiveSession(
      admin.authorization.sessionId,
      admin.authorization.user,
      admin.authorization.sessionId
    );

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "SELF_SESSION_REVOKE_NOT_ALLOWED",
        message: "Usa cerrar sesion para finalizar tu sesion actual."
      }
    });
  });
});

async function loginAsAdminWithPermission() {
  const loginResult = await login({
    userName: "admin",
    password: adminPassword
  });

  if (!loginResult.ok) {
    throw new Error(loginResult.error.code);
  }

  const authorization = await requirePermission(
    loginResult.value.token,
    "Platform.ManageSessions"
  );

  if (!authorization.ok) {
    throw new Error(authorization.error.code);
  }

  return {
    token: loginResult.value.token,
    authorization
  };
}

async function initializeForSessions(): Promise<void> {
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
