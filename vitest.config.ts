import { existsSync } from "node:fs";

import { config as loadEnvironment } from "dotenv";
import { defineConfig } from "vitest/config";

if (process.env.CI !== "true" && existsSync(".env.vitest.local")) {
  loadEnvironment({ path: ".env.vitest.local", override: true, quiet: true });
}

export default defineConfig({
  resolve: {
    alias: {
      "server-only": "./tests/mocks/server-only.ts",
      "@": "./"
    }
  },
  test: {
    environment: "node",
    fileParallelism: false,
    globalSetup: ["./tests/setup/vitestDatabaseGuard.ts"],
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    sequence: {
      concurrent: false
    }
  }
});
