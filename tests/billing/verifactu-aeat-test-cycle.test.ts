import { describe, expect, it } from "vitest";
import { isCleanAcceptedAttempt, readConfig, stableCycleErrorCode } from "@/scripts/verify-verifactu-aeat-test-cycle";

const validEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  APP_ENV: "test",
  VERIFACTU_ENABLED: "true",
  VERIFACTU_ENVIRONMENT: "test",
  VERIFACTU_WORKER_ENVIRONMENT: "TEST",
  VERIFACTU_AEAT_TEST_CYCLE_ENABLED: "true",
  VERIFACTU_AEAT_TEST_CYCLE_CONFIRM: "AEAT_TEST_ONLY",
  VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_DATABASE: "crigestion_test",
  VERIFACTU_AEAT_TEST_CYCLE_INVOICE_ID: "a683f009-2832-426e-bcf9-9bbd0f957e80",
  VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_INVOICE_NUMBER: "F2600002",
  VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_COMPANY_ID: "05cf2ba1-4cd3-41a6-a47c-a776a4789c2a",
  VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_SIF_INSTALLATION_ID: "f20752b4-5980-44ae-96e2-a86b2c706c48",
  VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_CANCELLATION_ID: "331fb201-38d9-4165-a2de-2e499cd16342",
  VERIFACTU_AEAT_TEST_CYCLE_OPERATOR_ID: "release.operator",
  VERIFACTU_AEAT_TEST_CYCLE_RELEASE_ID: "release-2026.07.13"
};

describe("AEAT TEST cycle verifier safeguards", () => {
  it("accepts only an explicitly confirmed TEST configuration", () => {
    expect(readConfig(validEnvironment)).toEqual({
      expectedDatabase: "crigestion_test",
      invoiceId: "a683f009-2832-426e-bcf9-9bbd0f957e80",
      expectedInvoiceNumber: "F2600002",
      expectedCompanyId: "05cf2ba1-4cd3-41a6-a47c-a776a4789c2a",
      expectedSifInstallationId: "f20752b4-5980-44ae-96e2-a86b2c706c48",
      expectedCancellationId: "331fb201-38d9-4165-a2de-2e499cd16342",
      operatorId: "release.operator",
      releaseId: "release-2026.07.13"
    });
  });

  it.each([
    ["disabled", { VERIFACTU_AEAT_TEST_CYCLE_ENABLED: "false" }, "VERIFACTU_AEAT_TEST_CYCLE_NOT_ENABLED"],
    ["unconfirmed", { VERIFACTU_AEAT_TEST_CYCLE_CONFIRM: "" }, "VERIFACTU_AEAT_TEST_CYCLE_CONFIRMATION_REQUIRED"],
    ["application production", { APP_ENV: "production" }, "VERIFACTU_AEAT_TEST_CYCLE_APP_ENV_INVALID"],
    ["missing application environment", { APP_ENV: undefined }, "VERIFACTU_AEAT_TEST_CYCLE_APP_ENV_INVALID"],
    ["development application environment", { APP_ENV: "development" }, "VERIFACTU_AEAT_TEST_CYCLE_APP_ENV_INVALID"],
    ["case-variant application environment", { APP_ENV: "TEST" }, "VERIFACTU_AEAT_TEST_CYCLE_APP_ENV_INVALID"],
    ["integration production", { VERIFACTU_ENVIRONMENT: "production" }, "VERIFACTU_AEAT_TEST_CYCLE_ENVIRONMENT_INVALID"],
    ["worker production", { VERIFACTU_WORKER_ENVIRONMENT: "PRODUCTION" }, "VERIFACTU_AEAT_TEST_CYCLE_ENVIRONMENT_INVALID"],
    ["invalid invoice id", { VERIFACTU_AEAT_TEST_CYCLE_INVOICE_ID: "not-a-uuid" }, "VERIFACTU_AEAT_TEST_CYCLE_INVOICE_ID_INVALID"],
    ["non-test database", { VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_DATABASE: "crigestion" }, "VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_DATABASE_INVALID"],
    ["unsafe database name", { VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_DATABASE: "crigestion;drop" }, "VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_DATABASE_INVALID"],
    ["control character in invoice number", { VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_INVOICE_NUMBER: "F26\n2" }, "VERIFACTU_AEAT_TEST_CYCLE_INVOICE_NUMBER_INVALID"],
    ["missing operator", { VERIFACTU_AEAT_TEST_CYCLE_OPERATOR_ID: "" }, "VERIFACTU_AEAT_TEST_CYCLE_OPERATOR_ID_INVALID"],
    ["missing release", { VERIFACTU_AEAT_TEST_CYCLE_RELEASE_ID: "" }, "VERIFACTU_AEAT_TEST_CYCLE_RELEASE_ID_INVALID"]
  ])("rejects %s", (_label, overrides, expectedError) => {
    expect(() => readConfig({ ...validEnvironment, ...overrides })).toThrow(expectedError);
  });

  it("requires clean acceptance without stable errors or AEAT warnings", () => {
    expect(isCleanAcceptedAttempt({ outcome: "ACCEPTED", stableErrorCode: null, aeatCodes: [] })).toBe(true);
    expect(isCleanAcceptedAttempt({ outcome: "ACCEPTED_WITH_ERRORS", stableErrorCode: null, aeatCodes: [] })).toBe(false);
    expect(isCleanAcceptedAttempt({ outcome: "ACCEPTED", stableErrorCode: "VERIFACTU_AEAT_RECORD_ERROR", aeatCodes: [] })).toBe(false);
    expect(isCleanAcceptedAttempt({ outcome: "ACCEPTED", stableErrorCode: null, aeatCodes: ["1100"] })).toBe(false);
  });

  it("never writes untrusted exception messages to the operational output", () => {
    expect(stableCycleErrorCode(new Error("postgres://secret@host/prod NIF 123 XML <Envelope>")))
      .toBe("VERIFACTU_AEAT_TEST_CYCLE_FAILED");
    expect(stableCycleErrorCode(new Error("VERIFACTU_AEAT_TEST_CYCLE_DATABASE_MISMATCH")))
      .toBe("VERIFACTU_AEAT_TEST_CYCLE_DATABASE_MISMATCH");
  });
});
