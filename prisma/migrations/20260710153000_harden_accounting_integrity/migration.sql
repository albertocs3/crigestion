CREATE UNIQUE INDEX "accounting_fiscal_years_one_open_per_company_key"
  ON "accounting_fiscal_years"("companyId")
  WHERE "status" = 'OPEN';

-- Estas invariantes requieren consultar el ejercicio o la cuenta y no pueden
-- expresarse mediante un CHECK limitado a la fila modificada.
CREATE FUNCTION validate_accounting_entry_fiscal_year()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  fiscal_year RECORD;
BEGIN
  SELECT "year", "startDate", "endDate"
  INTO fiscal_year
  FROM "accounting_fiscal_years"
  WHERE "id" = NEW."fiscalYearId";

  IF NOT FOUND
     OR NEW."year" <> fiscal_year."year"
     OR NEW."accountingDate" < fiscal_year."startDate"
     OR NEW."accountingDate" > fiscal_year."endDate" THEN
    RAISE EXCEPTION 'Accounting entry year/date does not match its fiscal year';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER accounting_journal_entries_fiscal_year_trigger
BEFORE INSERT OR UPDATE OF "fiscalYearId", "year", "accountingDate"
ON "accounting_journal_entries"
FOR EACH ROW
EXECUTE FUNCTION validate_accounting_entry_fiscal_year();

CREATE FUNCTION validate_accounting_line_fiscal_year()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entry_fiscal_year_id UUID;
  account_fiscal_year_id UUID;
BEGIN
  SELECT "fiscalYearId" INTO entry_fiscal_year_id
  FROM "accounting_journal_entries"
  WHERE "id" = NEW."entryId";

  SELECT "fiscalYearId" INTO account_fiscal_year_id
  FROM "accounting_accounts"
  WHERE "id" = NEW."accountId";

  IF entry_fiscal_year_id IS NULL
     OR account_fiscal_year_id IS NULL
     OR entry_fiscal_year_id <> account_fiscal_year_id THEN
    RAISE EXCEPTION 'Accounting entry and account must belong to the same fiscal year';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER accounting_journal_lines_fiscal_year_trigger
BEFORE INSERT OR UPDATE OF "entryId", "accountId"
ON "accounting_journal_lines"
FOR EACH ROW
EXECUTE FUNCTION validate_accounting_line_fiscal_year();
