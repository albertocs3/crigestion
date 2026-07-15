import { describe, expect, it } from "vitest";

import { isDisposableTestDatabaseName } from "@/tests/helpers/disposableTestDatabase";
import { assertVitestDatabaseUrl } from "@/lib/vitestDatabaseSafety";

const validEnvironment = {
  APP_ENV: "test",
  DATABASE_URL: "postgresql://crigestion_ci:test-only@localhost:5432/crigestion_ci_test?schema=public&application_name=crigestion-vitest",
  VITEST_ALLOW_DATABASE_RESET: "true",
  VITEST_DATABASE_HOST: "localhost"
};

describe("disposable test database guard", () => {
  it("accepts only CI test database names", () => {
    expect(isDisposableTestDatabaseName("crigestion_ci_test")).toBe(true);
  });

  it("rejects operational and production database names", () => {
    expect(isDisposableTestDatabaseName("crigestion_test")).toBe(false);
    expect(isDisposableTestDatabaseName("crigestion")).toBe(false);
    expect(isDisposableTestDatabaseName("feature_42_ci_test")).toBe(false);
    expect(isDisposableTestDatabaseName("crigestion_ci_test_copy")).toBe(false);
  });

  it("accepts the complete local CI identity", () => {
    expect(assertVitestDatabaseUrl(validEnvironment).pathname).toBe("/crigestion_ci_test");
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
