import { readFile } from "node:fs/promises";
import { prisma } from "../lib/prisma";
import {
  assertVerifactuTestWorkerConfiguration,
  getVerifactuWorkerStatePath,
  readVerifactuWorkerDeploymentId
} from "../modules/billing/application/verifactuWorkerConfiguration";
import { assertStagingRuntimeEnvironment } from "../modules/platform/application/stagingEnvironment";

async function main(): Promise<void> {
  const environment = process.env.VERIFACTU_WORKER_ENVIRONMENT?.trim().toUpperCase();
  if (environment !== "TEST") throw new Error("VERIFACTU_WORKER_HEALTH_ENVIRONMENT_INVALID");
  assertVerifactuTestWorkerConfiguration(process.env);
  const deploymentId = readVerifactuWorkerDeploymentId(process.env.VERIFACTU_WORKER_DEPLOYMENT_ID);
  const workerStatePath = getVerifactuWorkerStatePath(process.env);
  const staleSeconds = readStaleSeconds(process.env.VERIFACTU_WORKER_HEALTH_STALE_SECONDS);
  const [identity] = await prisma.$queryRaw<Array<{
    databaseName: string;
    databaseRole: string;
    serverAddress: string | null;
    serverPort: number | null;
  }>>`SELECT current_database() AS "databaseName", current_user AS "databaseRole",
    inet_server_addr()::text AS "serverAddress", inet_server_port() AS "serverPort"`;
  if (process.env.APP_ENV === "staging") assertStagingRuntimeEnvironment(process.env, identity);
  const state = await readWorkerState(workerStatePath, deploymentId);
  const installation = await prisma.installation.findUnique({
    where: { singletonKey: 1 },
    select: { companyId: true }
  });
  if (!installation?.companyId) throw new Error("VERIFACTU_WORKER_HEALTH_COMPANY_NOT_CONFIGURED");
  const run = await prisma.verifactuWorkerRun.findFirst({
    where: {
      id: state.runId,
      companyId: installation.companyId,
      environment: "TEST",
      workerId: state.workerId
    },
    select: { status: true, heartbeatAt: true, lastPollAt: true }
  });
  const staleBefore = new Date(Date.now() - staleSeconds * 1_000);
  if (
    !run ||
    run.status !== "RUNNING" ||
    run.heartbeatAt < staleBefore ||
    !run.lastPollAt ||
    run.lastPollAt < staleBefore
  ) {
    throw new Error("VERIFACTU_WORKER_UNHEALTHY");
  }
  process.stdout.write("VERIFACTU_WORKER_HEALTHY\n");
}

function readStaleSeconds(raw: string | undefined): number {
  if (!raw) return 180;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 120 || value > 300) {
    throw new Error("VERIFACTU_WORKER_HEALTH_CONFIGURATION_INVALID");
  }
  return value;
}

async function readWorkerState(workerStatePath: string, deploymentId: string): Promise<{ runId: string; workerId: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(workerStatePath, "utf8"));
  } catch {
    throw new Error("VERIFACTU_WORKER_HEALTH_STATE_INVALID");
  }
  if (!isRecord(parsed)) throw new Error("VERIFACTU_WORKER_HEALTH_STATE_INVALID");
  const runId = parsed.runId;
  const workerId = parsed.workerId;
  if (
    typeof runId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId) ||
    typeof workerId !== "string" ||
    workerId.length > 160 ||
    !workerId.startsWith(`verifactu:test:${deploymentId}:`) ||
    parsed.deploymentId !== deploymentId
  ) {
    throw new Error("VERIFACTU_WORKER_HEALTH_STATE_INVALID");
  }
  return { runId, workerId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,119}$/.test(error.message)
    ? error.message
    : "VERIFACTU_WORKER_HEALTH_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
