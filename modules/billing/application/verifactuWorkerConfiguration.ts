import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertStagingRuntimeEnvironment } from "@/modules/platform/application/stagingEnvironment";
import {
  assertTfmDemoRuntimeEnvironment,
  isTfmDemoRequested,
  tfmDemoDatabaseName
} from "@/modules/platform/application/tfmDemoEnvironment";

export function assertVerifactuTestWorkerConfiguration(
  env: Readonly<Record<string, string | undefined>>
): void {
  const expectedDatabase = env.APP_ENV === "test"
    ? "crigestion_test"
    : env.APP_ENV === "staging" ? "crigestion_staging" : isTfmDemoRequested(env) ? tfmDemoDatabaseName : null;
  if (
    expectedDatabase === null ||
    env.VERIFACTU_ENABLED !== "true" ||
    env.VERIFACTU_ENVIRONMENT !== "TEST" ||
    env.VERIFACTU_WORKER_ENVIRONMENT !== "TEST" ||
    env.VERIFACTU_ALLOW_PRODUCTION !== "false" ||
    env.VERIFACTU_WORKER_ALLOW_PRODUCTION !== "false" ||
    env.VERIFACTU_WORKER_EXPECTED_DATABASE !== expectedDatabase
  ) {
    throw new Error("VERIFACTU_WORKER_TEST_SERVICE_ENVIRONMENT_INVALID");
  }
  if (env.APP_ENV === "staging") {
    try { assertStagingRuntimeEnvironment(env); }
    catch { throw new Error("VERIFACTU_WORKER_DATABASE_URL_INVALID"); }
    return;
  }
  if (isTfmDemoRequested(env)) {
    try { assertTfmDemoRuntimeEnvironment(env); }
    catch { throw new Error("VERIFACTU_WORKER_DATABASE_URL_INVALID"); }
    return;
  }
  let database: URL;
  try { database = new URL(env.DATABASE_URL ?? ""); }
  catch { throw new Error("VERIFACTU_WORKER_DATABASE_URL_INVALID"); }
  const databaseName = decodeURIComponent(database.pathname.replace(/^\//, ""));
  const deploymentId = env.VERIFACTU_WORKER_DEPLOYMENT_ID?.trim().toLowerCase() || "host";
  const allowedHosts = deploymentId === "docker-test"
    ? ["postgres"]
    : ["localhost", "127.0.0.1", "[::1]"];
  if (
    (database.protocol !== "postgres:" && database.protocol !== "postgresql:") ||
    !allowedHosts.includes(database.hostname) ||
    databaseName !== expectedDatabase
  ) {
    throw new Error("VERIFACTU_WORKER_DATABASE_URL_INVALID");
  }
}

export function readVerifactuWorkerDeploymentId(raw: string | undefined): string {
  const value = raw?.trim().toLowerCase() || "host";
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(value)) {
    throw new Error("VERIFACTU_WORKER_DEPLOYMENT_ID_INVALID");
  }
  return value;
}

export function getVerifactuWorkerStatePath(
  env: Readonly<Record<string, string | undefined>>
): string {
  const appEnvironment = env.APP_ENV;
  if (!appEnvironment || !/^(development|test|staging|production)$/.test(appEnvironment)) {
    throw new Error("VERIFACTU_WORKER_APP_ENV_INVALID");
  }
  const deploymentId = readVerifactuWorkerDeploymentId(env.VERIFACTU_WORKER_DEPLOYMENT_ID);
  return join(tmpdir(), `crigestion-verifactu-worker-state-${appEnvironment}-${deploymentId}.json`);
}

export function assertVerifactuProductionWorkerConfiguration(
  env: Readonly<Record<string, string | undefined>>
): void {
  if (
    env.APP_ENV !== "production" ||
    env.VERIFACTU_ENABLED !== "true" ||
    env.VERIFACTU_ENVIRONMENT?.trim().toUpperCase() !== "PRODUCTION" ||
    env.VERIFACTU_WORKER_ENVIRONMENT?.trim().toUpperCase() !== "PRODUCTION" ||
    env.VERIFACTU_WORKER_ALLOW_PRODUCTION !== "true" ||
    env.VERIFACTU_WORKER_PRODUCTION_CONFIRM !== "AEAT_PRODUCTION_AUTHORIZED"
  ) {
    throw new Error("VERIFACTU_WORKER_PRODUCTION_ENVIRONMENT_INVALID");
  }

  const expectedDatabase = env.VERIFACTU_WORKER_EXPECTED_DATABASE?.trim();
  if (!expectedDatabase || !/^[A-Za-z0-9_-]{1,63}$/.test(expectedDatabase) || /(?:^|[_-])test$/i.test(expectedDatabase)) {
    throw new Error("VERIFACTU_WORKER_PRODUCTION_DATABASE_INVALID");
  }

  let database: URL;
  try { database = new URL(env.DATABASE_URL ?? ""); }
  catch { throw new Error("VERIFACTU_WORKER_DATABASE_URL_INVALID"); }
  const databaseName = decodeURIComponent(database.pathname.replace(/^\//, ""));
  if (
    (database.protocol !== "postgres:" && database.protocol !== "postgresql:") ||
    databaseName !== expectedDatabase
  ) {
    throw new Error("VERIFACTU_WORKER_PRODUCTION_DATABASE_INVALID");
  }
}
