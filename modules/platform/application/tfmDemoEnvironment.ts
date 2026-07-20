export const tfmDemoConfirmation = "TFM_DEMO_AEAT_TEST_ONLY";
export const tfmDemoDatabaseName = "crigestion_prod";
export const tfmDemoDatabaseRole = "crigestion_app";
export const tfmDemoDatabasePort = 5433;

export type TfmDemoDatabaseIdentity = {
  databaseName: string | null | undefined;
  databaseRole: string | null | undefined;
  serverAddress: string | null | undefined;
  serverPort: number | null | undefined;
};

export function isTfmDemoRequested(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return env.APP_ENV === "production" && env.VERIFACTU_TFM_DEMO_CONFIRM === tfmDemoConfirmation;
}

export function isTfmDemoRuntimeEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  try {
    assertTfmDemoRuntimeEnvironment(env);
    return true;
  } catch {
    return false;
  }
}

export function assertTfmDemoRuntimeEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  identity?: TfmDemoDatabaseIdentity
): void {
  if (
    env.NODE_ENV !== "production" ||
    env.APP_ENV !== "production" ||
    env.VERIFACTU_TFM_DEMO_CONFIRM !== tfmDemoConfirmation ||
    !isCanonicalBoolean(env.VERIFACTU_ENABLED) ||
    env.VERIFACTU_ENVIRONMENT !== "TEST" ||
    env.VERIFACTU_WORKER_ENVIRONMENT !== "TEST" ||
    env.VERIFACTU_ALLOW_PRODUCTION !== "false" ||
    env.VERIFACTU_WORKER_ALLOW_PRODUCTION !== "false" ||
    (env.VERIFACTU_PRODUCTION_RELEASE_ID ?? "") !== "" ||
    (env.VERIFACTU_WORKER_PRODUCTION_CONFIRM ?? "") !== "" ||
    env.VERIFACTU_WORKER_EXPECTED_DATABASE !== tfmDemoDatabaseName
  ) {
    throw new Error("TFM_DEMO_ENVIRONMENT_INVALID");
  }

  assertTfmDemoDatabaseUrl(env.DATABASE_URL);
  if (identity) assertTfmDemoDatabaseIdentity(identity);
}

export function assertTfmDemoDatabaseUrl(connectionString: string | undefined): void {
  let url: URL;
  try {
    url = new URL(connectionString ?? "");
  } catch {
    throw new Error("TFM_DEMO_DATABASE_URL_INVALID");
  }
  const parameters = Array.from(url.searchParams.entries());
  const databaseName = decodeUrlComponent(url.pathname.slice(1));
  const databaseRole = decodeUrlComponent(url.username);
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.port !== String(tfmDemoDatabasePort) ||
    databaseName !== tfmDemoDatabaseName ||
    databaseRole !== tfmDemoDatabaseRole ||
    url.password.length === 0 ||
    url.hash !== "" ||
    parameters.length !== 1 ||
    parameters[0]?.[0] !== "schema" ||
    parameters[0]?.[1] !== "public"
  ) {
    throw new Error("TFM_DEMO_DATABASE_URL_INVALID");
  }
}

export function assertTfmDemoDatabaseIdentity(identity: TfmDemoDatabaseIdentity): void {
  if (
    identity.databaseName !== tfmDemoDatabaseName ||
    identity.databaseRole !== tfmDemoDatabaseRole ||
    !["127.0.0.1", "127.0.0.1/32", "::1", "::1/128"].includes(identity.serverAddress ?? "") ||
    identity.serverPort !== tfmDemoDatabasePort
  ) {
    throw new Error("TFM_DEMO_DATABASE_IDENTITY_INVALID");
  }
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
