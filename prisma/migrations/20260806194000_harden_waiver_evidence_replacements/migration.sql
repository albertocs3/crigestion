BEGIN;

ALTER TABLE "subscription_renewal_waiver_review_evidence"
  ADD CONSTRAINT "subscription_renewal_waiver_review_evidence_chain_chk" CHECK (
    "sequence" > 0 AND (
      ("sequence" = 1 AND "supersedesEvidenceId" IS NULL AND "replacementRequestId" IS NULL)
      OR ("sequence" > 1 AND "supersedesEvidenceId" IS NOT NULL AND "replacementRequestId" IS NOT NULL)
    )
  );

ALTER TABLE "accounting_journal_entries"
  DROP CONSTRAINT "accounting_journal_entries_origin_source_check";
ALTER TABLE "accounting_journal_entries"
  ADD CONSTRAINT "accounting_journal_entries_waiver_replacement_source_chk" CHECK (
    ("origin" = 'WAIVER_REGULARIZATION_REPLACEMENT' AND "waiverReplacementRequestId" IS NOT NULL
      AND "waiverReviewId" IS NULL AND "waiverReversalRequestId" IS NULL AND "reversesEntryId" IS NULL
      AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL
      AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL
      AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL)
    OR ("origin" <> 'WAIVER_REGULARIZATION_REPLACEMENT' AND "waiverReplacementRequestId" IS NULL)
  );
