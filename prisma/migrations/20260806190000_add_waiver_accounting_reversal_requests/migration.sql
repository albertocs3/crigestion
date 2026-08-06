BEGIN;

CREATE TABLE "accounting_waiver_reversal_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "reviewId" UUID NOT NULL,
  "evidenceId" UUID NOT NULL,
  "targetEntryId" UUID NOT NULL,
  "status" "AccountingWaiverReversalRequestStatus" NOT NULL DEFAULT 'REQUESTED',
  "version" INTEGER NOT NULL DEFAULT 1,
  "reasonCode" "AccountingWaiverReversalReasonCode" NOT NULL,
  "reasonDetail" VARCHAR(500) NOT NULL,
  "accountingDate" DATE NOT NULL,
  "requestedById" UUID NOT NULL,
  "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedById" UUID,
  "approvedAt" TIMESTAMPTZ(3),
  "rejectedById" UUID,
  "rejectedAt" TIMESTAMPTZ(3),
  "rejectionDetail" VARCHAR(500),
  "cancelledById" UUID,
  "cancelledAt" TIMESTAMPTZ(3),
  "targetSnapshot" JSONB NOT NULL,
  "reversalSnapshot" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "accounting_waiver_reversal_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "accounting_waiver_reversal_requests_company_fkey" FOREIGN KEY ("companyId") REFERENCES "companies" ("id") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_reversal_requests_review_fkey" FOREIGN KEY ("reviewId", "companyId") REFERENCES "subscription_renewal_waiver_reviews" ("id", "companyId") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_reversal_requests_evidence_fkey" FOREIGN KEY ("evidenceId") REFERENCES "subscription_renewal_waiver_review_evidence" ("id") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_reversal_requests_target_fkey" FOREIGN KEY ("targetEntryId") REFERENCES "accounting_journal_entries" ("id") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_reversal_requests_requestedBy_fkey" FOREIGN KEY ("requestedById") REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_reversal_requests_approvedBy_fkey" FOREIGN KEY ("approvedById") REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_reversal_requests_rejectedBy_fkey" FOREIGN KEY ("rejectedById") REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_reversal_requests_cancelledBy_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_reversal_requests_state_chk" CHECK (
    ("status" = 'REQUESTED' AND "version" = 1 AND "approvedById" IS NULL AND "approvedAt" IS NULL AND "reversalSnapshot" IS NULL
      AND "rejectedById" IS NULL AND "rejectedAt" IS NULL AND "rejectionDetail" IS NULL AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'COMPLETED' AND "version" = 2 AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "approvedAt" >= "requestedAt" AND "reversalSnapshot" IS NOT NULL
      AND "rejectedById" IS NULL AND "rejectedAt" IS NULL AND "rejectionDetail" IS NULL AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'REJECTED' AND "version" = 2 AND "approvedById" IS NULL AND "approvedAt" IS NULL AND "reversalSnapshot" IS NULL
      AND "rejectedById" IS NOT NULL AND "rejectedAt" IS NOT NULL AND "rejectedAt" >= "requestedAt" AND length(btrim("rejectionDetail")) >= 10 AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'CANCELLED' AND "version" = 2 AND "approvedById" IS NULL AND "approvedAt" IS NULL AND "reversalSnapshot" IS NULL
      AND "rejectedById" IS NULL AND "rejectedAt" IS NULL AND "rejectionDetail" IS NULL AND "cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL AND "cancelledAt" >= "requestedAt")
  ),
  CONSTRAINT "accounting_waiver_reversal_requests_reason_chk" CHECK (length(btrim("reasonDetail")) >= 10 AND jsonb_typeof("targetSnapshot") = 'object'
    AND ("reversalSnapshot" IS NULL OR jsonb_typeof("reversalSnapshot") = 'object'))
);

CREATE UNIQUE INDEX "accounting_waiver_reversal_requests_active_target_key"
  ON "accounting_waiver_reversal_requests" ("targetEntryId") WHERE "status" IN ('REQUESTED', 'COMPLETED');
