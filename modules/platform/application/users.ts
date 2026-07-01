import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { normalizeUserName } from "@/modules/platform/application/installation";
import { hashPassword } from "@/modules/platform/application/passwords";
import type { SessionUser } from "@/modules/platform/application/auth";

export const createUserSchema = z.object({
  displayName: z.string().trim().min(2).max(160),
  userName: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .regex(
      /^[a-zA-Z0-9._-]+$/,
      "El usuario solo admite letras, numeros, punto, guion y guion bajo."
    ),
  password: z
    .string()
    .min(12)
    .max(200)
    .regex(/[a-z]/, "La contrasena debe incluir una minuscula.")
    .regex(/[A-Z]/, "La contrasena debe incluir una mayuscula.")
    .regex(/[0-9]/, "La contrasena debe incluir un numero.")
    .regex(/[^a-zA-Z0-9]/, "La contrasena debe incluir un caracter especial."),
  roleCode: z.string().trim().min(1).max(80).default("Administrador")
});

export type CreateUserCommand = z.infer<typeof createUserSchema>;

export type UserListItem = {
  id: string;
  displayName: string;
  userName: string;
  status: string;
  role: {
    code: string;
    name: string;
  };
  failedLoginCount: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
};

export type CreateUserResult =
  | { ok: true; status: 201; value: UserListItem }
  | {
      ok: false;
      status: 409 | 422;
      error: {
        code: "USER_NAME_ALREADY_USED" | "ROLE_NOT_FOUND";
        message: string;
      };
    };

export type ChangeUserStatusResult =
  | { ok: true; status: 200; value: UserListItem }
  | {
      ok: false;
      status: 404 | 409;
      error: {
        code: "USER_NOT_FOUND" | "SELF_STATUS_CHANGE_NOT_ALLOWED";
        message: string;
      };
    };

export type ChangeUserRoleResult =
  | { ok: true; status: 200; value: UserListItem }
  | {
      ok: false;
      status: 404 | 409 | 422;
      error: {
        code: "USER_NOT_FOUND" | "SELF_ROLE_CHANGE_NOT_ALLOWED" | "ROLE_NOT_FOUND";
        message: string;
      };
    };

export async function listUsers(): Promise<UserListItem[]> {
  const users = await prisma.user.findMany({
    orderBy: [{ createdAt: "asc" }],
    select: {
      id: true,
      displayName: true,
      userName: true,
      status: true,
      failedLoginCount: true,
      lockedUntil: true,
      lastLoginAt: true,
      createdAt: true,
      role: {
        select: {
          code: true,
          name: true
        }
      }
    }
  });

  return users.map(mapUserListItem);
}

export async function listAssignableRoles(): Promise<Array<{ code: string; name: string }>> {
  return prisma.role.findMany({
    orderBy: { name: "asc" },
    select: {
      code: true,
      name: true
    }
  });
}

export async function createUser(
  command: CreateUserCommand,
  actor: SessionUser
): Promise<CreateUserResult> {
  const normalizedUserName = normalizeUserName(command.userName);
  const role = await prisma.role.findUnique({
    where: { code: command.roleCode },
    select: { id: true }
  });

  if (!role) {
    return {
      ok: false,
      status: 422,
      error: {
        code: "ROLE_NOT_FOUND",
        message: "El rol indicado no existe."
      }
    };
  }

  try {
    const user = await prisma.$transaction(async (tx) => {
      const existingReservation = await tx.reservedUserName.findUnique({
        where: { normalizedUserName },
        select: { id: true }
      });

      if (existingReservation) {
        return null;
      }

      const createdUser = await tx.user.create({
        data: {
          displayName: command.displayName,
          userName: command.userName,
          normalizedUserName,
          passwordHash: hashPassword(command.password),
          status: "ACTIVE",
          roleId: role.id
        },
        select: {
          id: true,
          displayName: true,
          userName: true,
          status: true,
          failedLoginCount: true,
          lockedUntil: true,
          lastLoginAt: true,
          createdAt: true,
          role: {
            select: {
              code: true,
              name: true
            }
          }
        }
      });

      await tx.reservedUserName.create({
        data: {
          normalizedUserName,
          reservedByUserId: createdUser.id,
          reason: "USER_CREATED"
        }
      });

      await tx.auditEvent.create({
        data: {
          eventType: "USER_CREATED",
          actorType: "USER",
          payload: {
            actorUserId: actor.id,
            userId: createdUser.id,
            roleCode: command.roleCode
          }
        }
      });

      return createdUser;
    });

    if (!user) {
      return userNameAlreadyUsed();
    }

    return {
      ok: true,
      status: 201,
      value: mapUserListItem(user)
    };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return userNameAlreadyUsed();
    }

    throw error;
  }
}