ALTER TABLE "accounting_journal_entries"
  ADD CONSTRAINT "accounting_journal_entries_origin_source_check" CHECK (
    "origin" IN ('WAIVER_REGULARIZATION_REVERSAL', 'WAIVER_REGULARIZATION_REPLACEMENT')
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

CREATE OR REPLACE FUNCTION "enforce_accounting_waiver_replacement_request_history"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review RECORD; source_evidence RECORD; reversal RECORD; fiscal RECORD; replacement RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Accounting waiver replacement requests cannot be deleted.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "status", "version", "decision", "openedById", "closedById" INTO review
    FROM "subscription_renewal_waiver_reviews" WHERE "id" = NEW."reviewId" AND "companyId" = NEW."companyId" FOR UPDATE;
  SELECT evidence."reviewId", evidence."accountingJournalEntryId", evidence."sequence",
      NOT EXISTS (SELECT 1 FROM "subscription_renewal_waiver_review_evidence" child WHERE child."supersedesEvidenceId" = evidence."id") AS is_leaf
    INTO source_evidence FROM "subscription_renewal_waiver_review_evidence" evidence WHERE evidence."id" = NEW."sourceEvidenceId";
  SELECT "status", "evidenceId", "targetEntryId", "reasonCode", "accountingDate" INTO reversal
    FROM "accounting_waiver_reversal_requests" WHERE "id" = NEW."reversalRequestId";
  SELECT "companyId", "status", "startDate", "endDate" INTO fiscal
    FROM "accounting_fiscal_years" WHERE "id" = NEW."fiscalYearId" FOR UPDATE;
  IF review."status" <> 'CLOSED' OR review."version" <> 4 OR review."decision" <> 'MANUAL_ACCOUNTING_ACTION_REQUIRED'
    OR source_evidence."reviewId" <> NEW."reviewId" OR (TG_OP = 'INSERT' AND NOT source_evidence.is_leaf)
    OR reversal."status" <> 'COMPLETED' OR reversal."evidenceId" <> NEW."sourceEvidenceId"
    OR reversal."targetEntryId" <> source_evidence."accountingJournalEntryId"
    OR reversal."reasonCode" = 'DUPLICATE_REGULARIZATION' OR fiscal."companyId" <> NEW."companyId" THEN
    RAISE EXCEPTION 'Invalid accounting waiver evidence replacement request.' USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."status" = 'COMPLETED') AND (fiscal."status" <> 'OPEN'
    OR NEW."accountingDate" < reversal."accountingDate" OR NEW."accountingDate" < fiscal."startDate"
    OR NEW."accountingDate" > fiscal."endDate") THEN
    RAISE EXCEPTION 'The waiver replacement fiscal year must be open.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."requestedById" IN (review."openedById", review."closedById") THEN
      RAISE EXCEPTION 'Accounting waiver replacement request requires independent control.' USING ERRCODE = 'check_violation';
    END IF;
    NEW."requestedAt" := clock_timestamp(); NEW."createdAt" := NEW."requestedAt"; NEW."updatedAt" := NEW."requestedAt";
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'REQUESTED' OR OLD."version" <> 1 OR NEW."version" <> 2
    OR (NEW."id", NEW."companyId", NEW."reviewId", NEW."sourceEvidenceId", NEW."reversalRequestId", NEW."fiscalYearId",
      NEW."reasonCode", NEW."reasonDetail", NEW."accountingDate", NEW."concept", NEW."requestedById", NEW."requestedAt",
      NEW."proposalSnapshot", NEW."createdAt") IS DISTINCT FROM
      (OLD."id", OLD."companyId", OLD."reviewId", OLD."sourceEvidenceId", OLD."reversalRequestId", OLD."fiscalYearId",
      OLD."reasonCode", OLD."reasonDetail", OLD."accountingDate", OLD."concept", OLD."requestedById", OLD."requestedAt",
      OLD."proposalSnapshot", OLD."createdAt") THEN
    RAISE EXCEPTION 'Invalid accounting waiver replacement request transition.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'COMPLETED' THEN
    NEW."approvedAt" := clock_timestamp();
    IF NEW."approvedById" IN (OLD."requestedById", review."openedById", review."closedById") THEN
      RAISE EXCEPTION 'Accounting waiver replacement approval requires independent control.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "id", "origin", "status", "fiscalYearId", "accountingDate", "concept", "totalDebit", "totalCredit", "createdById"
      INTO replacement FROM "accounting_journal_entries" WHERE "waiverReplacementRequestId" = NEW."id";
    IF replacement."origin" <> 'WAIVER_REGULARIZATION_REPLACEMENT' OR replacement."status" <> 'POSTED'
      OR replacement."fiscalYearId" <> NEW."fiscalYearId" OR replacement."accountingDate" <> NEW."accountingDate"
      OR replacement."concept" <> NEW."concept" OR replacement."createdById" <> NEW."approvedById"
      OR replacement."totalDebit" <= 0 OR replacement."totalDebit" <> replacement."totalCredit" THEN
      RAISE EXCEPTION 'Accounting waiver replacement entry is incomplete.' USING ERRCODE = 'check_violation';
    END IF;
    NEW."replacementSnapshot" := jsonb_build_object('entryId', replacement."id", 'accountingDate', replacement."accountingDate",
      'totalDebit', replacement."totalDebit", 'totalCredit', replacement."totalCredit", 'validationVersion', 'waiver-replacement-v1');
  ELSIF NEW."status" = 'REJECTED' THEN
    NEW."rejectedAt" := clock_timestamp();
    IF NEW."rejectedById" = OLD."requestedById" THEN RAISE EXCEPTION 'Requester cannot reject own replacement request.' USING ERRCODE = 'check_violation'; END IF;
  ELSIF NEW."status" = 'CANCELLED' THEN
    NEW."cancelledAt" := clock_timestamp();
    IF NEW."cancelledById" <> OLD."requestedById" THEN RAISE EXCEPTION 'Only requester can cancel replacement request.' USING ERRCODE = 'check_violation'; END IF;
  ELSE RAISE EXCEPTION 'Invalid accounting waiver replacement terminal status.' USING ERRCODE = 'check_violation'; END IF;
  NEW."updatedAt" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "accounting_waiver_replacement_request_history_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "accounting_waiver_evidence_replacement_requests"
FOR EACH ROW EXECUTE FUNCTION "enforce_accounting_waiver_replacement_request_history"();

CREATE OR REPLACE FUNCTION "enforce_accounting_waiver_replacement_line_history"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_status "AccountingWaiverReplacementRequestStatus"; request_fiscal_year UUID; event_exists BOOLEAN; account_valid BOOLEAN;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Accounting waiver replacement proposal lines are append-only.' USING ERRCODE = 'check_violation'; END IF;
  SELECT "status", "fiscalYearId", EXISTS (SELECT 1 FROM "accounting_waiver_evidence_replacement_events" event WHERE event."requestId" = NEW."requestId")
    INTO request_status, request_fiscal_year, event_exists FROM "accounting_waiver_evidence_replacement_requests" WHERE "id" = NEW."requestId" FOR UPDATE;
  SELECT "fiscalYearId" = request_fiscal_year AND "status" = 'ACTIVE' AND "isPostable" INTO account_valid
    FROM "accounting_accounts" WHERE "id" = NEW."accountId";
  IF request_status <> 'REQUESTED' OR event_exists OR NOT COALESCE(account_valid, false) THEN
    RAISE EXCEPTION 'Invalid accounting waiver replacement proposal line.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "accounting_waiver_replacement_line_history_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "accounting_waiver_evidence_replacement_lines"
