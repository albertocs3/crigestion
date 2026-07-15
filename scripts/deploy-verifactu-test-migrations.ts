import { spawn } from "node:child_process";
import { Client } from "pg";

async function main(): Promise<void> {
  if (process.env.APP_ENV !== "test" || process.env.VERIFACTU_MIGRATION_CONFIRM_TEST !== "true") {
    throw new Error("VERIFACTU_MIGRATION_TEST_CONFIRMATION_REQUIRED");
  }
  const expectedDatabase = process.env.VERIFACTU_MIGRATION_EXPECTED_DATABASE?.trim();
  if (!expectedDatabase || !/^[A-Za-z0-9_-]{1,63}_test$/.test(expectedDatabase)) {
    throw new Error("VERIFACTU_MIGRATION_EXPECTED_DATABASE_INVALID");
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("VERIFACTU_MIGRATION_DATABASE_URL_MISSING");
  const client = new Client({ connectionString, application_name: "crigestion-verifactu-test-migrate-preflight" });
  await client.connect();
  try {
    const result = await client.query<{ name: string }>('SELECT current_database() AS "name"');
    if (result.rows[0]?.name !== expectedDatabase) {
      throw new Error("VERIFACTU_MIGRATION_DATABASE_MISMATCH");
    }
  } finally {
    await client.end().catch(() => undefined);
  }
  await runPrismaMigrateDeploy();
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
  if (exitCode !== 0) throw new Error("VERIFACTU_MIGRATION_DEPLOY_FAILED");
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,119}$/.test(error.message)
    ? error.message
    : "VERIFACTU_MIGRATION_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
