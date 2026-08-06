BEGIN;

ALTER TABLE "subscription_renewal_waiver_reviews"
  ADD COLUMN "completionDetail" VARCHAR(500);

ALTER TABLE "accounting_journal_entries"
  ADD COLUMN "waiverReviewId" UUID,
  ADD CONSTRAINT "accounting_journal_entries_waiverReviewId_key" UNIQUE ("waiverReviewId"),
  ADD CONSTRAINT "accounting_journal_entries_waiverReviewId_fkey"
    FOREIGN KEY ("waiverReviewId") REFERENCES "subscription_renewal_waiver_reviews" ("id") ON DELETE RESTRICT;

ALTER TABLE "accounting_journal_entries" DROP CONSTRAINT IF EXISTS "accounting_journal_entries_origin_source_check";
ALTER TABLE "accounting_journal_entries" ADD CONSTRAINT "accounting_journal_entries_origin_source_check" CHECK (
  ("origin" = 'INVOICE' AND "invoiceId" IS NOT NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL AND "waiverReviewId" IS NULL)
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

CREATE TABLE "subscription_renewal_waiver_review_evidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "reviewId" UUID NOT NULL,
  "kind" "SubscriptionRenewalWaiverReviewEvidenceKind" NOT NULL,
  "accountingJournalEntryId" UUID NOT NULL,
  "evidenceSnapshot" JSONB NOT NULL,
  "addedById" UUID NOT NULL,
  "addedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "correlationId" VARCHAR(100),
  CONSTRAINT "subscription_renewal_waiver_review_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_renewal_waiver_review_evidence_entry_key" UNIQUE ("accountingJournalEntryId"),
  CONSTRAINT "subscription_renewal_waiver_review_evidence_review_kind_key" UNIQUE ("reviewId", "kind"),
  CONSTRAINT "subscription_renewal_waiver_review_evidence_review_fkey"
    FOREIGN KEY ("reviewId", "companyId") REFERENCES "subscription_renewal_waiver_reviews" ("id", "companyId") ON DELETE RESTRICT,
  CONSTRAINT "subscription_renewal_waiver_review_evidence_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies" ("id") ON DELETE RESTRICT,
  CONSTRAINT "subscription_renewal_waiver_review_evidence_entry_fkey"
    FOREIGN KEY ("accountingJournalEntryId") REFERENCES "accounting_journal_entries" ("id") ON DELETE RESTRICT,
  CONSTRAINT "subscription_renewal_waiver_review_evidence_addedBy_fkey"
    FOREIGN KEY ("addedById") REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "subscription_renewal_waiver_review_evidence_snapshot_chk"
    CHECK ("kind" = 'ACCOUNTING_JOURNAL_ENTRY' AND jsonb_typeof("evidenceSnapshot") = 'object')
);

CREATE INDEX "subscription_renewal_waiver_review_evidence_review_added_idx"
  ON "subscription_renewal_waiver_review_evidence" ("reviewId", "addedAt", "id");
CREATE INDEX "subscription_renewal_waiver_review_evidence_company_kind_added_idx"
  ON "subscription_renewal_waiver_review_evidence" ("companyId", "kind", "addedAt", "id");

CREATE OR REPLACE FUNCTION "validate_waiver_regularization_accounting_entry"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review RECORD; fiscal_company_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."waiverReviewId" IS NOT NULL
    AND (NEW."origin", NEW."waiverReviewId", NEW."fiscalYearId", NEW."status", NEW."year", NEW."sequence", NEW."number",
      NEW."accountingDate", NEW."concept", NEW."totalDebit", NEW."totalCredit", NEW."createdById", NEW."createdAt")
      IS DISTINCT FROM
      (OLD."origin", OLD."waiverReviewId", OLD."fiscalYearId", OLD."status", OLD."year", OLD."sequence", OLD."number",
      OLD."accountingDate", OLD."concept", OLD."totalDebit", OLD."totalCredit", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'Accounting waiver regularization evidence is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reversesEntryId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "subscription_renewal_waiver_review_evidence" evidence
    WHERE evidence."accountingJournalEntryId" = NEW."reversesEntryId"
  ) THEN
    RAISE EXCEPTION 'An evidenced waiver regularization requires a dedicated supersession workflow.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."origin" <> 'WAIVER_REGULARIZATION' THEN RETURN NEW; END IF;
  SELECT "companyId", "status", "version", "decision" INTO review
    FROM "subscription_renewal_waiver_reviews" WHERE "id" = NEW."waiverReviewId" FOR UPDATE;
  SELECT "companyId" INTO fiscal_company_id FROM "accounting_fiscal_years" WHERE "id" = NEW."fiscalYearId";
  IF review."companyId" IS NULL OR fiscal_company_id IS NULL OR review."companyId" <> fiscal_company_id OR review."status" <> 'ACTION_REQUIRED'
    OR review."version" <> 3 OR review."decision" <> 'MANUAL_ACCOUNTING_ACTION_REQUIRED' THEN
    RAISE EXCEPTION 'Invalid waiver review for accounting regularization.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "accounting_journal_entry_waiver_review_guard"
