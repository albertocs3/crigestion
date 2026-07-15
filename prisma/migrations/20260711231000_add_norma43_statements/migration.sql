BEGIN;

CREATE TYPE "BankStatementFormat" AS ENUM ('AEB43_2012');

CREATE TABLE "bank_statements" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "bankAccountId" UUID NOT NULL,
  "format" "BankStatementFormat" NOT NULL DEFAULT 'AEB43_2012',
  "dateFrom" DATE NOT NULL,
  "dateTo" DATE NOT NULL,
  "openingBalance" DECIMAL(14,2) NOT NULL,
  "closingBalance" DECIMAL(14,2) NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
  "rawSha256" CHAR(64) NOT NULL,
  "recordCount" INTEGER NOT NULL,
  "movementCount" INTEGER NOT NULL,
  "importedById" UUID NOT NULL,
  "importedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bank_statements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bank_statements_date_range_check" CHECK ("dateFrom" <= "dateTo"),
  CONSTRAINT "bank_statements_currency_check" CHECK ("currency" = 'EUR'),
  CONSTRAINT "bank_statements_counts_check" CHECK ("recordCount" >= 4 AND "movementCount" > 0)
);

ALTER TABLE "bank_movements" ADD COLUMN "bankStatementId" UUID;
ALTER TABLE "bank_movements" ADD COLUMN "statementOrdinal" INTEGER;
ALTER TABLE "bank_movements" ADD COLUMN "statementDocumentNumber" VARCHAR(10);
ALTER TABLE "bank_movements" ADD CONSTRAINT "bank_movements_statement_fields_check" CHECK (
  ("source" = 'MANUAL' AND "bankStatementId" IS NULL AND "statementOrdinal" IS NULL)
  OR ("source" = 'NORMA43' AND "bankStatementId" IS NOT NULL AND "statementOrdinal" > 0)
);

CREATE UNIQUE INDEX "bank_statements_companyId_rawSha256_key" ON "bank_statements"("companyId", "rawSha256");
CREATE INDEX "bank_statements_bankAccountId_dateFrom_dateTo_id_idx" ON "bank_statements"("bankAccountId", "dateFrom", "dateTo", "id");
CREATE INDEX "bank_statements_importedById_importedAt_idx" ON "bank_statements"("importedById", "importedAt");
CREATE UNIQUE INDEX "bank_movements_bankStatementId_statementOrdinal_key" ON "bank_movements"("bankStatementId", "statementOrdinal");

ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_importedById_fkey" FOREIGN KEY ("importedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION validate_bank_statement_ownership()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "bank_accounts" a WHERE a."id" = NEW."bankAccountId" AND a."companyId" = NEW."companyId") THEN
    RAISE EXCEPTION 'Bank statement account must belong to its company';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_statements_ownership_trigger BEFORE INSERT OR UPDATE OF "companyId", "bankAccountId" ON "bank_statements" FOR EACH ROW EXECUTE FUNCTION validate_bank_statement_ownership();

CREATE FUNCTION validate_bank_movement_statement_account()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."bankStatementId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "bank_statements" s WHERE s."id" = NEW."bankStatementId" AND s."bankAccountId" = NEW."bankAccountId") THEN
    RAISE EXCEPTION 'Bank movement account must match its statement account';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_movements_statement_account_trigger BEFORE INSERT OR UPDATE OF "bankStatementId", "bankAccountId" ON "bank_movements" FOR EACH ROW EXECUTE FUNCTION validate_bank_movement_statement_account();

COMMIT;
