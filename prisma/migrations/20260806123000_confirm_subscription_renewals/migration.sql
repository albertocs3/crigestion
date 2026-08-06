CREATE OR REPLACE FUNCTION "enforce_subscription_header_lifecycle"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW."id", NEW."companyId", NEW."year", NEW."numberSequence", NEW."number", NEW."createdById", NEW."createdAt")
      IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."year", OLD."numberSequence", OLD."number", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'Immutable subscription identity fields cannot change.' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" = 'DRAFT' AND NEW."status" NOT IN ('DRAFT', 'ACTIVE') THEN
    RAISE EXCEPTION 'Invalid subscription status transition.' USING ERRCODE = 'check_violation';
  ELSIF OLD."status" = 'ACTIVE' AND NEW."status" NOT IN ('ACTIVE', 'CANCELLED') THEN
    RAISE EXCEPTION 'Invalid subscription status transition.' USING ERRCODE = 'check_violation';
  ELSIF OLD."status" = 'RENEWAL_PENDING' AND NEW."status" NOT IN ('RENEWAL_PENDING', 'ACTIVE', 'CANCELLED') THEN
    RAISE EXCEPTION 'Invalid subscription status transition.' USING ERRCODE = 'check_violation';
  ELSIF OLD."status" = 'CANCELLED' AND NEW."status" <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Invalid subscription status transition.' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" <> 'DRAFT' AND
     (NEW."customerId", NEW."name", NEW."periodicity", NEW."pricingMode", NEW."paymentMethod",
      NEW."startDate", NEW."endDate", NEW."notes")
       IS DISTINCT FROM
     (OLD."customerId", OLD."name", OLD."periodicity", OLD."pricingMode", OLD."paymentMethod",
      OLD."startDate", OLD."endDate", OLD."notes") THEN
    RAISE EXCEPTION 'Active subscription contract fields cannot change.' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."nextRenewalDate" IS DISTINCT FROM OLD."nextRenewalDate" THEN
    IF OLD."status" = 'DRAFT' THEN
      IF NEW."status" <> 'DRAFT' OR NEW."nextRenewalDate" <> NEW."startDate" OR NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION 'Invalid draft renewal date change.' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF OLD."status" NOT IN ('ACTIVE', 'RENEWAL_PENDING')
        OR NEW."status" <> 'ACTIVE'
        OR NEW."version" <> OLD."version" + 1
        OR NEW."nextRenewalDate" <> "subscription_next_renewal_date"(OLD."nextRenewalDate", OLD."periodicity")
        OR NOT EXISTS (
          SELECT 1
          FROM "subscription_renewal_reservations" reservation
          JOIN "invoices" invoice ON invoice."id" = reservation."invoiceId" AND invoice."companyId" = reservation."companyId"
          WHERE reservation."companyId" = OLD."companyId"
            AND reservation."subscriptionId" = OLD."id"
            AND reservation."status" = 'RESERVED'
            AND reservation."periodStart" = OLD."nextRenewalDate"
            AND reservation."periodEndExclusive" = NEW."nextRenewalDate"
            AND reservation."subscriptionVersionSnapshot" = OLD."version"
            AND invoice."origin" = 'SUBSCRIPTION'
            AND invoice."documentType" = 'STANDARD'
            AND invoice."status" = 'ISSUED'
            AND invoice."issuedAt" IS NOT NULL
        ) THEN
        RAISE EXCEPTION 'Invalid subscription renewal advance.' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF OLD."activatedAt" IS NOT NULL AND
     (NEW."activatedAt", NEW."activatedById") IS DISTINCT FROM (OLD."activatedAt", OLD."activatedById") THEN
    RAISE EXCEPTION 'Subscription activation evidence is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."cancelledAt" IS NOT NULL AND
     (NEW."cancelledAt", NEW."cancelledById", NEW."cancellationEffectiveDate", NEW."cancellationReason")
       IS DISTINCT FROM
     (OLD."cancelledAt", OLD."cancelledById", OLD."cancellationEffectiveDate", OLD."cancellationReason") THEN
    RAISE EXCEPTION 'Subscription cancellation evidence is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'ACTIVE' THEN
    IF NOT EXISTS (SELECT 1 FROM "subscription_lines" WHERE "subscriptionId" = OLD."id") THEN
      RAISE EXCEPTION 'An active subscription requires at least one line.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."pricingMode" = 'FIXED' AND EXISTS (
      SELECT 1 FROM "subscription_lines" WHERE "subscriptionId" = OLD."id" AND "quantity" <> 1
    ) THEN
      RAISE EXCEPTION 'Fixed subscriptions require quantity one.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "assert_subscription_renewal_advance_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' AND NEW."nextRenewalDate" IS DISTINCT FROM OLD."nextRenewalDate" THEN
    IF NEW."nextRenewalDate" <= OLD."nextRenewalDate"
      OR NEW."version" <> OLD."version" + 1
      OR NEW."status" <> 'ACTIVE'
      OR NOT EXISTS (
        SELECT 1
        FROM "subscription_renewal_reservations" reservation
        WHERE reservation."companyId" = NEW."companyId"
          AND reservation."subscriptionId" = NEW."id"
          AND reservation."status" = 'BILLED'
          AND reservation."periodStart" = OLD."nextRenewalDate"
          AND reservation."periodEndExclusive" = NEW."nextRenewalDate"
          AND reservation."subscriptionVersionSnapshot" = OLD."version"
      ) THEN
      RAISE EXCEPTION 'Subscription renewal advancement requires matching billed evidence.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "subscription_renewal_advance_consistency_trigger"
