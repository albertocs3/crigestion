import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";

export const createRoleSchema = z.object({
  code: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .regex(
      /^[a-zA-Z0-9._-]+$/,
      "El codigo solo admite letras, numeros, punto, guion y guion bajo."
    ),
  name: z.string().trim().min(2).max(120),
  permissionCodes: z.array(z.string().trim().min(1).max(120)).min(1)
});

export type CreateRoleCommand = z.infer<typeof createRoleSchema>;

export type PermissionListItem = {
  code: string;
  name: string;
};

export type RoleListItem = {
  id: string;
  code: string;
  name: string;
  isProtected: boolean;
  permissions: PermissionListItem[];
  userCount: number;
  createdAt: string;
};

export type CreateRoleResult =
  | { ok: true; status: 201; value: RoleListItem }
  | {
      ok: false;
      status: 409 | 422;
      error: {
        code: "ROLE_CODE_ALREADY_USED" | "PERMISSION_NOT_FOUND";
        message: string;
      };
    };

export async function listRoles(): Promise<RoleListItem[]> {
  const roles = await prisma.role.findMany({
    orderBy: [{ isProtected: "desc" }, { name: "asc" }],
    include: {
      permissions: {
        include: {
          permission: true
        },
        orderBy: {
          permission: {
            code: "asc"
          }
        }
      },
      _count: {
        select: {
          users: true
        }
      }
    }
  });

  return roles.map(mapRoleListItem);
}

export async function listPermissions(): Promise<PermissionListItem[]> {
  return prisma.permission.findMany({
    orderBy: { code: "asc" },
    select: {
      code: true,
      name: true
    }
  });
}

export async function createRole(
  command: CreateRoleCommand,
  actor: SessionUser
): Promise<CreateRoleResult> {
  const uniquePermissionCodes = [...new Set(command.permissionCodes)];
  const permissions = await prisma.permission.findMany({
    where: {
      code: {
        in: uniquePermissionCodes
      }
    },
    select: {
      id: true,
      code: true
    }
  });

  if (permissions.length !== uniquePermissionCodes.length) {
    return {
      ok: false,
      status: 422,
      error: {
        code: "PERMISSION_NOT_FOUND",
        message: "Alguno de los permisos indicados no existe."
      }
    };
  }

  try {
    const role = await prisma.$transaction(async (tx) => {
      const createdRole = await tx.role.create({
        data: {
          code: command.code,
          name: command.name,
          isProtected: false
        }
      });

      await tx.rolePermission.createMany({
        data: permissions.map((permission) => ({
          roleId: createdRole.id,
          permissionId: permission.id
        }))
      });

      await tx.auditEvent.create({
        data: {
          eventType: "ROLE_CREATED",
          actorType: "USER",
          payload: {
            actorUserId: actor.id,
            roleId: createdRole.id,
            roleCode: createdRole.code,
            permissionCodes: uniquePermissionCodes
          }
        }
      });

      return tx.role.findUniqueOrThrow({
        where: { id: createdRole.id },
        include: {
          permissions: {
            include: {
              permission: true
            },
            orderBy: {
              permission: {
                code: "asc"
              }
            }
          },
          _count: {
            select: {
              users: true
            }
          }
        }
      });
    });

    return {
      ok: true,
      status: 201,
      value: mapRoleListItem(role)
    };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return {
        ok: false,
        status: 409,
        error: {
          code: "ROLE_CODE_ALREADY_USED",
          message: "El codigo de rol ya existe."
        }
      };
    }

    throw error;
  }
}

function mapRoleListItem(role: {
  id: string;
  code: string;
  name: string;
  isProtected: boolean;
  createdAt: Date;
  permissions: Array<{
    permission: {
      code: string;
      name: string;
    };
  }>;
  _count: {
    users: number;
  };
}): RoleListItem {
  return {
    id: role.id,
    code: role.code,
    name: role.name,
    isProtected: role.isProtected,
    permissions: role.permissions.map((rolePermission) => ({
      code: rolePermission.permission.code,
      name: rolePermission.permission.name
    })),
    userCount: role._count.users,
    createdAt: role.createdAt.toISOString()
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
