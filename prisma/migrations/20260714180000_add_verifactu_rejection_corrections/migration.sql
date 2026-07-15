BEGIN;

ALTER TABLE "verifactu_fiscal_records"
  ADD COLUMN "correctedRecordId" UUID;

DROP INDEX IF EXISTS "verifactu_fiscal_records_one_alta_per_invoice_key";
DROP INDEX IF EXISTS "verifactu_fiscal_records_one_alta_per_installation_invoice";

CREATE UNIQUE INDEX "verifactu_fiscal_records_correctedRecordId_sifInstallationId_invoiceId_key"
  ON "verifactu_fiscal_records"("correctedRecordId", "sifInstallationId", "invoiceId");

CREATE UNIQUE INDEX "verifactu_fiscal_records_one_original_alta_per_invoice_key"
  ON "verifactu_fiscal_records"("sifInstallationId", "invoiceId")
  WHERE "recordType" = 'ALTA' AND "correctedRecordId" IS NULL;

ALTER TABLE "verifactu_fiscal_records"
  ADD CONSTRAINT "verifactu_fiscal_records_correction_shape_check"
  CHECK ("correctedRecordId" IS NULL OR "recordType" = 'ALTA');

ALTER TABLE "verifactu_fiscal_records"
  ADD CONSTRAINT "verifactu_fiscal_records_corrected_target_fkey"
  FOREIGN KEY ("correctedRecordId", "sifInstallationId", "invoiceId")
  REFERENCES "verifactu_fiscal_records"("id", "sifInstallationId", "invoiceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION validate_verifactu_correction_target()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  latest_outcome public."VerifactuAttemptOutcome";
  target_record public."verifactu_fiscal_records"%ROWTYPE;
BEGIN
  IF NEW."correctedRecordId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT target.*
    INTO target_record
  FROM public."verifactu_fiscal_records" target
  WHERE target."id" = NEW."correctedRecordId"
    AND target."sifInstallationId" = NEW."sifInstallationId"
    AND target."invoiceId" = NEW."invoiceId";

  SELECT attempt."outcome"
    INTO latest_outcome
  FROM public."verifactu_submission_attempts" attempt
  WHERE attempt."fiscalRecordId" = NEW."correctedRecordId"
  ORDER BY attempt."attemptNumber" DESC
  LIMIT 1;

  IF target_record."id" IS NULL
    OR target_record."recordType" IS DISTINCT FROM 'ALTA'
    OR target_record."correctedRecordId" IS NOT NULL
    OR NEW."companyId" IS DISTINCT FROM target_record."companyId"
    OR NEW."issuerTaxId" IS DISTINCT FROM target_record."issuerTaxId"
    OR NEW."issuerName" IS DISTINCT FROM target_record."issuerName"
    OR NEW."invoiceSeries" IS DISTINCT FROM target_record."invoiceSeries"
    OR NEW."invoiceNumber" IS DISTINCT FROM target_record."invoiceNumber"
    OR NEW."invoiceIssueDate" IS DISTINCT FROM target_record."invoiceIssueDate"
    OR latest_outcome IS DISTINCT FROM 'REJECTED'
    OR NOT EXISTS (
      SELECT 1
      FROM public."verifactu_outbox_messages" message
      WHERE message."fiscalRecordId" = NEW."correctedRecordId"
        AND message."operation" = 'SUBMIT'
        AND message."status" = 'PROCESSED'
    ) THEN
    RAISE EXCEPTION 'Invalid rejected VeriFactu correction target' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER verifactu_fiscal_records_correction_target_trigger
BEFORE INSERT ON "verifactu_fiscal_records"
FOR EACH ROW EXECUTE FUNCTION validate_verifactu_correction_target();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Billing.CreateVerifactuRejectionCorrection', 'Subsanar rechazos VeriFactu', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'Billing.CreateVerifactuRejectionCorrection'
WHERE role."code" = 'Administrador'
ON CONFLICT DO NOTHING;

COMMIT;
