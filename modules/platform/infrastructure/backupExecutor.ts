import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import type { BackupOperation, PrismaClient } from "@prisma/client";
import { z } from "zod";

const backupMagic = "CRIGESTION-BACKUP-v1";
const backupKeySchema = z.string().trim().min(1);
const backupEnvironmentSchema = z.object({
  BACKUP_DIRECTORY: z.string().trim().min(1).default("backups"),
  BACKUP_ENCRYPTION_KEY: backupKeySchema,
  PG_DUMP_BINARY: z.string().trim().min(1).default("pg_dump"),
  BACKUP_RUNNING_TIMEOUT_MINUTES: z.coerce.number().int().min(1).default(720)
});

type BackupEnvironment = z.infer<typeof backupEnvironmentSchema>;
type DumpSource = {
  stream: Readable;
  wait: () => Promise<void>;
};

export type BackupExecutorOptions = {
  prisma: PrismaClient;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  createDumpStream?: (databaseUrl: string) => Readable;
  createDumpSource?: (databaseUrl: string) => DumpSource;
};

export type BackupExecutorResult =
  | {
      processed: true;
      operationId: string;
      status: "VERIFIED";
      storageKey: string;
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
      reason: "NO_REQUESTED_BACKUP";
    };

type ClaimedBackupOperation = Pick<BackupOperation, "id">;

