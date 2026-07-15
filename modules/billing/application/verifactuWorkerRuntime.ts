import "server-only";

import type { VerifactuAttemptOutcome, VerifactuEnvironment } from "@prisma/client";
import { Client, type QueryResult } from "pg";
import { prisma } from "@/lib/prisma";

export type WorkerCycle =
  | { kind: "idle" }
  | { kind: "lease-lost" }
  | { kind: "processed"; outcome?: VerifactuAttemptOutcome }
  | { kind: "error"; code: string };

export type VerifactuWorkerLeadership = {
  verify: () => Promise<boolean>;
  onLost: (handler: () => void) => () => void;
  release: () => Promise<void>;
};

export async function acquireVerifactuWorkerLeadership(
  companyId: string,
  environment: VerifactuEnvironment
): Promise<VerifactuWorkerLeadership | null> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("VERIFACTU_WORKER_DATABASE_URL_MISSING");
  const lockKey = `crigestion:verifactu:${companyId}:${environment}`;
  const client = new Client({
    connectionString,
    application_name: "crigestion-verifactu-leader",
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000
  });
  let connected = false;
  let healthy = true;
  const lostHandlers = new Set<() => void>();
  const markLost = (): void => {
    if (!healthy) return;
    healthy = false;
    for (const handler of lostHandlers) handler();
  };
  client.on("error", markLost);
  client.on("end", markLost);
  let result: QueryResult<{ acquired: boolean }>;
  try {
    await client.connect();
    connected = true;
    result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS "acquired"',
      [lockKey]
    );
  } catch (error) {
    connected = false;
    await client.end().catch(() => undefined);
    throw error;
  }
  if (result.rows[0]?.acquired !== true) {
    await client.end();
    return null;
  }
  return {
    verify: async () => {
      if (!healthy) return false;
      try {
        await client.query("SELECT 1");
        return healthy;
      } catch {
        healthy = false;
        return false;
      }
    },
    onLost: (handler) => {
      lostHandlers.add(handler);
      if (!healthy) queueMicrotask(handler);
      return () => { lostHandlers.delete(handler); };
    },
    release: async () => {
      if (!connected) return;
      connected = false;
      try {
        if (healthy) {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
        }
      } finally {
        lostHandlers.clear();
        await client.end().catch(() => undefined);
      }
    }
  };
}

export async function startVerifactuWorkerRun(input: {
  companyId: string;
  workerId: string;
  environment: VerifactuEnvironment;
  now?: Date;
}): Promise<string> {
  const now = input.now ?? new Date();
  const run = await prisma.verifactuWorkerRun.create({
    data: {
      companyId: input.companyId,
      workerId: input.workerId,
      environment: input.environment,
      status: "RUNNING",
      startedAt: now,
      heartbeatAt: now
    },
    select: { id: true }
  });
  return run.id;
}

export async function heartbeatVerifactuWorker(runId: string, workerId: string, now = new Date()): Promise<boolean> {
  const updated = await prisma.verifactuWorkerRun.updateMany({
    where: { id: runId, workerId, status: { in: ["RUNNING", "STOPPING"] } },
    data: { heartbeatAt: now }
  });
  return updated.count === 1;
}

export async function recordVerifactuWorkerCycle(
  runId: string,
  workerId: string,
  cycle: WorkerCycle,
  now = new Date()
): Promise<boolean> {
  const data = cycle.kind === "processed"
    ? { lastPollAt: now, lastProcessedAt: now, heartbeatAt: now, processedCount: { increment: 1 }, lastOutcome: cycle.outcome ?? null, lastErrorCode: null }
    : cycle.kind === "idle"
      ? { lastPollAt: now, heartbeatAt: now, idleCount: { increment: 1 }, lastErrorCode: null }
      : cycle.kind === "lease-lost"
        ? { lastPollAt: now, heartbeatAt: now, leaseLostCount: { increment: 1 }, lastErrorCode: "VERIFACTU_WORKER_LEASE_LOST" }
        : { lastPollAt: now, heartbeatAt: now, errorCount: { increment: 1 }, lastErrorCode: cycle.code };
  const updated = await prisma.verifactuWorkerRun.updateMany({
    where: { id: runId, workerId, status: "RUNNING" },
    data
  });
  return updated.count === 1;
}

export async function markVerifactuWorkerStopping(runId: string, workerId: string, now = new Date()): Promise<void> {
  await prisma.verifactuWorkerRun.updateMany({
    where: { id: runId, workerId, status: "RUNNING" },
    data: { status: "STOPPING", heartbeatAt: now }
  });
}

export async function finishVerifactuWorkerRun(
  runId: string,
  workerId: string,
  status: "STOPPED" | "FAILED",
  errorCode?: string,
  now = new Date()
): Promise<void> {
  await prisma.verifactuWorkerRun.updateMany({
    where: { id: runId, workerId, status: { in: ["RUNNING", "STOPPING"] } },
    data: {
      status,
      stoppedAt: now,
      heartbeatAt: now,
      ...(status === "FAILED" ? { errorCount: { increment: 1 }, lastErrorCode: errorCode ?? "VERIFACTU_WORKER_FAILED" } : {})
    }
  });
}
