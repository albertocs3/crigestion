import { spawn } from "node:child_process";
import { Client } from "pg";

const migrationLockId = 2_026_071_501;

async function main(): Promise<void> {
  if (
    process.env.APP_ENV !== "production" ||
    process.env.CRIGESTION_MIGRATION_CONFIRM_PRODUCTION !== "CRIGESTION_PRODUCTION_MIGRATION_AUTHORIZED"
  ) {
    throw new Error("PRODUCTION_MIGRATION_CONFIRMATION_REQUIRED");
  }

  const expectedDatabase = process.env.CRIGESTION_MIGRATION_EXPECTED_DATABASE?.trim();
  if (
    !expectedDatabase ||
    !/^[A-Za-z0-9_-]{1,63}$/.test(expectedDatabase) ||
    /(?:^|[_-])test$/i.test(expectedDatabase)
  ) {
    throw new Error("PRODUCTION_MIGRATION_EXPECTED_DATABASE_INVALID");
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("PRODUCTION_MIGRATION_DATABASE_URL_MISSING");
  assertUrlDatabase(connectionString, expectedDatabase);

  const client = new Client({
    connectionString,
    application_name: "crigestion-production-migration-preflight"
  });
  await client.connect();
  try {
    const identity = await client.query<{ name: string }>('SELECT current_database() AS "name"');
    if (identity.rows[0]?.name !== expectedDatabase) {
      throw new Error("PRODUCTION_MIGRATION_DATABASE_MISMATCH");
    }
    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS "acquired"',
      [migrationLockId]
    );
    if (!lock.rows[0]?.acquired) throw new Error("PRODUCTION_MIGRATION_ALREADY_RUNNING");
    await runPrismaMigrateDeploy();
  } finally {
    await client.end().catch(() => undefined);
  }
}

function assertUrlDatabase(connectionString: string, expectedDatabase: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("PRODUCTION_MIGRATION_DATABASE_URL_INVALID");
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    databaseName !== expectedDatabase
  ) {
    throw new Error("PRODUCTION_MIGRATION_DATABASE_URL_INVALID");
  }
}

async function runPrismaMigrateDeploy(): Promise<void> {
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["node_modules/prisma/build/index.js", "migrate", "deploy"],
      { stdio: "inherit", shell: false }
    );
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) throw new Error("PRODUCTION_MIGRATION_DEPLOY_FAILED");
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,119}$/.test(error.message)
    ? error.message
    : "PRODUCTION_MIGRATION_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