AFTER UPDATE OF "nextRenewalDate", "version", "status" ON "subscriptions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_subscription_renewal_advance_consistency"();

CREATE FUNCTION "assert_billed_renewal_final_closure"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" = 'BILLED' AND OLD."status" <> 'BILLED' AND NOT EXISTS (
    SELECT 1
    FROM "subscription_renewal_reservations" reservation
    JOIN "invoices" invoice ON invoice."id" = reservation."invoiceId" AND invoice."companyId" = reservation."companyId"
    JOIN "subscriptions" subscription ON subscription."id" = reservation."subscriptionId" AND subscription."companyId" = reservation."companyId"
    WHERE reservation."id" = NEW."id"
      AND reservation."status" = 'BILLED'
      AND invoice."origin" = 'SUBSCRIPTION'
      AND invoice."documentType" = 'STANDARD'
      AND invoice."status" = 'ISSUED'
      AND invoice."issuedAt" = reservation."billedAt"
      AND EXISTS (
        SELECT 1
        FROM "accounting_journal_entries" entry
        WHERE entry."invoiceId" = invoice."id"
          AND entry."origin" = 'INVOICE'
          AND entry."status" = 'POSTED'
          AND entry."totalDebit" = invoice."total"
          AND entry."totalCredit" = invoice."total"
          AND EXISTS (
            SELECT 1 FROM "accounting_journal_lines" line WHERE line."entryId" = entry."id"
          )
          AND entry."totalDebit" = (
            SELECT COALESCE(SUM(line."debit"), 0) FROM "accounting_journal_lines" line WHERE line."entryId" = entry."id"
          )
          AND entry."totalCredit" = (
            SELECT COALESCE(SUM(line."credit"), 0) FROM "accounting_journal_lines" line WHERE line."entryId" = entry."id"
          )
      )
      AND (
        (
          invoice."verifactuStatus" = 'NOT_APPLICABLE'
          AND EXISTS (
            SELECT 1
            FROM "invoice_verifactu_records" disabled_record
            WHERE disabled_record."invoiceId" = invoice."id"
              AND disabled_record."status" = 'PENDING'
          )
        )
        OR (
          invoice."verifactuStatus" = 'PENDING'
          AND EXISTS (
            SELECT 1
            FROM "verifactu_fiscal_records" fiscal_record
            JOIN "verifactu_outbox_messages" outbox ON outbox."fiscalRecordId" = fiscal_record."id"
            WHERE fiscal_record."invoiceId" = invoice."id"
              AND fiscal_record."recordType" = 'ALTA'
              AND outbox."operation" = 'SUBMIT'
          )
        )
      )
      AND EXISTS (
        SELECT 1
        FROM "audit_events" invoice_audit
        WHERE invoice_audit."eventType" = 'INVOICE_ISSUED'
          AND invoice_audit."payload"->>'invoiceId' = invoice."id"::text
      )
      AND EXISTS (
        SELECT 1
        FROM "audit_events" renewal_audit
        WHERE renewal_audit."eventType" = 'SUBSCRIPTION_RENEWAL_BILLED'
          AND renewal_audit."payload"->>'invoiceId' = invoice."id"::text
      )
      AND EXISTS (
        SELECT 1
        FROM "idempotency_records" replay
        WHERE replay."responseStatus" = 200
          AND replay."responseBody"->>'invoiceId' = invoice."id"::text
      )
      AND subscription."status" = 'ACTIVE'
      AND subscription."nextRenewalDate" = reservation."periodEndExclusive"
      AND subscription."version" = reservation."subscriptionVersionSnapshot" + 1
  ) THEN
    RAISE EXCEPTION 'Billed renewal final closure is inconsistent.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "billed_renewal_final_closure_trigger"
AFTER UPDATE OF "status", "billedAt" ON "subscription_renewal_reservations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_billed_renewal_final_closure"();

