import "server-only";

import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { normalizeUserName } from "@/modules/platform/application/installation";
import {
  getSessionCookieName,
  getSessionSecret,
} from "@/modules/platform/application/environment";
import {
  dummyPasswordHash,
  hashPassword,
  verifyPassword
} from "@/modules/platform/application/passwords";

const sessionDurationMs = 5 * 60 * 60 * 1000;
const maxFailedAttempts = 5;
const lockDurationMs = 30 * 60 * 1000;
const loginRateLimitWindowMs = 15 * 60 * 1000;
const maxLoginAttemptsByIp = 20;
const genericLoginError = {
  code: "INVALID_CREDENTIALS",
  message: "Usuario o contrasena incorrectos."
} as const;

class ActiveSessionExistsError extends Error {}
class LoginStateChangedError extends Error {}

export const sessionCookieName = getSessionCookieName();

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
  correlationId?: string;
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
      status: 401 | 409 | 429;
      error: {
        code:
          | "INVALID_CREDENTIALS"
          | "ACTIVE_SESSION_EXISTS"
          | "LOGIN_RATE_LIMITED";
        message: string;
        retryAfterSeconds?: number;
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

  const rateLimit = await consumeLoginRateLimit(context, now);

  if (rateLimit.limited) {
    await recordLoginAttempt(normalizedUserName, false, "LOGIN_RATE_LIMITED", context);
    await auditLogin("LOGIN_FAILED", {
      normalizedUserName,
      reason: "LOGIN_RATE_LIMITED"
    });

    return {
      ok: false,
      status: 429,
      error: {
        code: "LOGIN_RATE_LIMITED",
        message: "Demasiados intentos de acceso. Espera antes de reintentar.",
        retryAfterSeconds: rateLimit.retryAfterSeconds
      }
    };
  }

  let user = await findUserForLogin(normalizedUserName);

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
    verifyPassword(command.password, user.passwordHash);
    await recordAttemptDuringActiveLock(user.id, normalizedUserName, context, now);

    return invalidCredentials();
  }

  const lockExpired =
    user.status === "LOCKED" &&
    user.lockedUntil !== null &&
    user.lockedUntil <= now;

  if (lockExpired) {
    await materializeExpiredLock(user.id, now);
    user = await findUserForLogin(normalizedUserName);

    if (!user) {
      await recordLoginAttempt(normalizedUserName, false, "INVALID_CREDENTIALS", context);
      await auditLogin("LOGIN_FAILED", {
        normalizedUserName,
        reason: "INVALID_CREDENTIALS"
      });
      return invalidCredentials();
    }
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
    await recordInvalidPasswordAttempt(user.id, normalizedUserName, context, now);

    return invalidCredentials();
  }

  await revokeExpiredSessionsForUser(user.id, now);

  const token = createSessionToken();
  const expiresAt = new Date(now.getTime() + sessionDurationMs);

  try {
    await prisma.$transaction(async (transaction) => {
      const activeSession = await transaction.session.findFirst({
        where: {
          userId: user.id,
          revokedAt: null
        },
        select: { id: true }
      });

      if (activeSession) {
        throw new ActiveSessionExistsError();
      }

      const userUpdate = await transaction.user.updateMany({
        where: {
          id: user.id,
          status: "ACTIVE",
          passwordHash: user.passwordHash,
          roleId: user.roleId,
          securityVersion: user.securityVersion
        },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: now
        }
      });

      if (userUpdate.count !== 1) {
        throw new LoginStateChangedError();
      }

      await transaction.session.create({
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
      });
      await transaction.loginAttempt.create({
        data: {
          normalizedUserName,
          succeeded: true,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent
        }
      });
      await transaction.auditEvent.create({
        data: {
          eventType: "LOGIN_SUCCEEDED",
          actorType: "USER",
          payload: {
            userId: user.id
          }
        }
      });
    });
  } catch (error) {
    if (error instanceof ActiveSessionExistsError) {
      return activeSessionExists(normalizedUserName, user.id, context);
    }

    if (error instanceof LoginStateChangedError) {
      await recordLoginAttempt(normalizedUserName, false, "INVALID_CREDENTIALS", context);
      await auditLogin("LOGIN_FAILED", {
        userId: user.id,
        reason: "INVALID_CREDENTIALS"
      });
      return invalidCredentials();
    }

    if (isUniqueConstraintError(error)) {
      return activeSessionExists(normalizedUserName, user.id, context);
    }

    throw error;
  }

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
  permission: string,
  context: Pick<RequestContext, "correlationId"> = {}
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
          permission,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
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

async function findUserForLogin(normalizedUserName: string) {
  return prisma.user.findUnique({
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
}

async function materializeExpiredLock(userId: string, now: Date): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const transition = await transaction.user.updateMany({
      where: {
        id: userId,
        status: "LOCKED",
        lockedUntil: {
          not: null,
          lte: now
        }
      },
      data: {
        status: "ACTIVE",
        failedLoginCount: 0,
        lockedUntil: null
      }
    });

    if (transition.count !== 1) {
      return;
    }

    await revokeSessionsForAccountLock(transaction, userId, now);
    await transaction.auditEvent.create({
      data: {
        eventType: "ACCOUNT_UNLOCKED",
        actorType: "SYSTEM",
        payload: {
          userId,
          reason: "LOCK_EXPIRED"
        }
      }
    });
  });
}

