BEGIN;

CREATE UNIQUE INDEX "accounting_fiscal_year_close_requests_completed_key"
  ON "accounting_fiscal_year_close_requests" ("fiscalYearId")
  WHERE "status" = 'COMPLETED';

CREATE FUNCTION validate_accounting_fiscal_year_close_request() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE fiscal_status "AccountingFiscalYearStatus";
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'REQUESTED' THEN
      RAISE EXCEPTION 'ACCOUNTING_CLOSE_REQUEST_INITIAL_STATUS_INVALID' USING ERRCODE = '23514';
    END IF;
    SELECT "status" INTO fiscal_status
      FROM "accounting_fiscal_years"
      WHERE "id" = NEW."fiscalYearId" AND "companyId" = NEW."companyId"
      FOR SHARE;
    IF fiscal_status IS NULL OR fiscal_status <> 'OPEN' THEN
      RAISE EXCEPTION 'ACCOUNTING_CLOSE_REQUEST_FISCAL_YEAR_NOT_OPEN' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."companyId" IS DISTINCT FROM OLD."companyId"
     OR NEW."fiscalYearId" IS DISTINCT FROM OLD."fiscalYearId"
     OR NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
     OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
     OR NEW."preflightSnapshot" IS DISTINCT FROM OLD."preflightSnapshot" THEN
    RAISE EXCEPTION 'ACCOUNTING_CLOSE_REQUEST_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" <> 'REQUESTED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'ACCOUNTING_CLOSE_REQUEST_TERMINAL_STATE' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'REQUESTED' AND NEW."status" NOT IN ('REQUESTED', 'COMPLETED', 'CANCELLED') THEN
    RAISE EXCEPTION 'ACCOUNTING_CLOSE_REQUEST_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "accounting_fiscal_year_close_requests_validate"
BEFORE INSERT OR UPDATE ON "accounting_fiscal_year_close_requests"
FOR EACH ROW EXECUTE FUNCTION validate_accounting_fiscal_year_close_request();

COMMIT;
