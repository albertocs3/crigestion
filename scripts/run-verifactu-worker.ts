import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { processNextVerifactuOutboxMessage } from "../modules/billing/application/verifactuOutboxWorker";
import {
  assertVerifactuProductionWorkerConfiguration,
  assertVerifactuTestWorkerConfiguration,
  getVerifactuWorkerStatePath,
  readVerifactuWorkerDeploymentId
} from "../modules/billing/application/verifactuWorkerConfiguration";
import { assertStagingRuntimeEnvironment } from "../modules/platform/application/stagingEnvironment";
import {
  acquireVerifactuWorkerLeadership,
  finishVerifactuWorkerRun,
  heartbeatVerifactuWorker,
  markVerifactuWorkerStopping,
  recordVerifactuWorkerCycle,
  startVerifactuWorkerRun
} from "../modules/billing/application/verifactuWorkerRuntime";
import { readConfiguredAeatVerifactuTransport } from "../modules/billing/infrastructure/verifactu/configuredTransport";
import { readVerifactuPayloadCipherFromEnvironment } from "../modules/billing/infrastructure/verifactu/payloadCipher";
import { prisma } from "../lib/prisma";

type Environment = "TEST" | "PRODUCTION";

const once = process.argv.includes("--once");
const testOnly = process.argv.includes("--test-only");
let stopping = false;
let runId: string | null = null;
let workerId: string | null = null;
let heartbeatBusy = false;
let heartbeatFailures = 0;
let fatalErrorCode: string | null = null;

function requestStop(): void {
  if (stopping) return;
  stopping = true;
  if (runId && workerId) void markVerifactuWorkerStopping(runId, workerId).catch(() => undefined);
}

process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);

