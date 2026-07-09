import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";
import { processNextRequestedBackup } from "@/modules/platform/infrastructure/backupExecutor";
import {
  createPgRestoreApplyPort,
  processNextRequestedRestore,
  processNextValidatedRestoreApply
} from "@/modules/platform/infrastructure/restoreExecutor";

const baseCommand: InitializeCommand = {
  company: {
    legalName: "CriGestion Test SL",
    taxId: "B12345678",
    email: "admin@example.test"
  },
  administrator: {
    displayName: "Administrador",
    userName: "admin",
    password: "Cambiar-esta-clave-2026"
  }
};

describe("restore executor", () => {
  let backupDirectory: string;

  beforeEach(async () => {
    backupDirectory = await mkdtemp(path.join(os.tmpdir(), "crigestion-restore-"));
    await resetPlatformTables();
    await initializeForRestores();
  });

  afterEach(async () => {
    await rm(backupDirectory, { force: true, recursive: true });
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("validates the encrypted artifact for the next requested restore", async () => {
    const backup = await createVerifiedBackupFromDump(backupDirectory);
    const restore = await createRequestedRestore(backup.id);

    const result = await processNextRequestedRestore({
      prisma,
      env: backupEnv(backupDirectory),
      now: fixedNow
    });
    const updatedRestore = await prisma.restoreOperation.findUniqueOrThrow({
      where: { id: restore.id }
    });
    const startedEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "RESTORE_VALIDATION_STARTED" }
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "RESTORE_VALIDATED" }
    });

    expect(result).toEqual({
      processed: true,
      operationId: restore.id,
      status: "VALIDATED",
      backupOperationId: backup.id,
      sizeBytes: backup.sizeBytes,
      sha256: backup.sha256
    });
    expect(updatedRestore.status).toBe("VALIDATED");
    expect(updatedRestore.startedAt?.toISOString()).toBe("2026-07-02T10:00:00.000Z");
    expect(updatedRestore.validatedAt?.toISOString()).toBe("2026-07-02T10:00:00.000Z");
    expect(updatedRestore.completedAt).toBeNull();
    expect(updatedRestore.errorCode).toBeNull();
    expect(startedEvent.payload).toMatchObject({
      restoreOperationId: restore.id,
      backupOperationId: backup.id,
      status: "VALIDATING"
    });
    expect(JSON.stringify(auditEvent.payload)).not.toContain("storageKey");
    expect(auditEvent.payload).toMatchObject({
      restoreOperationId: restore.id,
      backupOperationId: backup.id,
      status: "VALIDATED",
      sha256: backup.sha256
    });
  });

  it("fails safely when the artifact content no longer matches metadata", async () => {
    const backup = await createVerifiedBackupFromDump(backupDirectory);
    const restore = await createRequestedRestore(backup.id);

    await writeFile(
      path.join(backupDirectory, backup.storageKey ?? ""),
      "tampered artifact"
    );

    const result = await processNextRequestedRestore({
      prisma,
      env: backupEnv(backupDirectory),
      now: fixedNow
    });
    const updatedRestore = await prisma.restoreOperation.findUniqueOrThrow({
      where: { id: restore.id }
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "RESTORE_VALIDATION_FAILED" }
    });

    expect(result).toEqual({
      processed: true,
      operationId: restore.id,
      status: "FAILED",
      errorCode: "RESTORE_BACKUP_SIZE_MISMATCH"
    });
    expect(updatedRestore.status).toBe("FAILED");
    expect(updatedRestore.completedAt?.toISOString()).toBe("2026-07-02T10:00:00.000Z");
    expect(updatedRestore.errorCode).toBe("RESTORE_BACKUP_SIZE_MISMATCH");
    expect(auditEvent.payload).toMatchObject({
      restoreOperationId: restore.id,
      backupOperationId: backup.id,
      status: "FAILED",
      errorCode: "RESTORE_BACKUP_SIZE_MISMATCH"
    });
  });

  it("fails safely when the backup encryption key is invalid", async () => {
    const backup = await createVerifiedBackupFromDump(backupDirectory);
    const restore = await createRequestedRestore(backup.id);

    const result = await processNextRequestedRestore({
      prisma,
      env: {
        ...backupEnv(backupDirectory),
        BACKUP_ENCRYPTION_KEY: "not-a-valid-key"
      },
      now: fixedNow
    });
    const updatedRestore = await prisma.restoreOperation.findUniqueOrThrow({
      where: { id: restore.id }
    });

    expect(result).toEqual({
      processed: true,
      operationId: restore.id,
      status: "FAILED",
      errorCode: "BACKUP_ENCRYPTION_KEY_INVALID"
    });
    expect(updatedRestore.status).toBe("FAILED");
    expect(updatedRestore.errorCode).toBe("BACKUP_ENCRYPTION_KEY_INVALID");
  });

  it("rejects storage keys that escape the backup directory", async () => {
    const admin = await prisma.user.findUniqueOrThrow({
      where: { normalizedUserName: "admin" }
    });
    const backup = await prisma.backupOperation.create({
      data: {
        status: "VERIFIED",
        requestedById: admin.id,
        productVersion: "0.1.0",
        storageKey: "../outside.backup",
        sizeBytes: 1234n,
        sha256: "a".repeat(64)
      }
    });
    const restore = await createRequestedRestore(backup.id);

    const result = await processNextRequestedRestore({
      prisma,
      env: backupEnv(backupDirectory),
      now: fixedNow
    });
    const updatedRestore = await prisma.restoreOperation.findUniqueOrThrow({
      where: { id: restore.id }
    });

    expect(result).toEqual({
      processed: true,
      operationId: restore.id,
      status: "FAILED",
      errorCode: "RESTORE_BACKUP_STORAGE_KEY_INVALID"
    });
    expect(updatedRestore.status).toBe("FAILED");
    expect(updatedRestore.errorCode).toBe("RESTORE_BACKUP_STORAGE_KEY_INVALID");
  });

  it("fails stale validation operations before processing the next request", async () => {
    const backup = await createVerifiedBackupFromDump(backupDirectory);
    const staleRestore = await createRequestedRestore(backup.id);
    await prisma.restoreOperation.update({
      where: { id: staleRestore.id },
      data: {
        status: "VALIDATING",
        startedAt: new Date("2026-07-02T08:00:00.000Z")
      }
    });

    const result = await processNextRequestedRestore({
      prisma,
      env: {
        ...backupEnv(backupDirectory),
        RESTORE_VALIDATION_TIMEOUT_MINUTES: "60"
      },
      now: fixedNow
    });
    const staleAfterRun = await prisma.restoreOperation.findUniqueOrThrow({
      where: { id: staleRestore.id }
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: {
        eventType: "RESTORE_VALIDATION_FAILED",
        payload: {
          path: ["errorCode"],
          equals: "RESTORE_WORKER_TIMEOUT"
        }
      }
    });

    expect(result).toEqual({
      processed: false,
      reason: "NO_REQUESTED_RESTORE"
    });
    expect(staleAfterRun.status).toBe("FAILED");
    expect(staleAfterRun.errorCode).toBe("RESTORE_WORKER_TIMEOUT");
    expect(auditEvent.payload).toMatchObject({
      restoreOperationId: staleRestore.id,
      backupOperationId: backup.id,
      errorCode: "RESTORE_WORKER_TIMEOUT"
    });
  });

  it("allows only one concurrent worker to claim a requested restore", async () => {
    const backup = await createVerifiedBackupFromDump(backupDirectory);
    const restore = await createRequestedRestore(backup.id);

    const results = await Promise.all([
      processNextRequestedRestore({
        prisma,
        env: backupEnv(backupDirectory),
        now: fixedNow
      }),
      processNextRequestedRestore({
        prisma,
        env: backupEnv(backupDirectory),
        now: fixedNow
      })
    ]);
    const processedResults = results.filter((result) => result.processed);
    const idleResults = results.filter((result) => !result.processed);
    const updatedRestore = await prisma.restoreOperation.findUniqueOrThrow({
      where: { id: restore.id }
    });

    expect(processedResults).toHaveLength(1);
    expect(processedResults[0]).toMatchObject({
      operationId: restore.id,
      status: "VALIDATED"
    });
    expect(idleResults).toEqual([{ processed: false, reason: "NO_REQUESTED_RESTORE" }]);
    expect(updatedRestore.status).toBe("VALIDATED");
  });

  it("applies a validated restore only when restore maintenance is active", async () => {
    const backup = await createVerifiedBackupFromDump(backupDirectory);
    const restore = await createValidatedRestore(backup.id);

    const idleResult = await processNextValidatedRestoreApply({
      prisma,
      env: backupEnv(backupDirectory),
      now: fixedNow,
      createDumpStream: () => Readable.from(["pre restore dump"]),
      applyRestore: async () => {}
    });

    await enableMaintenanceForRestore(restore.id);
    const admin = await prisma.user.findUniqueOrThrow({
      where: { normalizedUserName: "admin" }
    });

    const result = await processNextValidatedRestoreApply({
      prisma,
      env: backupEnv(backupDirectory),
      now: fixedNow,
      actor: {
        userId: admin.id,
        correlationId: "restore-apply-0001"
      },
      createDumpStream: () => Readable.from(["pre restore dump"]),
      applyRestore: async ({ restoreOperationId, backupOperationId }) => {
        expect(restoreOperationId).toBe(restore.id);
        expect(backupOperationId).toBe(backup.id);
      }
    });
    const updatedRestore = await prisma.restoreOperation.findUniqueOrThrow({
      where: { id: restore.id }
    });
    const preRestoreBackup = await prisma.backupOperation.findUniqueOrThrow({
      where: { id: updatedRestore.preRestoreBackupOperationId ?? "" }
    });
    const completedEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "RESTORE_COMPLETED" }
    });

    expect(idleResult).toEqual({
      processed: false,
      reason: "NO_VALIDATED_RESTORE_IN_MAINTENANCE"
    });
    expect(result).toMatchObject({
      processed: true,
      operationId: restore.id,
      status: "COMPLETED",
      backupOperationId: backup.id,
      preRestoreBackupOperationId: preRestoreBackup.id
    });
    expect(updatedRestore.status).toBe("COMPLETED");
    expect(updatedRestore.completedAt?.toISOString()).toBe("2026-07-02T10:00:00.000Z");
    expect(preRestoreBackup.status).toBe("VERIFIED");
    expect(completedEvent.payload).toMatchObject({
      actorUserId: admin.id,
      correlationId: "restore-apply-0001",
      restoreOperationId: restore.id,
      backupOperationId: backup.id,
      preRestoreBackupOperationId: preRestoreBackup.id,
      status: "COMPLETED"
    });
    expect(completedEvent.actorType).toBe("USER");
    expect(JSON.stringify(completedEvent.payload)).not.toContain("storageKey");
  });

  it("records completion when pg_restore replaces restore control rows", async () => {
    const backup = await createVerifiedBackupFromDump(backupDirectory);
    const restore = await createValidatedRestore(backup.id);
    await enableMaintenanceForRestore(restore.id);

    const result = await processNextValidatedRestoreApply({
      prisma,
      env: backupEnv(backupDirectory),
      now: fixedNow,
      createDumpStream: () => Readable.from(["pre restore dump"]),
      applyRestore: async () => {
        const preRestoreBackup = await prisma.restoreOperation
          .findUniqueOrThrow({
            where: { id: restore.id },
            select: { preRestoreBackupOperationId: true }
          })
          .then((operation) => operation.preRestoreBackupOperationId);

        await prisma.platformMaintenanceState.deleteMany();
        await prisma.restoreOperation.deleteMany({ where: { id: restore.id } });
        await prisma.backupOperation.deleteMany({
          where: { id: preRestoreBackup ?? "" }
        });
        await prisma.backupOperation.update({
          where: { id: backup.id },
          data: {
            status: "RUNNING",
            completedAt: null,
            storageKey: null,
            sizeBytes: null,
            sha256: null
          }
        });
      }
    });
    const updatedRestore = await prisma.restoreOperation.findUniqueOrThrow({
      where: { id: restore.id }
    });
    const sourceBackup = await prisma.backupOperation.findUniqueOrThrow({
      where: { id: backup.id }
    });
    const preRestoreBackup = await prisma.backupOperation.findUniqueOrThrow({
      where: { id: updatedRestore.preRestoreBackupOperationId ?? "" }
    });

    expect(result).toMatchObject({
      processed: true,
      operationId: restore.id,
      status: "COMPLETED",
      backupOperationId: backup.id,
      preRestoreBackupOperationId: preRestoreBackup.id
    });
    expect(updatedRestore.status).toBe("COMPLETED");
    expect(sourceBackup.status).toBe("VERIFIED");
    expect(sourceBackup.storageKey).toBe(backup.storageKey);
    expect(preRestoreBackup.status).toBe("VERIFIED");
  });

  it("requires recovery when the destructive apply step fails after the pre-restore backup", async () => {
    const backup = await createVerifiedBackupFromDump(backupDirectory);
    const restore = await createValidatedRestore(backup.id);
    await enableMaintenanceForRestore(restore.id);

    const result = await processNextValidatedRestoreApply({
      prisma,
      env: backupEnv(backupDirectory),
      now: fixedNow,
      createDumpStream: () => Readable.from(["pre restore dump"]),
      applyRestore: async () => {
        throw new Error("pg_restore failed");
      }
    });
    const updatedRestore = await prisma.restoreOperation.findUniqueOrThrow({
      where: { id: restore.id }
    });
    const recoveryEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "RESTORE_REQUIRES_RECOVERY" }
    });

    expect(result).toMatchObject({
      processed: true,
      operationId: restore.id,
      status: "REQUIRES_RECOVERY",
      errorCode: "RESTORE_APPLY_FAILED"
    });
    expect(updatedRestore.status).toBe("REQUIRES_RECOVERY");
    expect(updatedRestore.preRestoreBackupOperationId).toBeTruthy();
    expect(updatedRestore.errorCode).toBe("RESTORE_APPLY_FAILED");
    expect(recoveryEvent.payload).toMatchObject({
      restoreOperationId: restore.id,
      backupOperationId: backup.id,
      status: "REQUIRES_RECOVERY",
      errorCode: "RESTORE_APPLY_FAILED"
    });
  });

  it("fails without requiring recovery when restore target configuration is invalid", async () => {
    const backup = await createVerifiedBackupFromDump(backupDirectory);
    const restore = await createValidatedRestore(backup.id);
    await enableMaintenanceForRestore(restore.id);

    const result = await processNextValidatedRestoreApply({
      prisma,
      env: backupEnv(backupDirectory),
      now: fixedNow,
      createDumpStream: () => Readable.from(["pre restore dump"]),
      applyRestore: createPgRestoreApplyPort({
        targetDatabaseUrl: "mysql://restore_user:restore_password@localhost:3306/restore_db",
        pgRestoreBinary: "pg_restore_test"
      })
    });
    const updatedRestore = await prisma.restoreOperation.findUniqueOrThrow({
      where: { id: restore.id }
    });
    const preRestoreBackup = await prisma.backupOperation.findUniqueOrThrow({
      where: { id: updatedRestore.preRestoreBackupOperationId ?? "" }
    });
    const failedEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "RESTORE_APPLY_FAILED" }
    });

    expect(result).toMatchObject({
      processed: true,
      operationId: restore.id,
      status: "FAILED",
      errorCode: "RESTORE_TARGET_DATABASE_URL_INVALID",
      preRestoreBackupOperationId: preRestoreBackup.id
    });
    expect(updatedRestore.status).toBe("FAILED");
    expect(updatedRestore.preRestoreBackupOperationId).toBe(preRestoreBackup.id);
    expect(preRestoreBackup.status).toBe("VERIFIED");
    expect(failedEvent.payload).toMatchObject({
      restoreOperationId: restore.id,
      status: "FAILED",
      errorCode: "RESTORE_TARGET_DATABASE_URL_INVALID"
    });
  });

  it("fails before creating the pre-restore backup when no apply port is configured", async () => {
    const backup = await createVerifiedBackupFromDump(backupDirectory);
    const restore = await createValidatedRestore(backup.id);
    await enableMaintenanceForRestore(restore.id);

    const result = await processNextValidatedRestoreApply({
      prisma,
      env: backupEnv(backupDirectory),
      now: fixedNow,
      createDumpStream: () => Readable.from(["pre restore dump"])
    });
    const updatedRestore = await prisma.restoreOperation.findUniqueOrThrow({
      where: { id: restore.id }
    });

    expect(result).toMatchObject({
      processed: true,
      operationId: restore.id,
      status: "FAILED",
      errorCode: "RESTORE_APPLY_PORT_NOT_CONFIGURED"
    });
    expect(updatedRestore.status).toBe("FAILED");
    expect(updatedRestore.preRestoreBackupOperationId).toBeNull();
    expect(updatedRestore.errorCode).toBe("RESTORE_APPLY_PORT_NOT_CONFIGURED");
  });

  it("streams the decrypted backup artifact to pg_restore without putting secrets in args", async () => {
    const backup = await createVerifiedBackupFromDump(backupDirectory);
    const receivedChunks: Buffer[] = [];
    const spawnCalls: Array<{
      command: string;
      args: string[];
      password: string | undefined;
    }> = [];
    const fakeSpawn = (
      command: string,
      args: readonly string[],
      options: { env?: NodeJS.ProcessEnv }
    ) => {
      const child = new EventEmitter() as ReturnType<typeof import("node:child_process").spawn>;
      const stdin = new PassThrough();
      const stderr = new PassThrough();

      spawnCalls.push({
        command,
        args: [...args],
        password: options.env?.PGPASSWORD
      });
      stdin.on("data", (chunk: Buffer) => {
        receivedChunks.push(chunk);
      });
      stdin.on("finish", () => {
        setImmediate(() => child.emit("close", 0));
      });
      Object.assign(child, {
        stdin,
        stderr
      });

      return child;
    };
    const artifactPath = path.join(backupDirectory, backup.storageKey ?? "");
    const applyRestore = createPgRestoreApplyPort({
      targetDatabaseUrl: "postgresql://restore_user:restore_password@localhost:5432/restore_db",
      pgRestoreBinary: "pg_restore_test",
      spawnProcess: fakeSpawn as typeof import("node:child_process").spawn
    });

    await applyRestore({
      restoreOperationId: randomUUID(),
      backupOperationId: backup.id,
      artifactPath,
      backupEncryptionKey: backupKey(),
      env: {
        BACKUP_DIRECTORY: backupDirectory,
        BACKUP_ENCRYPTION_KEY: backupKey().toString("hex"),
        PG_RESTORE_BINARY: "pg_restore_test",
        RESTORE_VALIDATION_TIMEOUT_MINUTES: 720
      }
    });

    expect(Buffer.concat(receivedChunks).toString("utf8")).toBe("pg dump content");
    expect(spawnCalls).toEqual([
      {
        command: "pg_restore_test",
        args: [
          "--clean",
          "--if-exists",
          "--single-transaction",
          "--no-owner",
          "--no-privileges",
          "--host",
          "localhost",
          "--port",
          "5432",
          "--username",
          "restore_user",
          "--dbname",
          "restore_db"
        ],
        password: "restore_password"
      }
    ]);
    expect(spawnCalls[0]?.args.join(" ")).not.toContain("restore_password");
  });

  it("rejects non-PostgreSQL restore target URLs", async () => {
    const applyRestore = createPgRestoreApplyPort({
      targetDatabaseUrl: "mysql://restore_user:restore_password@localhost:3306/restore_db",
      pgRestoreBinary: "pg_restore_test"
    });

    await expect(
      applyRestore({
        restoreOperationId: randomUUID(),
        backupOperationId: randomUUID(),
        artifactPath: path.join(backupDirectory, "missing.backup"),
        backupEncryptionKey: backupKey(),
        env: {
          BACKUP_DIRECTORY: backupDirectory,
          BACKUP_ENCRYPTION_KEY: backupKey().toString("hex"),
          PG_RESTORE_BINARY: "pg_restore_test",
          RESTORE_VALIDATION_TIMEOUT_MINUTES: 720
        }
      })
    ).rejects.toThrow("RESTORE_TARGET_DATABASE_URL_INVALID");
  });

  it("does nothing when no restore has been requested", async () => {
    const result = await processNextRequestedRestore({
      prisma,
      env: backupEnv(backupDirectory),
      now: fixedNow
    });

    expect(result).toEqual({
      processed: false,
      reason: "NO_REQUESTED_RESTORE"
    });
  });
});