async function recordAttemptDuringActiveLock(
  userId: string,
  normalizedUserName: string,
  context: RequestContext,
  now: Date
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const extension = await transaction.user.updateMany({
      where: {
        id: userId,
        status: "LOCKED",
        lockedUntil: { gt: now }
      },
      data: {
        lockedUntil: new Date(now.getTime() + lockDurationMs)
      }
    });
    const failureCode = extension.count === 1 ? "ACCOUNT_LOCKED" : "INVALID_CREDENTIALS";

    await transaction.loginAttempt.create({
      data: {
        normalizedUserName,
        succeeded: false,
        failureCode,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent
      }
    });
    await transaction.auditEvent.create({
      data: {
        eventType: "LOGIN_FAILED",
        actorType: "USER",
        payload: {
          userId,
          reason: failureCode
        }
      }
    });
  });
}

async function recordInvalidPasswordAttempt(
  userId: string,
  normalizedUserName: string,
  context: RequestContext,
  now: Date
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const nextLockedUntil = new Date(now.getTime() + lockDurationMs);
    const [updatedUser] = await transaction.$queryRaw<
      Array<{ failedLoginCount: number; status: "ACTIVE" | "LOCKED" }>
    >(Prisma.sql`
      UPDATE "users"
      SET
        "failedLoginCount" = "failedLoginCount" + 1,
        "status" = CASE
          WHEN "failedLoginCount" + 1 >= ${maxFailedAttempts}
            THEN CAST('LOCKED' AS "UserStatus")
          ELSE "status"
        END,
        "lockedUntil" = CASE
          WHEN "failedLoginCount" + 1 >= ${maxFailedAttempts}
            THEN ${nextLockedUntil}
          ELSE NULL
        END,
        "updatedAt" = ${now}
      WHERE "id" = ${userId}::uuid
        AND "status" = CAST('ACTIVE' AS "UserStatus")
      RETURNING "failedLoginCount", "status"
    `);

    let failureCode = "INVALID_CREDENTIALS";

    if (updatedUser?.status === "LOCKED") {
      failureCode = "ACCOUNT_LOCKED";
      await revokeSessionsForAccountLock(transaction, userId, now);
    } else if (!updatedUser) {
      const currentUser = await transaction.user.findUnique({
        where: { id: userId },
        select: { status: true, lockedUntil: true }
      });

      if (
        currentUser?.status === "LOCKED" &&
        currentUser.lockedUntil &&
        currentUser.lockedUntil > now
      ) {
        failureCode = "ACCOUNT_LOCKED";
        await transaction.user.updateMany({
          where: {
            id: userId,
            status: "LOCKED",
            lockedUntil: { gt: now }
          },
          data: { lockedUntil: nextLockedUntil }
        });
      }
    }

    await transaction.loginAttempt.create({
      data: {
        normalizedUserName,
        succeeded: false,
        failureCode,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent
      }
    });
    await transaction.auditEvent.create({
      data: {
        eventType: "LOGIN_FAILED",
        actorType: "USER",
        payload: {
          userId,
          reason: failureCode
        }
      }
    });
  });
}

async function revokeSessionsForAccountLock(
  transaction: Prisma.TransactionClient,
  userId: string,
  now: Date
): Promise<void> {
  const revokedSessions = await transaction.session.updateManyAndReturn({
    where: {
      userId,
      revokedAt: null
    },
    data: {
      revokedAt: now,
      revokeReason: "ACCOUNT_LOCKED"
    },
    select: {
      id: true,
      userId: true
    }
  });

  for (const session of revokedSessions) {
    await transaction.auditEvent.create({
      data: {
        eventType: "SESSION_REVOKED",
        actorType: "SYSTEM",
        payload: {
          sessionId: session.id,
          userId: session.userId,
          reason: "ACCOUNT_LOCKED"
        }
      }
    });
  }
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

async function consumeLoginRateLimit(
  context: RequestContext,
  now: Date
): Promise<{ limited: false } | { limited: true; retryAfterSeconds: number }> {
  if (!context.ipAddress) {
    return { limited: false };
  }

  const windowStart = new Date(now.getTime() - loginRateLimitWindowMs);
  const key = `login:${context.ipAddress}`;
  const bucketId = randomUUID();
  const [bucket] = await prisma.$queryRaw<Array<{ count: number; windowStart: Date }>>`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (${bucketId}::uuid, ${key}, ${now}, 1, ${now}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN 1
        ELSE "rate_limit_buckets"."count" + 1
      END,
      "windowStart" = CASE
        WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN ${now}
        ELSE "rate_limit_buckets"."windowStart"
      END,
      "updatedAt" = ${now}
    RETURNING "count", "windowStart"
  `;

  if (!bucket || bucket.count <= maxLoginAttemptsByIp) {
    return { limited: false };
  }

  const retryAfterMs = Math.max(
    1_000,
    bucket.windowStart.getTime() + loginRateLimitWindowMs - now.getTime()
  );

  return {
    limited: true,
    retryAfterSeconds: Math.ceil(retryAfterMs / 1_000)
  };
}

async function revokeExpiredSessionsForUser(userId: string, now: Date): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const expiredSessions = await transaction.session.updateManyAndReturn({
      where: {
        userId,
        revokedAt: null,
        expiresAt: {
          lte: now
        }
      },
      data: {
        revokedAt: now,
        revokeReason: "SESSION_EXPIRED"
      }
    });

    for (const session of expiredSessions) {
      await transaction.auditEvent.create({
        data: {
          eventType: "SESSION_REVOKED",
          actorType: "SYSTEM",
          payload: {
            sessionId: session.id,
            userId: session.userId,
            reason: "SESSION_EXPIRED"
          }
        }
      });
    }
  });
}

async function activeSessionExists(
  normalizedUserName: string,
  userId: string,
  context: RequestContext
): Promise<LoginResult> {
  await recordLoginAttempt(normalizedUserName, false, "ACTIVE_SESSION_EXISTS", context);
  await auditLogin("LOGIN_FAILED", {
    userId,
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

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
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
