BEGIN;

ALTER TABLE "verifactu_sif_installations"
  DROP CONSTRAINT "verifactu_sif_installations_head_check";
ALTER TABLE "verifactu_sif_installations"
  ADD CONSTRAINT "verifactu_sif_installations_head_check" CHECK (
    ("nextPosition" = 1 AND "lastRecordId" IS NULL AND "lastRecordHash" IS NULL)
    OR ("nextPosition" > 1 AND "lastRecordId" IS NOT NULL AND "lastRecordHash" ~ '^[0-9A-Fa-f]{64}$')
  );

ALTER TABLE "verifactu_fiscal_records"
  DROP CONSTRAINT "verifactu_fiscal_records_chain_check";
ALTER TABLE "verifactu_fiscal_records"
  ADD CONSTRAINT "verifactu_fiscal_records_chain_check" CHECK (
    ("chainPosition" = 1 AND "previousRecordId" IS NULL AND "previousHash" IS NULL)
    OR ("chainPosition" > 1 AND "previousRecordId" IS NOT NULL AND "previousHash" ~ '^[0-9A-Fa-f]{64}$')
  );

ALTER TABLE "verifactu_fiscal_records"
  DROP CONSTRAINT "verifactu_fiscal_records_hashes_check";
ALTER TABLE "verifactu_fiscal_records"
  ADD CONSTRAINT "verifactu_fiscal_records_hashes_check" CHECK (
    "hashAlgorithm" = 'SHA-256'
    AND "recordHash" ~ '^[0-9A-Fa-f]{64}$'
    AND "payloadSha256" ~ '^[0-9a-f]{64}$'
  );

COMMIT;