FOR EACH ROW EXECUTE FUNCTION "enforce_accounting_waiver_replacement_line_history"();

CREATE OR REPLACE FUNCTION "enforce_accounting_waiver_replacement_event_history"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request RECORD; expected_type "AccountingWaiverReplacementEventType"; expected_actor UUID; expected_at TIMESTAMPTZ;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Accounting waiver replacement events are append-only.' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO request FROM "accounting_waiver_evidence_replacement_requests" WHERE "id" = NEW."requestId" FOR UPDATE;
  expected_type := request."status"::text::"AccountingWaiverReplacementEventType";
  expected_actor := CASE request."status" WHEN 'REQUESTED' THEN request."requestedById" WHEN 'COMPLETED' THEN request."approvedById"
    WHEN 'REJECTED' THEN request."rejectedById" ELSE request."cancelledById" END;
  expected_at := CASE request."status" WHEN 'REQUESTED' THEN request."requestedAt" WHEN 'COMPLETED' THEN request."approvedAt"
    WHEN 'REJECTED' THEN request."rejectedAt" ELSE request."cancelledAt" END;
  IF NEW."companyId" <> request."companyId" OR NEW."requestVersion" <> request."version" OR NEW."type" <> expected_type
    OR NEW."actorId" <> expected_actor OR NEW."occurredAt" IS DISTINCT FROM expected_at THEN
    RAISE EXCEPTION 'Invalid accounting waiver replacement event.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "accounting_waiver_replacement_event_history_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "accounting_waiver_evidence_replacement_events"
FOR EACH ROW EXECUTE FUNCTION "enforce_accounting_waiver_replacement_event_history"();

CREATE OR REPLACE FUNCTION "assert_accounting_waiver_replacement_consistency"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_id UUID; request RECORD; event_count INTEGER; line_stats RECORD; replacement RECORD; result_count INTEGER; mismatch_count INTEGER;
BEGIN
  request_id := CASE TG_TABLE_NAME
    WHEN 'accounting_waiver_evidence_replacement_requests' THEN NEW."id"
    WHEN 'accounting_waiver_evidence_replacement_events' THEN NEW."requestId"
    WHEN 'accounting_waiver_evidence_replacement_lines' THEN NEW."requestId"
    WHEN 'accounting_journal_entries' THEN NEW."waiverReplacementRequestId"
    ELSE NEW."replacementRequestId" END;
  IF request_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO request FROM "accounting_waiver_evidence_replacement_requests" WHERE "id" = request_id;
  SELECT count(*) INTO event_count FROM "accounting_waiver_evidence_replacement_events" WHERE "requestId" = request_id;
  SELECT count(*) AS line_count, COALESCE(sum("debit"), 0) AS debit, COALESCE(sum("credit"), 0) AS credit
    INTO line_stats FROM "accounting_waiver_evidence_replacement_lines" WHERE "requestId" = request_id;
  IF event_count <> request."version" OR line_stats.line_count < 2 OR line_stats.debit <= 0 OR line_stats.debit <> line_stats.credit THEN
    RAISE EXCEPTION 'Accounting waiver replacement proposal ledger is inconsistent.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO result_count FROM "accounting_journal_entries" WHERE "waiverReplacementRequestId" = request_id;
  IF request."status" = 'COMPLETED' THEN
    SELECT * INTO replacement FROM "accounting_journal_entries" WHERE "waiverReplacementRequestId" = request_id;
    IF result_count <> 1 OR replacement."status" <> 'POSTED' OR
      (SELECT count(*) FROM "subscription_renewal_waiver_review_evidence" evidence
        JOIN "subscription_renewal_waiver_review_evidence" source ON source."id" = evidence."supersedesEvidenceId"
        WHERE evidence."replacementRequestId" = request_id AND evidence."reviewId" = request."reviewId"
          AND evidence."companyId" = request."companyId" AND evidence."kind" = source."kind"
          AND evidence."accountingJournalEntryId" = replacement."id" AND evidence."addedById" = request."approvedById"
          AND evidence."supersedesEvidenceId" = request."sourceEvidenceId" AND evidence."sequence" = source."sequence" + 1) <> 1 THEN
      RAISE EXCEPTION 'Completed accounting waiver replacement requires one posted entry and one evidence.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO mismatch_count FROM (
      SELECT COALESCE(proposal."position", journal."position")
      FROM (SELECT "position", "accountId", "concept", "debit", "credit" FROM "accounting_waiver_evidence_replacement_lines" WHERE "requestId" = request_id) proposal
      FULL JOIN (SELECT "position", "accountId", "concept", "debit", "credit" FROM "accounting_journal_lines" WHERE "entryId" = replacement."id") journal USING ("position")
      WHERE proposal."position" IS NULL OR journal."position" IS NULL OR proposal."accountId" <> journal."accountId"
        OR proposal."concept" <> journal."concept" OR proposal."debit" <> journal."debit" OR proposal."credit" <> journal."credit"
    ) mismatch;
    IF mismatch_count <> 0 THEN RAISE EXCEPTION 'Accounting waiver replacement must exactly match its approved proposal.' USING ERRCODE = 'check_violation'; END IF;
  ELSIF result_count <> 0 OR EXISTS (SELECT 1 FROM "subscription_renewal_waiver_review_evidence" WHERE "replacementRequestId" = request_id) THEN
    RAISE EXCEPTION 'Non-completed accounting waiver replacement cannot retain results.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "accounting_waiver_replacement_request_consistency" AFTER INSERT OR UPDATE ON "accounting_waiver_evidence_replacement_requests"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_accounting_waiver_replacement_consistency"();
