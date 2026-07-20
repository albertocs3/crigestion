const expectedDatabaseName = "crigestion_test";
const expectedDatabaseUser = "crigestion";
const expectedApplicationName = "crigestion-e2e";
const loopbackHosts = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function parseE2eDatabaseUrl(
  env: Readonly<Record<string, string | undefined>>,
  expectsApplicationName: boolean
): URL {
  if (
    env.APP_ENV !== "test" ||
    env.E2E_ALLOW_DATABASE_RESET !== "true" ||
    env.E2E_APPLICATION_NAME !== expectedApplicationName
  ) {
    throw new Error("E2E_DATABASE_RESET_NOT_ALLOWED");
  }

  const value = env.DATABASE_URL;
  const expectedHost = env.E2E_DATABASE_HOST;
  if (!value || !expectedHost || !loopbackHosts.has(expectedHost)) {
    throw new Error("E2E_DATABASE_RESET_NOT_ALLOWED");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("E2E_DATABASE_RESET_NOT_ALLOWED");
  }

  const declaredDatabaseName = decodeURIComponent(parsed.pathname.slice(1));
  const expectedParameterCount = expectsApplicationName ? 2 : 1;
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.hostname !== expectedHost ||
    (parsed.port !== "" && parsed.port !== "5432") ||
    parsed.hash !== "" ||
    declaredDatabaseName !== expectedDatabaseName ||
    decodeURIComponent(parsed.username) !== expectedDatabaseUser ||
    !parsed.password ||
    [...parsed.searchParams.keys()].length !== expectedParameterCount ||
    parsed.searchParams.getAll("schema").length !== 1 ||
    parsed.searchParams.get("schema") !== "public" ||
    parsed.searchParams.getAll("application_name").length !== (expectsApplicationName ? 1 : 0) ||
    (expectsApplicationName &&
      parsed.searchParams.get("application_name") !== expectedApplicationName)
  ) {
    throw new Error("E2E_DATABASE_RESET_NOT_ALLOWED");
  }

  return parsed;
}

export function prepareE2eDatabaseUrl(
  env: Readonly<Record<string, string | undefined>>
): URL {
  const parsed = parseE2eDatabaseUrl(env, false);
  parsed.searchParams.set("application_name", expectedApplicationName);
  return parsed;
}

export function assertE2eDatabaseUrl(
  env: Readonly<Record<string, string | undefined>>
): URL {
  return parseE2eDatabaseUrl(env, true);
}

export const e2eDatabaseIdentity = {
  applicationName: expectedApplicationName,
  databaseName: expectedDatabaseName,
  databaseUser: expectedDatabaseUser
} as const;
