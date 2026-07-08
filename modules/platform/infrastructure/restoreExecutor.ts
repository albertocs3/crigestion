import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { PrismaClient, RestoreOperation } from "@prisma/client";
import { z } from "zod";
import { productVersion } from "@/modules/platform/productVersion";
import {
  createDecryptedBackupArtifactStream,
  processNextRequestedBackup,
  verifyEncryptedBackupArtifact
} from "@/modules/platform/infrastructure/backupExecutor";

const restoreEnvironmentSchema = z.object({
  BACKUP_DIRECTORY: z.string().trim().min(1).default("backups"),
  BACKUP_ENCRYPTION_KEY: z.string().trim().min(1),
  PG_RESTORE_BINARY: z.string().trim().min(1).default("pg_restore"),
  RESTORE_TARGET_DATABASE_URL: z.string().trim().min(1).optional(),
  RESTORE_VALIDATION_TIMEOUT_MINUTES: z.coerce.number().int().min(1).default(720)
});

type RestoreEnvironment = z.infer<typeof restoreEnvironmentSchema>;

export type RestoreExecutorOptions = {
  prisma: PrismaClient;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

export type RestoreApplyExecutorOptions = RestoreExecutorOptions & {
  actor?: {
    userId: string;
    correlationId?: string;
  };
  createDumpStream?: Parameters<typeof processNextRequestedBackup>[0]["createDumpStream"];
  createDumpSource?: Parameters<typeof processNextRequestedBackup>[0]["createDumpSource"];
  applyRestore?: (context: {
    restoreOperationId: string;
    backupOperationId: string;
    artifactPath: string;
    backupEncryptionKey: Buffer;
    env: RestoreEnvironment;
  }) => Promise<void>;
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

export type RestoreApplyExecutorResult =
  | {
      processed: true;
      operationId: string;
      status: "COMPLETED";
      backupOperationId: string;
      preRestoreBackupOperationId: string;
    }
  | {
      processed: true;
      operationId: string;
      status: "FAILED" | "REQUIRES_RECOVERY";
      errorCode: string;
      preRestoreBackupOperationId: string | null;
    }
  | {
      processed: false;
      reason: "NO_VALIDATED_RESTORE_IN_MAINTENANCE";
    };

type ClaimedRestoreOperation = Pick<RestoreOperation, "id" | "backupOperationId"> & {
  requestedById: string;
  reason: string;
  requestedAt: Date;
  startedAt: Date | null;
  validatedAt: Date | null;
  backupOperation: {
    id: string;
    status: "REQUESTED" | "RUNNING" | "VERIFIED" | "FAILED";
    requestedById: string;
    requestedAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    productVersion: string;
    storageKey: string | null;
    sizeBytes: bigint | null;
    sha256: string | null;
    errorCode: string | null;
  };
};

type BackupOperationSnapshot = ClaimedRestoreOperation["backupOperation"];

type VerifiedBackupOperationSnapshot = Omit<
  BackupOperationSnapshot,
  "status" | "storageKey" | "sizeBytes" | "sha256"
> & {
  status: "VERIFIED";
  storageKey: string;
  sizeBytes: bigint;
  sha256: string;
};

type SpawnRestoreProcess = typeof spawn;

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

export async function processNextValidatedRestoreApply(
  options: RestoreApplyExecutorOptions
): Promise<RestoreApplyExecutorResult> {
  const now = options.now ?? (() => new Date());
  const operation = await claimNextValidatedRestoreForApply(
    options.prisma,
    now,
    options.actor
  );

  if (!operation) {
    return {
      processed: false,
      reason: "NO_VALIDATED_RESTORE_IN_MAINTENANCE"
    };
  }

  let preRestoreBackup: VerifiedBackupOperationSnapshot | null = null;

  try {
    if (!options.applyRestore) {
      throw new RestoreValidationError("RESTORE_APPLY_PORT_NOT_CONFIGURED");
    }

    const env = readRestoreEnvironment(options.env ?? process.env);
    const validation = await validateRestoreArtifact(operation, env);
    preRestoreBackup = await createPreRestoreBackup({
      ...options,
      operation,
      now
    });

    await options.prisma.$transaction([
      options.prisma.restoreOperation.update({
        where: { id: operation.id },
        data: {
          status: "RESTORING",
          preRestoreBackupOperationId: preRestoreBackup.id,
          errorCode: null
        }
      }),
      options.prisma.auditEvent.create({
        data: {
          eventType: "RESTORE_APPLY_STARTED",
          actorType: restoreApplyActorType(options),
          payload: {
            ...restoreApplyActorPayload(options),
            restoreOperationId: operation.id,
            backupOperationId: operation.backupOperationId,
            preRestoreBackupOperationId: preRestoreBackup.id,
            status: "RESTORING"
          }
        }
      })
    ]);

    await options.applyRestore({
      restoreOperationId: operation.id,
      backupOperationId: operation.backupOperationId,
      artifactPath: validation.artifactPath,
      backupEncryptionKey: validation.backupEncryptionKey,
      env
    });

    await recordRestoreApplyCompleted(options.prisma, {
      operation,
      sourceBackup: verifiedSourceBackupSnapshot(operation.backupOperation),
      preRestoreBackup,
      completedAt: now(),
      actor: options.actor
    });

    return {
      processed: true,
      operationId: operation.id,
      status: "COMPLETED",
      backupOperationId: operation.backupOperationId,
      preRestoreBackupOperationId: preRestoreBackup.id
    };
  } catch (error) {
    const errorCode = classifyRestoreApplyError(error);
    const failedStatus =
      preRestoreBackup && requiresManualRestoreRecovery(errorCode)
        ? "REQUIRES_RECOVERY"
        : "FAILED";

    await recordRestoreApplyFailed(options.prisma, {
      operation,
      sourceBackup: operation.backupOperation,
      preRestoreBackup,
      failedStatus,
      errorCode,
      completedAt: now(),
      actor: options.actor
    });

    return {
      processed: true,
      operationId: operation.id,
      status: failedStatus,
      errorCode,
      preRestoreBackupOperationId: preRestoreBackup?.id ?? null
    };
  }
}

export function createPgRestoreApplyPort(options: {
  targetDatabaseUrl?: string;
  pgRestoreBinary?: string;
  spawnProcess?: SpawnRestoreProcess;
} = {}): NonNullable<RestoreApplyExecutorOptions["applyRestore"]> {
  return async ({ artifactPath, backupEncryptionKey, env }) => {
    const databaseUrl = options.targetDatabaseUrl ?? env.RESTORE_TARGET_DATABASE_URL;

    if (!databaseUrl) {
      throw new RestoreValidationError("RESTORE_TARGET_DATABASE_URL_INVALID");
    }

    const connection = toPostgresConnection(databaseUrl);
    const child = (options.spawnProcess ?? spawn)(
      options.pgRestoreBinary ?? env.PG_RESTORE_BINARY,
      [
        "--clean",
        "--if-exists",
        "--single-transaction",
        "--no-owner",
        "--no-privileges",
        "--host",
        connection.host,
        "--port",
        connection.port,
        "--username",
        connection.user,
        "--dbname",
        connection.database
      ],
      {
        env: postgresToolEnvironment(connection.password),
        shell: isWindowsCommandScript(options.pgRestoreBinary ?? env.PG_RESTORE_BINARY),
        stdio: ["pipe", "ignore", "pipe"]
      }
    );
    let stderr = "";
    const wait = new Promise<void>((resolve, reject) => {
      child.on("error", (error) => {
        child.stdin.destroy(error);
        reject(error);
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(`pg_restore failed with code ${code}: ${stderr.slice(0, 200)}`));
      });
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    await Promise.all([
      pipeline(
        await createDecryptedBackupArtifactStream(artifactPath, backupEncryptionKey),
        child.stdin
      ),
      wait
    ]);
  };
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
        requestedById: true,
        reason: true,
        requestedAt: true,
        startedAt: true,
        validatedAt: true,
        backupOperation: {
          select: {
            id: true,
            status: true,
            requestedById: true,
            requestedAt: true,
            startedAt: true,
            completedAt: true,
            productVersion: true,
            storageKey: true,
            sizeBytes: true,
            sha256: true,
            errorCode: true
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

async function claimNextValidatedRestoreForApply(
  prisma: PrismaClient,
  now: () => Date,
  actor?: RestoreApplyExecutorOptions["actor"]
): Promise<ClaimedRestoreOperation | null> {
  return prisma.$transaction(async (tx) => {
    const operation = await tx.restoreOperation.findFirst({
      where: {
        status: "VALIDATED",
        maintenanceStates: {
          some: {
            enabled: true,
            mode: "RESTORE"
          }
        }
      },
      orderBy: [{ validatedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        backupOperationId: true,
        requestedById: true,
        reason: true,
        requestedAt: true,
        startedAt: true,
        validatedAt: true,
        backupOperation: {
          select: {
            id: true,
            status: true,
            requestedById: true,
            requestedAt: true,
            startedAt: true,
            completedAt: true,
            productVersion: true,
            storageKey: true,
            sizeBytes: true,
            sha256: true,
            errorCode: true
          }
        }
      }
    });

    if (!operation) {
      return null;
    }

    const claimed = await tx.restoreOperation.updateMany({
      where: { id: operation.id, status: "VALIDATED" },
      data: {
        status: "PREPARING",
        startedAt: now(),
        errorCode: null
      }
    });

    if (claimed.count !== 1) {
      return null;
    }

    await tx.auditEvent.create({
      data: {
        eventType: "RESTORE_PREPARING_STARTED",
        actorType: restoreApplyActorType({ actor }),
        payload: {
          ...restoreApplyActorPayload({ actor }),
          restoreOperationId: operation.id,
          backupOperationId: operation.backupOperationId,
          status: "PREPARING"
        }
      }
    });

    return operation;
  });
}

async function createPreRestoreBackup(
  options: RestoreApplyExecutorOptions & {
    operation: ClaimedRestoreOperation;
    now: () => Date;
  }
): Promise<VerifiedBackupOperationSnapshot> {
  const preRestoreBackup = await options.prisma.backupOperation.create({
    data: {
      status: "REQUESTED",
      requestedById: options.operation.requestedById,
      productVersion
    }
  });
  const result = await processNextRequestedBackup({
    prisma: options.prisma,
    env: options.env,
    now: options.now,
    operationId: preRestoreBackup.id,
    createDumpStream: options.createDumpStream,
    createDumpSource: options.createDumpSource
  });

  if (
    !result.processed ||
    result.status !== "VERIFIED" ||
    result.operationId !== preRestoreBackup.id
  ) {
    throw new RestoreValidationError("PRE_RESTORE_BACKUP_FAILED");
  }

  await options.prisma.auditEvent.create({
    data: {
      eventType: "PRE_RESTORE_BACKUP_VERIFIED",
      actorType: restoreApplyActorType(options),
      payload: {
        ...restoreApplyActorPayload(options),
        restoreOperationId: options.operation.id,
        backupOperationId: options.operation.backupOperationId,
        preRestoreBackupOperationId: preRestoreBackup.id,
        status: "VERIFIED"
      }
    }
  });

  const verifiedBackup = await options.prisma.backupOperation.findUniqueOrThrow({
    where: { id: preRestoreBackup.id },
    select: backupSnapshotSelect
  });

  return verifiedSourceBackupSnapshot(verifiedBackup);
}

const backupSnapshotSelect = {
  id: true,
  status: true,
  requestedById: true,
  requestedAt: true,
  startedAt: true,
  completedAt: true,
  productVersion: true,
  storageKey: true,
  sizeBytes: true,
  sha256: true,
  errorCode: true
} as const;

function verifiedSourceBackupSnapshot(
  backup: BackupOperationSnapshot
): VerifiedBackupOperationSnapshot {
  if (
    backup.status !== "VERIFIED" ||
    !backup.storageKey ||
    !backup.sizeBytes ||
    !backup.sha256
  ) {
    throw new RestoreValidationError("RESTORE_BACKUP_NOT_RESTORABLE");
  }

  return {
    ...backup,
    status: "VERIFIED",
    storageKey: backup.storageKey,
    sizeBytes: backup.sizeBytes,
    sha256: backup.sha256
  };
}

async function recordRestoreApplyCompleted(
  prisma: PrismaClient,
  context: {
    operation: ClaimedRestoreOperation;
    sourceBackup: VerifiedBackupOperationSnapshot;
    preRestoreBackup: VerifiedBackupOperationSnapshot;
    completedAt: Date;
    actor?: RestoreApplyExecutorOptions["actor"];
  }
): Promise<void> {
  await prisma.$transaction([
    upsertVerifiedBackup(prisma, context.sourceBackup),
    upsertVerifiedBackup(prisma, context.preRestoreBackup),
    prisma.restoreOperation.upsert({
      where: { id: context.operation.id },
      update: {
        status: "COMPLETED",
        completedAt: context.completedAt,
        preRestoreBackupOperationId: context.preRestoreBackup.id,
        errorCode: null
      },
      create: {
        id: context.operation.id,
        status: "COMPLETED",
        backupOperationId: context.operation.backupOperationId,
        requestedById: context.operation.requestedById,
        reason: context.operation.reason,
        requestedAt: context.operation.requestedAt,
        startedAt: context.operation.startedAt ?? context.completedAt,
        validatedAt: context.operation.validatedAt ?? context.completedAt,
        completedAt: context.completedAt,
        preRestoreBackupOperationId: context.preRestoreBackup.id,
        errorCode: null
      }
    }),
    prisma.auditEvent.create({
      data: {
        eventType: "RESTORE_COMPLETED",
        actorType: restoreApplyActorType(context),
        payload: {
          ...restoreApplyActorPayload(context),
          restoreOperationId: context.operation.id,
          backupOperationId: context.operation.backupOperationId,
          preRestoreBackupOperationId: context.preRestoreBackup.id,
          status: "COMPLETED"
        }
      }
    })
  ]);
}

async function recordRestoreApplyFailed(
  prisma: PrismaClient,
  context: {
    operation: ClaimedRestoreOperation;
    sourceBackup: BackupOperationSnapshot;
    preRestoreBackup: VerifiedBackupOperationSnapshot | null;
    failedStatus: "FAILED" | "REQUIRES_RECOVERY";
    errorCode: string;
    completedAt: Date;
    actor?: RestoreApplyExecutorOptions["actor"];
  }
): Promise<void> {
  await prisma.$transaction([
    ...(context.sourceBackup.status === "VERIFIED"
      ? [upsertVerifiedBackup(prisma, verifiedSourceBackupSnapshot(context.sourceBackup))]
      : []),
    ...(context.preRestoreBackup
      ? [upsertVerifiedBackup(prisma, context.preRestoreBackup)]
      : []),
    prisma.restoreOperation.upsert({
      where: { id: context.operation.id },
      update: {
        status: context.failedStatus,
        completedAt: context.completedAt,
        errorCode: context.errorCode,
        ...(context.preRestoreBackup
          ? { preRestoreBackupOperationId: context.preRestoreBackup.id }
          : {})
      },
      create: {
        id: context.operation.id,
        status: context.failedStatus,
        backupOperationId: context.operation.backupOperationId,
        requestedById: context.operation.requestedById,
        reason: context.operation.reason,
        requestedAt: context.operation.requestedAt,
        startedAt: context.operation.startedAt ?? context.completedAt,
        validatedAt: context.operation.validatedAt,
        completedAt: context.completedAt,
        preRestoreBackupOperationId: context.preRestoreBackup?.id ?? null,
        errorCode: context.errorCode
      }
    }),
    prisma.auditEvent.create({
      data: {
        eventType:
          context.failedStatus === "REQUIRES_RECOVERY"
            ? "RESTORE_REQUIRES_RECOVERY"
            : "RESTORE_APPLY_FAILED",
        actorType: restoreApplyActorType(context),
        payload: {
          ...restoreApplyActorPayload(context),
          restoreOperationId: context.operation.id,
          backupOperationId: context.operation.backupOperationId,
          preRestoreBackupOperationId: context.preRestoreBackup?.id ?? null,
          status: context.failedStatus,
          errorCode: context.errorCode
        }
      }
    })
  ]);
}

function restoreApplyActorType(context: {
  actor?: RestoreApplyExecutorOptions["actor"];
}): "SYSTEM" | "USER" {
  return context.actor ? "USER" : "SYSTEM";
}

function restoreApplyActorPayload(context: {
  actor?: RestoreApplyExecutorOptions["actor"];
}): Record<string, string> {
  if (!context.actor) {
    return {};
  }

  return {
    actorUserId: context.actor.userId,
    ...(context.actor.correlationId
      ? { correlationId: context.actor.correlationId }
      : {})
  };
}

function upsertVerifiedBackup(
  prisma: PrismaClient,
  backup: VerifiedBackupOperationSnapshot
) {
  return prisma.backupOperation.upsert({
    where: { id: backup.id },
    update: {
      status: "VERIFIED",
      startedAt: backup.startedAt,
      completedAt: backup.completedAt,
      productVersion: backup.productVersion,
      storageKey: backup.storageKey,
      sizeBytes: backup.sizeBytes,
      sha256: backup.sha256,
      errorCode: null
    },
    create: {
      id: backup.id,
      status: "VERIFIED",
      requestedById: backup.requestedById,
      requestedAt: backup.requestedAt,
      startedAt: backup.startedAt,
      completedAt: backup.completedAt,
      productVersion: backup.productVersion,
      storageKey: backup.storageKey,
      sizeBytes: backup.sizeBytes,
      sha256: backup.sha256,
      errorCode: null
    }
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
): Promise<{
  sizeBytes: bigint;
  sha256: string;
  artifactPath: string;
  backupEncryptionKey: Buffer;
}> {
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

  const backupEncryptionKey = parseBackupEncryptionKey(env.BACKUP_ENCRYPTION_KEY);

  await verifyEncryptedBackupArtifact(artifactPath, backupEncryptionKey);

  return {
    sizeBytes: actualSize,
    sha256: actualSha256,
    artifactPath,
    backupEncryptionKey
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

function classifyRestoreApplyError(error: unknown): string {
  if (error instanceof RestoreValidationError) {
    return error.code;
  }

  return "RESTORE_APPLY_FAILED";
}

function requiresManualRestoreRecovery(errorCode: string): boolean {
  return errorCode === "RESTORE_APPLY_FAILED";
}

function toPostgresConnection(databaseUrl: string): {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
} {
  let url: URL;

  try {
    url = new URL(databaseUrl);
  } catch {
    throw new RestoreValidationError("RESTORE_TARGET_DATABASE_URL_INVALID");
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));

  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !database ||
    !url.hostname ||
    !url.username
  ) {
    throw new RestoreValidationError("RESTORE_TARGET_DATABASE_URL_INVALID");
  }

  return {
    host: url.hostname,
    port: url.port || "5432",
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database
  };
}

function postgresToolEnvironment(password: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    NODE_ENV: process.env.NODE_ENV,
    PGPASSWORD: password
  };
}

function isWindowsCommandScript(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

class RestoreValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
