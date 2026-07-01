import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  changePassword,
  createCsrfToken,
  hashSessionToken,
  login,
  logout,
  validateCsrfToken
} from "@/modules/platform/application/auth";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";

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

describe("platform authentication", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await initializeForAuth();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("creates a single opaque-token session on valid login", async () => {
    const result = await login({
      userName: "admin",
      password: baseCommand.administrator.password
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    const session = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashSessionToken(result.value.token) }
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { normalizedUserName: "admin" }
    });

    expect(session.tokenHash).not.toBe(result.value.token);
    expect(session.userId).toBe(user.id);
    expect(session.revokedAt).toBeNull();
    expect(result.value.user.permissions).toContain("Platform.ManageUsers");
  });

  it("rejects a second active session for the same user", async () => {
    await login({
      userName: "admin",
      password: baseCommand.administrator.password
    });

    const second = await login({
      userName: "admin",
      password: baseCommand.administrator.password
    });

    expect(second).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "ACTIVE_SESSION_EXISTS",
        message: "Ya existe una sesion activa para este usuario."
      }
    });
  });

  it("revokes expired sessions before creating a new one", async () => {
    const first = await login({
      userName: "admin",
      password: baseCommand.administrator.password
    });

    expect(first.ok).toBe(true);

    if (!first.ok) {
      return;
    }

    const expiredAt = new Date(Date.now() - 1_000);
    await prisma.session.update({
      where: { tokenHash: hashSessionToken(first.value.token) },
      data: {
        expiresAt: expiredAt
      }
    });

    const second = await login({
      userName: "admin",
      password: baseCommand.administrator.password
    });

    expect(second.ok).toBe(true);

    const oldSession = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashSessionToken(first.value.token) }
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { normalizedUserName: "admin" }
    });
    const activeSessionCount = await prisma.session.count({
      where: {
        userId: user.id,
        revokedAt: null
      }
    });

    expect(oldSession.revokedAt).toBeInstanceOf(Date);
    expect(oldSession.revokeReason).toBe("SESSION_EXPIRED");
    expect(activeSessionCount).toBe(1);
  });

  it("revokes the session on logout", async () => {
    const result = await login({
      userName: "admin",
      password: baseCommand.administrator.password
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    await logout(result.value.token);

    const session = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashSessionToken(result.value.token) }
    });

    expect(session.revokedAt).toBeInstanceOf(Date);
    expect(session.revokeReason).toBe("USER_LOGOUT");
  });

  it("validates CSRF tokens derived from the session token", async () => {
    const result = await login({
      userName: "admin",
      password: baseCommand.administrator.password
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    const csrfToken = createCsrfToken(result.value.token);

    expect(validateCsrfToken(result.value.token, csrfToken)).toEqual({ ok: true });
    expect(validateCsrfToken(result.value.token, "invalid")).toEqual({
      ok: false,
      status: 403,
      error: {
        code: "CSRF_TOKEN_INVALID",
        message: "Token CSRF invalido."
      }
    });
  });

  it("locks the user after five failed attempts without storing passwords", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login({
        userName: "admin",
        password: "Clave-incorrecta-2026"
      });
    }

    const user = await prisma.user.findUniqueOrThrow({
      where: { normalizedUserName: "admin" }
    });
    const attempts = await prisma.loginAttempt.findMany({
      where: { normalizedUserName: "admin" }
    });
    const auditPayloads = await prisma.auditEvent.findMany({
      where: { eventType: "LOGIN_FAILED" },
      select: { payload: true }
    });
    const serializedAudit = JSON.stringify(auditPayloads);

    expect(user.status).toBe("LOCKED");
    expect(user.lockedUntil).toBeInstanceOf(Date);
    expect(attempts).toHaveLength(5);
    expect(serializedAudit).not.toContain("Clave-incorrecta-2026");
  });

  it("changes password, revokes sessions, and does not audit secrets", async () => {
    const loginResult = await login({
      userName: "admin",
      password: baseCommand.administrator.password
    });

    expect(loginResult.ok).toBe(true);

    if (!loginResult.ok) {
      return;
    }

    const newPassword = "Nueva-clave-segura-2026";
    const result = await changePassword(loginResult.value.token, {
      currentPassword: baseCommand.administrator.password,
      newPassword
    });

    expect(result).toEqual({
      ok: true,
      status: 200
    });

    const session = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashSessionToken(loginResult.value.token) }
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { normalizedUserName: "admin" }
    });
    const auditEvents = await prisma.auditEvent.findMany({
      where: { eventType: "PASSWORD_CHANGED" },
      select: { payload: true }
    });
    const oldPasswordLogin = await login({
      userName: "admin",
      password: baseCommand.administrator.password
    });
    const newPasswordLogin = await login({
      userName: "admin",
      password: newPassword
    });

    expect(session.revokedAt).toBeInstanceOf(Date);
    expect(session.revokeReason).toBe("USER_PASSWORD_CHANGED");
    expect(user.passwordHash).not.toContain(newPassword);
    expect(user.securityVersion).toBeGreaterThan(1);
    expect(oldPasswordLogin.ok).toBe(false);
    expect(newPasswordLogin.ok).toBe(true);
    expect(JSON.stringify(auditEvents)).not.toContain(baseCommand.administrator.password);
    expect(JSON.stringify(auditEvents)).not.toContain(newPassword);
    expect(JSON.stringify(auditEvents)).not.toContain(user.passwordHash);
  });

  it("rejects invalid current password without auditing the submitted password", async () => {
    const loginResult = await login({
      userName: "admin",
      password: baseCommand.administrator.password
    });

    expect(loginResult.ok).toBe(true);

    if (!loginResult.ok) {
      return;
    }

    const result = await changePassword(loginResult.value.token, {
      currentPassword: "Clave-incorrecta-2026",
      newPassword: "Nueva-clave-segura-2026"
    });
    const session = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashSessionToken(loginResult.value.token) }
    });
    const auditEvents = await prisma.auditEvent.findMany({
      where: { eventType: "PASSWORD_CHANGE_FAILED" },
      select: { payload: true }
    });

    expect(result).toEqual({
      ok: false,
      status: 401,
      error: {
        code: "INVALID_CURRENT_PASSWORD",
        message: "La contrasena actual no es correcta."
      }
    });
    expect(session.revokedAt).toBeNull();
    expect(JSON.stringify(auditEvents)).not.toContain("Clave-incorrecta-2026");
  });
});

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