CREATE FUNCTION "invoice_has_billed_subscription_renewal"(target_invoice_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "subscription_renewal_reservations"
    WHERE "invoiceId" = target_invoice_id AND "status" = 'BILLED'
  );
$$;

CREATE FUNCTION "prevent_billed_renewal_accounting_entry_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."invoiceId" IS NOT NULL AND "invoice_has_billed_subscription_renewal"(OLD."invoiceId") THEN
    RAISE EXCEPTION 'Billed renewal accounting evidence is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "billed_renewal_accounting_entries_immutable"
BEFORE UPDATE OR DELETE ON "accounting_journal_entries"
FOR EACH ROW EXECUTE FUNCTION "prevent_billed_renewal_accounting_entry_mutation"();

CREATE FUNCTION "prevent_billed_renewal_accounting_line_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE target_entry_id UUID;
BEGIN
  target_entry_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."entryId" ELSE NEW."entryId" END;
  IF EXISTS (
    SELECT 1
    FROM "accounting_journal_entries" entry
    WHERE entry."id" = target_entry_id
      AND entry."invoiceId" IS NOT NULL
      AND "invoice_has_billed_subscription_renewal"(entry."invoiceId")
  ) THEN
    RAISE EXCEPTION 'Billed renewal accounting lines are immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "billed_renewal_accounting_lines_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "accounting_journal_lines"
FOR EACH ROW EXECUTE FUNCTION "prevent_billed_renewal_accounting_line_mutation"();

CREATE FUNCTION "prevent_billed_renewal_process_evidence_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE target_invoice_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'audit_events' THEN
    IF OLD."eventType" NOT IN ('INVOICE_ISSUED', 'SUBSCRIPTION_RENEWAL_BILLED') THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    target_invoice_id := OLD."payload"->>'invoiceId';
  ELSE
    target_invoice_id := OLD."responseBody"->>'invoiceId';
  END IF;
  IF target_invoice_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "subscription_renewal_reservations" reservation
    WHERE reservation."invoiceId"::text = target_invoice_id AND reservation."status" = 'BILLED'
  ) THEN
    RAISE EXCEPTION 'Billed renewal process evidence is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "billed_renewal_audits_immutable"
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION "prevent_billed_renewal_process_evidence_mutation"();

CREATE TRIGGER "billed_renewal_idempotency_immutable"
BEFORE UPDATE OR DELETE ON "idempotency_records"
FOR EACH ROW EXECUTE FUNCTION "prevent_billed_renewal_process_evidence_mutation"();

CREATE FUNCTION "prevent_billed_renewal_disabled_fiscal_record_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF "invoice_has_billed_subscription_renewal"(OLD."invoiceId") THEN
    RAISE EXCEPTION 'Billed renewal disabled fiscal evidence is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "billed_renewal_disabled_fiscal_records_immutable"
BEFORE UPDATE OR DELETE ON "invoice_verifactu_records"
FOR EACH ROW EXECUTE FUNCTION "prevent_billed_renewal_disabled_fiscal_record_mutation"();

CREATE FUNCTION "prevent_billed_renewal_fiscal_record_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF "invoice_has_billed_subscription_renewal"(OLD."invoiceId") THEN
    RAISE EXCEPTION 'Billed renewal fiscal evidence is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "billed_renewal_fiscal_records_immutable"
BEFORE UPDATE OR DELETE ON "verifactu_fiscal_records"
FOR EACH ROW EXECUTE FUNCTION "prevent_billed_renewal_fiscal_record_mutation"();

CREATE FUNCTION "prevent_billed_renewal_outbox_identity_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE target_invoice_id UUID;
BEGIN
  SELECT fiscal_record."invoiceId" INTO target_invoice_id
  FROM "verifactu_fiscal_records" fiscal_record
  WHERE fiscal_record."id" = OLD."fiscalRecordId";

  IF target_invoice_id IS NOT NULL AND "invoice_has_billed_subscription_renewal"(target_invoice_id) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Billed renewal outbox identity is immutable.' USING ERRCODE = 'check_violation';
    ELSIF (NEW."id", NEW."fiscalRecordId", NEW."operation", NEW."idempotencyKey", NEW."bodySha256", NEW."createdAt")
         IS DISTINCT FROM
       (OLD."id", OLD."fiscalRecordId", OLD."operation", OLD."idempotencyKey", OLD."bodySha256", OLD."createdAt") THEN
      RAISE EXCEPTION 'Billed renewal outbox identity is immutable.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "billed_renewal_outbox_identity_immutable"
BEFORE UPDATE OR DELETE ON "verifactu_outbox_messages"
FOR EACH ROW EXECUTE FUNCTION "prevent_billed_renewal_outbox_identity_mutation"();