async function createVerifiedBackupFromDump(backupDirectory: string) {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { normalizedUserName: "admin" }
  });
  const operation = await prisma.backupOperation.create({
    data: {
      status: "REQUESTED",
      requestedById: admin.id,
      productVersion: "0.1.0"
    }
  });
  const result = await processNextRequestedBackup({
    prisma,
    env: backupEnv(backupDirectory),
    now: fixedNow,
    createDumpStream: () => Readable.from(["pg dump content"])
  });

  expect(result.processed).toBe(true);
  expect(result).toMatchObject({
    operationId: operation.id,
    status: "VERIFIED"
  });

  return prisma.backupOperation.findUniqueOrThrow({
    where: { id: operation.id }
  });
}

async function createRequestedRestore(backupOperationId: string) {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { normalizedUserName: "admin" }
  });

  return prisma.restoreOperation.create({
    data: {
      status: "REQUESTED",
      backupOperationId,
      requestedById: admin.id,
      reason: "Restauracion de prueba controlada"
    }
  });
}

async function createValidatedRestore(backupOperationId: string) {
  const restore = await createRequestedRestore(backupOperationId);

  return prisma.restoreOperation.update({
    where: { id: restore.id },
    data: {
      status: "VALIDATED",
      startedAt: new Date("2026-07-02T09:00:00.000Z"),
      validatedAt: new Date("2026-07-02T09:05:00.000Z")
    }
  });
}

