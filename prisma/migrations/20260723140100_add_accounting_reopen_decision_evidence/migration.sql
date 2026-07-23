BEGIN;

ALTER TABLE "accounting_fiscal_year_reopen_requests"
  ADD COLUMN "expiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "rejectedById" UUID,
  ADD COLUMN "rejectedAt" TIMESTAMPTZ(3),
  ADD COLUMN "rejectionReason" VARCHAR(500),
  ADD COLUMN "expiredAt" TIMESTAMPTZ(3);

UPDATE "accounting_fiscal_year_reopen_requests"
SET "expiresAt" = "requestedAt" + INTERVAL '168 hours';

ALTER TABLE "accounting_fiscal_year_reopen_requests"
  ALTER COLUMN "expiresAt" SET NOT NULL,
  DROP CONSTRAINT "accounting_fiscal_year_reopen_requests_maker_checker_check",
  DROP CONSTRAINT "accounting_fiscal_year_reopen_requests_actor_state_check",
  ADD CONSTRAINT "accounting_fiscal_year_reopen_requests_expiry_check" CHECK (
    "expiresAt" = "requestedAt" + INTERVAL '168 hours'
  ),
  ADD CONSTRAINT "accounting_fiscal_year_reopen_requests_maker_checker_check" CHECK (
    ("approvedById" IS NULL OR "approvedById" <> "requestedById")
    AND ("rejectedById" IS NULL OR "rejectedById" <> "requestedById")
  ),
  ADD CONSTRAINT "accounting_fiscal_year_reopen_requests_actor_state_check" CHECK (
    (
      "status" = 'REQUESTED'
      AND "approvedById" IS NULL AND "approvedAt" IS NULL
      AND "cancelledById" IS NULL AND "cancelledAt" IS NULL
      AND "rejectedById" IS NULL AND "rejectedAt" IS NULL AND "rejectionReason" IS NULL
      AND "expiredAt" IS NULL
      AND "regularizationReversalEntryId" IS NULL
      AND "closingReversalEntryId" IS NULL
      AND "openingReversalEntryId" IS NULL
    )
    OR (
      "status" = 'COMPLETED'
      AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL
      AND "cancelledById" IS NULL AND "cancelledAt" IS NULL
      AND "rejectedById" IS NULL AND "rejectedAt" IS NULL AND "rejectionReason" IS NULL
      AND "expiredAt" IS NULL
    )
    OR (
      "status" = 'CANCELLED'
      AND "approvedById" IS NULL AND "approvedAt" IS NULL
      AND "cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL
      AND "rejectedById" IS NULL AND "rejectedAt" IS NULL AND "rejectionReason" IS NULL
      AND "expiredAt" IS NULL
      AND "regularizationReversalEntryId" IS NULL
      AND "closingReversalEntryId" IS NULL
      AND "openingReversalEntryId" IS NULL
    )
    OR (
      "status" = 'REJECTED'
      AND "approvedById" IS NULL AND "approvedAt" IS NULL
      AND "cancelledById" IS NULL AND "cancelledAt" IS NULL
      AND "rejectedById" IS NOT NULL AND "rejectedAt" IS NOT NULL
      AND char_length(btrim("rejectionReason")) BETWEEN 10 AND 500
      AND "expiredAt" IS NULL
      AND "regularizationReversalEntryId" IS NULL
      AND "closingReversalEntryId" IS NULL
      AND "openingReversalEntryId" IS NULL
    )
    OR (
      "status" = 'EXPIRED'
      AND "approvedById" IS NULL AND "approvedAt" IS NULL
      AND "cancelledById" IS NULL AND "cancelledAt" IS NULL
      AND "rejectedById" IS NULL AND "rejectedAt" IS NULL AND "rejectionReason" IS NULL
      AND "expiredAt" IS NOT NULL
      AND "regularizationReversalEntryId" IS NULL
      AND "closingReversalEntryId" IS NULL
      AND "openingReversalEntryId" IS NULL
    )
  ),
  ADD CONSTRAINT "accounting_fiscal_year_reopen_requests_rejectedById_fkey"
    FOREIGN KEY ("rejectedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "accounting_fiscal_year_reopen_requests_company_status_expires_idx"
  ON "accounting_fiscal_year_reopen_requests"("companyId", "status", "expiresAt", "id");
CREATE INDEX "accounting_fiscal_year_reopen_requests_rejected_at_idx"
  ON "accounting_fiscal_year_reopen_requests"("rejectedById", "rejectedAt");

CREATE OR REPLACE FUNCTION validate_accounting_fiscal_year_reopen_request() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  close_status "AccountingFiscalYearCloseRequestStatus";
  close_company UUID;
  close_source UUID;
  close_successor UUID;
  close_regularization UUID;
  close_closing UUID;
  close_opening UUID;
  source_status "AccountingFiscalYearStatus";
  successor_status "AccountingFiscalYearStatus";
BEGIN
  SELECT "status", "companyId", "fiscalYearId", "successorFiscalYearId",
         "regularizationEntryId", "closingEntryId", "openingEntryId"
    INTO close_status, close_company, close_source, close_successor,
         close_regularization, close_closing, close_opening
    FROM "accounting_fiscal_year_close_requests" WHERE "id" = NEW."closeRequestId" FOR SHARE;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'REQUESTED' THEN
      RAISE EXCEPTION 'ACCOUNTING_REOPEN_REQUEST_INITIAL_STATUS_INVALID' USING ERRCODE = '23514';
    END IF;
    IF close_status <> 'COMPLETED'
       OR close_company IS DISTINCT FROM NEW."companyId"
       OR close_source IS DISTINCT FROM NEW."fiscalYearId"
       OR close_successor IS DISTINCT FROM NEW."successorFiscalYearId" THEN
      RAISE EXCEPTION 'ACCOUNTING_REOPEN_REQUEST_CLOSE_EVIDENCE_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."companyId" IS DISTINCT FROM OLD."companyId"
     OR NEW."closeRequestId" IS DISTINCT FROM OLD."closeRequestId"
     OR NEW."fiscalYearId" IS DISTINCT FROM OLD."fiscalYearId"
     OR NEW."successorFiscalYearId" IS DISTINCT FROM OLD."successorFiscalYearId"
     OR NEW."reasonCode" IS DISTINCT FROM OLD."reasonCode"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."preflightSnapshot" IS DISTINCT FROM OLD."preflightSnapshot"
     OR NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
     OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    RAISE EXCEPTION 'ACCOUNTING_REOPEN_REQUEST_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" <> 'REQUESTED' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."approvedById" IS DISTINCT FROM OLD."approvedById"
       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
       OR NEW."cancelledById" IS DISTINCT FROM OLD."cancelledById"
       OR NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt"
       OR NEW."rejectedById" IS DISTINCT FROM OLD."rejectedById"
       OR NEW."rejectedAt" IS DISTINCT FROM OLD."rejectedAt"
       OR NEW."rejectionReason" IS DISTINCT FROM OLD."rejectionReason"
       OR NEW."expiredAt" IS DISTINCT FROM OLD."expiredAt"
       OR NEW."regularizationReversalEntryId" IS DISTINCT FROM OLD."regularizationReversalEntryId"
       OR NEW."closingReversalEntryId" IS DISTINCT FROM OLD."closingReversalEntryId"
       OR NEW."openingReversalEntryId" IS DISTINCT FROM OLD."openingReversalEntryId" THEN
      RAISE EXCEPTION 'ACCOUNTING_REOPEN_REQUEST_TERMINAL_EVIDENCE_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" = 'CANCELLED' AND NEW."cancelledById" IS DISTINCT FROM NEW."requestedById" THEN
    RAISE EXCEPTION 'ACCOUNTING_REOPEN_REQUEST_CANCELLER_MUST_BE_REQUESTER' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'REJECTED' AND NEW."rejectedById" IS NOT DISTINCT FROM NEW."requestedById" THEN
    RAISE EXCEPTION 'ACCOUNTING_REOPEN_REQUEST_REJECTER_MUST_BE_CHECKER' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'EXPIRED' AND NEW."expiredAt" < NEW."expiresAt" THEN
    RAISE EXCEPTION 'ACCOUNTING_REOPEN_REQUEST_EXPIRY_PREMATURE' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = 'COMPLETED' THEN
    SELECT "status" INTO source_status FROM "accounting_fiscal_years"
      WHERE "id" = NEW."fiscalYearId" AND "companyId" = NEW."companyId" FOR SHARE;
    SELECT "status" INTO successor_status FROM "accounting_fiscal_years"
      WHERE "id" = NEW."successorFiscalYearId" AND "companyId" = NEW."companyId" FOR SHARE;
    IF close_status <> 'COMPLETED' OR source_status <> 'OPEN' OR successor_status <> 'REVERSED' THEN
      RAISE EXCEPTION 'ACCOUNTING_REOPEN_REQUEST_COMPLETION_EVIDENCE_INVALID' USING ERRCODE = '23514';
    END IF;
    IF (close_regularization IS NULL) <> (NEW."regularizationReversalEntryId" IS NULL)
       OR (close_closing IS NULL) <> (NEW."closingReversalEntryId" IS NULL)
       OR (close_opening IS NULL) <> (NEW."openingReversalEntryId" IS NULL) THEN
      RAISE EXCEPTION 'ACCOUNTING_REOPEN_REQUEST_REVERSAL_SHAPE_INVALID' USING ERRCODE = '23514';
    END IF;
    IF NEW."regularizationReversalEntryId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "accounting_journal_entries" entry WHERE entry."id" = NEW."regularizationReversalEntryId"
        AND entry."reversesEntryId" = close_regularization AND entry."fiscalYearId" = NEW."fiscalYearId"
        AND entry."origin" = 'FISCAL_YEAR_CLOSE_REVERSAL' AND entry."status" = 'POSTED'
    ) THEN RAISE EXCEPTION 'ACCOUNTING_REOPEN_REQUEST_REGULARIZATION_REVERSAL_INVALID' USING ERRCODE = '23514'; END IF;
    IF NEW."closingReversalEntryId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "accounting_journal_entries" entry WHERE entry."id" = NEW."closingReversalEntryId"
        AND entry."reversesEntryId" = close_closing AND entry."fiscalYearId" = NEW."fiscalYearId"
        AND entry."origin" = 'FISCAL_YEAR_CLOSE_REVERSAL' AND entry."status" = 'POSTED'
    ) THEN RAISE EXCEPTION 'ACCOUNTING_REOPEN_REQUEST_CLOSING_REVERSAL_INVALID' USING ERRCODE = '23514'; END IF;
    IF NEW."openingReversalEntryId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "accounting_journal_entries" entry WHERE entry."id" = NEW."openingReversalEntryId"
        AND entry."reversesEntryId" = close_opening AND entry."fiscalYearId" = NEW."successorFiscalYearId"
        AND entry."origin" = 'FISCAL_YEAR_CLOSE_REVERSAL' AND entry."status" = 'POSTED'
    ) THEN RAISE EXCEPTION 'ACCOUNTING_REOPEN_REQUEST_OPENING_REVERSAL_INVALID' USING ERRCODE = '23514'; END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
