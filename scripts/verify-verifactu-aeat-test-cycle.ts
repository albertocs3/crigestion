import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { prisma } from "../lib/prisma";
import {
  isCleanAcceptedAttempt,
  verifyVerifactuAeatTestCycle,
  type AeatTestCycleConfig
} from "../modules/billing/application/verifyVerifactuAeatTestCycle";
import { readConfiguredAeatVerifactuTransport } from "../modules/billing/infrastructure/verifactu/configuredTransport";
import { createPrismaAeatTestCycleRepository } from "../modules/billing/infrastructure/verifactu/aeatTestCycleRepository";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const testDatabaseNamePattern = /^[A-Za-z0-9_-]{1,58}_test$/;
const operationalIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,119}$/;

async function main(): Promise<void> {
  const config = readConfig(process.env);
  await verifyVerifactuAeatTestCycle(config, {
    repository: createPrismaAeatTestCycleRepository(prisma),
    transport: readConfiguredAeatVerifactuTransport(),
    newRequestId: () => `vf-test-cycle:${config.expectedCancellationId}:${randomUUID()}`,
    now: () => new Date(),
    runnerHost: hostname(),
    applicationVersion: process.env.npm_package_version ?? "unknown"
  });
  process.stdout.write("AEAT TEST cycle verified: ALTA ACCEPTED -> ANULACION ACCEPTED -> QUERY ANULADO\n");
}

export function readConfig(env: NodeJS.ProcessEnv): AeatTestCycleConfig {
  if (env.VERIFACTU_AEAT_TEST_CYCLE_ENABLED !== "true") throw new Error("VERIFACTU_AEAT_TEST_CYCLE_NOT_ENABLED");
  if (env.VERIFACTU_AEAT_TEST_CYCLE_CONFIRM !== "AEAT_TEST_ONLY") throw new Error("VERIFACTU_AEAT_TEST_CYCLE_CONFIRMATION_REQUIRED");
  if (env.APP_ENV !== "test") throw new Error("VERIFACTU_AEAT_TEST_CYCLE_APP_ENV_INVALID");
  if (env.VERIFACTU_ENABLED !== "true" || env.VERIFACTU_ENVIRONMENT?.trim().toUpperCase() !== "TEST"
    || env.VERIFACTU_WORKER_ENVIRONMENT?.trim().toUpperCase() !== "TEST") {
    throw new Error("VERIFACTU_AEAT_TEST_CYCLE_ENVIRONMENT_INVALID");
  }
  const invoiceId = readUuid(env.VERIFACTU_AEAT_TEST_CYCLE_INVOICE_ID, "INVOICE_ID");
  const expectedCompanyId = readUuid(env.VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_COMPANY_ID, "EXPECTED_COMPANY_ID");
  const expectedSifInstallationId = readUuid(env.VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_SIF_INSTALLATION_ID, "EXPECTED_SIF_INSTALLATION_ID");
  const expectedCancellationId = readUuid(env.VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_CANCELLATION_ID, "EXPECTED_CANCELLATION_ID");
  const expectedInvoiceNumber = env.VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_INVOICE_NUMBER?.trim() ?? "";
  if (!expectedInvoiceNumber || expectedInvoiceNumber.length > 60 || /[\u0000-\u001F\u007F]/.test(expectedInvoiceNumber)) {
    throw new Error("VERIFACTU_AEAT_TEST_CYCLE_INVOICE_NUMBER_INVALID");
  }
  const expectedDatabase = env.VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_DATABASE?.trim() ?? "";
  if (!testDatabaseNamePattern.test(expectedDatabase)) throw new Error("VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_DATABASE_INVALID");
  return { invoiceId, expectedInvoiceNumber, expectedDatabase, expectedCompanyId, expectedSifInstallationId,
    expectedCancellationId, operatorId: readOperationalId(env.VERIFACTU_AEAT_TEST_CYCLE_OPERATOR_ID, "OPERATOR_ID"),
    releaseId: readOperationalId(env.VERIFACTU_AEAT_TEST_CYCLE_RELEASE_ID, "RELEASE_ID") };
}

export { isCleanAcceptedAttempt };

export function stableCycleErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "VERIFACTU_AEAT_TEST_CYCLE_FAILED";
  return /^VERIFACTU_AEAT_TEST_CYCLE_[A-Z0-9_]{2,90}$/.test(error.message)
    ? error.message : "VERIFACTU_AEAT_TEST_CYCLE_FAILED";
}

function readUuid(raw: string | undefined, name: string): string {
  const value = raw?.trim() ?? "";
  if (!uuidPattern.test(value)) throw new Error(`VERIFACTU_AEAT_TEST_CYCLE_${name}_INVALID`);
  return value;
}

function readOperationalId(raw: string | undefined, name: string): string {
  const value = raw?.trim() ?? "";
  if (!operationalIdPattern.test(value)) throw new Error(`VERIFACTU_AEAT_TEST_CYCLE_${name}_INVALID`);
  return value;
}

if (process.env.NODE_ENV !== "test") {
  main().catch((error: unknown) => {
    process.stderr.write(`${stableCycleErrorCode(error)}\n`);
    process.exitCode = 1;
  }).finally(async () => prisma.$disconnect());
}
