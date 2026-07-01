import "server-only";

import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";

export type ActiveSessionListItem = {
  id: string;
  user: {
    id: string;
    displayName: string;
    userName: string;
    role: {
      code: string;
      name: string;
    };
  };
  startedAt: string;
  lastActivityAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  isCurrentSession: boolean;
};

export type RevokeSessionResult =
  | { ok: true; status: 200; value: { revoked: true } }
  | {
      ok: false;
      status: 404 | 409;
      error: {
        code: "SESSION_NOT_FOUND" | "SELF_SESSION_REVOKE_NOT_ALLOWED";
        message: string;
      };
    };

export async function listActiveSessions(
  currentSessionId: string
): Promise<ActiveSessionListItem[]> {
  const sessions = await prisma.session.findMany({
    where: {
      revokedAt: null
    },
    orderBy: [{ lastActivityAt: "desc" }, { startedAt: "desc" }],
    select: {
      id: true,
      startedAt: true,
      lastActivityAt: true,
      expiresAt: true,
      ipAddress: true,
      userAgent: true,
      user: {
        select: {
          id: true,
          displayName: true,
          userName: true,
          role: {
            select: {
              code: true,
              name: true
            }
          }
        }
      }
    }
  });

  return sessions.map((session) => ({
    id: session.id,
    user: session.user,
    startedAt: session.startedAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    isCurrentSession: session.id === currentSessionId
  }));
}

export async function revokeActiveSession(
  sessionId: string,
  actor: SessionUser,
  currentSessionId: string
): Promise<RevokeSessionResult> {
  if (sessionId === currentSessionId) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "SELF_SESSION_REVOKE_NOT_ALLOWED",
        message: "Usa cerrar sesion para finalizar tu sesion actual."
      }
    };
  }

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      userId: true,
      revokedAt: true
    }
  });

  if (!session || session.revokedAt) {
    return {
      ok: false,
      status: 404,
      error: {
        code: "SESSION_NOT_FOUND",
        message: "La sesion no existe o ya fue revocada."
      }
    };
  }

  await prisma.$transaction([
    prisma.session.update({
      where: { id: sessionId },
      data: {
        revokedAt: new Date(),
        revokeReason: "ADMIN_SESSION_REVOKED"
      }
    }),
    prisma.auditEvent.create({
      data: {
        eventType: "SESSION_REVOKED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          sessionId,
          userId: session.userId,
          reason: "ADMIN_SESSION_REVOKED"
        }
      }
    })
  ]);

  return {
    ok: true,
    status: 200,
    value: { revoked: true }
  };
}
