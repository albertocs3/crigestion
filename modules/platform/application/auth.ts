import "server-only";

import {
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { normalizeUserName } from "@/modules/platform/application/installation";
import {
  dummyPasswordHash,
  hashPassword,
  verifyPassword
} from "@/modules/platform/application/passwords";

const sessionDurationMs = 5 * 60 * 60 * 1000;
const maxFailedAttempts = 5;
const lockDurationMs = 30 * 60 * 1000;
const genericLoginError = {
  code: "INVALID_CREDENTIALS",
  message: "Usuario o contrasena incorrectos."
} as const;

export const sessionCookieName =
  process.env.AUTH_COOKIE_NAME ?? "crigestion_session";

export const loginSchema = z.object({
  userName: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200)
});

const strongPasswordSchema = z
  .string()
  .min(12)
  .max(200)
  .regex(/[a-z]/, "La contrasena debe incluir una minuscula.")
  .regex(/[A-Z]/, "La contrasena debe incluir una mayuscula.")
  .regex(/[0-9]/, "La contrasena debe incluir un numero.")
  .regex(/[^a-zA-Z0-9]/, "La contrasena debe incluir un caracter especial.");

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: strongPasswordSchema
});

export type LoginCommand = z.infer<typeof loginSchema>;
export type ChangePasswordCommand = z.infer<typeof changePasswordSchema>;

export type RequestContext = {
  ipAddress?: string;
  userAgent?: string;
};

export type LoginResult =
  | {
      ok: true;
      value: {
        token: string;
        expiresAt: Date;
        user: SessionUser;
      };
    }
  | {
      ok: false;
      status: 401 | 409 | 423;
      error: {
        code: "INVALID_CREDENTIALS" | "ACCOUNT_LOCKED" | "ACTIVE_SESSION_EXISTS";
        message: string;
      };
    };

export type LogoutResult =
  | { ok: true }
  | {
      ok: false;
      status: 401;
      error: { code: "UNAUTHENTICATED"; message: string };
    };

export type ChangePasswordResult =
  | { ok: true; status: 200 }
  | {
      ok: false;
      status: 401 | 409;
      error: {
        code:
          | "UNAUTHENTICATED"
          | "INVALID_CURRENT_PASSWORD"
          | "PASSWORD_REUSE_NOT_ALLOWED";
        message: string;
      };
    };

export type SessionUser = {
  id: string;
  displayName: string;
  userName: string;
  role: {
    code: string;
    name: string;
  };
  permissions: string[];
};

export type SessionState =
  | { authenticated: false }
  | {
      authenticated: true;
      user: SessionUser;
      expiresAt: string;
    };

export type CsrfValidationResult =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 403;
      error: {
        code: "UNAUTHENTICATED" | "CSRF_TOKEN_INVALID";
        message: string;
      };
    };