BEFORE INSERT OR UPDATE ON "accounting_journal_entries"
FOR EACH ROW EXECUTE FUNCTION "validate_waiver_regularization_accounting_entry"();

CREATE OR REPLACE FUNCTION "protect_waiver_regularization_accounting_lines"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_entry_id UUID; new_entry_id UUID;
BEGIN
  old_entry_id := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD."entryId" ELSE NULL END;
  new_entry_id := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW."entryId" ELSE NULL END;
  PERFORM 1 FROM "accounting_journal_entries" journal
    WHERE journal."id" IN (old_entry_id, new_entry_id) AND journal."waiverReviewId" IS NOT NULL
    ORDER BY journal."id" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "subscription_renewal_waiver_review_evidence" evidence
    WHERE evidence."accountingJournalEntryId" IN (old_entry_id, new_entry_id)) THEN
    RAISE EXCEPTION 'Accounting waiver regularization evidence lines are immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "accounting_journal_line_waiver_evidence_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "accounting_journal_lines"
FOR EACH ROW EXECUTE FUNCTION "protect_waiver_regularization_accounting_lines"();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "subscription_renewal_waiver_reviews"
    WHERE ("status" IN ('ACTION_REQUIRED', 'ESCALATED') AND "version" <> 3)
      OR ("status" = 'CLOSED' AND ("version" <> 3 OR "decision" <> 'NO_ADDITIONAL_ACTION'))) THEN
    RAISE EXCEPTION 'Existing fiscal review state is incompatible with accounting completion.';
  END IF;
  IF EXISTS (SELECT 1 FROM "subscription_renewal_waiver_reviews" review
    WHERE (SELECT count(*) FROM "subscription_renewal_waiver_review_events" event WHERE event."reviewId" = review."id") <> review."version") THEN
    RAISE EXCEPTION 'Existing fiscal review ledger contains version gaps.';
  END IF;
END;
$$;

ALTER TABLE "subscription_renewal_waiver_reviews"
  DROP CONSTRAINT "subscription_renewal_waiver_reviews_evidence_chk";
