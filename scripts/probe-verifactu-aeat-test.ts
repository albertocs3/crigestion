import { prisma } from "../lib/prisma";
import { readConfiguredAeatVerifactuTransport } from "../modules/billing/infrastructure/verifactu/configuredTransport";

async function main(): Promise<void> {
  if (process.env.VERIFACTU_AEAT_PROBE_ENABLED !== "true") throw new Error("VERIFACTU_AEAT_PROBE_NOT_ENABLED");
  const fiscalRecordId = process.env.VERIFACTU_AEAT_PROBE_RECORD_ID;
  if (!fiscalRecordId) throw new Error("VERIFACTU_AEAT_PROBE_RECORD_ID_REQUIRED");
  const record = await prisma.verifactuFiscalRecord.findUnique({
    where: { id: fiscalRecordId },
    select: {
      id: true, companyId: true, sifInstallationId: true, invoiceId: true, preparationKey: true, recordType: true,
      issuerName: true, issuerTaxId: true, invoiceNumber: true, invoiceIssueDate: true,
      sifInstallation: { select: { companyId: true, environment: true, status: true, credentialRef: true } }
    }
  });
  if (!record?.sifInstallation.credentialRef || record.sifInstallation.environment !== "TEST" || record.sifInstallation.status !== "ACTIVE") {
    throw new Error("VERIFACTU_AEAT_PROBE_FIXTURE_UNAVAILABLE");
  }
  if (record.companyId !== record.sifInstallation.companyId) throw new Error("VERIFACTU_AEAT_PROBE_COMPANY_MISMATCH");
  const requestId = `vf-probe:${record.id}:${Date.now()}`;
  await prisma.auditEvent.create({ data: { eventType: "VERIFACTU_AEAT_TEST_PROBE_STARTED", actorType: "SYSTEM", payload: { fiscalRecordId: record.id, sifInstallationId: record.sifInstallationId, requestId } } });
  const result = await readConfiguredAeatVerifactuTransport().reconcile({
    credentialRef: record.sifInstallation.credentialRef,
    environment: "TEST",
    requestId,
    fiscalKey: {
      issuerName: record.issuerName,
      issuerTaxId: record.issuerTaxId,
      invoiceNumber: record.invoiceNumber,
      issueDate: formatAeatDate(record.invoiceIssueDate)
    },
    context: { companyId: record.companyId, sifInstallationId: record.sifInstallationId, invoiceId: record.invoiceId, preparationKey: record.preparationKey, recordType: record.recordType },
    externalSubmissionId: null
  });
  await prisma.auditEvent.create({ data: { eventType: "VERIFACTU_AEAT_TEST_PROBE_COMPLETED", actorType: "SYSTEM", payload: { fiscalRecordId: record.id, sifInstallationId: record.sifInstallationId, requestId, outcome: result.outcome, stableCode: result.stableCode, ...(result.credentialVersionId ? { mtlsVersionId: result.credentialVersionId } : {}) } } });
  process.stdout.write(`AEAT TEST probe: ${result.outcome}${result.stableCode ? ` (${result.stableCode})` : ""}\n`);
}

function formatAeatDate(value: Date): string {
  return `${String(value.getUTCDate()).padStart(2, "0")}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${value.getUTCFullYear()}`;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "VERIFACTU_AEAT_PROBE_FAILED"}\n`);
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
