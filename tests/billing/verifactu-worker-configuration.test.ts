import { describe, expect, it } from "vitest";
import {
  assertVerifactuProductionWorkerConfiguration,
  assertVerifactuTestWorkerConfiguration
} from "@/modules/billing/application/verifactuWorkerConfiguration";

const valid = {
  APP_ENV: "test",
  DATABASE_URL: "postgresql://local:local@localhost:5432/crigestion_test?schema=public",
  VERIFACTU_ENABLED: "true",
  VERIFACTU_ENVIRONMENT: "TEST",
  VERIFACTU_ALLOW_PRODUCTION: "false",
  VERIFACTU_WORKER_ENVIRONMENT: "TEST",
  VERIFACTU_WORKER_ALLOW_PRODUCTION: "false",
  VERIFACTU_WORKER_EXPECTED_DATABASE: "crigestion_test"
};

describe("VeriFactu TEST worker configuration", () => {
  it("accepts only the isolated local TEST database", () => {
    expect(() => assertVerifactuTestWorkerConfiguration(valid)).not.toThrow();
  });

  it("accepts staging only on the exact loopback staging database", () => {
    const staging = {
      ...valid,
      NODE_ENV: "production",
      APP_ENV: "staging",
      DATABASE_URL: "postgresql://crigestion_staging_app:local@127.0.0.1:5432/crigestion_staging?schema=public",
      VERIFACTU_WORKER_EXPECTED_DATABASE: "crigestion_staging"
    };
    expect(() => assertVerifactuTestWorkerConfiguration(staging)).not.toThrow();
    expect(() => assertVerifactuTestWorkerConfiguration({
      ...staging,
      DATABASE_URL: "postgresql://local:local@127.0.0.1:5432/crigestion_test?schema=public"
    })).toThrow("VERIFACTU_WORKER_DATABASE_URL_INVALID");
    expect(() => assertVerifactuTestWorkerConfiguration({
      ...staging,
      VERIFACTU_WORKER_ALLOW_PRODUCTION: "true"
    })).toThrow("VERIFACTU_WORKER_TEST_SERVICE_ENVIRONMENT_INVALID");
  });

  it.each([
    ["APP_ENV", "development"],
    ["VERIFACTU_ENABLED", "false"],
    ["VERIFACTU_ENVIRONMENT", "PRODUCTION"],
    ["VERIFACTU_WORKER_ENVIRONMENT", "PRODUCTION"],
    ["VERIFACTU_ALLOW_PRODUCTION", "true"],
    ["VERIFACTU_WORKER_ALLOW_PRODUCTION", "true"],
    ["VERIFACTU_WORKER_EXPECTED_DATABASE", "crigestion"]
  ])("rejects an unsafe %s", (name, value) => {
    expect(() => assertVerifactuTestWorkerConfiguration({ ...valid, [name]: value })).toThrow(
      "VERIFACTU_WORKER_TEST_SERVICE_ENVIRONMENT_INVALID"
    );
  });

  it.each([
    "postgresql://local:local@localhost:5432/crigestion",
    "postgresql://local:local@db.example:5432/crigestion_test",
    "https://localhost/crigestion_test",
    "not-a-url"
  ])("rejects an unsafe database URL", (databaseUrl) => {
    expect(() => assertVerifactuTestWorkerConfiguration({ ...valid, DATABASE_URL: databaseUrl })).toThrow(
      "VERIFACTU_WORKER_DATABASE_URL_INVALID"
    );
  });

  it("accepts the isolated Docker TEST service host only for its deployment id", () => {
    expect(() => assertVerifactuTestWorkerConfiguration({
      ...valid,
      DATABASE_URL: "postgresql://local:local@postgres:5432/crigestion_test?schema=public",
      VERIFACTU_WORKER_DEPLOYMENT_ID: "docker-test"
    })).not.toThrow();
    expect(() => assertVerifactuTestWorkerConfiguration({
      ...valid,
      DATABASE_URL: "postgresql://local:local@postgres:5432/crigestion_test?schema=public"
    })).toThrow("VERIFACTU_WORKER_DATABASE_URL_INVALID");
  });
});

const validProduction = {
  APP_ENV: "production",
  DATABASE_URL: "postgresql://worker:secret@db.internal:5432/crigestion_prod?schema=public",
  VERIFACTU_ENABLED: "true",
  VERIFACTU_ENVIRONMENT: "PRODUCTION",
  VERIFACTU_WORKER_ENVIRONMENT: "PRODUCTION",
  VERIFACTU_WORKER_ALLOW_PRODUCTION: "true",
  VERIFACTU_WORKER_PRODUCTION_CONFIRM: "AEAT_PRODUCTION_AUTHORIZED",
  VERIFACTU_WORKER_EXPECTED_DATABASE: "crigestion_prod"
};

describe("VeriFactu PRODUCTION worker configuration", () => {
  it("requires the complete production authorization and exact database", () => {
    expect(() => assertVerifactuProductionWorkerConfiguration(validProduction)).not.toThrow();
  });

  it.each([
    ["APP_ENV", "test", "VERIFACTU_WORKER_PRODUCTION_ENVIRONMENT_INVALID"],
    ["VERIFACTU_WORKER_ALLOW_PRODUCTION", "false", "VERIFACTU_WORKER_PRODUCTION_ENVIRONMENT_INVALID"],
    ["VERIFACTU_WORKER_PRODUCTION_CONFIRM", "", "VERIFACTU_WORKER_PRODUCTION_ENVIRONMENT_INVALID"],
    ["VERIFACTU_WORKER_EXPECTED_DATABASE", "crigestion_test", "VERIFACTU_WORKER_PRODUCTION_DATABASE_INVALID"],
    ["VERIFACTU_WORKER_EXPECTED_DATABASE", "other_prod", "VERIFACTU_WORKER_PRODUCTION_DATABASE_INVALID"]
  ])("rejects unsafe %s", (name, value, code) => {
    expect(() => assertVerifactuProductionWorkerConfiguration({ ...validProduction, [name]: value })).toThrow(code);
  });
});
