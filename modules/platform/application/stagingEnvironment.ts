import { isTfmDemoRequested } from "./tfmDemoEnvironment";

export const stagingDatabaseName = "crigestion_staging";
export const stagingRuntimeDatabaseRole = "crigestion_staging_app";
export const stagingMigratorDatabaseRole = "crigestion_staging_migrator";

export type StagingDatabaseIdentity = {
  databaseName: string | null | undefined;
  databaseRole: string | null | undefined;
  serverAddress: string | null | undefined;
  serverPort: number | null | undefined;
};

export function assertStagingRuntimeEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  identity?: StagingDatabaseIdentity
): void {
  if (
    env.NODE_ENV !== "production" ||
    env.APP_ENV !== "staging" ||
    !isCanonicalBoolean(env.VERIFACTU_ENABLED) ||
    env.VERIFACTU_ENVIRONMENT !== "TEST" ||
    env.VERIFACTU_WORKER_ENVIRONMENT !== "TEST" ||
    env.VERIFACTU_ALLOW_PRODUCTION !== "false" ||
    env.VERIFACTU_WORKER_ALLOW_PRODUCTION !== "false"
  ) {
    throw new Error("STAGING_ENVIRONMENT_INVALID");
  }

  assertStagingDatabaseUrl(env.DATABASE_URL, stagingRuntimeDatabaseRole);
  if (identity) assertStagingDatabaseIdentity(identity, stagingRuntimeDatabaseRole);
}

export function assertStagingMigratorEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  identity?: StagingDatabaseIdentity
): void {
  if (
    env.NODE_ENV !== "production" ||
    env.APP_ENV !== "staging" ||
    env.CRIGESTION_MIGRATION_EXPECTED_DATABASE !== stagingDatabaseName ||
    env.CRIGESTION_RUNTIME_DATABASE_ROLE !== stagingRuntimeDatabaseRole
  ) {
    throw new Error("STAGING_MIGRATION_ENVIRONMENT_INVALID");
  }

  assertStagingDatabaseUrl(env.DATABASE_URL, stagingMigratorDatabaseRole);
  if (identity) assertStagingDatabaseIdentity(identity, stagingMigratorDatabaseRole);
}

export function assertStagingDatabaseUrl(
  connectionString: string | undefined,
  expectedRole: string
): void {
  let url: URL;
  try {
    url = new URL(connectionString ?? "");
  } catch {
    throw new Error("STAGING_DATABASE_URL_INVALID");
  }

  const parameters = Array.from(url.searchParams.entries());
  const databaseName = decodeUrlComponent(url.pathname.slice(1));
  const databaseRole = decodeUrlComponent(url.username);
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    (url.port !== "" && url.port !== "5432") ||
    databaseName !== stagingDatabaseName ||
    databaseRole !== expectedRole ||
    url.password.length === 0 ||
    url.hash !== "" ||
    parameters.length !== 1 ||
    parameters[0]?.[0] !== "schema" ||
    parameters[0]?.[1] !== "public"
  ) {
    throw new Error("STAGING_DATABASE_URL_INVALID");
  }
}

export function assertStagingDatabaseIdentity(
  identity: StagingDatabaseIdentity,
  expectedRole: string
): void {
  if (
    identity.databaseName !== stagingDatabaseName ||
    identity.databaseRole !== expectedRole ||
    !["127.0.0.1", "127.0.0.1/32", "::1", "::1/128"].includes(identity.serverAddress ?? "") ||
    identity.serverPort !== 5432
  ) {
    throw new Error("STAGING_DATABASE_IDENTITY_INVALID");
  }
}

export function isStagingProductionCapabilityForbidden(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return env.APP_ENV === "staging" || isTfmDemoRequested(env);
}

function isCanonicalBoolean(value: string | undefined): boolean {
  return value === "true" || value === "false";
}

function decodeUrlComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
