BEGIN;

ALTER TABLE "accounting_fiscal_years"
  DROP CONSTRAINT "accounting_fiscal_year_closed_check",
  ADD CONSTRAINT "accounting_fiscal_year_closed_check" CHECK (
    ("status" IN ('OPEN', 'REVERSED') AND "closedAt" IS NULL AND "closedById" IS NULL)
    OR ("status" = 'CLOSED' AND "closedAt" IS NOT NULL AND "closedById" IS NOT NULL)
  );

ALTER TABLE "accounting_fiscal_year_close_requests"
  ADD COLUMN "successorFiscalYearId" UUID,
  ADD COLUMN "regularizationEntryId" UUID,
  ADD COLUMN "closingEntryId" UUID,
  ADD COLUMN "openingEntryId" UUID;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "accounting_fiscal_year_close_requests" request
    WHERE request."status" = 'COMPLETED'
      AND 1 <> (
        SELECT COUNT(*)
        FROM "audit_events" event
        WHERE event."eventType" = 'ACCOUNTING_FISCAL_YEAR_CLOSED'
          AND event."payload"->>'closeRequestId' = request."id"::text
      )
  ) THEN
    RAISE EXCEPTION 'ACCOUNTING_CLOSE_REQUEST_BACKFILL_AMBIGUOUS';
  END IF;
END;
$$;