export async function deactivateUser(
  userId: string,
  actor: SessionUser
): Promise<ChangeUserStatusResult> {
  if (userId === actor.id) {
    return selfStatusChangeNotAllowed();
  }

  const user = await prisma.$transaction(async (tx) => {
    const existingUser = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true }
    });

    if (!existingUser) {
      return null;
    }

    const updatedUser = await tx.user.update({
      where: { id: userId },
      data: {
        status: "INACTIVE",
        lockedUntil: null,
        securityVersion: {
          increment: 1
        }
      },
      select: userListSelect
    });

    await tx.session.updateMany({
      where: {
        userId,
        revokedAt: null
      },
      data: {
        revokedAt: new Date(),
        revokeReason: "USER_DEACTIVATED"
      }
    });

    await tx.auditEvent.create({
      data: {
        eventType: "USER_DEACTIVATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          userId
        }
      }
    });

    return updatedUser;
  });

  if (!user) {
    return userNotFound();
  }

  return {
    ok: true,
    status: 200,
    value: mapUserListItem(user)
  };
}

export async function reactivateUser(
  userId: string,
  actor: SessionUser
): Promise<ChangeUserStatusResult> {
  const user = await prisma.$transaction(async (tx) => {
    const existingUser = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true }
    });

    if (!existingUser) {
      return null;
    }

    const updatedUser = await tx.user.update({
      where: { id: userId },
      data: {
        status: "ACTIVE",
        failedLoginCount: 0,
        lockedUntil: null,
        securityVersion: {
          increment: 1
        }
      },
      select: userListSelect
    });

    await tx.auditEvent.create({
      data: {
        eventType: "USER_REACTIVATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          userId
        }
      }
    });

    return updatedUser;
  });

  if (!user) {
    return userNotFound();
  }

  return {
    ok: true,
    status: 200,
    value: mapUserListItem(user)
  };
}

export async function changeUserRole(
  userId: string,
  roleCode: string,
  actor: SessionUser
): Promise<ChangeUserRoleResult> {
  if (userId === actor.id) {
    return selfRoleChangeNotAllowed();
  }

  const user = await prisma.$transaction(async (tx) => {
    const [existingUser, role] = await Promise.all([
      tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          role: {
            select: {
              code: true
            }
          }
        }
      }),
      tx.role.findUnique({
        where: { code: roleCode },
        select: {
          id: true,
          code: true
        }
      })
    ]);

    if (!existingUser) {
      return { status: "user-not-found" as const };
    }

    if (!role) {
      return { status: "role-not-found" as const };
    }

    const updatedUser = await tx.user.update({
      where: { id: userId },
      data: {
        roleId: role.id,
        securityVersion: {
          increment: 1
        }
      },
      select: userListSelect
    });

    await tx.session.updateMany({
      where: {
        userId,
        revokedAt: null
      },
      data: {
        revokedAt: new Date(),
        revokeReason: "USER_ROLE_CHANGED"
      }
    });

    await tx.auditEvent.create({
      data: {
        eventType: "USER_ROLE_CHANGED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          userId,
          previousRoleCode: existingUser.role.code,
          newRoleCode: role.code
        }
      }
    });

    return {
      status: "changed" as const,
      user: updatedUser
    };
  });

  if (user.status === "user-not-found") {
    return userNotFoundForRole();
  }

  if (user.status === "role-not-found") {
    return roleNotFound();
  }

  return {
    ok: true,
    status: 200,
    value: mapUserListItem(user.user)
  };
}

const userListSelect = {
  id: true,
  displayName: true,
  userName: true,
  status: true,
  failedLoginCount: true,
  lockedUntil: true,
  lastLoginAt: true,
  createdAt: true,
  role: {
    select: {
      code: true,
      name: true
    }
  }
} as const;

function mapUserListItem(user: {
  id: string;
  displayName: string;
  userName: string;
  status: string;
  failedLoginCount: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  role: {
    code: string;
    name: string;
  };
}): UserListItem {
  return {
    id: user.id,
    displayName: user.displayName,
    userName: user.userName,
    status: user.status,
    role: user.role,
    failedLoginCount: user.failedLoginCount,
    lockedUntil: user.lockedUntil?.toISOString() ?? null,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString()
  };
}

function userNameAlreadyUsed(): CreateUserResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "USER_NAME_ALREADY_USED",
      message: "El nombre de usuario ya esta reservado."
    }
  };
}

function userNotFound(): ChangeUserStatusResult {
  return {
    ok: false,
    status: 404,
    error: {
      code: "USER_NOT_FOUND",
      message: "El usuario no existe."
    }
  };
}

function userNotFoundForRole(): ChangeUserRoleResult {
  return {
    ok: false,
    status: 404,
    error: {
      code: "USER_NOT_FOUND",
      message: "El usuario no existe."
    }
  };
}

function selfStatusChangeNotAllowed(): ChangeUserStatusResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "SELF_STATUS_CHANGE_NOT_ALLOWED",
      message: "No puedes cambiar tu propio estado."
    }
  };
}

function selfRoleChangeNotAllowed(): ChangeUserRoleResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "SELF_ROLE_CHANGE_NOT_ALLOWED",
      message: "No puedes cambiar tu propio rol."
    }
  };
}

function roleNotFound(): ChangeUserRoleResult {
  return {
    ok: false,
    status: 422,
    error: {
      code: "ROLE_NOT_FOUND",
      message: "El rol indicado no existe."
    }
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
