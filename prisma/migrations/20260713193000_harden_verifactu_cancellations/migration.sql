BEGIN;

ALTER TYPE "InvoiceVerifactuStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

CREATE INDEX "verifactu_submission_attempts_accepted_record_idx"
  ON "verifactu_submission_attempts"("fiscalRecordId")
  WHERE "outcome" IN ('ACCEPTED', 'ACCEPTED_WITH_ERRORS');

CREATE FUNCTION validate_verifactu_cancellation_target()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  target public."verifactu_fiscal_records"%ROWTYPE;
BEGIN
  IF NEW."recordType" <> 'ANULACION' THEN
    RETURN NEW;
  END IF;

  SELECT record.* INTO target
  FROM public."verifactu_fiscal_records" record
  WHERE record."id" = NEW."cancelledRecordId"
    AND record."sifInstallationId" = NEW."sifInstallationId"
    AND record."invoiceId" = NEW."invoiceId";

  IF target."id" IS NULL
    OR target."recordType" <> 'ALTA'
    OR NEW."companyId" IS DISTINCT FROM target."companyId"
    OR NEW."issuerTaxId" IS DISTINCT FROM target."issuerTaxId"
    OR NEW."issuerName" IS DISTINCT FROM target."issuerName"
    OR NEW."invoiceSeries" IS DISTINCT FROM target."invoiceSeries"
    OR NEW."invoiceNumber" IS DISTINCT FROM target."invoiceNumber"
    OR NEW."invoiceIssueDate" IS DISTINCT FROM target."invoiceIssueDate"
    OR NOT EXISTS (
      SELECT 1
      FROM public."verifactu_submission_attempts" attempt
      WHERE attempt."fiscalRecordId" = target."id"
        AND attempt."outcome" IN ('ACCEPTED', 'ACCEPTED_WITH_ERRORS')
    ) THEN
    RAISE EXCEPTION 'Invalid VeriFactu cancellation target' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER verifactu_fiscal_records_cancellation_target_trigger
BEFORE INSERT ON "verifactu_fiscal_records"
FOR EACH ROW EXECUTE FUNCTION validate_verifactu_cancellation_target();

COMMIT;