export async function processNextRequestedBackup(
  options: BackupExecutorOptions
): Promise<BackupExecutorResult> {
  const now = options.now ?? (() => new Date());
  const staleTimeoutMinutes = readBackupRunningTimeoutMinutes(
    options.env ?? process.env
  );

  await failStaleRunningBackups(options.prisma, now, staleTimeoutMinutes);

  const operation = await claimNextRequestedBackup(options.prisma, now);

  if (!operation) {
    return {
      processed: false,
      reason: "NO_REQUESTED_BACKUP"
    };
  }

  try {
    const env = readBackupEnvironment(options.env ?? process.env);
    const artifact = await createEncryptedDatabaseBackup({
      operationId: operation.id,
      env,
      databaseUrl: readDatabaseUrl(options.env ?? process.env),
      now,
      createDumpSource: options.createDumpSource,
      createDumpStream: options.createDumpStream
    });

    await options.prisma.$transaction([
      options.prisma.backupOperation.update({
        where: { id: operation.id },
        data: {
          status: "VERIFIED",
          completedAt: now(),
          storageKey: artifact.storageKey,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
          errorCode: null
        }
      }),
      options.prisma.auditEvent.create({
        data: {
          eventType: "BACKUP_VERIFIED",
          actorType: "SYSTEM",
          payload: {
            backupOperationId: operation.id,
            status: "VERIFIED",
            sizeBytes: artifact.sizeBytes.toString(),
            sha256: artifact.sha256
          }
        }
      })
    ]);

    return {
      processed: true,
      operationId: operation.id,
      status: "VERIFIED",
      storageKey: artifact.storageKey,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256
    };
  } catch (error) {
    const errorCode = classifyBackupError(error);

    await options.prisma.$transaction([
      options.prisma.backupOperation.update({
        where: { id: operation.id },
        data: {
          status: "FAILED",
          completedAt: now(),
          errorCode
        }
      }),
      options.prisma.auditEvent.create({
        data: {
          eventType: "BACKUP_FAILED",
          actorType: "SYSTEM",
          payload: {
            backupOperationId: operation.id,
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

async function failStaleRunningBackups(
  prisma: PrismaClient,
  now: () => Date,
  timeoutMinutes: number
): Promise<void> {
  const cutoff = new Date(now().getTime() - timeoutMinutes * 60 * 1_000);
  const staleOperations = await prisma.backupOperation.findMany({
    where: {
      status: "RUNNING",
      startedAt: {
        lt: cutoff
      }
    },
    select: {
      id: true
    }
  });

  for (const operation of staleOperations) {
    await prisma.$transaction([
      prisma.backupOperation.update({
        where: { id: operation.id },
        data: {
          status: "FAILED",
          completedAt: now(),
          errorCode: "BACKUP_WORKER_TIMEOUT"
        }
      }),
      prisma.auditEvent.create({
        data: {
          eventType: "BACKUP_FAILED",
          actorType: "SYSTEM",
          payload: {
            backupOperationId: operation.id,
            status: "FAILED",
            errorCode: "BACKUP_WORKER_TIMEOUT"
          }
        }
      })
    ]);
  }
}

async function claimNextRequestedBackup(
  prisma: PrismaClient,
  now: () => Date
): Promise<ClaimedBackupOperation | null> {
  return prisma.$transaction(async (tx) => {
    const operation = await tx.backupOperation.findFirst({
      where: { status: "REQUESTED" },
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
      select: { id: true }
    });

    if (!operation) {
      return null;
    }

    const claimed = await tx.backupOperation.updateMany({
      where: { id: operation.id, status: "REQUESTED" },
      data: {
        status: "RUNNING",
        startedAt: now(),
        errorCode: null
      }
    });

    return claimed.count === 1 ? operation : null;
  });
}

async function createEncryptedDatabaseBackup(options: {
  operationId: string;
  env: BackupEnvironment;
  databaseUrl: string;
  now: () => Date;
  createDumpSource?: (databaseUrl: string) => DumpSource;
  createDumpStream?: (databaseUrl: string) => Readable;
}): Promise<{ storageKey: string; sizeBytes: bigint; sha256: string }> {
  const backupDirectory = path.resolve(options.env.BACKUP_DIRECTORY);
  const fileBaseName = `crigestion-${formatTimestamp(options.now())}-${options.operationId}`;
  const storageKey = `${fileBaseName}.backup`;
  const finalPath = path.join(backupDirectory, storageKey);
  const temporaryPath = `${finalPath}.tmp`;
  const key = parseBackupEncryptionKey(options.env.BACKUP_ENCRYPTION_KEY);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const dumpSource =
    options.createDumpSource?.(options.databaseUrl) ??
    (options.createDumpStream
      ? {
          stream: options.createDumpStream(options.databaseUrl),
          wait: async () => {}
        }
      : null) ??
    createDumpSource(options.databaseUrl, options.env);

  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await chmod(backupDirectory, 0o700);

  try {
    const headerFrame = backupHeaderFrame({
      algorithm: "aes-256-gcm",
      contentType: "postgresql.pg_dump.custom",
      iv: iv.toString("base64url"),
      createdAt: options.now().toISOString()
    });
    cipher.setAAD(headerFrame);

    await writeFile(temporaryPath, headerFrame, { mode: 0o600 });
    await Promise.all([
      pipeline(
        dumpSource.stream,
        cipher,
        createWriteStream(temporaryPath, { flags: "a", mode: 0o600 })
      ),
      dumpSource.wait()
    ]);
    await appendFile(temporaryPath, cipher.getAuthTag());
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, finalPath);
    await chmod(finalPath, 0o600);

    const [fileStat, sha256] = await Promise.all([
      stat(finalPath),
      sha256File(finalPath)
    ]);

    return {
      storageKey,
      sizeBytes: BigInt(fileStat.size),
      sha256
    };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    await rm(finalPath, { force: true });
    throw error;
  }
}

function createDumpSource(databaseUrl: string, env: BackupEnvironment): DumpSource {
  return createPgDumpSource(databaseUrl, env.PG_DUMP_BINARY);
}

function backupHeaderFrame(header: Record<string, string>): Buffer {
  const headerBuffer = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.from(`${backupMagic}\n${headerBuffer.byteLength}\n`, "utf8");

  return Buffer.concat([prefix, headerBuffer]);
}

function createPgDumpSource(databaseUrl: string, pgDumpBinary: string): DumpSource {
  const connection = toPgDumpConnection(databaseUrl);
  const child = spawn(
    pgDumpBinary,
    [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--host",
      connection.host,
      "--port",
      connection.port,
      "--username",
      connection.user,
      "--dbname",
      connection.database,
      ...(connection.schema ? ["--schema", connection.schema] : [])
    ],
    {
      env: pgDumpEnvironment(connection.password),
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  let stderr = "";
  const wait = new Promise<void>((resolve, reject) => {
    child.on("error", (error) => {
      child.stdout.destroy(error);
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`pg_dump failed with code ${code}: ${stderr.slice(0, 200)}`));
    });
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return {
    stream: child.stdout,
    wait: () => wait
  };
}

function pgDumpEnvironment(password: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    NODE_ENV: process.env.NODE_ENV,
    PGPASSWORD: password
  };
}

function toPgDumpConnection(databaseUrl: string): {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  schema: string | null;
} {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));

  if (!database) {
    throw new Error("DATABASE_URL does not include a database name.");
  }

  return {
    host: url.hostname,
    port: url.port || "5432",
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    schema: url.searchParams.get("schema")
  };
}

function readBackupEnvironment(env: NodeJS.ProcessEnv): BackupEnvironment {
  const parsed = backupEnvironmentSchema.safeParse(env);

  if (!parsed.success) {
    throw new Error(`Invalid backup environment: ${parsed.error.issues[0]?.path.join(".")}`);
  }

  parseBackupEncryptionKey(parsed.data.BACKUP_ENCRYPTION_KEY);

  return parsed.data;
}

function readBackupRunningTimeoutMinutes(env: NodeJS.ProcessEnv): number {
  const value = env.BACKUP_RUNNING_TIMEOUT_MINUTES;

  if (!value) {
    return backupEnvironmentSchema.shape.BACKUP_RUNNING_TIMEOUT_MINUTES.parse(undefined);
  }

  return backupEnvironmentSchema.shape.BACKUP_RUNNING_TIMEOUT_MINUTES.parse(value);
}

function readDatabaseUrl(env: NodeJS.ProcessEnv): string {
  if (!env.DATABASE_URL) {
    throw new Error("Invalid backup environment: DATABASE_URL");
  }

  return env.DATABASE_URL;
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

  throw new Error("Invalid backup environment: BACKUP_ENCRYPTION_KEY");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

function formatTimestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, "-");
}

function classifyBackupError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.includes("BACKUP_ENCRYPTION_KEY")) {
      return "BACKUP_ENCRYPTION_KEY_INVALID";
    }

    if (error.message.includes("DATABASE_URL")) {
      return "DATABASE_URL_INVALID";
    }

    if (error.message.includes("pg_dump")) {
      return "PG_DUMP_FAILED";
    }
  }

  return "BACKUP_FAILED";
}