UPDATE "accounting_fiscal_year_close_requests" request
SET
  "successorFiscalYearId" = (event."payload"->>'nextFiscalYearId')::uuid,
  "regularizationEntryId" = NULLIF(event."payload" #>> '{automaticEntries,regularization,id}', '')::uuid,
  "closingEntryId" = NULLIF(event."payload" #>> '{automaticEntries,closing,id}', '')::uuid,
  "openingEntryId" = NULLIF(event."payload" #>> '{automaticEntries,opening,id}', '')::uuid
FROM "audit_events" event
WHERE request."status" = 'COMPLETED'
  AND event."eventType" = 'ACCOUNTING_FISCAL_YEAR_CLOSED'
  AND event."payload"->>'closeRequestId' = request."id"::text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "accounting_fiscal_year_close_requests"
    WHERE "status" = 'COMPLETED' AND "successorFiscalYearId" IS NULL
  ) THEN
    RAISE EXCEPTION 'ACCOUNTING_CLOSE_REQUEST_BACKFILL_INCOMPLETE';
  END IF;
END;
$$;

CREATE UNIQUE INDEX "accounting_fiscal_year_close_requests_regularizationEntryId_key"
  ON "accounting_fiscal_year_close_requests"("regularizationEntryId");
CREATE UNIQUE INDEX "accounting_fiscal_year_close_requests_closingEntryId_key"
  ON "accounting_fiscal_year_close_requests"("closingEntryId");
CREATE UNIQUE INDEX "accounting_fiscal_year_close_requests_openingEntryId_key"
  ON "accounting_fiscal_year_close_requests"("openingEntryId");

DROP INDEX "accounting_fiscal_year_close_requests_completed_key";

ALTER TABLE "accounting_fiscal_year_close_requests"
  DROP CONSTRAINT "accounting_fiscal_year_close_requests_actor_state_check",
  ADD CONSTRAINT "accounting_fiscal_year_close_requests_actor_state_check" CHECK (
    (
      "status" = 'REQUESTED'
      AND "approvedById" IS NULL AND "approvedAt" IS NULL
      AND "cancelledById" IS NULL AND "cancelledAt" IS NULL
      AND "successorFiscalYearId" IS NULL
      AND "regularizationEntryId" IS NULL AND "closingEntryId" IS NULL AND "openingEntryId" IS NULL
    )
    OR (
      "status" = 'COMPLETED'
      AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL
      AND "cancelledById" IS NULL AND "cancelledAt" IS NULL
      AND "successorFiscalYearId" IS NOT NULL
    )
    OR (
      "status" = 'CANCELLED'
      AND "approvedById" IS NULL AND "approvedAt" IS NULL
      AND "cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL
      AND "successorFiscalYearId" IS NULL
      AND "regularizationEntryId" IS NULL AND "closingEntryId" IS NULL AND "openingEntryId" IS NULL
    )
  ),
  ADD CONSTRAINT "accounting_fiscal_year_close_requests_successorFiscalYearId_fkey"
    FOREIGN KEY ("successorFiscalYearId") REFERENCES "accounting_fiscal_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounting_fiscal_year_close_requests_regularizationEntryId_fkey"
    FOREIGN KEY ("regularizationEntryId") REFERENCES "accounting_journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounting_fiscal_year_close_requests_closingEntryId_fkey"
    FOREIGN KEY ("closingEntryId") REFERENCES "accounting_journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounting_fiscal_year_close_requests_openingEntryId_fkey"
    FOREIGN KEY ("openingEntryId") REFERENCES "accounting_journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "accounting_fiscal_year_reopen_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "closeRequestId" UUID NOT NULL,
  "fiscalYearId" UUID NOT NULL,
  "successorFiscalYearId" UUID NOT NULL,
  "status" "AccountingFiscalYearReopenRequestStatus" NOT NULL DEFAULT 'REQUESTED',
  "reasonCode" "AccountingFiscalYearReopenReasonCode" NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "preflightSnapshot" JSONB NOT NULL,
  "requestedById" UUID NOT NULL,
  "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedById" UUID,
  "approvedAt" TIMESTAMPTZ(3),
  "cancelledById" UUID,
  "cancelledAt" TIMESTAMPTZ(3),
  "regularizationReversalEntryId" UUID,
  "closingReversalEntryId" UUID,
  "openingReversalEntryId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "accounting_fiscal_year_reopen_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "accounting_fiscal_year_reopen_requests_reason_check" CHECK (
    char_length(btrim("reason")) BETWEEN 10 AND 500
  ),
  CONSTRAINT "accounting_fiscal_year_reopen_requests_maker_checker_check" CHECK (
    "approvedById" IS NULL OR "approvedById" <> "requestedById"
  ),
  CONSTRAINT "accounting_fiscal_year_reopen_requests_actor_state_check" CHECK (
    (
      "status" = 'REQUESTED'
      AND "approvedById" IS NULL AND "approvedAt" IS NULL
      AND "cancelledById" IS NULL AND "cancelledAt" IS NULL
      AND "regularizationReversalEntryId" IS NULL
      AND "closingReversalEntryId" IS NULL
      AND "openingReversalEntryId" IS NULL
    )
    OR (
      "status" = 'COMPLETED'
      AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL
      AND "cancelledById" IS NULL AND "cancelledAt" IS NULL
    )
    OR (
      "status" = 'CANCELLED'
      AND "approvedById" IS NULL AND "approvedAt" IS NULL
      AND "cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL
      AND "regularizationReversalEntryId" IS NULL
      AND "closingReversalEntryId" IS NULL
      AND "openingReversalEntryId" IS NULL
    )
  )
);

CREATE UNIQUE INDEX "accounting_fiscal_year_reopen_requests_active_key"
  ON "accounting_fiscal_year_reopen_requests"("closeRequestId") WHERE "status" = 'REQUESTED';
CREATE UNIQUE INDEX "accounting_fiscal_year_reopen_requests_completed_key"
  ON "accounting_fiscal_year_reopen_requests"("closeRequestId") WHERE "status" = 'COMPLETED';
CREATE UNIQUE INDEX "accounting_fiscal_year_reopen_requests_regularizationReversalEntryId_key"
  ON "accounting_fiscal_year_reopen_requests"("regularizationReversalEntryId");
CREATE UNIQUE INDEX "accounting_fiscal_year_reopen_requests_closingReversalEntryId_key"
  ON "accounting_fiscal_year_reopen_requests"("closingReversalEntryId");
CREATE UNIQUE INDEX "accounting_fiscal_year_reopen_requests_openingReversalEntryId_key"
  ON "accounting_fiscal_year_reopen_requests"("openingReversalEntryId");
CREATE INDEX "accounting_fiscal_year_reopen_requests_company_status_requested_idx"
  ON "accounting_fiscal_year_reopen_requests"("companyId", "status", "requestedAt", "id");
CREATE INDEX "accounting_fiscal_year_reopen_requests_fiscal_requested_idx"
  ON "accounting_fiscal_year_reopen_requests"("fiscalYearId", "requestedAt", "id");
CREATE INDEX "accounting_fiscal_year_reopen_requests_close_requested_idx"
  ON "accounting_fiscal_year_reopen_requests"("closeRequestId", "requestedAt", "id");
CREATE INDEX "accounting_fiscal_year_reopen_requests_requester_requested_idx"
  ON "accounting_fiscal_year_reopen_requests"("requestedById", "requestedAt");

ALTER TABLE "accounting_fiscal_year_reopen_requests"
  ADD CONSTRAINT "accounting_fiscal_year_reopen_requests_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounting_fiscal_year_reopen_requests_closeRequestId_fkey"
    FOREIGN KEY ("closeRequestId") REFERENCES "accounting_fiscal_year_close_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounting_fiscal_year_reopen_requests_fiscal_company_fkey"
    FOREIGN KEY ("fiscalYearId", "companyId") REFERENCES "accounting_fiscal_years"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounting_fiscal_year_reopen_requests_successorFiscalYearId_fkey"
    FOREIGN KEY ("successorFiscalYearId") REFERENCES "accounting_fiscal_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounting_fiscal_year_reopen_requests_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounting_fiscal_year_reopen_requests_approvedById_fkey"
    FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounting_fiscal_year_reopen_requests_cancelledById_fkey"
    FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounting_fiscal_year_reopen_requests_regularizationReversalEntryId_fkey"
    FOREIGN KEY ("regularizationReversalEntryId") REFERENCES "accounting_journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounting_fiscal_year_reopen_requests_closingReversalEntryId_fkey"
    FOREIGN KEY ("closingReversalEntryId") REFERENCES "accounting_journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounting_fiscal_year_reopen_requests_openingReversalEntryId_fkey"
    FOREIGN KEY ("openingReversalEntryId") REFERENCES "accounting_journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "accounting_journal_entries"
  DROP CONSTRAINT IF EXISTS "accounting_journal_entries_origin_source_check";
ALTER TABLE "accounting_journal_entries"
  ADD CONSTRAINT "accounting_journal_entries_origin_source_check" CHECK (
    ("origin" = 'INVOICE' AND "invoiceId" IS NOT NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" = 'INVOICE_VOIDING' AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NOT NULL AND "reversesEntryId" IS NOT NULL)
    OR ("origin" = 'CUSTOMER_PAYMENT' AND "customerPaymentId" IS NOT NULL AND "invoiceId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" = 'CUSTOMER_PAYMENT_RETURN' AND "customerPaymentReturnId" IS NOT NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" = 'CUSTOMER_CREDIT_REFUND' AND "customerCreditRefundId" IS NOT NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" = 'PURCHASE_INVOICE' AND "purchaseInvoiceId" IS NOT NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" = 'PURCHASE_RECTIFICATION' AND "purchaseInvoiceId" IS NOT NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NOT NULL)
    OR ("origin" = 'SUPPLIER_PAYMENT' AND "supplierPaymentId" IS NOT NULL AND "purchaseInvoiceId" IS NULL AND "supplierCreditRefundId" IS NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" = 'SUPPLIER_CREDIT_REFUND' AND "supplierCreditRefundId" IS NOT NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" IN ('MANUAL', 'REGULARIZATION', 'CLOSING', 'OPENING') AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" = 'FISCAL_YEAR_CLOSE_REVERSAL' AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION validate_accounting_fiscal_year_close_request() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fiscal_status "AccountingFiscalYearStatus";
  fiscal_closed_by UUID;
  fiscal_year INTEGER;
  successor_company UUID;
  successor_year INTEGER;
  successor_source UUID;
  successor_status "AccountingFiscalYearStatus";
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'REQUESTED' THEN
      RAISE EXCEPTION 'ACCOUNTING_CLOSE_REQUEST_INITIAL_STATUS_INVALID' USING ERRCODE = '23514';
    END IF;
    SELECT "status" INTO fiscal_status FROM "accounting_fiscal_years"
      WHERE "id" = NEW."fiscalYearId" AND "companyId" = NEW."companyId" FOR SHARE;
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
       OR NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt"
       OR NEW."successorFiscalYearId" IS DISTINCT FROM OLD."successorFiscalYearId"
       OR NEW."regularizationEntryId" IS DISTINCT FROM OLD."regularizationEntryId"
       OR NEW."closingEntryId" IS DISTINCT FROM OLD."closingEntryId"
       OR NEW."openingEntryId" IS DISTINCT FROM OLD."openingEntryId" THEN
      RAISE EXCEPTION 'ACCOUNTING_CLOSE_REQUEST_TERMINAL_EVIDENCE_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" = 'CANCELLED' AND NEW."cancelledById" IS DISTINCT FROM NEW."requestedById" THEN
    RAISE EXCEPTION 'ACCOUNTING_CLOSE_REQUEST_CANCELLER_MUST_BE_REQUESTER' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = 'COMPLETED' THEN
    SELECT "status", "closedById", "year" INTO fiscal_status, fiscal_closed_by, fiscal_year
      FROM "accounting_fiscal_years"
      WHERE "id" = NEW."fiscalYearId" AND "companyId" = NEW."companyId" FOR SHARE;
    SELECT "companyId", "year", "sourceFiscalYearId", "status"
      INTO successor_company, successor_year, successor_source, successor_status
      FROM "accounting_fiscal_years" WHERE "id" = NEW."successorFiscalYearId" FOR SHARE;
    IF fiscal_status <> 'CLOSED'
       OR fiscal_closed_by IS DISTINCT FROM NEW."approvedById"
       OR successor_company IS DISTINCT FROM NEW."companyId"
       OR successor_year <> fiscal_year + 1
       OR successor_source IS DISTINCT FROM NEW."fiscalYearId"
       OR successor_status <> 'OPEN' THEN
      RAISE EXCEPTION 'ACCOUNTING_CLOSE_REQUEST_COMPLETION_EVIDENCE_INVALID' USING ERRCODE = '23514';
    END IF;
    IF NEW."regularizationEntryId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "accounting_journal_entries" entry
      WHERE entry."id" = NEW."regularizationEntryId" AND entry."fiscalYearId" = NEW."fiscalYearId"
        AND entry."origin" = 'REGULARIZATION' AND entry."status" = 'POSTED'
    ) THEN RAISE EXCEPTION 'ACCOUNTING_CLOSE_REQUEST_REGULARIZATION_EVIDENCE_INVALID' USING ERRCODE = '23514'; END IF;
    IF NEW."closingEntryId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "accounting_journal_entries" entry
      WHERE entry."id" = NEW."closingEntryId" AND entry."fiscalYearId" = NEW."fiscalYearId"
        AND entry."origin" = 'CLOSING' AND entry."status" = 'POSTED'
    ) THEN RAISE EXCEPTION 'ACCOUNTING_CLOSE_REQUEST_CLOSING_EVIDENCE_INVALID' USING ERRCODE = '23514'; END IF;
    IF NEW."openingEntryId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "accounting_journal_entries" entry
      WHERE entry."id" = NEW."openingEntryId" AND entry."fiscalYearId" = NEW."successorFiscalYearId"
        AND entry."origin" = 'OPENING' AND entry."status" = 'POSTED'
    ) THEN RAISE EXCEPTION 'ACCOUNTING_CLOSE_REQUEST_OPENING_EVIDENCE_INVALID' USING ERRCODE = '23514'; END IF;
  END IF;

  RETURN NEW;
END;
$$;

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
     OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt" THEN
    RAISE EXCEPTION 'ACCOUNTING_REOPEN_REQUEST_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" <> 'REQUESTED' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."approvedById" IS DISTINCT FROM OLD."approvedById"
       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
       OR NEW."cancelledById" IS DISTINCT FROM OLD."cancelledById"
       OR NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt"
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

CREATE TRIGGER "accounting_fiscal_year_reopen_requests_validate"
BEFORE INSERT OR UPDATE ON "accounting_fiscal_year_reopen_requests"
FOR EACH ROW EXECUTE FUNCTION validate_accounting_fiscal_year_reopen_request();

CREATE FUNCTION validate_accounting_close_reversal_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE original_origin "AccountingEntryOrigin";
BEGIN
  IF NEW."origin" <> 'FISCAL_YEAR_CLOSE_REVERSAL' THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "accounting_fiscal_year_reopen_requests" request
    WHERE request."status" = 'COMPLETED'
      AND NEW."id" IN (
        request."regularizationReversalEntryId",
        request."closingReversalEntryId",
        request."openingReversalEntryId"
      )
  ) THEN
    RAISE EXCEPTION 'ACCOUNTING_CLOSE_REVERSAL_REQUEST_LINK_MISSING' USING ERRCODE = '23514';
  END IF;
  SELECT "origin" INTO original_origin FROM "accounting_journal_entries"
    WHERE "id" = NEW."reversesEntryId" AND "fiscalYearId" = NEW."fiscalYearId" AND "status" = 'POSTED';
  IF original_origin IS NULL OR original_origin NOT IN ('REGULARIZATION', 'CLOSING', 'OPENING') THEN
    RAISE EXCEPTION 'ACCOUNTING_CLOSE_REVERSAL_ORIGINAL_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "accounting_journal_entries" original
    WHERE original."id" = NEW."reversesEntryId"
      AND original."totalDebit" = NEW."totalCredit"
      AND original."totalCredit" = NEW."totalDebit"
  ) OR EXISTS (
    SELECT 1
    FROM (
      SELECT "accountId", SUM("debit") debit, SUM("credit") credit
      FROM "accounting_journal_lines" WHERE "entryId" = NEW."reversesEntryId" GROUP BY "accountId"
    ) original
    FULL JOIN (
      SELECT "accountId", SUM("debit") debit, SUM("credit") credit
      FROM "accounting_journal_lines" WHERE "entryId" = NEW."id" GROUP BY "accountId"
    ) reversal USING ("accountId")
    WHERE original.debit IS DISTINCT FROM reversal.credit
       OR original.credit IS DISTINCT FROM reversal.debit
  ) THEN
    RAISE EXCEPTION 'ACCOUNTING_CLOSE_REVERSAL_LINES_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "accounting_close_reversal_entry_validate"