ALTER TABLE "subscription_renewal_waiver_reviews"
  ADD CONSTRAINT "subscription_renewal_waiver_reviews_evidence_chk" CHECK (
    ("status" = 'PENDING' AND "version" = 1 AND "startedById" IS NULL AND "startedAt" IS NULL
      AND "decision" IS NULL AND "decisionDetail" IS NULL AND "actionDueDate" IS NULL
      AND "decidedById" IS NULL AND "decidedAt" IS NULL AND "closedById" IS NULL AND "closedAt" IS NULL AND "completionDetail" IS NULL)
    OR ("status" = 'IN_REVIEW' AND "version" = 2 AND "startedById" IS NOT NULL AND "startedById" <> "openedById"
      AND "startedAt" IS NOT NULL AND "startedAt" >= "openedAt" AND "decision" IS NULL AND "decisionDetail" IS NULL
      AND "actionDueDate" IS NULL AND "decidedById" IS NULL AND "decidedAt" IS NULL AND "closedById" IS NULL AND "closedAt" IS NULL AND "completionDetail" IS NULL)
    OR ("status" IN ('ESCALATED', 'ACTION_REQUIRED', 'CLOSED') AND "version" = 3
      AND "startedById" IS NOT NULL AND "startedById" <> "openedById" AND "startedAt" IS NOT NULL AND "startedAt" >= "openedAt"
      AND "decision" IS NOT NULL AND "decisionDetail" IS NOT NULL AND length(btrim("decisionDetail")) >= 10
      AND "decidedById" = "startedById" AND "decidedAt" IS NOT NULL AND "decidedAt" >= "startedAt" AND "completionDetail" IS NULL
      AND (("status" = 'CLOSED' AND "decision" = 'NO_ADDITIONAL_ACTION' AND "actionDueDate" IS NULL AND "closedById" = "decidedById" AND "closedAt" = "decidedAt")
        OR ("status" = 'ESCALATED' AND "decision" = 'EXTERNAL_ADVICE_REQUIRED' AND "actionDueDate" IS NOT NULL AND "actionDueDate" >= ("decidedAt" AT TIME ZONE 'Europe/Madrid')::date AND "closedById" IS NULL AND "closedAt" IS NULL)
        OR ("status" = 'ACTION_REQUIRED' AND "decision" IN ('MANUAL_ACCOUNTING_ACTION_REQUIRED', 'BILLING_REGULARIZATION_REQUIRED', 'EXTERNAL_FISCAL_ACTION_REQUIRED')
          AND "actionDueDate" IS NOT NULL AND "actionDueDate" >= ("decidedAt" AT TIME ZONE 'Europe/Madrid')::date AND "closedById" IS NULL AND "closedAt" IS NULL)))
    OR ("status" = 'CLOSED' AND "version" = 4 AND "decision" = 'MANUAL_ACCOUNTING_ACTION_REQUIRED'
      AND "startedById" IS NOT NULL AND "startedById" <> "openedById" AND "startedAt" IS NOT NULL
      AND "decisionDetail" IS NOT NULL AND "actionDueDate" IS NOT NULL AND "decidedById" = "startedById" AND "decidedAt" IS NOT NULL
      AND "closedById" = "decidedById" AND "closedAt" IS NOT NULL AND "closedAt" >= "decidedAt"
      AND "completionDetail" IS NOT NULL AND length(btrim("completionDetail")) >= 10)
  );

ALTER TABLE "subscription_renewal_waiver_review_events"
  DROP CONSTRAINT "subscription_renewal_waiver_review_events_evidence_chk";
ALTER TABLE "subscription_renewal_waiver_review_events"
  ADD CONSTRAINT "subscription_renewal_waiver_review_events_evidence_chk" CHECK (
    "reviewVersion" > 0 AND (
      ("type" IN ('OPENED', 'STARTED') AND "decision" IS NULL)
      OR ("type" IN ('DECIDED', 'COMPLETED') AND "decision" IS NOT NULL)
    )
  );

CREATE OR REPLACE FUNCTION "enforce_subscription_renewal_waiver_review_evidence_history"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review RECORD; entry RECORD; line_stats RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Subscription renewal waiver review evidence is append-only.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "status", "version", "decision", "openedById", "startedById" INTO review
    FROM "subscription_renewal_waiver_reviews" WHERE "id" = NEW."reviewId" AND "companyId" = NEW."companyId" FOR UPDATE;
  SELECT journal."origin", journal."status", journal."waiverReviewId", journal."number", journal."accountingDate",
      journal."fiscalYearId", journal."totalDebit", journal."totalCredit", fiscal."companyId" AS "companyId",
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
  IF NOT FOUND OR review."status" <> 'ACTION_REQUIRED' OR review."version" <> 3
    OR review."decision" <> 'MANUAL_ACCOUNTING_ACTION_REQUIRED' OR NEW."kind" <> 'ACCOUNTING_JOURNAL_ENTRY'
    OR NEW."addedById" <> review."startedById" OR NEW."addedById" = review."openedById"
    OR entry."companyId" <> NEW."companyId" OR entry."waiverReviewId" <> NEW."reviewId"
    OR entry."origin" <> 'WAIVER_REGULARIZATION' OR entry."status" <> 'POSTED' OR entry.reversed
    OR entry."totalDebit" <= 0 OR entry."totalDebit" <> entry."totalCredit"
    OR line_stats.line_count < 2 OR NOT line_stats.valid_lines
    OR line_stats.total_debit <> entry."totalDebit" OR line_stats.total_credit <> entry."totalCredit" THEN
    RAISE EXCEPTION 'Invalid accounting evidence for subscription renewal waiver review.' USING ERRCODE = 'check_violation';
  END IF;
  NEW."addedAt" := clock_timestamp();
  NEW."evidenceSnapshot" := jsonb_build_object('number', entry."number", 'accountingDate', entry."accountingDate",
    'origin', entry."origin", 'totalDebit', entry."totalDebit", 'totalCredit', entry."totalCredit",
    'lines', (SELECT jsonb_agg(jsonb_build_object('position', line."position", 'accountCode', account."code",
      'debit', line."debit", 'credit', line."credit") ORDER BY line."position")
      FROM "accounting_journal_lines" line JOIN "accounting_accounts" account ON account."id" = line."accountId"
      WHERE line."entryId" = NEW."accountingJournalEntryId"),
    'validationVersion', 'accounting-waiver-v1');
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_renewal_waiver_review_evidence_history_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "subscription_renewal_waiver_review_evidence"
FOR EACH ROW EXECUTE FUNCTION "enforce_subscription_renewal_waiver_review_evidence_history"();

