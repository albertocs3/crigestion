import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/modules/platform/application/passwords";

const productVersion = "0.1.0";

export const initializeSchema = z.object({
  company: z.object({
    legalName: z.string().trim().min(2).max(200),
    taxId: z.string().trim().min(3).max(32),
    email: z.string().trim().email().optional()
  }),
  administrator: z.object({
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
      .regex(/[^a-zA-Z0-9]/, "La contrasena debe incluir un caracter especial.")
  })
});

const platformPermissions = [
  ["Platform.ManageUsers", "Gestionar usuarios"],
  ["Platform.ManageRoles", "Gestionar roles"],
  ["Platform.ManageSessions", "Gestionar sesiones"],
  ["Platform.ManageConfiguration", "Gestionar configuracion"],
  ["Platform.ViewAudit", "Consultar auditoria"]
] as const;

export type InitializeCommand = z.infer<typeof initializeSchema>;

export type InstallationResponse = {
  id: string;
  singletonKey: number;
  status: "INITIALIZED";
  productVersion: string;
};

export type InstallationStateResponse = {
  initialized: boolean;
  installation: null | {
    id: string;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    productVersion: string;
  };
};

export type InitializePlatformResult =
  | { ok: true; status: 201; value: InstallationResponse }
  | { ok: true; status: 200; value: InstallationResponse }
  | {
      ok: false;
      status: 409;
      error: {
        code: "PLATFORM_ALREADY_INITIALIZED" | "IDEMPOTENCY_KEY_REUSED";
        message: string;
      };
    };

export function hashRequestBody(rawBody: string): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

export function normalizeUserName(userName: string): string {
  return userName.trim().toLocaleLowerCase("es-ES");
}

export async function getInstallationState(): Promise<InstallationStateResponse> {
  const installation = await prisma.installation.findFirst({
    select: {
      id: true,
      status: true,
      startedAt: true,
      completedAt: true,
      productVersion: true
    }
  });

  if (!installation) {
    return {
      initialized: false,
      installation: null
    };
  }

  return {
    initialized: installation.status === "INITIALIZED",
    installation: {
      id: installation.id,
      status: installation.status,
      startedAt: installation.startedAt?.toISOString() ?? null,
      completedAt: installation.completedAt?.toISOString() ?? null,
      productVersion: installation.productVersion
    }
  };
}

export async function initializePlatform(
  command: InitializeCommand,
  idempotencyKey: string,
  requestHash: string
): Promise<InitializePlatformResult> {
  const existingIdempotency = await prisma.idempotencyRecord.findUnique({
    where: { key: idempotencyKey }
  });

  if (existingIdempotency) {
    if (existingIdempotency.requestHash !== requestHash) {
      return {
        ok: false,
        status: 409,
        error: {
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "La clave de idempotencia ya se uso con otra peticion."
        }
      };
    }

    return {
      ok: true,
      status: 200,
      value: existingIdempotency.responseBody as InstallationResponse
    };
  }

  try {
    const response = await prisma.$transaction(async (tx) => {
      const existingInstallation = await tx.installation.findFirst({
        select: { id: true }
      });

      if (existingInstallation) {
        return null;
      }

      const administratorRole = await tx.role.upsert({
        where: { code: "Administrador" },
        update: { name: "Administrador", isProtected: true },
        create: {
          code: "Administrador",
          name: "Administrador",
          isProtected: true
        }
      });

      for (const [code, name] of platformPermissions) {
        const permission = await tx.permission.upsert({
          where: { code },
          update: { name },
          create: { code, name }
        });

        await tx.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: administratorRole.id,
              permissionId: permission.id
            }
          },
          update: {},
          create: {
            roleId: administratorRole.id,
            permissionId: permission.id
          }
        });
      }

      const normalizedUserName = normalizeUserName(command.administrator.userName);
      const now = new Date();

      const company = await tx.company.create({
        data: command.company
      });

      const administrator = await tx.user.create({
        data: {
          displayName: command.administrator.displayName,
          userName: command.administrator.userName,
          normalizedUserName,
          passwordHash: hashPassword(command.administrator.password),
          status: "ACTIVE",
          roleId: administratorRole.id
        }
      });

      await tx.reservedUserName.create({
        data: {
          normalizedUserName,
          reservedByUserId: administrator.id,
          reason: "INITIAL_ADMINISTRATOR"
        }
      });

      const installation = await tx.installation.create({
        data: {
          singletonKey: 1,
          status: "INITIALIZED",
          startedAt: now,
          completedAt: now,
          productVersion,
          companyId: company.id,
          initialAdministratorId: administrator.id
        },
        select: {
          id: true,
          singletonKey: true,
          status: true,
          productVersion: true
        }
      });

      const responseBody: InstallationResponse = {
        id: installation.id,
        singletonKey: installation.singletonKey,
        status: "INITIALIZED",
        productVersion: installation.productVersion
      };

      await tx.idempotencyRecord.create({
        data: {
          key: idempotencyKey,
          requestHash,
          responseStatus: 201,
          responseBody
        }
      });

      await tx.auditEvent.create({
        data: {
          eventType: "PLATFORM_INITIALIZED",
          actorType: "SYSTEM",
          payload: {
            companyId: company.id,
            administratorId: administrator.id
          }
        }
      });

      return responseBody;
    });

    if (!response) {
      return platformAlreadyInitialized();
    }

    return { ok: true, status: 201, value: response };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const replay = await replayIdempotentResponse(idempotencyKey, requestHash);

      if (replay) {
        return replay;
      }

      return platformAlreadyInitialized();
    }

    throw error;
  }
}

async function replayIdempotentResponse(
  idempotencyKey: string,
  requestHash: string
): Promise<InitializePlatformResult | null> {
  const existingIdempotency = await prisma.idempotencyRecord.findUnique({
    where: { key: idempotencyKey }
  });

  if (!existingIdempotency) {
    return null;
  }

  if (existingIdempotency.requestHash !== requestHash) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "La clave de idempotencia ya se uso con otra peticion."
      }
    };
  }

  return {
    ok: true,
    status: 200,
    value: existingIdempotency.responseBody as InstallationResponse
  };
}

function platformAlreadyInitialized(): InitializePlatformResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "PLATFORM_ALREADY_INITIALIZED",
      message: "La plataforma ya esta inicializada."
    }
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