export async function login(
  command: LoginCommand,
  context: RequestContext = {}
): Promise<LoginResult> {
  const normalizedUserName = normalizeUserName(command.userName);
  const now = new Date();
  const user = await prisma.user.findUnique({
    where: { normalizedUserName },
    include: {
      role: {
        include: {
          permissions: {
            include: {
              permission: true
            }
          }
        }
      }
    }
  });

  if (!user) {
    verifyPassword(command.password, dummyPasswordHash());
    await recordLoginAttempt(normalizedUserName, false, "INVALID_CREDENTIALS", context);
    await auditLogin("LOGIN_FAILED", {
      normalizedUserName,
      reason: "INVALID_CREDENTIALS"
    });
    return invalidCredentials();
  }

  if (user.status === "LOCKED" && user.lockedUntil && user.lockedUntil > now) {
    const lockedUntil = new Date(now.getTime() + lockDurationMs);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { lockedUntil }
      }),
      prisma.loginAttempt.create({
        data: {
          normalizedUserName,
          succeeded: false,
          failureCode: "ACCOUNT_LOCKED",
          ipAddress: context.ipAddress,
          userAgent: context.userAgent
        }
      }),
      prisma.auditEvent.create({
        data: {
          eventType: "LOGIN_FAILED",
          actorType: "USER",
          payload: {
            userId: user.id,
            reason: "ACCOUNT_LOCKED"
          }
        }
      })
    ]);

    return {
      ok: false,
      status: 423,
      error: {
        code: "ACCOUNT_LOCKED",
        message: "La cuenta esta bloqueada temporalmente."
      }
    };
  }

  if (user.status !== "ACTIVE") {
    await recordLoginAttempt(normalizedUserName, false, "INVALID_CREDENTIALS", context);
    await auditLogin("LOGIN_FAILED", {
      userId: user.id,
      reason: "INVALID_CREDENTIALS"
    });
    return invalidCredentials();
  }

  if (!verifyPassword(command.password, user.passwordHash)) {
    const failedLoginCount = user.failedLoginCount + 1;
    const shouldLock = failedLoginCount >= maxFailedAttempts;
    const lockedUntil = shouldLock
      ? new Date(now.getTime() + lockDurationMs)
      : undefined;

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount,
          status: shouldLock ? "LOCKED" : user.status,
          lockedUntil
        }
      }),
      prisma.loginAttempt.create({
        data: {
          normalizedUserName,
          succeeded: false,
          failureCode: shouldLock ? "ACCOUNT_LOCKED" : "INVALID_CREDENTIALS",
          ipAddress: context.ipAddress,
          userAgent: context.userAgent
        }
      }),
      prisma.auditEvent.create({
        data: {
          eventType: "LOGIN_FAILED",
          actorType: "USER",
          payload: {
            userId: user.id,
            reason: shouldLock ? "ACCOUNT_LOCKED" : "INVALID_CREDENTIALS"
          }
        }
      })
    ]);

    return invalidCredentials();
  }

  const activeSession = await prisma.session.findFirst({
    where: {
      userId: user.id,
      revokedAt: null,
      expiresAt: {
        gt: now
      }
    },
    select: { id: true }
  });

  if (activeSession) {
    await recordLoginAttempt(normalizedUserName, false, "ACTIVE_SESSION_EXISTS", context);
    await auditLogin("LOGIN_FAILED", {
      userId: user.id,
      reason: "ACTIVE_SESSION_EXISTS"
    });

    return {
      ok: false,
      status: 409,
      error: {
        code: "ACTIVE_SESSION_EXISTS",
        message: "Ya existe una sesion activa para este usuario."
      }
    };
  }

  const token = createSessionToken();
  const expiresAt = new Date(now.getTime() + sessionDurationMs);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: now
      }
    }),
    prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashSessionToken(token),
        startedAt: now,
        lastActivityAt: now,
        expiresAt,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        securityVersion: user.securityVersion
      }
    }),
    prisma.loginAttempt.create({
      data: {
        normalizedUserName,
        succeeded: true,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent
      }
    }),
    prisma.auditEvent.create({
      data: {
        eventType: "LOGIN_SUCCEEDED",
        actorType: "USER",
        payload: {
          userId: user.id
        }
      }
    })
  ]);

  return {
    ok: true,
    value: {
      token,
      expiresAt,
      user: mapSessionUser(user)
    }
  };
}

export async function logout(token: string | undefined): Promise<LogoutResult> {
  if (!token) {
    return unauthenticated();
  }

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    select: {
      id: true,
      userId: true,
      revokedAt: true
    }
  });

  if (!session || session.revokedAt) {
    return unauthenticated();
  }

  await prisma.$transaction([
    prisma.session.update({
      where: { id: session.id },
      data: {
        revokedAt: new Date(),
        revokeReason: "USER_LOGOUT"
      }
    }),
    prisma.auditEvent.create({
      data: {
        eventType: "LOGOUT_SUCCEEDED",
        actorType: "USER",
        payload: {
          userId: session.userId,
          sessionId: session.id
        }
      }
    })
  ]);

  return { ok: true };
}

export async function changePassword(
  token: string | undefined,
  command: ChangePasswordCommand
): Promise<ChangePasswordResult> {
  const session = await getValidSession(token);

  if (!session) {
    return {
      ok: false,
      status: 401,
      error: {
        code: "UNAUTHENTICATED",
        message: "No hay una sesion activa."
      }
    };
  }

  if (!verifyPassword(command.currentPassword, session.user.passwordHash)) {
    await prisma.auditEvent.create({
      data: {
        eventType: "PASSWORD_CHANGE_FAILED",
        actorType: "USER",
        payload: {
          userId: session.userId,
          reason: "INVALID_CURRENT_PASSWORD"
        }
      }
    });

    return {
      ok: false,
      status: 401,
      error: {
        code: "INVALID_CURRENT_PASSWORD",
        message: "La contrasena actual no es correcta."
      }
    };
  }

  if (verifyPassword(command.newPassword, session.user.passwordHash)) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "PASSWORD_REUSE_NOT_ALLOWED",
        message: "La nueva contrasena debe ser distinta de la actual."
      }
    };
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: session.userId },
      data: {
        passwordHash: hashPassword(command.newPassword),
        securityVersion: {
          increment: 1
        }
      }
    }),
    prisma.session.updateMany({
      where: {
        userId: session.userId,
        revokedAt: null
      },
      data: {
        revokedAt: new Date(),
        revokeReason: "USER_PASSWORD_CHANGED"
      }
    }),
    prisma.auditEvent.create({
      data: {
        eventType: "PASSWORD_CHANGED",
        actorType: "USER",
        payload: {
          userId: session.userId,
          sessionId: session.id
        }
      }
    })
  ]);

  return {
    ok: true,
    status: 200
  };
}

