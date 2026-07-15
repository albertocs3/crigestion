import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const baseEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "production",
  APP_ENV: "staging",
  CRIGESTION_MIGRATION_CONFIRM_STAGING: "CRIGESTION_STAGING_MIGRATION_AUTHORIZED",
  CRIGESTION_MIGRATION_EXPECTED_DATABASE: "crigestion_staging",
  CRIGESTION_RUNTIME_DATABASE_ROLE: "crigestion_staging_app"
};

describe("staging migration launcher preflight", () => {
  it.each([
    "postgresql://crigestion_staging_migrator:secret@127.0.0.1:5432/crigestion_staging?schema=public&host=evil.example",
    "postgresql://crigestion_staging_migrator:secret@127.0.0.1:5432/crigestion_staging?schema=public&user=postgres",
    "postgresql://crigestion_staging_migrator:secret@127.0.0.1:5432/crigestion_staging?schema=public&port=6543",
    "postgresql://crigestion_staging_migrator:secret@127.0.0.1:5432/crigestion_staging?schema=evil"
  ])("rejects a redirected URL before opening PostgreSQL: %s", (databaseUrl) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/deploy-staging-migrations.ts"], {
      cwd: process.cwd(),
      env: { ...baseEnvironment, DATABASE_URL: databaseUrl },
      encoding: "utf8",
      timeout: 15_000
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("STAGING_DATABASE_URL_INVALID");
    expect(result.stderr).not.toContain("secret");
  });

  it("rejects an unexpected runtime role before opening PostgreSQL", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/deploy-staging-migrations.ts"], {
      cwd: process.cwd(),
      env: {
        ...baseEnvironment,
        DATABASE_URL: "postgresql://crigestion_staging_migrator:secret@127.0.0.1:5432/crigestion_staging?schema=public",
        CRIGESTION_RUNTIME_DATABASE_ROLE: "decoy_role"
      },
      encoding: "utf8",
      timeout: 15_000
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("STAGING_MIGRATION_ENVIRONMENT_INVALID");
  });
});
