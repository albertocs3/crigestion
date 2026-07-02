import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient, RestoreOperation } from "@prisma/client";
import { z } from "zod";
import { productVersion } from "@/modules/platform/application/version";
import { verifyEncryptedBackupArtifact } from "@/modules/platform/infrastructure/backupExecutor";

const restoreEnvironmentSchema = z.object({
  BACKUP_DIRECTORY: z.string().trim().min(1).default("backups"),
  BACKUP_ENCRYPTION_KEY: z.string().trim().min(1),
  RESTORE_VALIDATION_TIMEOUT_MINUTES: z.coerce.number().int().min(1).default(720)
});

type RestoreEnvironment = z.infer<typeof restoreEnvironmentSchema>;

export type RestoreExecutorOptions = {
  prisma: PrismaClient;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

export type RestoreExecutorResult =
  | {
      processed: true;
      operationId: string;
      status: "VALIDATED";
      backupOperationId: string;
      sizeBytes: bigint;
      sha256: string;
    }
  | {
      processed: true;
      operationId: string;
      status: "FAILED";
      errorCode: string;
    }
  | {
      processed: false;
      reason: "NO_REQUESTED_RESTORE";
    };

type ClaimedRestoreOperation = Pick<RestoreOperation, "id" | "backupOperationId"> & {
  backupOperation: {
    id: string;
    status: "REQUESTED" | "RUNNING" | "VERIFIED" | "FAILED";
    productVersion: string;
    storageKey: string | null;
    sizeBytes: bigint | null;
    sha256: string | null;
  };
};

export async function processNextRequestedRestore(
  options: RestoreExecutorOptions
): Promise<RestoreExecutorResult> {
  const now = options.now ?? (() => new Date());
  const validationTimeoutMinutes = readRestoreValidationTimeoutMinutes(
    options.env ?? process.env
  );

  await failStaleValidatingRestores(options.prisma, now, validationTimeoutMinutes);

  const operation = await claimNextRequestedRestore(options.prisma, now);

  if (!operation) {
    return {
      processed: false,
      reason: "NO_REQUESTED_RESTORE"
    };
  }

  try {
    const env = readRestoreEnvironment(options.env ?? process.env);
    const validation = await validateRestoreArtifact(operation, env);

    await options.prisma.$transaction([
      options.prisma.restoreOperation.update({
        where: { id: operation.id },
        data: {
          status: "VALIDATED",
          validatedAt: now(),
          errorCode: null
        }
      }),
      options.prisma.auditEvent.create({
        data: {
          eventType: "RESTORE_VALIDATED",
          actorType: "SYSTEM",
          payload: {
            restoreOperationId: operation.id,
            backupOperationId: operation.backupOperationId,
            status: "VALIDATED",
            sizeBytes: validation.sizeBytes.toString(),
            sha256: validation.sha256
          }
        }
      })
    ]);

    return {
      processed: true,
      operationId: operation.id,
      status: "VALIDATED",
      backupOperationId: operation.backupOperationId,
      sizeBytes: validation.sizeBytes,
      sha256: validation.sha256
    };
  } catch (error) {
    const errorCode = classifyRestoreError(error);

    await options.prisma.$transaction([
      options.prisma.restoreOperation.update({
        where: { id: operation.id },
        data: {
          status: "FAILED",
          completedAt: now(),
          errorCode
        }
      }),
      options.prisma.auditEvent.create({
        data: {
          eventType: "RESTORE_VALIDATION_FAILED",
          actorType: "SYSTEM",
          payload: {
            restoreOperationId: operation.id,
            backupOperationId: operation.backupOperationId,
            status: "FAILED",
            errorCode
          }
        }
      })
    ]);

    return {
      processed: true,
      operationId: operation.id,
      status: "FAILED",
      errorCode
    };
  }
}

async function claimNextRequestedRestore(
  prisma: PrismaClient,
  now: () => Date
): Promise<ClaimedRestoreOperation | null> {
  return prisma.$transaction(async (tx) => {
    const operation = await tx.restoreOperation.findFirst({
      where: { status: "REQUESTED" },
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        backupOperationId: true,
        backupOperation: {
          select: {
            id: true,
            status: true,
            productVersion: true,
            storageKey: true,
            sizeBytes: true,
            sha256: true
          }
        }
      }
    });

    if (!operation) {
      return null;
    }

    const claimed = await tx.restoreOperation.updateMany({
      where: { id: operation.id, status: "REQUESTED" },
      data: {
        status: "VALIDATING",
        startedAt: now(),
        errorCode: null
      }
    });

    if (claimed.count !== 1) {
      return null;
    }

    await tx.auditEvent.create({
      data: {
        eventType: "RESTORE_VALIDATION_STARTED",
        actorType: "SYSTEM",
        payload: {
          restoreOperationId: operation.id,
          backupOperationId: operation.backupOperationId,
          status: "VALIDATING"
        }
      }
    });

    return operation;
  });
}