CREATE UNIQUE INDEX "accounting_waiver_reversal_requests_active_evidence_key"
  ON "accounting_waiver_reversal_requests" ("evidenceId") WHERE "status" IN ('REQUESTED', 'COMPLETED');
CREATE INDEX "accounting_waiver_reversal_requests_company_status_requested_idx"
  ON "accounting_waiver_reversal_requests" ("companyId", "status", "requestedAt", "id");
CREATE INDEX "accounting_waiver_reversal_requests_review_requested_idx"
  ON "accounting_waiver_reversal_requests" ("reviewId", "requestedAt", "id");

CREATE TABLE "accounting_waiver_reversal_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "requestVersion" INTEGER NOT NULL,
  "type" "AccountingWaiverReversalEventType" NOT NULL,
  "actorId" UUID NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "correlationId" VARCHAR(100),
  CONSTRAINT "accounting_waiver_reversal_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "accounting_waiver_reversal_events_request_version_key" UNIQUE ("requestId", "requestVersion"),
  CONSTRAINT "accounting_waiver_reversal_events_company_fkey" FOREIGN KEY ("companyId") REFERENCES "companies" ("id") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_reversal_events_request_fkey" FOREIGN KEY ("requestId") REFERENCES "accounting_waiver_reversal_requests" ("id") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_reversal_events_actor_fkey" FOREIGN KEY ("actorId") REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "accounting_waiver_reversal_events_version_chk" CHECK ("requestVersion" IN (1, 2))
);
CREATE INDEX "accounting_waiver_reversal_events_company_occurred_idx"
  ON "accounting_waiver_reversal_events" ("companyId", "occurredAt", "id");

ALTER TABLE "accounting_journal_entries"
  ADD COLUMN "waiverReversalRequestId" UUID,
  ADD CONSTRAINT "accounting_journal_entries_waiverReversalRequestId_key" UNIQUE ("waiverReversalRequestId"),
  ADD CONSTRAINT "accounting_journal_entries_waiverReversalRequestId_fkey"
    FOREIGN KEY ("waiverReversalRequestId") REFERENCES "accounting_waiver_reversal_requests" ("id") ON DELETE RESTRICT;

ALTER TABLE "accounting_journal_entries" DROP CONSTRAINT "accounting_journal_entries_origin_source_check";
ALTER TABLE "accounting_journal_entries" ADD CONSTRAINT "accounting_journal_entries_waiver_reversal_source_chk" CHECK (
  ("origin" = 'WAIVER_REGULARIZATION_REVERSAL' AND "waiverReversalRequestId" IS NOT NULL AND "reversesEntryId" IS NOT NULL
    AND "waiverReviewId" IS NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL
    AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL
    AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL)
  OR ("origin" <> 'WAIVER_REGULARIZATION_REVERSAL' AND "waiverReversalRequestId" IS NULL)
);