AFTER INSERT OR UPDATE ON "accounting_journal_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_accounting_close_reversal_entry();

CREATE FUNCTION validate_accounting_automatic_close_entry_link() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."origin" = 'REGULARIZATION' AND NOT EXISTS (
    SELECT 1 FROM "accounting_fiscal_year_close_requests"
    WHERE "status" = 'COMPLETED' AND "regularizationEntryId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'ACCOUNTING_REGULARIZATION_CLOSE_LINK_MISSING' USING ERRCODE = '23514';
  ELSIF NEW."origin" = 'CLOSING' AND NOT EXISTS (
    SELECT 1 FROM "accounting_fiscal_year_close_requests"
    WHERE "status" = 'COMPLETED' AND "closingEntryId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'ACCOUNTING_CLOSING_CLOSE_LINK_MISSING' USING ERRCODE = '23514';
  ELSIF NEW."origin" = 'OPENING' AND NOT EXISTS (
    SELECT 1 FROM "accounting_fiscal_year_close_requests"
    WHERE "status" = 'COMPLETED' AND "openingEntryId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'ACCOUNTING_OPENING_CLOSE_LINK_MISSING' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "accounting_automatic_close_entry_link_validate"
AFTER INSERT OR UPDATE ON "accounting_journal_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_accounting_automatic_close_entry_link();

CREATE FUNCTION accounting_entry_is_close_evidence(entry_id UUID) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "accounting_fiscal_year_close_requests"
    WHERE entry_id IN ("regularizationEntryId", "closingEntryId", "openingEntryId")
    UNION ALL
    SELECT 1 FROM "accounting_fiscal_year_reopen_requests"
    WHERE entry_id IN (
      "regularizationReversalEntryId",
      "closingReversalEntryId",
      "openingReversalEntryId"
    )
  );
$$;

CREATE FUNCTION prevent_accounting_close_evidence_entry_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF accounting_entry_is_close_evidence(OLD."id") THEN
    RAISE EXCEPTION 'ACCOUNTING_CLOSE_EVIDENCE_ENTRY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "accounting_close_evidence_entry_immutable"
BEFORE UPDATE OR DELETE ON "accounting_journal_entries"
FOR EACH ROW EXECUTE FUNCTION prevent_accounting_close_evidence_entry_mutation();

CREATE FUNCTION prevent_accounting_close_evidence_line_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND accounting_entry_is_close_evidence(OLD."entryId") THEN
    RAISE EXCEPTION 'ACCOUNTING_CLOSE_EVIDENCE_LINES_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND accounting_entry_is_close_evidence(NEW."entryId") THEN
    RAISE EXCEPTION 'ACCOUNTING_CLOSE_EVIDENCE_LINES_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "accounting_close_evidence_lines_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "accounting_journal_lines"
FOR EACH ROW EXECUTE FUNCTION prevent_accounting_close_evidence_line_mutation();

CREATE FUNCTION validate_accounting_fiscal_year_reopen_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE latest_close_id UUID;
BEGIN
  IF OLD."status" = 'CLOSED' AND NEW."status" = 'OPEN' THEN
    SELECT request."id" INTO latest_close_id
    FROM "accounting_fiscal_year_close_requests" request
    WHERE request."fiscalYearId" = NEW."id" AND request."status" = 'COMPLETED'
    ORDER BY request."approvedAt" DESC, request."id" DESC LIMIT 1;
  ELSIF OLD."status" = 'OPEN' AND NEW."status" = 'REVERSED' THEN
    SELECT request."id" INTO latest_close_id
    FROM "accounting_fiscal_year_close_requests" request
    WHERE request."successorFiscalYearId" = NEW."id" AND request."status" = 'COMPLETED'
    ORDER BY request."approvedAt" DESC, request."id" DESC LIMIT 1;
  ELSE
    RETURN NEW;
  END IF;

  IF latest_close_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM "accounting_fiscal_year_reopen_requests" reopen
    WHERE reopen."closeRequestId" = latest_close_id AND reopen."status" = 'COMPLETED'
  ) THEN
    RAISE EXCEPTION 'ACCOUNTING_FISCAL_YEAR_REOPEN_TRANSITION_EVIDENCE_MISSING' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "accounting_fiscal_year_reopen_transition_validate"
AFTER UPDATE OF "status" ON "accounting_fiscal_years"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_accounting_fiscal_year_reopen_transition();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt") VALUES
  (gen_random_uuid(), 'Accounting.RequestExerciseReopenings', 'Solicitar reaperturas de ejercicio', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Accounting.ApproveExerciseReopenings', 'Aprobar reaperturas de ejercicio', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador'
  AND permission."code" IN ('Accounting.RequestExerciseReopenings', 'Accounting.ApproveExerciseReopenings')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