CREATE CONSTRAINT TRIGGER "accounting_waiver_replacement_event_consistency" AFTER INSERT ON "accounting_waiver_evidence_replacement_events"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_accounting_waiver_replacement_consistency"();
CREATE CONSTRAINT TRIGGER "accounting_waiver_replacement_line_consistency" AFTER INSERT ON "accounting_waiver_evidence_replacement_lines"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_accounting_waiver_replacement_consistency"();
CREATE CONSTRAINT TRIGGER "accounting_waiver_replacement_entry_consistency" AFTER INSERT OR UPDATE ON "accounting_journal_entries"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_accounting_waiver_replacement_consistency"();
CREATE CONSTRAINT TRIGGER "accounting_waiver_replacement_evidence_consistency" AFTER INSERT ON "subscription_renewal_waiver_review_evidence"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_accounting_waiver_replacement_consistency"();

CREATE OR REPLACE FUNCTION "enforce_subscription_renewal_waiver_review_evidence_history"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review RECORD; entry RECORD; line_stats RECORD; replacement RECORD; source_evidence RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Subscription renewal waiver review evidence is append-only.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "status", "version", "decision", "openedById", "startedById", "closedById" INTO review
    FROM "subscription_renewal_waiver_reviews" WHERE "id" = NEW."reviewId" AND "companyId" = NEW."companyId" FOR UPDATE;
  SELECT journal."origin", journal."status", journal."waiverReviewId", journal."waiverReplacementRequestId", journal."number",
      journal."accountingDate", journal."fiscalYearId", journal."totalDebit", journal."totalCredit", fiscal."companyId" AS "companyId",
      EXISTS (SELECT 1 FROM "accounting_journal_entries" reversal WHERE reversal."reversesEntryId" = journal."id") AS reversed
    INTO entry FROM "accounting_journal_entries" journal
    JOIN "accounting_fiscal_years" fiscal ON fiscal."id" = journal."fiscalYearId"
    WHERE journal."id" = NEW."accountingJournalEntryId" FOR UPDATE OF journal;
  SELECT count(*) AS line_count, COALESCE(sum(line."debit"), 0) AS total_debit,
      COALESCE(sum(line."credit"), 0) AS total_credit,
      COALESCE(bool_and(account."fiscalYearId" = entry."fiscalYearId" AND account."status" = 'ACTIVE'
        AND account."isPostable" AND ((line."debit" > 0 AND line."credit" = 0) OR (line."credit" > 0 AND line."debit" = 0))), false) AS valid_lines
    INTO line_stats FROM "accounting_journal_lines" line
    LEFT JOIN "accounting_accounts" account ON account."id" = line."accountId"
    WHERE line."entryId" = NEW."accountingJournalEntryId";
  IF NEW."kind" <> 'ACCOUNTING_JOURNAL_ENTRY' OR entry."companyId" <> NEW."companyId" OR entry."status" <> 'POSTED'
    OR entry.reversed OR entry."totalDebit" <= 0 OR entry."totalDebit" <> entry."totalCredit"
    OR line_stats.line_count < 2 OR NOT line_stats.valid_lines
    OR line_stats.total_debit <> entry."totalDebit" OR line_stats.total_credit <> entry."totalCredit" THEN
    RAISE EXCEPTION 'Invalid accounting evidence for subscription renewal waiver review.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."replacementRequestId" IS NULL THEN
    IF review."status" <> 'ACTION_REQUIRED' OR review."version" <> 3 OR review."decision" <> 'MANUAL_ACCOUNTING_ACTION_REQUIRED'
      OR NEW."sequence" <> 1 OR NEW."supersedesEvidenceId" IS NOT NULL OR NEW."addedById" <> review."startedById"
      OR NEW."addedById" = review."openedById" OR entry."waiverReviewId" <> NEW."reviewId"
      OR entry."origin" <> 'WAIVER_REGULARIZATION' THEN
      RAISE EXCEPTION 'Invalid initial accounting evidence for subscription renewal waiver review.' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT "status", "reviewId", "sourceEvidenceId", "fiscalYearId", "accountingDate", "requestedById"
      INTO replacement FROM "accounting_waiver_evidence_replacement_requests" WHERE "id" = NEW."replacementRequestId" FOR UPDATE;
    SELECT "reviewId", "companyId", "kind", "sequence" INTO source_evidence
      FROM "subscription_renewal_waiver_review_evidence" WHERE "id" = NEW."supersedesEvidenceId";
    IF review."status" <> 'CLOSED' OR review."version" <> 4 OR review."decision" <> 'MANUAL_ACCOUNTING_ACTION_REQUIRED'
      OR replacement."status" <> 'REQUESTED' OR replacement."reviewId" <> NEW."reviewId"
      OR replacement."sourceEvidenceId" <> NEW."supersedesEvidenceId"
      OR source_evidence."reviewId" <> NEW."reviewId" OR source_evidence."companyId" <> NEW."companyId"
      OR source_evidence."kind" <> NEW."kind" OR NEW."sequence" <> source_evidence."sequence" + 1
      OR EXISTS (SELECT 1 FROM "subscription_renewal_waiver_review_evidence" child WHERE child."supersedesEvidenceId" = NEW."supersedesEvidenceId")
      OR entry."origin" <> 'WAIVER_REGULARIZATION_REPLACEMENT' OR entry."waiverReplacementRequestId" <> NEW."replacementRequestId"
      OR entry."fiscalYearId" <> replacement."fiscalYearId" OR entry."accountingDate" <> replacement."accountingDate"
      OR NEW."addedById" IN (replacement."requestedById", review."openedById", review."closedById") THEN
      RAISE EXCEPTION 'Invalid replacement accounting evidence for subscription renewal waiver review.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW."addedAt" := clock_timestamp();
  NEW."evidenceSnapshot" := jsonb_build_object('number', entry."number", 'accountingDate', entry."accountingDate",
    'origin', entry."origin", 'totalDebit', entry."totalDebit", 'totalCredit', entry."totalCredit",
    'lines', (SELECT jsonb_agg(jsonb_build_object('position', line."position", 'accountCode', account."code",
      'debit', line."debit", 'credit', line."credit") ORDER BY line."position")
      FROM "accounting_journal_lines" line JOIN "accounting_accounts" account ON account."id" = line."accountId"
      WHERE line."entryId" = NEW."accountingJournalEntryId"),
    'validationVersion', CASE WHEN NEW."replacementRequestId" IS NULL THEN 'accounting-waiver-v1' ELSE 'accounting-waiver-replacement-v1' END);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "protect_accounting_waiver_replacement_entry"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."waiverReplacementRequestId" IS NOT NULL THEN
    RAISE EXCEPTION 'Accounting waiver replacement entries cannot be deleted.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."waiverReplacementRequestId" IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Accounting waiver replacement entries are immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER "accounting_waiver_replacement_entry_guard"
