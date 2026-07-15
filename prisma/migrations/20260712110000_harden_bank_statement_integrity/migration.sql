BEGIN;

CREATE EXTENSION IF NOT EXISTS "btree_gist";

ALTER TABLE "bank_accounts"
ADD CONSTRAINT "bank_accounts_id_companyId_key"
UNIQUE ("id", "companyId");

ALTER TABLE "bank_statements"
ADD CONSTRAINT "bank_statements_id_bankAccountId_key"
UNIQUE ("id", "bankAccountId");

ALTER TABLE "bank_statements"
ADD CONSTRAINT "bank_statements_bankAccountId_companyId_fkey"
FOREIGN KEY ("bankAccountId", "companyId")
REFERENCES "bank_accounts"("id", "companyId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bank_movements"
ADD CONSTRAINT "bank_movements_bankStatementId_bankAccountId_fkey"
FOREIGN KEY ("bankStatementId", "bankAccountId")
REFERENCES "bank_statements"("id", "bankAccountId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bank_statements"
ADD CONSTRAINT "bank_statements_account_date_range_excl"
EXCLUDE USING gist (
  "bankAccountId" WITH =,
  daterange("dateFrom", "dateTo", '[]') WITH &&
);

DROP TRIGGER "bank_movements_statement_account_trigger" ON "bank_movements";
DROP FUNCTION "validate_bank_movement_statement_account"();

DROP TRIGGER "bank_statements_ownership_trigger" ON "bank_statements";
DROP FUNCTION "validate_bank_statement_ownership"();

COMMIT;
