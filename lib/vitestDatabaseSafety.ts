const expectedDatabaseName = "crigestion_ci_test";
const expectedDatabaseUser = "crigestion_ci";
const expectedApplicationName = "crigestion-vitest";
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

export function assertVitestDatabaseUrl(env: Readonly<Record<string, string | undefined>>): URL {
  if (env.APP_ENV !== "test" || env.VITEST_ALLOW_DATABASE_RESET !== "true") {
    throw new Error("VITEST_DATABASE_RESET_NOT_ALLOWED");
  }

  const value = env.DATABASE_URL;
  const expectedHost = env.VITEST_DATABASE_HOST;
  if (!value || !expectedHost || !loopbackHosts.has(expectedHost)) {
    throw new Error("VITEST_DATABASE_RESET_NOT_ALLOWED");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("VITEST_DATABASE_RESET_NOT_ALLOWED");
  }

  const declaredDatabaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.hostname !== expectedHost ||
    declaredDatabaseName !== expectedDatabaseName ||
    decodeURIComponent(parsed.username) !== expectedDatabaseUser ||
    !parsed.password ||
    parsed.searchParams.getAll("schema").length !== 1 ||
    parsed.searchParams.get("schema") !== "public" ||
    parsed.searchParams.getAll("application_name").length !== 1 ||
    parsed.searchParams.get("application_name") !== expectedApplicationName
  ) {
    throw new Error("VITEST_DATABASE_RESET_NOT_ALLOWED");
  }

  return parsed;
}

export const vitestDatabaseIdentity = {
  applicationName: expectedApplicationName,
  databaseName: expectedDatabaseName,
  databaseUser: expectedDatabaseUser
} as const;