-- Preserve the established origin/source matrix for every non-waiver-reversal entry.
ALTER TABLE "accounting_journal_entries" ADD CONSTRAINT "accounting_journal_entries_origin_source_check" CHECK (
  "origin" = 'WAIVER_REGULARIZATION_REVERSAL'
  OR ("origin" = 'INVOICE' AND "invoiceId" IS NOT NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL AND "waiverReviewId" IS NULL)
  OR ("origin" = 'INVOICE_VOIDING' AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NOT NULL AND "reversesEntryId" IS NOT NULL AND "waiverReviewId" IS NULL)
  OR ("origin" = 'CUSTOMER_PAYMENT' AND "customerPaymentId" IS NOT NULL AND "invoiceId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL AND "waiverReviewId" IS NULL)
  OR ("origin" = 'CUSTOMER_PAYMENT_RETURN' AND "customerPaymentReturnId" IS NOT NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL AND "waiverReviewId" IS NULL)
  OR ("origin" = 'CUSTOMER_CREDIT_REFUND' AND "customerCreditRefundId" IS NOT NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL AND "waiverReviewId" IS NULL)
  OR ("origin" = 'PURCHASE_INVOICE' AND "purchaseInvoiceId" IS NOT NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL AND "waiverReviewId" IS NULL)
  OR ("origin" = 'PURCHASE_RECTIFICATION' AND "purchaseInvoiceId" IS NOT NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NOT NULL AND "waiverReviewId" IS NULL)
  OR ("origin" = 'SUPPLIER_PAYMENT' AND "supplierPaymentId" IS NOT NULL AND "purchaseInvoiceId" IS NULL AND "supplierCreditRefundId" IS NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL AND "waiverReviewId" IS NULL)
  OR ("origin" = 'SUPPLIER_CREDIT_REFUND' AND "supplierCreditRefundId" IS NOT NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL AND "waiverReviewId" IS NULL)
  OR ("origin" IN ('MANUAL', 'REGULARIZATION', 'CLOSING', 'OPENING') AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL AND "waiverReviewId" IS NULL)
  OR ("origin" = 'FISCAL_YEAR_CLOSE_REVERSAL' AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NOT NULL AND "waiverReviewId" IS NULL)
  OR ("origin" = 'WAIVER_REGULARIZATION' AND "waiverReviewId" IS NOT NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
);

CREATE OR REPLACE FUNCTION "enforce_accounting_waiver_reversal_request_history"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review RECORD; evidence RECORD; target RECORD; reversal RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Accounting waiver reversal requests cannot be deleted.' USING ERRCODE = 'check_violation'; END IF;
  SELECT "status", "version", "decision", "openedById", "closedById" INTO review
    FROM "subscription_renewal_waiver_reviews" WHERE "id" = NEW."reviewId" AND "companyId" = NEW."companyId" FOR UPDATE;
  SELECT "reviewId", "accountingJournalEntryId" INTO evidence
    FROM "subscription_renewal_waiver_review_evidence" WHERE "id" = NEW."evidenceId";
  SELECT journal."origin", journal."status", journal."fiscalYearId", journal."accountingDate", journal."number",
      journal."totalDebit", journal."totalCredit", fiscal."companyId", fiscal."status" AS fiscal_status,
      fiscal."startDate", fiscal."endDate" INTO target
    FROM "accounting_journal_entries" journal JOIN "accounting_fiscal_years" fiscal ON fiscal."id" = journal."fiscalYearId"
    WHERE journal."id" = NEW."targetEntryId" FOR UPDATE OF journal, fiscal;
  IF review."status" <> 'CLOSED' OR review."version" <> 4 OR review."decision" <> 'MANUAL_ACCOUNTING_ACTION_REQUIRED'
    OR evidence."reviewId" <> NEW."reviewId" OR evidence."accountingJournalEntryId" <> NEW."targetEntryId"
    OR target."companyId" <> NEW."companyId" OR target."origin" <> 'WAIVER_REGULARIZATION' OR target."status" <> 'POSTED' THEN
    RAISE EXCEPTION 'Invalid accounting waiver reversal request.' USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."status" = 'COMPLETED') AND (target.fiscal_status <> 'OPEN'
    OR NEW."accountingDate" < target."accountingDate" OR NEW."accountingDate" < target."startDate"
    OR NEW."accountingDate" > target."endDate") THEN
    RAISE EXCEPTION 'The evidenced entry fiscal year must be open for reversal.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."requestedById" = review."openedById" OR NEW."requestedById" = review."closedById" THEN
      RAISE EXCEPTION 'Accounting waiver reversal request requires independent control.' USING ERRCODE = 'check_violation';
    END IF;
    NEW."requestedAt" := clock_timestamp(); NEW."createdAt" := NEW."requestedAt"; NEW."updatedAt" := NEW."requestedAt";
    NEW."targetSnapshot" := jsonb_build_object('number', target."number", 'accountingDate', target."accountingDate",
      'totalDebit', target."totalDebit", 'totalCredit', target."totalCredit", 'validationVersion', 'waiver-reversal-target-v1');
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'REQUESTED' OR OLD."version" <> 1 OR NEW."version" <> 2
    OR (NEW."id", NEW."companyId", NEW."reviewId", NEW."evidenceId", NEW."targetEntryId", NEW."reasonCode",
      NEW."reasonDetail", NEW."accountingDate", NEW."requestedById", NEW."requestedAt", NEW."targetSnapshot", NEW."createdAt")
      IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."reviewId", OLD."evidenceId", OLD."targetEntryId", OLD."reasonCode",
      OLD."reasonDetail", OLD."accountingDate", OLD."requestedById", OLD."requestedAt", OLD."targetSnapshot", OLD."createdAt") THEN
    RAISE EXCEPTION 'Invalid accounting waiver reversal request transition.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'COMPLETED' THEN
    NEW."approvedAt" := clock_timestamp();
    IF NEW."approvedById" = OLD."requestedById" OR NEW."approvedById" = review."openedById" OR NEW."approvedById" = review."closedById" THEN
      RAISE EXCEPTION 'Accounting waiver reversal approval requires independent control.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "id", "origin", "status", "reversesEntryId", "waiverReversalRequestId", "accountingDate", "totalDebit", "totalCredit"
      INTO reversal FROM "accounting_journal_entries" WHERE "waiverReversalRequestId" = NEW."id";
    IF reversal."origin" <> 'WAIVER_REGULARIZATION_REVERSAL' OR reversal."status" <> 'POSTED' OR reversal."reversesEntryId" <> NEW."targetEntryId"
      OR reversal."accountingDate" <> NEW."accountingDate" OR reversal."totalDebit" <> target."totalCredit"
      OR reversal."totalCredit" <> target."totalDebit" THEN
      RAISE EXCEPTION 'Accounting waiver reversal entry is incomplete.' USING ERRCODE = 'check_violation';
    END IF;
    NEW."reversalSnapshot" := jsonb_build_object('entryId', reversal."id", 'accountingDate', reversal."accountingDate",
      'totalDebit', reversal."totalDebit", 'totalCredit', reversal."totalCredit", 'validationVersion', 'waiver-reversal-v1');
  ELSIF NEW."status" = 'REJECTED' THEN
    NEW."rejectedAt" := clock_timestamp();
    IF NEW."rejectedById" = OLD."requestedById" THEN RAISE EXCEPTION 'Requester cannot reject own reversal request.' USING ERRCODE = 'check_violation'; END IF;
  ELSIF NEW."status" = 'CANCELLED' THEN
    NEW."cancelledAt" := clock_timestamp();
    IF NEW."cancelledById" <> OLD."requestedById" THEN RAISE EXCEPTION 'Only requester can cancel reversal request.' USING ERRCODE = 'check_violation'; END IF;
  ELSE RAISE EXCEPTION 'Invalid accounting waiver reversal terminal status.' USING ERRCODE = 'check_violation'; END IF;
  NEW."updatedAt" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "accounting_waiver_reversal_request_history_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "accounting_waiver_reversal_requests"
