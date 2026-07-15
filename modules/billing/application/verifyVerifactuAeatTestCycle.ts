import "server-only";

import type { VerifactuTransport, VerifactuTransportResult } from "@/modules/billing/application/verifactuOutboxWorker";

export type AeatTestCycleConfig = {
  invoiceId: string;
  expectedInvoiceNumber: string;
  expectedDatabase: string;
  expectedCompanyId: string;
  expectedSifInstallationId: string;
  expectedCancellationId: string;
  operatorId: string;
  releaseId: string;
};

type AttemptEvidence = { outcome: string; stableErrorCode: string | null; aeatCodes: unknown };
type RecordEvidence = {
  id: string; recordType: "ALTA" | "ANULACION"; chainPosition: bigint; previousRecordId: string | null;
  cancelledRecordId: string | null; companyId: string; sifInstallationId: string; invoiceId: string;
  preparationKey: string; issuerName: string; issuerTaxId: string; invoiceNumber: string; invoiceIssueDate: Date;
  outboxStatuses: string[]; latestAttempt?: AttemptEvidence;
};

export type AeatTestCycleEvidence = {
  invoiceId: string; invoiceNumber: string | null; verifactuStatus: string;
  installation: { companyId: string; environment: string; status: string; credentialRef: string | null };
  records: RecordEvidence[];
};

export type AeatTestCycleAuditIdentity = Record<string, string>;
export type AeatTestCycleRepository = {
  assertExpectedDatabase(expected: string): Promise<void>;
  loadEvidence(invoiceId: string): Promise<AeatTestCycleEvidence | null>;
  createAudit(eventType: string, identity: AeatTestCycleAuditIdentity, extra?: Record<string, string | null>): Promise<void>;
  persistResult(input: {
    cancellationId: string; requestId: string; startedAt: Date; completedAt: Date;
    result: VerifactuTransportResult; cleanQuery: boolean; identity: AeatTestCycleAuditIdentity;
  }): Promise<void>;
};

export async function verifyVerifactuAeatTestCycle(
  config: AeatTestCycleConfig,
  dependencies: {
    repository: AeatTestCycleRepository;
    transport: VerifactuTransport;
    newRequestId: () => string;
    now: () => Date;
    runnerHost: string;
    applicationVersion: string;
  }
): Promise<{ requestId: string }> {
  const { repository } = dependencies;
  await repository.assertExpectedDatabase(config.expectedDatabase);
  const evidence = await repository.loadEvidence(config.invoiceId);
  if (!evidence || evidence.invoiceNumber !== config.expectedInvoiceNumber) fail("INVOICE_MISMATCH");
  const alta = evidence.records.find((record) => record.recordType === "ALTA");
  const cancellation = evidence.records.find((record) => record.recordType === "ANULACION");
  if (!alta || !cancellation || evidence.records.length !== 2) fail("RECORDS_INVALID");
  if (
    cancellation.id !== config.expectedCancellationId || cancellation.companyId !== config.expectedCompanyId
    || cancellation.sifInstallationId !== config.expectedSifInstallationId || cancellation.cancelledRecordId !== alta.id
    || cancellation.previousRecordId === null || cancellation.chainPosition <= alta.chainPosition
    || alta.companyId !== cancellation.companyId || alta.sifInstallationId !== cancellation.sifInstallationId
    || alta.invoiceId !== cancellation.invoiceId || alta.issuerName !== cancellation.issuerName
    || alta.issuerTaxId !== cancellation.issuerTaxId || alta.invoiceNumber !== cancellation.invoiceNumber
    || alta.invoiceNumber !== evidence.invoiceNumber || alta.invoiceNumber !== config.expectedInvoiceNumber
    || alta.invoiceIssueDate.getTime() !== cancellation.invoiceIssueDate.getTime()
  ) fail("LINK_INVALID");
  if (
    !isCleanAcceptedAttempt(alta.latestAttempt) || !isCleanAcceptedAttempt(cancellation.latestAttempt)
    || alta.outboxStatuses.length !== 1 || cancellation.outboxStatuses.length !== 1
    || alta.outboxStatuses[0] !== "PROCESSED" || cancellation.outboxStatuses[0] !== "PROCESSED"
    || evidence.verifactuStatus !== "CANCELLED"
  ) fail("NOT_TERMINAL");
  const installation = evidence.installation;
  if (installation.environment !== "TEST" || installation.status !== "ACTIVE" || !installation.credentialRef
    || installation.companyId !== config.expectedCompanyId) fail("INSTALLATION_INVALID");

  const requestId = dependencies.newRequestId();
  const identity = {
    invoiceId: evidence.invoiceId, altaRecordId: alta.id, cancellationRecordId: cancellation.id,
    companyId: config.expectedCompanyId, sifInstallationId: config.expectedSifInstallationId,
    claimedOperatorId: config.operatorId, runnerHost: dependencies.runnerHost, releaseId: config.releaseId,
    applicationVersion: dependencies.applicationVersion, requestId
  };
  await repository.createAudit("VERIFACTU_AEAT_TEST_CYCLE_STARTED", identity);
  const startedAt = dependencies.now();
  let result: VerifactuTransportResult;
  try {
    result = await dependencies.transport.reconcile({
      credentialRef: installation.credentialRef, environment: "TEST", requestId,
      fiscalKey: { issuerName: cancellation.issuerName, issuerTaxId: cancellation.issuerTaxId,
        invoiceNumber: cancellation.invoiceNumber, issueDate: formatAeatDate(cancellation.invoiceIssueDate) },
      context: { companyId: cancellation.companyId, sifInstallationId: cancellation.sifInstallationId,
        invoiceId: cancellation.invoiceId, preparationKey: cancellation.preparationKey, recordType: "ANULACION" },
      externalSubmissionId: null
    });
  } catch {
    await repository.createAudit("VERIFACTU_AEAT_TEST_CYCLE_FAILED", identity,
      { stableCode: "VERIFACTU_AEAT_TEST_CYCLE_TRANSPORT_FAILED" }).catch(() => undefined);
    fail("TRANSPORT_FAILED");
  }
  const cleanQuery = result.outcome === "ACCEPTED" && result.stableCode === null && isEmptyAeatCodes(result.aeatCodes)
    && Boolean(result.response?.sha256 && result.response.ciphertext.length > 0)
    && Boolean(result.credentialVersionId && result.endpointKind && result.requestSha256);
  try {
    await repository.persistResult({ cancellationId: cancellation.id, requestId, startedAt,
      completedAt: dependencies.now(), result, cleanQuery, identity });
  } catch {
    await repository.createAudit("VERIFACTU_AEAT_TEST_CYCLE_FAILED", identity,
      { stableCode: "VERIFACTU_AEAT_TEST_CYCLE_PERSISTENCE_FAILED" }).catch(() => undefined);
    fail("PERSISTENCE_FAILED");
  }
  if (!cleanQuery) fail("QUERY_NOT_ANULADO");
  return { requestId };
}

export function isCleanAcceptedAttempt(attempt: AttemptEvidence | undefined): boolean {
  return attempt?.outcome === "ACCEPTED" && attempt.stableErrorCode === null && isEmptyAeatCodes(attempt.aeatCodes);
}

function isEmptyAeatCodes(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function formatAeatDate(value: Date): string {
  return `${String(value.getUTCDate()).padStart(2, "0")}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${value.getUTCFullYear()}`;
}

function fail(suffix: string): never {
  throw new Error(`VERIFACTU_AEAT_TEST_CYCLE_${suffix}`);
}
