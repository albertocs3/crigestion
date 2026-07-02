import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type {
  RequestContext,
  SessionUser
} from "@/modules/platform/application/auth";
import { productVersion } from "@/modules/platform/application/version";

const defaultLimit = 25;
const maxLimit = 100;
const operationExclusionAdvisoryLockKey = 72072072;
const activeRestoreStatuses = [
  "REQUESTED",
  "VALIDATING",
  "PREPARING",
  "RESTORING",
  "VERIFYING"
] as const;

export const listRestoreOperationsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  cursor: z.string().uuid().optional(),
  status: z
    .enum([
      "REQUESTED",
      "VALIDATING",
      "VALIDATED",
      "PREPARING",
      "RESTORING",
      "VERIFYING",
      "COMPLETED",
      "FAILED",
      "REQUIRES_RECOVERY"
    ])
    .optional()
});

export const requestRestoreSchema = z.object({
  backupOperationId: z.string().uuid(),
  reason: z.string().trim().min(10).max(500)
});

export type ListRestoreOperationsCommand = z.infer<
  typeof listRestoreOperationsSchema
>;
export type RequestRestoreCommand = z.infer<typeof requestRestoreSchema>;

export type RestoreOperationListItem = {
  id: string;
  status:
    | "REQUESTED"
    | "VALIDATING"
    | "VALIDATED"
    | "PREPARING"
    | "RESTORING"
    | "VERIFYING"
    | "COMPLETED"
    | "FAILED"
    | "REQUIRES_RECOVERY";
  backup: {
    id: string;
    productVersion: string;
    requestedAt: string;
    completedAt: string | null;
    sizeBytes: string | null;
    sha256: string | null;
  };
  requestedBy: {
    id: string;
    displayName: string;
    userName: string;
  };
  reason: string;
  requestedAt: string;
  startedAt: string | null;
  validatedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
};

export type RestoreOperationList = {
  restores: RestoreOperationListItem[];
  nextCursor: string | null;
};

export type RequestRestoreResult =
  | { ok: true; status: 202; value: RestoreOperationListItem }
  | {
      ok: false;
      status: 404 | 409;
      error: {
        code:
          | "BACKUP_NOT_FOUND"
          | "BACKUP_NOT_RESTORABLE"
          | "BACKUP_VERSION_INCOMPATIBLE"
          | "RESTORE_OPERATION_ALREADY_ACTIVE";
        message: string;
      };
    };

export async function listRestoreOperations(
  command: ListRestoreOperationsCommand,
  actor: SessionUser
): Promise<RestoreOperationList> {
  const operations = await prisma.restoreOperation.findMany({
    where: command.status ? { status: command.status } : undefined,
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    cursor: command.cursor ? { id: command.cursor } : undefined,
    skip: command.cursor ? 1 : 0,
    take: command.limit + 1,
    select: restoreOperationListSelect
  });
  const page = operations.slice(0, command.limit);
  const nextCursor =
    operations.length > command.limit ? page.at(-1)?.id ?? null : null;

  await prisma.auditEvent.create({
    data: {
      eventType: "RESTORE_OPERATIONS_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        status: command.status ?? null,
        limit: command.limit,
        cursor: command.cursor ?? null,
        resultCount: page.length
      }
    }
  });

  return {
    restores: page.map(mapRestoreOperationListItem),
    nextCursor
  };
}

