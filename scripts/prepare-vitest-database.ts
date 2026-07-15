import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadEnvironment } from "dotenv";

import { verifyVitestDatabaseEnvironment } from "../tests/helpers/vitestDatabaseEnvironment";

if (process.env.CI !== "true" && existsSync(".env.vitest.local")) {
  loadEnvironment({ path: ".env.vitest.local", override: true, quiet: true });
}

async function main(): Promise<void> {
  const identity = await verifyVitestDatabaseEnvironment();
  console.info(
    `Preparing disposable database: ${identity.databaseName} (${identity.databaseUser}, ${identity.applicationName})`
  );

  const prismaCli = fileURLToPath(new URL("../node_modules/prisma/build/index.js", import.meta.url));
  const result = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    env: process.env,
    stdio: "inherit"
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "VITEST_DATABASE_PREPARATION_FAILED");
  process.exit(1);
});
