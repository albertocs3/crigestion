BEGIN;

CREATE TYPE "VerifactuEnvironment" AS ENUM ('TEST', 'PRODUCTION');
CREATE TYPE "VerifactuSifStatus" AS ENUM ('ACTIVE', 'RETIRED');
CREATE TYPE "VerifactuRecordType" AS ENUM ('ALTA', 'ANULACION');
CREATE TYPE "VerifactuAttemptKind" AS ENUM ('SUBMIT', 'RECONCILE');
CREATE TYPE "VerifactuAttemptOutcome" AS ENUM ('ACCEPTED', 'ACCEPTED_WITH_ERRORS', 'REJECTED', 'RETRYABLE_FAILURE', 'UNKNOWN');
CREATE TYPE "VerifactuOutboxStatus" AS ENUM ('PENDING', 'CLAIMED', 'PROCESSED', 'DEAD');

ALTER TABLE "invoices" ADD COLUMN "companyId" UUID;

UPDATE "invoices" invoice
SET "companyId" = installation."companyId"
FROM "installations" installation
WHERE installation."status" = 'INITIALIZED'
  AND installation."companyId" IS NOT NULL
  AND invoice."companyId" IS NULL;

CREATE UNIQUE INDEX "invoices_id_companyId_key" ON "invoices"("id", "companyId");
CREATE INDEX "invoices_companyId_issueDate_id_idx" ON "invoices"("companyId", "issueDate", "id");
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "verifactu_sif_installations" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "installationCode" VARCHAR(80) NOT NULL,
  "environment" "VerifactuEnvironment" NOT NULL,
  "status" "VerifactuSifStatus" NOT NULL DEFAULT 'ACTIVE',
  "contractVersion" VARCHAR(32) NOT NULL,
  "schemaVersion" VARCHAR(32) NOT NULL,
  "artifactManifestVersion" VARCHAR(80) NOT NULL,
  "artifactManifestSha256" CHAR(64) NOT NULL,
  "producerTaxId" VARCHAR(32) NOT NULL,
  "producerName" VARCHAR(200) NOT NULL,
  "systemName" VARCHAR(120) NOT NULL,
  "systemId" VARCHAR(40) NOT NULL,
  "systemVersion" VARCHAR(40) NOT NULL,
  "installationNumber" VARCHAR(100) NOT NULL,
  "credentialRef" VARCHAR(200),
  "nextPosition" BIGINT NOT NULL DEFAULT 1,
  "lastRecordId" UUID,
  "lastRecordHash" CHAR(64),
  "activatedAt" TIMESTAMPTZ(3) NOT NULL,
  "retiredAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "verifactu_sif_installations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "verifactu_sif_installations_lifecycle_check" CHECK (
    ("status" = 'ACTIVE' AND "retiredAt" IS NULL)
    OR ("status" = 'RETIRED' AND "retiredAt" IS NOT NULL)
  ),
  CONSTRAINT "verifactu_sif_installations_head_check" CHECK (
    ("nextPosition" = 1 AND "lastRecordId" IS NULL AND "lastRecordHash" IS NULL)
    OR ("nextPosition" > 1 AND "lastRecordId" IS NOT NULL AND "lastRecordHash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "verifactu_sif_installations_manifest_hash_check" CHECK ("artifactManifestSha256" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "verifactu_sif_installations_companyId_installationCode_envi_key"
  ON "verifactu_sif_installations"("companyId", "installationCode", "environment");
CREATE UNIQUE INDEX "verifactu_sif_installations_id_companyId_key"
  ON "verifactu_sif_installations"("id", "companyId");
CREATE UNIQUE INDEX "verifactu_sif_installations_one_active_per_environment_key"
  ON "verifactu_sif_installations"("companyId", "environment") WHERE "status" = 'ACTIVE';
CREATE INDEX "verifactu_sif_installations_companyId_environment_status_idx"
  ON "verifactu_sif_installations"("companyId", "environment", "status");
ALTER TABLE "verifactu_sif_installations" ADD CONSTRAINT "verifactu_sif_installations_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "verifactu_fiscal_records" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "sifInstallationId" UUID NOT NULL,
  "invoiceId" UUID NOT NULL,
  "recordType" "VerifactuRecordType" NOT NULL,
  "chainPosition" BIGINT NOT NULL,
  "previousRecordId" UUID,
  "cancelledRecordId" UUID,
  "issuerTaxId" VARCHAR(32) NOT NULL,
  "invoiceSeries" VARCHAR(8) NOT NULL,
  "invoiceNumber" VARCHAR(20) NOT NULL,
  "invoiceIssueDate" DATE NOT NULL,
  "generatedAt" TIMESTAMPTZ(3) NOT NULL,
  "contractVersion" VARCHAR(32) NOT NULL,
  "schemaVersion" VARCHAR(32) NOT NULL,
  "canonicalizationVersion" VARCHAR(32) NOT NULL,
  "hashAlgorithm" VARCHAR(20) NOT NULL DEFAULT 'SHA-256',
  "previousHash" CHAR(64),
  "recordHash" CHAR(64) NOT NULL,
  "fiscalSnapshot" JSONB NOT NULL,
  "payloadCiphertext" BYTEA NOT NULL,
  "encryptionKeyId" VARCHAR(120) NOT NULL,
  "payloadSha256" CHAR(64) NOT NULL,
  "qrUrl" TEXT,
  "preparationKey" VARCHAR(160) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "verifactu_fiscal_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "verifactu_fiscal_records_chain_check" CHECK (
    ("chainPosition" = 1 AND "previousRecordId" IS NULL AND "previousHash" IS NULL)
    OR ("chainPosition" > 1 AND "previousRecordId" IS NOT NULL AND "previousHash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "verifactu_fiscal_records_type_check" CHECK (
    ("recordType" = 'ALTA' AND "cancelledRecordId" IS NULL)
    OR ("recordType" = 'ANULACION' AND "cancelledRecordId" IS NOT NULL)
  ),
  CONSTRAINT "verifactu_fiscal_records_hashes_check" CHECK (
    "hashAlgorithm" = 'SHA-256'
    AND "recordHash" ~ '^[0-9a-f]{64}$'
    AND "payloadSha256" ~ '^[0-9a-f]{64}$'
  )
);

CREATE UNIQUE INDEX "verifactu_fiscal_records_previousRecordId_sifInstallationId_key" ON "verifactu_fiscal_records"("previousRecordId", "sifInstallationId");
CREATE UNIQUE INDEX "verifactu_fiscal_records_cancelledRecordId_sifInstallationId_invoiceId_key" ON "verifactu_fiscal_records"("cancelledRecordId", "sifInstallationId", "invoiceId");
CREATE UNIQUE INDEX "verifactu_fiscal_records_preparationKey_key" ON "verifactu_fiscal_records"("preparationKey");
CREATE UNIQUE INDEX "verifactu_fiscal_records_sifInstallationId_chainPosition_key" ON "verifactu_fiscal_records"("sifInstallationId", "chainPosition");
CREATE UNIQUE INDEX "verifactu_fiscal_records_sifInstallationId_recordHash_key" ON "verifactu_fiscal_records"("sifInstallationId", "recordHash");
CREATE UNIQUE INDEX "verifactu_fiscal_records_id_sifInstallationId_key" ON "verifactu_fiscal_records"("id", "sifInstallationId");
CREATE UNIQUE INDEX "verifactu_fiscal_records_id_sifInstallationId_invoiceId_key" ON "verifactu_fiscal_records"("id", "sifInstallationId", "invoiceId");
CREATE INDEX "verifactu_fiscal_records_companyId_invoiceIssueDate_id_idx" ON "verifactu_fiscal_records"("companyId", "invoiceIssueDate", "id");
CREATE INDEX "verifactu_fiscal_records_invoiceId_createdAt_id_idx" ON "verifactu_fiscal_records"("invoiceId", "createdAt", "id");

ALTER TABLE "verifactu_fiscal_records" ADD CONSTRAINT "verifactu_fiscal_records_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verifactu_fiscal_records" ADD CONSTRAINT "verifactu_fiscal_records_installation_company_fkey"
  FOREIGN KEY ("sifInstallationId", "companyId") REFERENCES "verifactu_sif_installations"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verifactu_fiscal_records" ADD CONSTRAINT "verifactu_fiscal_records_invoice_company_fkey"
  FOREIGN KEY ("invoiceId", "companyId") REFERENCES "invoices"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verifactu_fiscal_records" ADD CONSTRAINT "verifactu_fiscal_records_previous_chain_fkey"
  FOREIGN KEY ("previousRecordId", "sifInstallationId") REFERENCES "verifactu_fiscal_records"("id", "sifInstallationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verifactu_fiscal_records" ADD CONSTRAINT "verifactu_fiscal_records_cancelled_target_fkey"
  FOREIGN KEY ("cancelledRecordId", "sifInstallationId", "invoiceId") REFERENCES "verifactu_fiscal_records"("id", "sifInstallationId", "invoiceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verifactu_sif_installations" ADD CONSTRAINT "verifactu_sif_installations_last_record_fkey"
  FOREIGN KEY ("lastRecordId", "id") REFERENCES "verifactu_fiscal_records"("id", "sifInstallationId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "verifactu_submission_attempts" (
  "id" UUID NOT NULL,
  "fiscalRecordId" UUID NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "kind" "VerifactuAttemptKind" NOT NULL,
  "idempotencyKey" VARCHAR(160) NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3) NOT NULL,
  "outcome" "VerifactuAttemptOutcome" NOT NULL,
  "requestCiphertext" BYTEA,
  "responseCiphertext" BYTEA,
  "encryptionKeyId" VARCHAR(120),
  "requestSha256" CHAR(64) NOT NULL,
  "responseSha256" CHAR(64),
  "externalSubmissionId" VARCHAR(160),
  "aeatCsv" VARCHAR(160),
  "aeatCodes" JSONB,
  "stableErrorCode" VARCHAR(120),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "verifactu_submission_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "verifactu_submission_attempts_times_check" CHECK ("completedAt" >= "startedAt"),
  CONSTRAINT "verifactu_submission_attempts_number_check" CHECK ("attemptNumber" > 0),
  CONSTRAINT "verifactu_submission_attempts_hashes_check" CHECK (
    "requestSha256" ~ '^[0-9a-f]{64}$'
    AND ("responseSha256" IS NULL OR "responseSha256" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "verifactu_submission_attempts_encryption_check" CHECK (
    ("requestCiphertext" IS NULL AND "responseCiphertext" IS NULL)
    OR "encryptionKeyId" IS NOT NULL
  )
);

CREATE UNIQUE INDEX "verifactu_submission_attempts_idempotencyKey_key" ON "verifactu_submission_attempts"("idempotencyKey");
CREATE UNIQUE INDEX "verifactu_submission_attempts_fiscalRecordId_attemptNumber_key" ON "verifactu_submission_attempts"("fiscalRecordId", "attemptNumber");
CREATE INDEX "verifactu_submission_attempts_fiscalRecordId_createdAt_id_idx" ON "verifactu_submission_attempts"("fiscalRecordId", "createdAt", "id");
CREATE INDEX "verifactu_submission_attempts_outcome_createdAt_id_idx" ON "verifactu_submission_attempts"("outcome", "createdAt", "id");
ALTER TABLE "verifactu_submission_attempts" ADD CONSTRAINT "verifactu_submission_attempts_fiscalRecordId_fkey"
  FOREIGN KEY ("fiscalRecordId") REFERENCES "verifactu_fiscal_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "verifactu_outbox_messages" (
  "id" UUID NOT NULL,
  "fiscalRecordId" UUID NOT NULL,
  "operation" "VerifactuAttemptKind" NOT NULL,
  "idempotencyKey" VARCHAR(160) NOT NULL,
  "bodySha256" CHAR(64) NOT NULL,
  "status" "VerifactuOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 20,
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" VARCHAR(160),
  "leaseToken" UUID,
  "leaseUntil" TIMESTAMPTZ(3),
  "lastErrorCode" VARCHAR(120),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "processedAt" TIMESTAMPTZ(3),
  CONSTRAINT "verifactu_outbox_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "verifactu_outbox_messages_attempts_check" CHECK ("attemptCount" >= 0 AND "maxAttempts" > 0 AND "attemptCount" <= "maxAttempts"),
  CONSTRAINT "verifactu_outbox_messages_hash_check" CHECK ("bodySha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "verifactu_outbox_messages_state_check" CHECK (
    ("status" = 'PENDING' AND "leaseOwner" IS NULL AND "leaseToken" IS NULL AND "leaseUntil" IS NULL AND "processedAt" IS NULL)
    OR ("status" = 'CLAIMED' AND "leaseOwner" IS NOT NULL AND "leaseToken" IS NOT NULL AND "leaseUntil" IS NOT NULL AND "processedAt" IS NULL)
    OR ("status" = 'PROCESSED' AND "leaseOwner" IS NULL AND "leaseToken" IS NULL AND "leaseUntil" IS NULL AND "processedAt" IS NOT NULL)
    OR ("status" = 'DEAD' AND "leaseOwner" IS NULL AND "leaseToken" IS NULL AND "leaseUntil" IS NULL AND "processedAt" IS NULL)
  )
);

CREATE UNIQUE INDEX "verifactu_outbox_messages_idempotencyKey_key" ON "verifactu_outbox_messages"("idempotencyKey");
CREATE UNIQUE INDEX "verifactu_outbox_messages_fiscalRecordId_operation_key" ON "verifactu_outbox_messages"("fiscalRecordId", "operation");
CREATE INDEX "verifactu_outbox_messages_status_nextAttemptAt_createdAt_id_idx" ON "verifactu_outbox_messages"("status", "nextAttemptAt", "createdAt", "id");
CREATE INDEX "verifactu_outbox_messages_leaseUntil_status_idx" ON "verifactu_outbox_messages"("leaseUntil", "status");
ALTER TABLE "verifactu_outbox_messages" ADD CONSTRAINT "verifactu_outbox_messages_fiscalRecordId_fkey"
  FOREIGN KEY ("fiscalRecordId") REFERENCES "verifactu_fiscal_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_verifactu_append_only_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'VeriFactu append-only records cannot be updated or deleted';
END $$;

CREATE TRIGGER verifactu_fiscal_records_append_only_trigger
BEFORE UPDATE OR DELETE ON "verifactu_fiscal_records"
FOR EACH ROW EXECUTE FUNCTION reject_verifactu_append_only_change();

CREATE TRIGGER verifactu_submission_attempts_append_only_trigger
BEFORE UPDATE OR DELETE ON "verifactu_submission_attempts"
FOR EACH ROW EXECUTE FUNCTION reject_verifactu_append_only_change();

COMMIT;