export async function getSessionState(
  token: string | undefined
): Promise<SessionState> {
  const session = await getValidSession(token);

  if (!session) {
    return { authenticated: false };
  }

  return {
    authenticated: true,
    user: mapSessionUser(session.user),
    expiresAt: session.expiresAt.toISOString()
  };
}

export async function getValidSession(token: string | undefined) {
  if (!token) {
    return null;
  }

  const now = new Date();
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: {
      user: {
        include: {
          role: {
            include: {
              permissions: {
                include: {
                  permission: true
                }
              }
            }
          }
        }
      }
    }
  });

  if (
    !session ||
    session.revokedAt ||
    session.expiresAt <= now ||
    session.user.status !== "ACTIVE" ||
    session.securityVersion !== session.user.securityVersion
  ) {
    return null;
  }

  await prisma.session.update({
    where: { id: session.id },
    data: { lastActivityAt: now }
  });

  return session;
}

export async function requirePermission(
  token: string | undefined,
  permission: string
): Promise<
  | { ok: true; user: SessionUser; sessionId: string }
  | {
      ok: false;
      status: 401 | 403;
      error: {
        code: "UNAUTHENTICATED" | "FORBIDDEN";
        message: string;
      };
    }
> {
  const session = await getValidSession(token);

  if (!session) {
    return {
      ok: false,
      status: 401,
      error: {
        code: "UNAUTHENTICATED",
        message: "No hay una sesion activa."
      }
    };
  }

  const user = mapSessionUser(session.user);

  if (!user.permissions.includes(permission)) {
    await prisma.auditEvent.create({
      data: {
        eventType: "ACCESS_DENIED",
        actorType: "USER",
        payload: {
          userId: user.id,
          permission
        }
      }
    });

    return {
      ok: false,
      status: 403,
      error: {
        code: "FORBIDDEN",
        message: "No tienes permiso para realizar esta accion."
      }
    };
  }

  return {
    ok: true,
    user,
    sessionId: session.id
  };
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHmac("sha256", getSessionSecret()).update(token).digest("hex");
}

export function createCsrfToken(token: string): string {
  return createHmac("sha256", getSessionSecret())
    .update(`csrf:${token}`)
    .digest("base64url");
}

export function validateCsrfToken(
  sessionToken: string | undefined,
  submittedToken: string | null
): CsrfValidationResult {
  if (!sessionToken) {
    return {
      ok: false,
      status: 401,
      error: {
        code: "UNAUTHENTICATED",
        message: "No hay una sesion activa."
      }
    };
  }

  if (!submittedToken || !safeTokenEquals(submittedToken, createCsrfToken(sessionToken))) {
    return {
      ok: false,
      status: 403,
      error: {
        code: "CSRF_TOKEN_INVALID",
        message: "Token CSRF invalido."
      }
    };
  }

  return { ok: true };
}

function safeTokenEquals(submittedToken: string, expectedToken: string): boolean {
  const submitted = Buffer.from(submittedToken);
  const expected = Buffer.from(expectedToken);

  return submitted.length === expected.length && timingSafeEqual(submitted, expected);
}

function mapSessionUser(user: {
  id: string;
  displayName: string;
  userName: string;
  role: {
    code: string;
    name: string;
    permissions: Array<{
      permission: {
        code: string;
      };
    }>;
  };
}): SessionUser {
  return {
    id: user.id,
    displayName: user.displayName,
    userName: user.userName,
    role: {
      code: user.role.code,
      name: user.role.name
    },
    permissions: user.role.permissions.map((rolePermission) => rolePermission.permission.code)
  };
}

async function recordLoginAttempt(
  normalizedUserName: string,
  succeeded: boolean,
  failureCode: string | null,
  context: RequestContext
): Promise<void> {
  await prisma.loginAttempt.create({
    data: {
      normalizedUserName,
      succeeded,
      failureCode,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent
    }
  });
}

async function auditLogin(
  eventType: "LOGIN_FAILED" | "LOGIN_SUCCEEDED",
  payload: Record<string, string>
): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      eventType,
      actorType: "USER",
      payload
    }
  });
}

function invalidCredentials(): LoginResult {
  return {
    ok: false,
    status: 401,
    error: genericLoginError
  };
}

function unauthenticated(): LogoutResult {
  return {
    ok: false,
    status: 401,
    error: {
      code: "UNAUTHENTICATED",
      message: "No hay una sesion activa."
    }
  };
}

function getSessionSecret(): string {
  const secret = process.env.APP_SESSION_SECRET;

  if (!secret || secret === "change-me-in-local-env") {
    throw new Error("APP_SESSION_SECRET must be configured.");
  }

  return secret;
}
