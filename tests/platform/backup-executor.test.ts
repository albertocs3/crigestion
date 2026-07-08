import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  processNextRequestedBackup,
  verifyEncryptedBackupArtifact
} from "@/modules/platform/infrastructure/backupExecutor";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";

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

describe("backup executor", () => {
  let backupDirectory: string;

  beforeEach(async () => {
    backupDirectory = await mkdtemp(path.join(os.tmpdir(), "crigestion-backup-"));
    await resetPlatformTables();
    await initializeForBackups();
  });

  afterEach(async () => {
    await rm(backupDirectory, { force: true, recursive: true });
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("processes the next requested backup and stores encrypted metadata", async () => {
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

    expect(result).toMatchObject({
      processed: true,
      operationId: operation.id,
      status: "VERIFIED",
      storageKey: expect.stringContaining(operation.id),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });

    if (!result.processed || result.status !== "VERIFIED") {
      return;
    }

    const updatedOperation = await prisma.backupOperation.findUniqueOrThrow({
      where: { id: operation.id }
    });
    const artifactPath = path.join(backupDirectory, result.storageKey);
    const artifact = await readFile(artifactPath);
    const originalArtifact = Buffer.from(artifact);
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "BACKUP_VERIFIED" }
    });

    expect(updatedOperation.status).toBe("VERIFIED");
    expect(updatedOperation.startedAt?.toISOString()).toBe("2026-07-02T10:00:00.000Z");
    expect(updatedOperation.completedAt?.toISOString()).toBe("2026-07-02T10:00:00.000Z");
    expect(updatedOperation.storageKey).toBe(result.storageKey);
    expect(updatedOperation.sizeBytes).toBe(result.sizeBytes);
    expect(updatedOperation.sha256).toBe(result.sha256);
    expect(typeof result.sizeBytes).toBe("bigint");
    expect(artifact.toString("utf8")).toContain("CRIGESTION-BACKUP-v1");
    expect(artifact.toString("utf8")).not.toContain("pg dump content");
    await expect(
      verifyEncryptedBackupArtifact(artifactPath, backupKey())
    ).resolves.toBeUndefined();

    await expect(
      verifyEncryptedBackupArtifact(artifactPath, Buffer.alloc(32, 7))
    ).rejects.toThrow();

    const headerTamperedArtifact = Buffer.from(originalArtifact);
    const headerOffset = headerTamperedArtifact.indexOf("2026-07-02");
    expect(headerOffset).toBeGreaterThan(0);
    headerTamperedArtifact[headerOffset + 9] =
      headerTamperedArtifact[headerOffset + 9] ^ 1;
    await writeFile(artifactPath, headerTamperedArtifact);
    await expect(
      verifyEncryptedBackupArtifact(artifactPath, backupKey())
    ).rejects.toThrow();

    const tagTamperedArtifact = Buffer.from(originalArtifact);
    tagTamperedArtifact[tagTamperedArtifact.length - 1] =
      tagTamperedArtifact[tagTamperedArtifact.length - 1] ^ 1;
    await writeFile(artifactPath, tagTamperedArtifact);
    await expect(
      verifyEncryptedBackupArtifact(artifactPath, backupKey())
    ).rejects.toThrow();

    await writeFile(artifactPath, originalArtifact.subarray(0, originalArtifact.length - 8));
    await expect(
      verifyEncryptedBackupArtifact(artifactPath, backupKey())
    ).rejects.toThrow();
    expect(auditEvent.payload).toMatchObject({
      backupOperationId: operation.id,
      status: "VERIFIED",
      sha256: result.sha256
    });
  });

  it("marks the backup as failed with a safe error code", async () => {
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
      env: {
        ...backupEnv(backupDirectory),
        BACKUP_ENCRYPTION_KEY: "not-a-valid-key"
      },
      now: fixedNow,
      createDumpStream: () => Readable.from(["pg dump content"])
    });
    const updatedOperation = await prisma.backupOperation.findUniqueOrThrow({
      where: { id: operation.id }
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "BACKUP_FAILED" }
    });

    expect(result).toEqual({
      processed: true,
      operationId: operation.id,
      status: "FAILED",
      errorCode: "BACKUP_ENCRYPTION_KEY_INVALID"
    });
    expect(updatedOperation.status).toBe("FAILED");
    expect(updatedOperation.errorCode).toBe("BACKUP_ENCRYPTION_KEY_INVALID");
    expect(auditEvent.payload).toMatchObject({
      backupOperationId: operation.id,
      status: "FAILED",
      errorCode: "BACKUP_ENCRYPTION_KEY_INVALID"
    });
  });

  it("marks pg dump failures as failed and removes partial artifacts", async () => {
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
      createDumpSource: () => ({
        stream: Readable.from(["partial dump"]),
        wait: async () => {
          throw new Error("pg_dump failed with code 1");
        }
      })
    });
    const updatedOperation = await prisma.backupOperation.findUniqueOrThrow({
      where: { id: operation.id }
    });
    const files = await readdir(backupDirectory);

    expect(result).toEqual({
      processed: true,
      operationId: operation.id,
      status: "FAILED",
      errorCode: "PG_DUMP_FAILED"
    });
    expect(updatedOperation.status).toBe("FAILED");
    expect(files).toEqual([]);
  });

  it("fails stale running backups before processing the next request", async () => {
    const admin = await prisma.user.findUniqueOrThrow({
      where: { normalizedUserName: "admin" }
    });
    const staleOperation = await prisma.backupOperation.create({
      data: {
        status: "RUNNING",
        requestedById: admin.id,
        requestedAt: new Date("2026-07-02T08:00:00.000Z"),
        startedAt: new Date("2026-07-02T08:00:00.000Z"),
        productVersion: "0.1.0"
      }
    });
    const result = await processNextRequestedBackup({
      prisma,
      env: {
        ...backupEnv(backupDirectory),
        BACKUP_RUNNING_TIMEOUT_MINUTES: "60"
      },
      now: fixedNow,
      createDumpStream: () => Readable.from(["pg dump content"])
    });
    const staleAfterRun = await prisma.backupOperation.findUniqueOrThrow({
      where: { id: staleOperation.id }
    });

    expect(result).toEqual({
      processed: false,
      reason: "NO_REQUESTED_BACKUP"
    });
    expect(staleAfterRun.status).toBe("FAILED");
    expect(staleAfterRun.errorCode).toBe("BACKUP_WORKER_TIMEOUT");
  });

  it("does nothing when no backup has been requested", async () => {
    const result = await processNextRequestedBackup({
      prisma,
      env: backupEnv(backupDirectory),
      now: fixedNow,
      createDumpStream: () => Readable.from(["pg dump content"])
    });

    expect(result).toEqual({
      processed: false,
      reason: "NO_REQUESTED_BACKUP"
    });
  });
});

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

async function initializeForBackups(): Promise<void> {
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

    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