async function failStaleValidatingRestores(
  prisma: PrismaClient,
  now: () => Date,
  timeoutMinutes: number
): Promise<void> {
  const cutoff = new Date(now().getTime() - timeoutMinutes * 60 * 1_000);
  const staleOperations = await prisma.restoreOperation.findMany({
    where: {
      status: "VALIDATING",
      startedAt: {
        lt: cutoff
      }
    },
    select: {
      id: true,
      backupOperationId: true
    }
  });

  for (const operation of staleOperations) {
    await prisma.$transaction([
      prisma.restoreOperation.update({
        where: { id: operation.id },
        data: {
          status: "FAILED",
          completedAt: now(),
          errorCode: "RESTORE_WORKER_TIMEOUT"
        }
      }),
      prisma.auditEvent.create({
        data: {
          eventType: "RESTORE_VALIDATION_FAILED",
          actorType: "SYSTEM",
          payload: {
            restoreOperationId: operation.id,
            backupOperationId: operation.backupOperationId,
            status: "FAILED",
            errorCode: "RESTORE_WORKER_TIMEOUT"
          }
        }
      })
    ]);
  }
}

async function validateRestoreArtifact(
  operation: ClaimedRestoreOperation,
  env: RestoreEnvironment
): Promise<{ sizeBytes: bigint; sha256: string }> {
  const backup = operation.backupOperation;

  if (
    backup.status !== "VERIFIED" ||
    backup.productVersion !== productVersion ||
    !backup.storageKey ||
    !backup.sizeBytes ||
    !backup.sha256
  ) {
    throw new RestoreValidationError("RESTORE_BACKUP_NOT_RESTORABLE");
  }

  const artifactPath = resolveBackupArtifactPath(env.BACKUP_DIRECTORY, backup.storageKey);
  const fileStat = await stat(artifactPath);
  const actualSize = BigInt(fileStat.size);

  if (actualSize !== backup.sizeBytes) {
    throw new RestoreValidationError("RESTORE_BACKUP_SIZE_MISMATCH");
  }

  const actualSha256 = await sha256File(artifactPath);

  if (actualSha256 !== backup.sha256) {
    throw new RestoreValidationError("RESTORE_BACKUP_SHA256_MISMATCH");
  }

  await verifyEncryptedBackupArtifact(
    artifactPath,
    parseBackupEncryptionKey(env.BACKUP_ENCRYPTION_KEY)
  );

  return {
    sizeBytes: actualSize,
    sha256: actualSha256
  };
}

function resolveBackupArtifactPath(backupDirectory: string, storageKey: string): string {
  if (
    path.isAbsolute(storageKey) ||
    storageKey.includes("/") ||
    storageKey.includes("\\") ||
    storageKey.includes("..") ||
    !storageKey.endsWith(".backup")
  ) {
    throw new RestoreValidationError("RESTORE_BACKUP_STORAGE_KEY_INVALID");
  }

  const resolvedBackupDirectory = path.resolve(backupDirectory);
  const resolvedArtifactPath = path.resolve(resolvedBackupDirectory, storageKey);

  if (!resolvedArtifactPath.startsWith(`${resolvedBackupDirectory}${path.sep}`)) {
    throw new RestoreValidationError("RESTORE_BACKUP_STORAGE_KEY_INVALID");
  }

  return resolvedArtifactPath;
}

function readRestoreEnvironment(env: NodeJS.ProcessEnv): RestoreEnvironment {
  const parsed = restoreEnvironmentSchema.safeParse(env);

  if (!parsed.success) {
    throw new RestoreValidationError("RESTORE_ENV_INVALID");
  }

  parseBackupEncryptionKey(parsed.data.BACKUP_ENCRYPTION_KEY);

  return parsed.data;
}

function readRestoreValidationTimeoutMinutes(env: NodeJS.ProcessEnv): number {
  const value = env.RESTORE_VALIDATION_TIMEOUT_MINUTES;

  if (!value) {
    return restoreEnvironmentSchema.shape.RESTORE_VALIDATION_TIMEOUT_MINUTES.parse(
      undefined
    );
  }

  return restoreEnvironmentSchema.shape.RESTORE_VALIDATION_TIMEOUT_MINUTES.parse(value);
}

function parseBackupEncryptionKey(value: string): Buffer {
  const normalized = value.trim();

  if (/^[a-fA-F0-9]{64}$/.test(normalized)) {
    return Buffer.from(normalized, "hex");
  }

  const base64Key = Buffer.from(normalized, "base64");

  if (base64Key.length === 32) {
    return base64Key;
  }

  throw new RestoreValidationError("BACKUP_ENCRYPTION_KEY_INVALID");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

function classifyRestoreError(error: unknown): string {
  if (error instanceof RestoreValidationError) {
    return error.code;
  }

  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return "RESTORE_BACKUP_ARTIFACT_NOT_FOUND";
  }

  return "RESTORE_BACKUP_DECRYPTION_FAILED";
}

class RestoreValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