async function enableMaintenanceForRestore(restoreOperationId: string): Promise<void> {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { normalizedUserName: "admin" }
  });

  await prisma.platformMaintenanceState.create({
    data: {
      singletonKey: 1,
      enabled: true,
      mode: "RESTORE",
      reason: "Ventana de restauracion controlada",
      restoreOperationId,
      enabledById: admin.id,
      enabledAt: new Date("2026-07-02T09:10:00.000Z")
    }
  });
}

function backupEnv(backupDirectory: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL,
    BACKUP_DIRECTORY: backupDirectory,
    BACKUP_ENCRYPTION_KEY: backupKey().toString("hex")
  };
}

function backupKey(): Buffer {
  return Buffer.from(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "hex"
  );
}

function fixedNow(): Date {
  return new Date("2026-07-02T10:00:00.000Z");
}

async function initializeForRestores(): Promise<void> {
  const rawBody = JSON.stringify(baseCommand);
  const result = await initializePlatform(
    baseCommand,
    randomUUID(),
    hashRequestBody(rawBody)
  );

  if (!result.ok) {
    throw new Error(result.error.code);
  }
}

async function resetPlatformTables(): Promise<void> {
  await prisma.$transaction([
    prisma.platformMaintenanceState.deleteMany(),
    prisma.restoreOperation.deleteMany(),
    prisma.backupOperation.deleteMany(),
    prisma.idempotencyRecord.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.installation.deleteMany(),
    prisma.reservedUserName.deleteMany(),
    prisma.session.deleteMany(),
    prisma.rateLimitBucket.deleteMany(),
    prisma.loginAttempt.deleteMany(),
    prisma.customerAddress.deleteMany(),

    prisma.customerStore.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.catalogItem.deleteMany(),

    prisma.accountingJournalLine.deleteMany(),
    prisma.accountingJournalEntry.deleteMany(),
    prisma.accountingAccount.deleteMany(),
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