FOR EACH ROW EXECUTE FUNCTION "enforce_accounting_waiver_reversal_request_history"();

CREATE OR REPLACE FUNCTION "enforce_accounting_waiver_reversal_event_history"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request RECORD; expected_type "AccountingWaiverReversalEventType"; expected_actor UUID; expected_at TIMESTAMPTZ;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Accounting waiver reversal events are append-only.' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO request FROM "accounting_waiver_reversal_requests" WHERE "id" = NEW."requestId" FOR UPDATE;
  expected_type := CASE request."status" WHEN 'REQUESTED' THEN 'REQUESTED'::"AccountingWaiverReversalEventType"
    WHEN 'COMPLETED' THEN 'COMPLETED'::"AccountingWaiverReversalEventType" WHEN 'REJECTED' THEN 'REJECTED'::"AccountingWaiverReversalEventType"
    ELSE 'CANCELLED'::"AccountingWaiverReversalEventType" END;
  expected_actor := CASE request."status" WHEN 'REQUESTED' THEN request."requestedById" WHEN 'COMPLETED' THEN request."approvedById"
    WHEN 'REJECTED' THEN request."rejectedById" ELSE request."cancelledById" END;
  expected_at := CASE request."status" WHEN 'REQUESTED' THEN request."requestedAt" WHEN 'COMPLETED' THEN request."approvedAt"
    WHEN 'REJECTED' THEN request."rejectedAt" ELSE request."cancelledAt" END;
  IF NEW."companyId" <> request."companyId" OR NEW."requestVersion" <> request."version" OR NEW."type" <> expected_type
    OR NEW."actorId" <> expected_actor OR NEW."occurredAt" IS DISTINCT FROM expected_at THEN
    RAISE EXCEPTION 'Invalid accounting waiver reversal event.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "accounting_waiver_reversal_event_history_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "accounting_waiver_reversal_events"
