import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";
import { processNextRequestedBackup } from "@/modules/platform/infrastructure/backupExecutor";
import { processNextRequestedRestore } from "@/modules/platform/infrastructure/restoreExecutor";

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
    prisma.restoreOperation.deleteMany(),
    prisma.backupOperation.deleteMany(),
    prisma.idempotencyRecord.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.installation.deleteMany(),
    prisma.reservedUserName.deleteMany(),
    prisma.session.deleteMany(),
    prisma.rateLimitBucket.deleteMany(),
    prisma.loginAttempt.deleteMany(),
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
