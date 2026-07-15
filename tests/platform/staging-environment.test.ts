import { describe, expect, it } from "vitest";
import {
  assertStagingDatabaseIdentity,
  assertStagingDatabaseUrl,
  assertStagingRuntimeEnvironment,
  stagingRuntimeDatabaseRole
} from "@/modules/platform/application/stagingEnvironment";

const validDatabaseUrl = "postgresql://crigestion_staging_app:secret@127.0.0.1:5432/crigestion_staging?schema=public";
const validEnvironment = {
  NODE_ENV: "production",
  APP_ENV: "staging",
  DATABASE_URL: validDatabaseUrl,
  VERIFACTU_ENABLED: "false",
  VERIFACTU_ENVIRONMENT: "TEST",
  VERIFACTU_WORKER_ENVIRONMENT: "TEST",
  VERIFACTU_ALLOW_PRODUCTION: "false",
  VERIFACTU_WORKER_ALLOW_PRODUCTION: "false"
};

describe("staging environment guard", () => {
  it("accepts only the exact declaration and effective runtime identity", () => {
    expect(() => assertStagingRuntimeEnvironment(validEnvironment, {
      databaseName: "crigestion_staging",
      databaseRole: "crigestion_staging_app",
      serverAddress: "127.0.0.1",
      serverPort: 5432
    })).not.toThrow();
  });

  it.each([
    "postgresql://crigestion_staging_app:secret@localhost:5432/crigestion_staging?schema=public",
    "postgresql://other:secret@127.0.0.1:5432/crigestion_staging?schema=public",
    "postgresql://crigestion_staging_app:secret@127.0.0.1:6543/crigestion_staging?schema=public",
    "postgresql://crigestion_staging_app:secret@127.0.0.1:5432/crigestion_test?schema=public",
    "postgresql://crigestion_staging_app:secret@127.0.0.1:5432/crigestion_staging?schema=evil",
    "postgresql://crigestion_staging_app:secret@127.0.0.1:5432/crigestion_staging?schema=public&host=evil.example",
    "postgresql://crigestion_staging_app:secret@127.0.0.1:5432/crigestion_staging?schema=public&hostaddr=203.0.113.10",
    "postgresql://crigestion_staging_app:secret@127.0.0.1:5432/crigestion_staging?schema=public&service=evil",
    "postgresql://crigestion_staging_app:secret@127.0.0.1:5432/crigestion_staging?schema=public&options=-csearch_path%3Devil",
    "postgresql://crigestion_staging_app:secret@127.0.0.1:5432/crigestion_staging?schema=public&schema=public",
    "postgresql://crigestion_staging_app:secret@127.0.0.1:5432/crigestion_staging?schema=public#fragment"
  ])("rejects unsafe DATABASE_URL %s", (databaseUrl) => {
    expect(() => assertStagingDatabaseUrl(databaseUrl, stagingRuntimeDatabaseRole))
      .toThrow("STAGING_DATABASE_URL_INVALID");
  });

  it.each([
    ["VERIFACTU_ENVIRONMENT", "test"],
    ["VERIFACTU_WORKER_ENVIRONMENT", " TEST "],
    ["VERIFACTU_ALLOW_PRODUCTION", undefined],
    ["VERIFACTU_WORKER_ALLOW_PRODUCTION", "true"],
    ["VERIFACTU_ENABLED", "FALSE"]
  ])("rejects non-canonical %s", (name, value) => {
    expect(() => assertStagingRuntimeEnvironment({ ...validEnvironment, [name]: value }))
      .toThrow("STAGING_ENVIRONMENT_INVALID");
  });

  it("rejects an effective identity with the migrator role", () => {
    expect(() => assertStagingDatabaseIdentity({
      databaseName: "crigestion_staging",
      databaseRole: "crigestion_staging_migrator",
      serverAddress: "127.0.0.1",
      serverPort: 5432
    }, stagingRuntimeDatabaseRole)).toThrow("STAGING_DATABASE_IDENTITY_INVALID");
  });
});