FOR EACH ROW EXECUTE FUNCTION "enforce_accounting_waiver_reversal_event_history"();

CREATE OR REPLACE FUNCTION "assert_accounting_waiver_reversal_consistency"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_id UUID; request RECORD; event_count INTEGER; reversal RECORD; reversal_count INTEGER; mismatch_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'accounting_waiver_reversal_requests' THEN
    request_id := NEW."id";
  ELSE
    request_id := NEW."requestId";
  END IF;
  SELECT * INTO request FROM "accounting_waiver_reversal_requests" WHERE "id" = request_id;
  SELECT count(*) INTO event_count FROM "accounting_waiver_reversal_events" WHERE "requestId" = request_id;
  IF event_count <> request."version" THEN RAISE EXCEPTION 'Every accounting waiver reversal version requires one event.' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO reversal_count FROM "accounting_journal_entries" WHERE "waiverReversalRequestId" = request_id;
  IF request."status" = 'COMPLETED' THEN
    SELECT * INTO reversal FROM "accounting_journal_entries" WHERE "waiverReversalRequestId" = request_id;
    IF reversal_count <> 1 OR reversal."status" <> 'POSTED' THEN
      RAISE EXCEPTION 'A completed accounting waiver reversal requires one posted entry.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO mismatch_count FROM (
      SELECT COALESCE(original."position", reversed."position") AS position
      FROM (SELECT "position", "accountId", "concept", "debit", "credit" FROM "accounting_journal_lines" WHERE "entryId" = request."targetEntryId") original
      FULL JOIN (SELECT "position", "accountId", "concept", "debit", "credit" FROM "accounting_journal_lines" WHERE "entryId" = reversal."id") reversed USING ("position")
      WHERE original."position" IS NULL OR reversed."position" IS NULL OR original."accountId" <> reversed."accountId"
        OR original."concept" <> reversed."concept" OR original."debit" <> reversed."credit" OR original."credit" <> reversed."debit"
    ) mismatch;
    IF reversal."id" IS NULL OR mismatch_count <> 0 THEN RAISE EXCEPTION 'Accounting waiver reversal lines must exactly invert target lines.' USING ERRCODE = 'check_violation'; END IF;
  ELSIF reversal_count <> 0 THEN
    RAISE EXCEPTION 'A non-completed accounting waiver reversal cannot retain an entry.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "accounting_waiver_reversal_request_consistency"
AFTER INSERT OR UPDATE ON "accounting_waiver_reversal_requests"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_accounting_waiver_reversal_consistency"();
CREATE CONSTRAINT TRIGGER "accounting_waiver_reversal_event_consistency"
AFTER INSERT ON "accounting_waiver_reversal_events"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_accounting_waiver_reversal_consistency"();