CREATE OR REPLACE FUNCTION "enforce_subscription_renewal_waiver_review_history"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Subscription renewal waiver reviews cannot be deleted.' USING ERRCODE = 'check_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT exclusion."status", exclusion."resolution", exclusion."resolvedById" INTO parent
      FROM "subscription_renewal_exclusions" exclusion WHERE exclusion."id" = NEW."exclusionId" AND exclusion."companyId" = NEW."companyId" FOR UPDATE;
    IF NEW."source" <> 'CURRENT_WORKFLOW' OR NOT FOUND OR parent."status" <> 'RESOLVED' OR parent."resolution" <> 'WAIVED'
      OR parent."resolvedById" <> NEW."openedById"
      OR NOT EXISTS (SELECT 1 FROM "subscription_renewal_waiver_snapshots" snapshot WHERE snapshot."exclusionId" = NEW."exclusionId")
      OR NOT EXISTS (SELECT 1 FROM "subscription_renewal_waiver_tax_summaries" tax WHERE tax."exclusionId" = NEW."exclusionId") THEN
      RAISE EXCEPTION 'Invalid subscription renewal waiver review source.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'CLOSED' THEN RAISE EXCEPTION 'Closed subscription renewal waiver reviews are immutable.' USING ERRCODE = 'check_violation'; END IF;
  IF (NEW."id", NEW."companyId", NEW."exclusionId", NEW."source", NEW."openedById", NEW."openedAt")
    IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."exclusionId", OLD."source", OLD."openedById", OLD."openedAt") THEN
    RAISE EXCEPTION 'Fiscal review identity is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'IN_REVIEW' AND (NEW."startedById", NEW."startedAt") IS DISTINCT FROM (OLD."startedById", OLD."startedAt") THEN
    RAISE EXCEPTION 'Fiscal review assignment is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."exclusionId", NEW."source", NEW."openedById", NEW."openedAt",
      NEW."startedById", NEW."startedAt", NEW."decision", NEW."decisionDetail", NEW."actionDueDate", NEW."decidedById", NEW."decidedAt")
    IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."exclusionId", OLD."source", OLD."openedById", OLD."openedAt",
      OLD."startedById", OLD."startedAt", OLD."decision", OLD."decisionDetail", OLD."actionDueDate", OLD."decidedById", OLD."decidedAt")
    AND OLD."status" IN ('ACTION_REQUIRED', 'ESCALATED') THEN
    RAISE EXCEPTION 'Fiscal review decision history is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."version" <> OLD."version" + 1 OR NOT (
      (OLD."status" = 'PENDING' AND NEW."status" = 'IN_REVIEW')
      OR (OLD."status" = 'IN_REVIEW' AND NEW."status" IN ('ESCALATED', 'ACTION_REQUIRED', 'CLOSED'))
      OR (OLD."status" = 'ACTION_REQUIRED' AND OLD."decision" = 'MANUAL_ACCOUNTING_ACTION_REQUIRED' AND NEW."status" = 'CLOSED'
        AND NEW."closedById" = OLD."startedById" AND EXISTS (SELECT 1 FROM "subscription_renewal_waiver_review_evidence" evidence
          WHERE evidence."reviewId" = OLD."id" AND evidence."kind" = 'ACCOUNTING_JOURNAL_ENTRY' AND evidence."addedAt" <= NEW."closedAt"))
    ) THEN RAISE EXCEPTION 'Invalid subscription renewal waiver review transition.' USING ERRCODE = 'check_violation'; END IF;
  SELECT "resolvedById" INTO parent FROM "subscription_renewal_exclusions"
    WHERE "id" = NEW."exclusionId" AND "companyId" = NEW."companyId" FOR UPDATE;
  IF NEW."startedById" = parent."resolvedById" OR NEW."decidedById" = parent."resolvedById" OR NEW."closedById" = parent."resolvedById" THEN
    RAISE EXCEPTION 'A waiver cannot be fiscally reviewed by its maker.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_subscription_renewal_waiver_review_event_history"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Subscription renewal waiver review events are append-only.' USING ERRCODE = 'check_violation'; END IF;
  SELECT "version", "status", "openedById", "openedAt", "startedById", "startedAt", "decidedById", "decidedAt",
      "closedById", "closedAt", "decision" INTO review FROM "subscription_renewal_waiver_reviews"
    WHERE "id" = NEW."reviewId" AND "companyId" = NEW."companyId" FOR UPDATE;
  IF NOT FOUND OR NEW."reviewVersion" <> review."version"
    OR (NEW."type" = 'OPENED' AND (review."version" <> 1 OR NEW."actorId" <> review."openedById" OR NEW."occurredAt" IS DISTINCT FROM review."openedAt"))
    OR (NEW."type" = 'STARTED' AND (review."status" <> 'IN_REVIEW' OR NEW."actorId" <> review."startedById" OR NEW."occurredAt" IS DISTINCT FROM review."startedAt"))
    OR (NEW."type" = 'DECIDED' AND (review."version" <> 3 OR NEW."actorId" <> review."decidedById" OR NEW."decision" IS DISTINCT FROM review."decision" OR NEW."occurredAt" IS DISTINCT FROM review."decidedAt"))
    OR (NEW."type" = 'COMPLETED' AND (review."status" <> 'CLOSED' OR review."version" <> 4 OR NEW."actorId" <> review."closedById"
      OR NEW."decision" IS DISTINCT FROM review."decision" OR NEW."occurredAt" IS DISTINCT FROM review."closedAt")) THEN
    RAISE EXCEPTION 'Invalid subscription renewal waiver review event.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "assert_subscription_renewal_waiver_review_consistency"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_exclusion_id UUID; target_review_id UUID; parent RECORD; review_count INTEGER;
  current_review_version INTEGER; current_review_status "SubscriptionRenewalWaiverReviewStatus";
  current_review_decision "SubscriptionRenewalWaiverReviewDecision"; event_count INTEGER; minimum_event_version INTEGER; maximum_event_version INTEGER; evidence_count INTEGER;
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
    SELECT count(*) INTO evidence_count FROM "subscription_renewal_waiver_review_evidence" WHERE "reviewId" = target_review_id;
    IF current_review_status = 'CLOSED' AND current_review_version = 4 AND current_review_decision = 'MANUAL_ACCOUNTING_ACTION_REQUIRED' AND evidence_count <> 1 THEN
      RAISE EXCEPTION 'Completed accounting review requires exactly one evidence record.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "subscription_renewal_waiver_review_evidence_consistency"
AFTER INSERT ON "subscription_renewal_waiver_review_evidence"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_subscription_renewal_waiver_review_consistency"();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Subscriptions.CompleteRenewalWaiverFiscalReviews', 'Completar revisiones fiscales de periodos condonados', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id" FROM "roles" role JOIN "permissions" permission
  ON permission."code" = 'Subscriptions.CompleteRenewalWaiverFiscalReviews'
WHERE role."isProtected" = true AND role."code" IN ('Administrator', 'Administrador') ON CONFLICT DO NOTHING;

COMMIT;
