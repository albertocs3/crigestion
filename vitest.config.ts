import { defineConfig } from "vitest/config";

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
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    sequence: {
      concurrent: false
    }
  }
});