CREATE OR REPLACE FUNCTION "assert_accounting_waiver_reversal_entry_consistency"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_id UUID; request RECORD; reversal_count INTEGER; reversal RECORD; mismatch_count INTEGER;
BEGIN
  request_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."waiverReversalRequestId" ELSE NEW."waiverReversalRequestId" END;
  IF request_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO request FROM "accounting_waiver_reversal_requests" WHERE "id" = request_id;
  SELECT count(*) INTO reversal_count FROM "accounting_journal_entries" WHERE "waiverReversalRequestId" = request_id;
  IF request."status" <> 'COMPLETED' THEN
    IF reversal_count <> 0 THEN RAISE EXCEPTION 'A non-completed accounting waiver reversal cannot retain an entry.' USING ERRCODE = 'check_violation'; END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO reversal FROM "accounting_journal_entries" WHERE "waiverReversalRequestId" = request_id;
  IF reversal_count <> 1 OR reversal."status" <> 'POSTED' THEN
    RAISE EXCEPTION 'A completed accounting waiver reversal requires one posted entry.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO mismatch_count FROM (
    SELECT COALESCE(original."position", reversed."position") AS position
    FROM (SELECT "position", "accountId", "concept", "debit", "credit" FROM "accounting_journal_lines" WHERE "entryId" = request."targetEntryId") original
    FULL JOIN (SELECT "position", "accountId", "concept", "debit", "credit" FROM "accounting_journal_lines" WHERE "entryId" = reversal."id") reversed USING ("position")
    WHERE original."position" IS NULL OR reversed."position" IS NULL OR original."accountId" <> reversed."accountId"
      OR original."concept" <> reversed."concept" OR original."debit" <> reversed."credit" OR original."credit" <> reversed."debit"
  ) mismatch;
  IF mismatch_count <> 0 THEN RAISE EXCEPTION 'Accounting waiver reversal lines must exactly invert target lines.' USING ERRCODE = 'check_violation'; END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "accounting_waiver_reversal_entry_consistency"
AFTER INSERT OR UPDATE OR DELETE ON "accounting_journal_entries"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_accounting_waiver_reversal_entry_consistency"();

CREATE OR REPLACE FUNCTION "protect_accounting_waiver_reversal_entry_delete"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."waiverReversalRequestId" IS NOT NULL THEN
    RAISE EXCEPTION 'Accounting waiver reversal entries cannot be deleted.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER "accounting_waiver_reversal_entry_delete_guard"
BEFORE DELETE ON "accounting_journal_entries"
FOR EACH ROW EXECUTE FUNCTION "protect_accounting_waiver_reversal_entry_delete"();