BEFORE UPDATE OR DELETE ON "accounting_journal_entries"
FOR EACH ROW EXECUTE FUNCTION "protect_accounting_waiver_replacement_entry"();

CREATE OR REPLACE FUNCTION "assert_subscription_renewal_waiver_review_consistency"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_exclusion_id UUID; target_review_id UUID; parent RECORD; review_count INTEGER;
  current_review_version INTEGER; current_review_status "SubscriptionRenewalWaiverReviewStatus";
  current_review_decision "SubscriptionRenewalWaiverReviewDecision"; event_count INTEGER; minimum_event_version INTEGER;
  maximum_event_version INTEGER; evidence_count INTEGER; root_count INTEGER; leaf_count INTEGER; maximum_sequence INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'subscription_renewal_exclusions' THEN target_exclusion_id := NEW."id"; SELECT "id" INTO target_review_id FROM "subscription_renewal_waiver_reviews" WHERE "exclusionId" = target_exclusion_id;
  ELSIF TG_TABLE_NAME = 'subscription_renewal_waiver_reviews' THEN target_exclusion_id := NEW."exclusionId"; target_review_id := NEW."id";
  ELSIF TG_TABLE_NAME = 'subscription_renewal_waiver_review_events' THEN target_review_id := NEW."reviewId"; SELECT "exclusionId" INTO target_exclusion_id FROM "subscription_renewal_waiver_reviews" WHERE "id" = target_review_id;
  ELSE target_review_id := NEW."reviewId"; SELECT "exclusionId" INTO target_exclusion_id FROM "subscription_renewal_waiver_reviews" WHERE "id" = target_review_id; END IF;
  SELECT "status", "resolution" INTO parent FROM "subscription_renewal_exclusions" WHERE "id" = target_exclusion_id;
  SELECT count(*) INTO review_count FROM "subscription_renewal_waiver_reviews" WHERE "exclusionId" = target_exclusion_id;
  IF parent."status" = 'RESOLVED' AND parent."resolution" = 'WAIVED' THEN
    IF review_count <> 1 THEN RAISE EXCEPTION 'Waived renewal requires exactly one fiscal review.' USING ERRCODE = 'check_violation'; END IF;
  ELSIF review_count <> 0 THEN RAISE EXCEPTION 'Only waived renewals may have fiscal reviews.' USING ERRCODE = 'check_violation'; END IF;
  IF target_review_id IS NOT NULL THEN
    SELECT "version", "status", "decision" INTO current_review_version, current_review_status, current_review_decision
      FROM "subscription_renewal_waiver_reviews" WHERE "id" = target_review_id;
    SELECT count(*), min("reviewVersion"), max("reviewVersion") INTO event_count, minimum_event_version, maximum_event_version
      FROM "subscription_renewal_waiver_review_events" WHERE "reviewId" = target_review_id;
    IF event_count <> current_review_version OR minimum_event_version <> 1 OR maximum_event_version <> current_review_version THEN
      RAISE EXCEPTION 'Every fiscal review version requires one ledger event.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*), count(*) FILTER (WHERE "sequence" = 1),
      count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "subscription_renewal_waiver_review_evidence" child WHERE child."supersedesEvidenceId" = evidence."id")),
      max("sequence") INTO evidence_count, root_count, leaf_count, maximum_sequence
      FROM "subscription_renewal_waiver_review_evidence" evidence WHERE "reviewId" = target_review_id;
    IF current_review_status = 'CLOSED' AND current_review_version = 4 AND current_review_decision = 'MANUAL_ACCOUNTING_ACTION_REQUIRED'
      AND (evidence_count < 1 OR root_count <> 1 OR leaf_count <> 1 OR maximum_sequence <> evidence_count) THEN
      RAISE EXCEPTION 'Completed accounting review requires one contiguous evidence chain.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

COMMIT;
