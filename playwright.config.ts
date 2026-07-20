import { existsSync } from "node:fs";

import { config as loadEnvironment } from "dotenv";
import { defineConfig, devices } from "@playwright/test";

import {
  assertE2eDatabaseUrl,
  prepareE2eDatabaseUrl
} from "./lib/e2eDatabaseSafety";

if (process.env.CI !== "true" && existsSync(".env.test.local")) {
  loadEnvironment({ path: ".env.test.local", override: true, quiet: true });
}

const databaseUrl = prepareE2eDatabaseUrl(process.env);
process.env.DATABASE_URL = databaseUrl.toString();
assertE2eDatabaseUrl(process.env);

const e2ePort = process.env.E2E_PORT ?? "3100";
const e2eBaseUrl = process.env.E2E_BASE_URL ?? `http://localhost:${e2ePort}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: {
    timeout: 15_000
  },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: e2eBaseUrl,
    trace: "on-first-retry"
  },
  webServer: {
    command: "npm run dev",
    url: e2eBaseUrl,
    env: {
      ...process.env,
      APP_ENV: "test",
      APP_BASE_URL: e2eBaseUrl,
      PORT: e2ePort,
      VERIFACTU_ENABLED: "false"
    },
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