-- Extend the existing accounting entry guard with one narrow, request-backed exception.
CREATE OR REPLACE FUNCTION "validate_waiver_regularization_accounting_entry"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review RECORD; fiscal_company_id UUID; reversal_request RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD."waiverReviewId" IS NOT NULL OR OLD."waiverReversalRequestId" IS NOT NULL)
    AND (NEW."origin", NEW."waiverReviewId", NEW."waiverReversalRequestId", NEW."fiscalYearId", NEW."status", NEW."year", NEW."sequence", NEW."number",
      NEW."accountingDate", NEW."concept", NEW."totalDebit", NEW."totalCredit", NEW."createdById", NEW."createdAt")
      IS DISTINCT FROM (OLD."origin", OLD."waiverReviewId", OLD."waiverReversalRequestId", OLD."fiscalYearId", OLD."status", OLD."year", OLD."sequence", OLD."number",
      OLD."accountingDate", OLD."concept", OLD."totalDebit", OLD."totalCredit", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'Accounting waiver evidence entries are immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."origin" = 'WAIVER_REGULARIZATION_REVERSAL' THEN
    SELECT request."status", request."targetEntryId", request."accountingDate", request."companyId", target."fiscalYearId",
      target."totalDebit", target."totalCredit" INTO reversal_request
      FROM "accounting_waiver_reversal_requests" request JOIN "accounting_journal_entries" target ON target."id" = request."targetEntryId"
      WHERE request."id" = NEW."waiverReversalRequestId" FOR UPDATE OF request, target;
    SELECT "companyId" INTO fiscal_company_id FROM "accounting_fiscal_years" WHERE "id" = NEW."fiscalYearId" AND "status" = 'OPEN' FOR UPDATE;
    IF reversal_request."status" <> 'REQUESTED' OR NEW."status" <> 'POSTED' OR reversal_request."targetEntryId" <> NEW."reversesEntryId"
      OR reversal_request."accountingDate" <> NEW."accountingDate" OR reversal_request."fiscalYearId" <> NEW."fiscalYearId"
      OR reversal_request."companyId" <> fiscal_company_id OR NEW."totalDebit" <> reversal_request."totalCredit"
      OR NEW."totalCredit" <> reversal_request."totalDebit" THEN
      RAISE EXCEPTION 'Invalid request-backed waiver regularization reversal.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."reversesEntryId" IS NOT NULL AND EXISTS (SELECT 1 FROM "subscription_renewal_waiver_review_evidence" evidence WHERE evidence."accountingJournalEntryId" = NEW."reversesEntryId") THEN
    RAISE EXCEPTION 'An evidenced waiver regularization requires its dedicated reversal workflow.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."origin" <> 'WAIVER_REGULARIZATION' THEN RETURN NEW; END IF;
  SELECT "companyId", "status", "version", "decision" INTO review FROM "subscription_renewal_waiver_reviews" WHERE "id" = NEW."waiverReviewId" FOR UPDATE;
  SELECT "companyId" INTO fiscal_company_id FROM "accounting_fiscal_years" WHERE "id" = NEW."fiscalYearId";
  IF review."companyId" IS NULL OR fiscal_company_id IS NULL OR review."companyId" <> fiscal_company_id OR review."status" <> 'ACTION_REQUIRED'
    OR review."version" <> 3 OR review."decision" <> 'MANUAL_ACCOUNTING_ACTION_REQUIRED' THEN
    RAISE EXCEPTION 'Invalid waiver review for accounting regularization.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "protect_waiver_regularization_accounting_lines"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_entry_id UUID; new_entry_id UUID;
BEGIN
  old_entry_id := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD."entryId" ELSE NULL END;
  new_entry_id := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW."entryId" ELSE NULL END;
  PERFORM 1 FROM "accounting_journal_entries" journal WHERE journal."id" IN (old_entry_id, new_entry_id)
    AND (journal."waiverReviewId" IS NOT NULL OR journal."waiverReversalRequestId" IS NOT NULL) ORDER BY journal."id" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "subscription_renewal_waiver_review_evidence" evidence WHERE evidence."accountingJournalEntryId" IN (old_entry_id, new_entry_id))
    OR EXISTS (SELECT 1 FROM "accounting_journal_entries" journal JOIN "accounting_waiver_reversal_requests" request
      ON request."id" = journal."waiverReversalRequestId" WHERE journal."id" IN (old_entry_id, new_entry_id) AND request."status" = 'COMPLETED') THEN
    RAISE EXCEPTION 'Accounting waiver evidence lines are immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt") VALUES
  (gen_random_uuid(), 'Accounting.RequestWaiverEvidenceReversals', 'Solicitar reversión de evidencia contable de condonaciones', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Accounting.ApproveWaiverEvidenceReversals', 'Aprobar reversión de evidencia contable de condonaciones', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id" FROM "roles" role JOIN "permissions" permission
  ON permission."code" IN ('Accounting.RequestWaiverEvidenceReversals', 'Accounting.ApproveWaiverEvidenceReversals')
WHERE role."isProtected" = true AND role."code" IN ('Administrator', 'Administrador') ON CONFLICT DO NOTHING;

COMMIT;
