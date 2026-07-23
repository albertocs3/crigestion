BEGIN;

CREATE OR REPLACE FUNCTION validate_accounting_fiscal_year_close_request() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fiscal_status "AccountingFiscalYearStatus";
  fiscal_closed_by UUID;
  successor_count INTEGER;
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

  IF OLD."status" <> 'REQUESTED' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."approvedById" IS DISTINCT FROM OLD."approvedById"
       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
       OR NEW."cancelledById" IS DISTINCT FROM OLD."cancelledById"
       OR NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt" THEN
      RAISE EXCEPTION 'ACCOUNTING_CLOSE_REQUEST_TERMINAL_EVIDENCE_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" = 'CANCELLED' AND NEW."cancelledById" IS DISTINCT FROM NEW."requestedById" THEN
    RAISE EXCEPTION 'ACCOUNTING_CLOSE_REQUEST_CANCELLER_MUST_BE_REQUESTER' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = 'COMPLETED' THEN
    SELECT "status", "closedById" INTO fiscal_status, fiscal_closed_by
      FROM "accounting_fiscal_years"
      WHERE "id" = NEW."fiscalYearId" AND "companyId" = NEW."companyId"
      FOR SHARE;
    SELECT COUNT(*) INTO successor_count
      FROM "accounting_fiscal_years"
      WHERE "companyId" = NEW."companyId" AND "sourceFiscalYearId" = NEW."fiscalYearId";
    IF fiscal_status <> 'CLOSED'
       OR fiscal_closed_by IS DISTINCT FROM NEW."approvedById"
       OR successor_count <> 1 THEN
      RAISE EXCEPTION 'ACCOUNTING_CLOSE_REQUEST_COMPLETION_EVIDENCE_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
