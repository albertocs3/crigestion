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

export const listBackupOperationsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  cursor: z.string().uuid().optional(),
  status: z
    .enum(["REQUESTED", "RUNNING", "VERIFIED", "FAILED"])
    .optional()
});

export const requestManualBackupSchema = z.object({}).strict();

export type ListBackupOperationsCommand = z.infer<
  typeof listBackupOperationsSchema
>;
export type RequestManualBackupCommand = z.infer<
  typeof requestManualBackupSchema
>;

export type BackupOperationListItem = {
  id: string;
  status: "REQUESTED" | "RUNNING" | "VERIFIED" | "FAILED";
  requestedBy: {
    id: string;
    displayName: string;
    userName: string;
  };
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  productVersion: string;
  sizeBytes: string | null;
  sha256: string | null;
  errorCode: string | null;
};

export type BackupOperationList = {
  backups: BackupOperationListItem[];
  nextCursor: string | null;
};

export type RequestManualBackupResult =
  | { ok: true; status: 202; value: BackupOperationListItem }
  | {
      ok: false;
      status: 409;
      error: {
        code: "BACKUP_OPERATION_ALREADY_ACTIVE";
        message: string;
      };
    };

export async function listBackupOperations(
  command: ListBackupOperationsCommand,
  actor: SessionUser
): Promise<BackupOperationList> {
  const operations = await prisma.backupOperation.findMany({
    where: command.status ? { status: command.status } : undefined,
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    cursor: command.cursor ? { id: command.cursor } : undefined,
    skip: command.cursor ? 1 : 0,
    take: command.limit + 1,
    select: {
      id: true,
      status: true,
      requestedAt: true,
      startedAt: true,
      completedAt: true,
      productVersion: true,
      sizeBytes: true,
      sha256: true,
      errorCode: true,
      requestedBy: {
        select: {
          id: true,
          displayName: true,
          userName: true
        }
      }
    }
  });

  const page = operations.slice(0, command.limit);
  const nextCursor =
    operations.length > command.limit ? page.at(-1)?.id ?? null : null;

  await prisma.auditEvent.create({
    data: {
      eventType: "BACKUP_OPERATIONS_VIEWED",
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
    backups: page.map(mapBackupOperationListItem),
    nextCursor
  };
}

export async function requestManualBackup(
  command: RequestManualBackupCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<RequestManualBackupResult> {
  void command;

  let operation: Parameters<typeof mapBackupOperationListItem>[0] | null;

  try {
    operation = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${operationExclusionAdvisoryLockKey})`;

      const activeOperation = await tx.backupOperation.findFirst({
        where: {
          status: {
            in: ["REQUESTED", "RUNNING"]
          }
        },
        select: {
          id: true
        }
      });

      if (activeOperation) {
        return null;
      }

      const activeRestore = await tx.restoreOperation.findFirst({
        where: {
          status: {
            in: [
              "REQUESTED",
              "VALIDATING",
              "PREPARING",
              "RESTORING",
              "VERIFYING"
            ]
          }
        },
        select: {
          id: true
        }
      });

      if (activeRestore) {
        return null;
      }

      const createdOperation = await tx.backupOperation.create({
        data: {
          status: "REQUESTED",
          requestedById: actor.id,
          productVersion
        },
        select: {
          id: true,
          status: true,
          requestedAt: true,
          startedAt: true,
          completedAt: true,
          productVersion: true,
          sizeBytes: true,
          sha256: true,
          errorCode: true,
          requestedBy: {
            select: {
              id: true,
              displayName: true,
              userName: true
            }
          }
        }
      });

      await tx.auditEvent.create({
        data: {
          eventType: "BACKUP_REQUESTED",
          actorType: "USER",
          payload: {
            actorUserId: actor.id,
            backupOperationId: createdOperation.id,
            status: createdOperation.status,
            ...(context.correlationId ? { correlationId: context.correlationId } : {})
          }
        }
      });

      return createdOperation;
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      operation = null;
    } else {
      throw error;
    }
  }

  if (!operation) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "BACKUP_OPERATION_ALREADY_ACTIVE",
        message: "Ya existe una operacion de copia o restauracion en curso."
      }
    };
  }

  return {
    ok: true,
    status: 202,
    value: mapBackupOperationListItem(operation)
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function mapBackupOperationListItem(operation: {
  id: string;
  status: "REQUESTED" | "RUNNING" | "VERIFIED" | "FAILED";
  requestedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  productVersion: string;
  sizeBytes: bigint | null;
  sha256: string | null;
  errorCode: string | null;
  requestedBy: {
    id: string;
    displayName: string;
    userName: string;
  };
}): BackupOperationListItem {
  return {
    id: operation.id,
    status: operation.status,
    requestedBy: operation.requestedBy,
    requestedAt: operation.requestedAt.toISOString(),
    startedAt: operation.startedAt?.toISOString() ?? null,
    completedAt: operation.completedAt?.toISOString() ?? null,
    productVersion: operation.productVersion,
    sizeBytes: operation.sizeBytes?.toString() ?? null,
    sha256: operation.sha256,
    errorCode: operation.errorCode
  };
}
