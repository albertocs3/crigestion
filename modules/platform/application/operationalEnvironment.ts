export type OperationalEnvironmentSummary = {
  appEnvironment: "TEST" | "STAGING" | "DEVELOPMENT" | "PRODUCTION" | "UNKNOWN";
  isTestMode: boolean;
  expectedDatabaseName: "crigestion_test" | "crigestion_staging" | null;
  databaseConfiguredAsTest: boolean;
  verifactuEnabled: boolean;
  verifactuEnvironment: "TEST" | "PRODUCTION" | "INVALID" | "DISABLED";
  workerEnvironment: "TEST" | "PRODUCTION" | "INVALID" | "DISABLED";
  productionWorkerAllowed: boolean;
  productionPreparationAllowed: boolean;
  productionReleaseIdConfigured: boolean;
  configurationFlagsValid: boolean;
  testIsolationConfigured: boolean;
};

export function readOperationalEnvironment(env: NodeJS.ProcessEnv): OperationalEnvironmentSummary {
  const appEnvironment = normalizeAppEnvironment(env.APP_ENV);
  const isTestMode = env.APP_ENV === "test" || env.APP_ENV === "staging";
  const expectedDatabaseName = env.APP_ENV === "test"
    ? "crigestion_test"
    : env.APP_ENV === "staging" ? "crigestion_staging" : null;
  const databaseConfiguredAsTest = expectedDatabaseName !== null
    && (env.APP_ENV === "staging"
      ? isValidStagingRuntimeDatabaseUrl(env.DATABASE_URL)
      : readDatabaseName(env.DATABASE_URL) === expectedDatabaseName);
  const enabledFlag = readBooleanFlag(env.VERIFACTU_ENABLED, false);
  const productionFlag = readBooleanFlag(env.VERIFACTU_WORKER_ALLOW_PRODUCTION, false);
  const preparationFlag = readBooleanFlag(env.VERIFACTU_ALLOW_PRODUCTION, false);
  const verifactuEnabled = enabledFlag.value;
  const configuredVerifactuEnvironment = normalizeVerifactuEnvironment(env.VERIFACTU_ENVIRONMENT);
  const configuredWorkerEnvironment = normalizeVerifactuEnvironment(env.VERIFACTU_WORKER_ENVIRONMENT);
  const verifactuEnvironment = verifactuEnabled ? configuredVerifactuEnvironment : "DISABLED";
  const workerEnvironment = verifactuEnabled ? configuredWorkerEnvironment : "DISABLED";
  const productionWorkerAllowed = productionFlag.value;
  const productionPreparationAllowed = preparationFlag.value;
  const productionReleaseIdConfigured = isValidReleaseId(env.VERIFACTU_PRODUCTION_RELEASE_ID);
  const configurationFlagsValid = enabledFlag.valid && productionFlag.valid && preparationFlag.valid;
  return {
    appEnvironment,
    isTestMode,
    expectedDatabaseName,
    databaseConfiguredAsTest,
    verifactuEnabled,
    verifactuEnvironment,
    workerEnvironment,
    productionWorkerAllowed,
    productionPreparationAllowed,
    productionReleaseIdConfigured,
    configurationFlagsValid,
    testIsolationConfigured: isTestMode && databaseConfiguredAsTest && configurationFlagsValid
      && configuredVerifactuEnvironment === "TEST" && configuredWorkerEnvironment === "TEST"
      && !productionWorkerAllowed && !productionPreparationAllowed
  };
}

export function isVerifactuEnvironmentCoherent(environment: OperationalEnvironmentSummary): boolean {
  return (environment.isTestMode && environment.verifactuEnvironment === "TEST"
    && environment.workerEnvironment === "TEST" && !environment.productionWorkerAllowed
    && !environment.productionPreparationAllowed)
    || (environment.appEnvironment === "PRODUCTION" && environment.verifactuEnvironment === "PRODUCTION"
      && environment.workerEnvironment === "PRODUCTION" && environment.productionWorkerAllowed
      && environment.productionPreparationAllowed && environment.productionReleaseIdConfigured);
}

export function isVerifactuPreparationAllowed(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.VERIFACTU_ENABLED !== "true") return false;
  const environment = normalizeVerifactuEnvironment(env.VERIFACTU_ENVIRONMENT);
  const preparationFlag = readBooleanFlag(env.VERIFACTU_ALLOW_PRODUCTION, false);
  if (!preparationFlag.valid) return false;
  if (environment === "TEST") {
    return (env.APP_ENV === "test" || env.APP_ENV === "staging") && !preparationFlag.value;
  }
  return environment === "PRODUCTION"
    && env.APP_ENV === "production"
    && preparationFlag.value
    && isValidReleaseId(env.VERIFACTU_PRODUCTION_RELEASE_ID);
}

export function classifyWorkerHealth(latest: {
  status: string;
  heartbeatAt: Date;
  lastPollAt: Date | null;
} | null, staleBefore: Date): "ok" | "degraded" {
  return latest?.status === "RUNNING" && latest.heartbeatAt >= staleBefore
    && latest.lastPollAt !== null && latest.lastPollAt >= staleBefore ? "ok" : "degraded";
}

function normalizeAppEnvironment(value: string | undefined): OperationalEnvironmentSummary["appEnvironment"] {
  if (value === "test") return "TEST";
  if (value === "staging") return "STAGING";
  if (value === "development") return "DEVELOPMENT";
  if (value === "production") return "PRODUCTION";
  return "UNKNOWN";
}

function readBooleanFlag(value: string | undefined, defaultValue: boolean): { value: boolean; valid: boolean } {
  if (value === undefined || value === "") return { value: defaultValue, valid: true };
  if (value === "true") return { value: true, valid: true };
  if (value === "false") return { value: false, valid: true };
  return { value: defaultValue, valid: false };
}

function normalizeVerifactuEnvironment(value: string | undefined): "TEST" | "PRODUCTION" | "INVALID" {
  if (value === "TEST") return "TEST";
  if (value === "PRODUCTION") return "PRODUCTION";
  return "INVALID";
}

function isValidStagingRuntimeDatabaseUrl(connectionString: string | undefined): boolean {
  try {
    assertStagingDatabaseUrl(connectionString, stagingRuntimeDatabaseRole);
    return true;
  } catch {
    return false;
  }
}

function readDatabaseName(connectionString: string | undefined): string | null {
  if (!connectionString) return null;
  try {
    const url = new URL(connectionString);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
    return decodeURIComponent(url.pathname.replace(/^\//, "")) || null;
  } catch {
    return null;
  }
}

function isValidReleaseId(value: string | undefined): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(value?.trim() ?? "");
}
import { assertStagingDatabaseUrl, stagingRuntimeDatabaseRole } from "./stagingEnvironment";