export async function requestRestore(
  command: RequestRestoreCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<RequestRestoreResult> {
  try {
    const operation = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${operationExclusionAdvisoryLockKey})`;

      const activeBackup = await tx.backupOperation.findFirst({
        where: {
          status: {
            in: ["REQUESTED", "RUNNING"]
          }
        },
        select: { id: true }
      });

      const activeRestore = await tx.restoreOperation.findFirst({
        where: {
          status: {
            in: [...activeRestoreStatuses]
          }
        },
        select: { id: true }
      });

      if (activeBackup || activeRestore) {
        return { kind: "active" } as const;
      }

      const backup = await tx.backupOperation.findUnique({
        where: { id: command.backupOperationId },
        select: {
          id: true,
          status: true,
          productVersion: true,
          storageKey: true,
          sizeBytes: true,
          sha256: true
        }
      });

      if (!backup) {
        return { kind: "missing" } as const;
      }

      if (backup.productVersion !== productVersion) {
        return { kind: "version" } as const;
      }

      if (
        backup.status !== "VERIFIED" ||
        !backup.storageKey ||
        !backup.sizeBytes ||
        !backup.sha256
      ) {
        return { kind: "notRestorable" } as const;
      }

      const createdRestore = await tx.restoreOperation.create({
        data: {
          status: "REQUESTED",
          backupOperationId: backup.id,
          requestedById: actor.id,
          reason: command.reason
        },
        select: restoreOperationListSelect
      });

      await tx.auditEvent.create({
        data: {
          eventType: "RESTORE_REQUESTED",
          actorType: "USER",
          payload: {
            actorUserId: actor.id,
            restoreOperationId: createdRestore.id,
            backupOperationId: backup.id,
            status: createdRestore.status,
            reasonLength: command.reason.length,
            ...(context.correlationId ? { correlationId: context.correlationId } : {})
          }
        }
      });

      return { kind: "created", operation: createdRestore } as const;
    });

    switch (operation.kind) {
      case "created":
        return {
          ok: true,
          status: 202,
          value: mapRestoreOperationListItem(operation.operation)
        };
      case "missing":
        return {
          ok: false,
          status: 404,
          error: {
            code: "BACKUP_NOT_FOUND",
            message: "La copia indicada no existe."
          }
        };
      case "version":
        return {
          ok: false,
          status: 409,
          error: {
            code: "BACKUP_VERSION_INCOMPATIBLE",
            message: "La copia no es compatible con la version actual."
          }
        };
      case "notRestorable":
        return {
          ok: false,
          status: 409,
          error: {
            code: "BACKUP_NOT_RESTORABLE",
            message: "La copia indicada no esta verificada o no es restaurable."
          }
        };
      case "active":
        return restoreAlreadyActive();
    }
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return restoreAlreadyActive();
    }

    throw error;
  }
}

const restoreOperationListSelect = {
  id: true,
  status: true,
  reason: true,
  requestedAt: true,
  startedAt: true,
  validatedAt: true,
  completedAt: true,
  errorCode: true,
  backupOperation: {
    select: {
      id: true,
      productVersion: true,
      requestedAt: true,
      completedAt: true,
      sizeBytes: true,
      sha256: true
    }
  },
  requestedBy: {
    select: {
      id: true,
      displayName: true,
      userName: true
    }
  }
} satisfies Prisma.RestoreOperationSelect;

function mapRestoreOperationListItem(operation: {
  id: string;
  status: RestoreOperationListItem["status"];
  reason: string;
  requestedAt: Date;
  startedAt: Date | null;
  validatedAt: Date | null;
  completedAt: Date | null;
  errorCode: string | null;
  backupOperation: {
    id: string;
    productVersion: string;
    requestedAt: Date;
    completedAt: Date | null;
    sizeBytes: bigint | null;
    sha256: string | null;
  };
  requestedBy: {
    id: string;
    displayName: string;
    userName: string;
  };
}): RestoreOperationListItem {
  return {
    id: operation.id,
    status: operation.status,
    backup: {
      id: operation.backupOperation.id,
      productVersion: operation.backupOperation.productVersion,
      requestedAt: operation.backupOperation.requestedAt.toISOString(),
      completedAt: operation.backupOperation.completedAt?.toISOString() ?? null,
      sizeBytes: operation.backupOperation.sizeBytes?.toString() ?? null,
      sha256: operation.backupOperation.sha256
    },
    requestedBy: operation.requestedBy,
    reason: operation.reason,
    requestedAt: operation.requestedAt.toISOString(),
    startedAt: operation.startedAt?.toISOString() ?? null,
    validatedAt: operation.validatedAt?.toISOString() ?? null,
    completedAt: operation.completedAt?.toISOString() ?? null,
    errorCode: operation.errorCode
  };
}

function restoreAlreadyActive(): RequestRestoreResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "RESTORE_OPERATION_ALREADY_ACTIVE",
      message: "Ya existe una operacion de copia o restauracion en curso."
    }
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