async function main(): Promise<void> {
  const environment = readEnvironment(testOnly);
  const pollMs = readInteger("VERIFACTU_WORKER_POLL_MS", 2_000, 250, 60_000);
  const heartbeatMs = readInteger("VERIFACTU_WORKER_HEARTBEAT_MS", 5_000, 1_000, 30_000);
  const leaseMs = readInteger("VERIFACTU_WORKER_LEASE_MS", 90_000, 60_000, 15 * 60_000);
  const deploymentId = readVerifactuWorkerDeploymentId(process.env.VERIFACTU_WORKER_DEPLOYMENT_ID);
  const workerStatePath = getVerifactuWorkerStatePath(process.env);
  const currentWorkerId = `verifactu:${environment.toLowerCase()}:${deploymentId}:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  workerId = currentWorkerId;
  await assertExpectedDatabase(true);
  const installation = await prisma.installation.findUnique({ where: { singletonKey: 1 }, select: { companyId: true } });
  if (!installation?.companyId) throw new Error("VERIFACTU_WORKER_COMPANY_NOT_CONFIGURED");
  const companyId = installation.companyId;
  const leadership = await acquireVerifactuWorkerLeadership(companyId, environment);
  if (!leadership) {
    throw new Error("VERIFACTU_WORKER_ALREADY_RUNNING");
  }
  const stopOnLeadershipLoss = (): void => {
    fatalErrorCode = "VERIFACTU_WORKER_LEADERSHIP_LOST";
    stopping = true;
  };
  const unsubscribeLeadershipLoss = leadership.onLost(stopOnLeadershipLoss);
  try {
    const cipher = readVerifactuPayloadCipherFromEnvironment();
    const transport = readConfiguredAeatVerifactuTransport();
    const currentRunId = await startVerifactuWorkerRun({ companyId, workerId: currentWorkerId, environment });
    runId = currentRunId;
    try {
      await writeFile(workerStatePath, JSON.stringify({ runId: currentRunId, workerId: currentWorkerId, deploymentId }), { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      await finishVerifactuWorkerRun(currentRunId, currentWorkerId, "FAILED", "VERIFACTU_WORKER_STATE_FILE_FAILED");
      throw error;
    }
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void leadership.verify()
        .then((isLeader) => {
          if (!isLeader) {
            stopOnLeadershipLoss();
            throw new Error("VERIFACTU_WORKER_LEADERSHIP_LOST");
          }
          return heartbeatVerifactuWorker(currentRunId, currentWorkerId);
        })
      .then((updated) => {
        if (!updated) throw new Error("VERIFACTU_WORKER_HEARTBEAT_LOST");
        heartbeatFailures = 0;
      })
      .catch(() => {
        heartbeatFailures += 1;
        if (heartbeatFailures >= 3) {
          fatalErrorCode = "VERIFACTU_WORKER_HEARTBEAT_FAILED";
          stopping = true;
        }
      })
      .finally(() => { heartbeatBusy = false; });
    }, heartbeatMs);
    heartbeat.unref();

    try {
      do {
        if (stopping) break;
        try {
          const result = await processNextVerifactuOutboxMessage({ workerId: currentWorkerId, companyId, environment, cipher, transport, leaseMs });
          await recordVerifactuWorkerCycle(currentRunId, currentWorkerId, result);
          process.stdout.write(`VeriFactu ${environment}: ${result.kind}${result.outcome ? ` (${result.outcome})` : ""}\n`);
          if (!once && result.kind === "idle") await interruptibleDelay(pollMs);
        } catch (error) {
          const code = stableErrorCode(error);
          await recordVerifactuWorkerCycle(currentRunId, currentWorkerId, { kind: "error", code });
          process.stderr.write(`VeriFactu ${environment}: ${code}\n`);
          if (once) throw error;
          await interruptibleDelay(Math.min(30_000, pollMs * 5));
        }
      } while (!once && !stopping);
      if (fatalErrorCode) throw new Error(fatalErrorCode);
      await finishVerifactuWorkerRun(currentRunId, currentWorkerId, "STOPPED");
    } catch (error) {
      await finishVerifactuWorkerRun(currentRunId, currentWorkerId, "FAILED", stableErrorCode(error));
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  } finally {
    unsubscribeLeadershipLoss();
    await leadership.release();
  }
}

function readEnvironment(restrictToTest: boolean): Environment {
  if (process.env.VERIFACTU_ENABLED !== "true") throw new Error("VERIFACTU_WORKER_DISABLED");
  const value = process.env.VERIFACTU_WORKER_ENVIRONMENT?.trim().toUpperCase();
  if (value !== "TEST" && value !== "PRODUCTION") throw new Error("VERIFACTU_WORKER_ENVIRONMENT_INVALID");
  if (restrictToTest && value !== "TEST") throw new Error("VERIFACTU_WORKER_TEST_SERVICE_ENVIRONMENT_INVALID");
  if (value === "TEST") assertVerifactuTestWorkerConfiguration(process.env);
  if (value === "PRODUCTION" && process.env.VERIFACTU_WORKER_ALLOW_PRODUCTION !== "true") {
    throw new Error("VERIFACTU_WORKER_PRODUCTION_NOT_ALLOWED");
  }
  if (value === "PRODUCTION") assertVerifactuProductionWorkerConfiguration(process.env);
  const transportEnvironment = process.env.VERIFACTU_ENVIRONMENT?.trim().toUpperCase();
  if (transportEnvironment !== value) throw new Error("VERIFACTU_WORKER_ENVIRONMENT_MISMATCH");
  return value;
}

async function assertExpectedDatabase(required: boolean): Promise<void> {
  if (!required) return;
  const expected = process.env.VERIFACTU_WORKER_EXPECTED_DATABASE?.trim();
  if (!expected || !/^[A-Za-z0-9_-]{1,63}$/.test(expected)) {
    throw new Error("VERIFACTU_WORKER_EXPECTED_DATABASE_INVALID");
  }
  const [identity] = await prisma.$queryRaw<Array<{
    databaseName: string;
    databaseRole: string;
    serverAddress: string | null;
    serverPort: number | null;
  }>>`SELECT current_database() AS "databaseName", current_user AS "databaseRole",
    inet_server_addr()::text AS "serverAddress", inet_server_port() AS "serverPort"`;
  if (identity?.databaseName !== expected) throw new Error("VERIFACTU_WORKER_DATABASE_MISMATCH");
  if (process.env.APP_ENV === "staging") {
    try { assertStagingRuntimeEnvironment(process.env, identity); }
    catch { throw new Error("VERIFACTU_WORKER_DATABASE_MISMATCH"); }
  }
}

function readInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name}_INVALID`);
  return value;
}

function stableErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "VERIFACTU_WORKER_FAILED";
  return /^[A-Z][A-Z0-9_]{2,119}$/.test(error.message) ? error.message : "VERIFACTU_WORKER_FAILED";
}

async function interruptibleDelay(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!stopping && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${stableErrorCode(error)}\n`);
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
