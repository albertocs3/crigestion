BEGIN;

CREATE UNIQUE INDEX "verifactu_fiscal_records_one_alta_per_invoice_key"
  ON "verifactu_fiscal_records"("sifInstallationId", "invoiceId")
  WHERE "recordType" = 'ALTA';

CREATE FUNCTION validate_verifactu_chain_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  previous_position BIGINT;
  previous_record_hash CHAR(64);
BEGIN
  IF NEW."chainPosition" = 1 THEN
    RETURN NEW;
  END IF;

  SELECT record."chainPosition", record."recordHash"
    INTO previous_position, previous_record_hash
  FROM public."verifactu_fiscal_records" record
  WHERE record."id" = NEW."previousRecordId"
    AND record."sifInstallationId" = NEW."sifInstallationId";

  IF previous_position IS NULL
    OR NEW."chainPosition" <> previous_position + 1
    OR NEW."previousHash" <> previous_record_hash THEN
    RAISE EXCEPTION 'Invalid VeriFactu chain link' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER verifactu_fiscal_records_chain_link_trigger
BEFORE INSERT ON "verifactu_fiscal_records"
FOR EACH ROW EXECUTE FUNCTION validate_verifactu_chain_link();

COMMIT;
