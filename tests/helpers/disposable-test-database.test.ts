import { describe, expect, it } from "vitest";

import {
  assertE2eDatabaseUrl,
  prepareE2eDatabaseUrl
} from "@/lib/e2eDatabaseSafety";
import { isDisposableTestDatabaseName } from "@/tests/helpers/disposableTestDatabase";
import { assertVitestDatabaseUrl } from "@/lib/vitestDatabaseSafety";

const validEnvironment = {
  APP_ENV: "test",
  DATABASE_URL: "postgresql://crigestion_ci:test-only@localhost:5432/crigestion_ci_test?schema=public&application_name=crigestion-vitest",
  VITEST_ALLOW_DATABASE_RESET: "true",
  VITEST_DATABASE_HOST: "localhost"
};

const validE2eEnvironment = {
  APP_ENV: "test",
  DATABASE_URL: "postgresql://crigestion:test-only@localhost:5432/crigestion_test?schema=public&application_name=crigestion-e2e",
  E2E_ALLOW_DATABASE_RESET: "true",
  E2E_APPLICATION_NAME: "crigestion-e2e",
  E2E_DATABASE_HOST: "localhost"
};

describe("disposable test database guard", () => {
  it("accepts only the explicit disposable test database names", () => {
    expect(isDisposableTestDatabaseName("crigestion_ci_test")).toBe(true);
    expect(isDisposableTestDatabaseName("crigestion_test")).toBe(true);
  });

  it("rejects operational and production database names", () => {
    expect(isDisposableTestDatabaseName("crigestion")).toBe(false);
    expect(isDisposableTestDatabaseName("feature_42_ci_test")).toBe(false);
    expect(isDisposableTestDatabaseName("crigestion_ci_test_copy")).toBe(false);
  });

  it("accepts the complete local CI identity", () => {
    expect(assertVitestDatabaseUrl(validEnvironment).pathname).toBe("/crigestion_ci_test");
  });

  it("accepts the complete local E2E identity", () => {
    expect(assertE2eDatabaseUrl(validE2eEnvironment).pathname).toBe("/crigestion_test");
  });

  it("prepares an explicitly authorized base URL for the E2E identity", () => {
    const environment = {
      ...validE2eEnvironment,
      DATABASE_URL: validE2eEnvironment.DATABASE_URL.replace(
        "&application_name=crigestion-e2e",
        ""
      )
    };

    expect(prepareE2eDatabaseUrl(environment).searchParams.get("application_name"))
      .toBe("crigestion-e2e");
  });

  it.each([
    ["operational database", { DATABASE_URL: validE2eEnvironment.DATABASE_URL.replace("crigestion_test", "crigestion") }],
    ["different user", { DATABASE_URL: validE2eEnvironment.DATABASE_URL.replace("crigestion:test-only", "other:test-only") }],
    ["missing confirmation", { E2E_ALLOW_DATABASE_RESET: undefined }],
    ["wrong declared application", { E2E_APPLICATION_NAME: "other-e2e" }],
    ["remote host", { DATABASE_URL: validE2eEnvironment.DATABASE_URL.replace("localhost", "db.example.test"), E2E_DATABASE_HOST: "db.example.test" }],
    ["unexpected port", { DATABASE_URL: validE2eEnvironment.DATABASE_URL.replace(":5432", ":6543") }],
    ["fragment", { DATABASE_URL: `${validE2eEnvironment.DATABASE_URL}#unsafe` }],
    ["extra parameter", { DATABASE_URL: `${validE2eEnvironment.DATABASE_URL}&host=evil.example` }],
    ["missing application name", { DATABASE_URL: validE2eEnvironment.DATABASE_URL.replace("&application_name=crigestion-e2e", "") }],
    ["duplicate application name", { DATABASE_URL: `${validE2eEnvironment.DATABASE_URL}&application_name=crigestion-e2e` }]
  ])("rejects E2E %s", (_caseName, overrides) => {
    expect(() => assertE2eDatabaseUrl({ ...validE2eEnvironment, ...overrides })).toThrow(
      "E2E_DATABASE_RESET_NOT_ALLOWED"
    );
  });

  it.each([
    ["operational database", { DATABASE_URL: validEnvironment.DATABASE_URL.replace("crigestion_ci_test", "crigestion_test") }],
    ["different user", { DATABASE_URL: validEnvironment.DATABASE_URL.replace("crigestion_ci:test-only", "crigestion:test-only") }],
    ["missing confirmation", { VITEST_ALLOW_DATABASE_RESET: undefined }],
    ["remote host", { DATABASE_URL: validEnvironment.DATABASE_URL.replace("localhost", "db.example.test"), VITEST_DATABASE_HOST: "db.example.test" }],
    ["missing application name", { DATABASE_URL: validEnvironment.DATABASE_URL.replace("&application_name=crigestion-vitest", "") }],
    ["duplicate application name", { DATABASE_URL: `${validEnvironment.DATABASE_URL}&application_name=crigestion-vitest` }]
  ])("rejects %s", (_caseName, overrides) => {
    expect(() => assertVitestDatabaseUrl({ ...validEnvironment, ...overrides })).toThrow(
      "VITEST_DATABASE_RESET_NOT_ALLOWED"
    );
  });
});
