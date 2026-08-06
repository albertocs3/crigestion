CREATE TYPE "SubscriptionRenewalReservationStatus" AS ENUM ('RESERVED', 'BILLED', 'RELEASED');

CREATE UNIQUE INDEX "invoice_lines_id_invoiceId_key" ON "invoice_lines"("id", "invoiceId");

CREATE TABLE "subscription_renewal_reservations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "paymentMethod" "CustomerPaymentMethod" NOT NULL,
  "subscriptionId" UUID NOT NULL,
  "invoiceId" UUID NOT NULL,
  "status" "SubscriptionRenewalReservationStatus" NOT NULL DEFAULT 'RESERVED',
  "periodStart" DATE NOT NULL,
  "periodEndExclusive" DATE NOT NULL,
  "subscriptionVersionSnapshot" INTEGER NOT NULL,
  "reservedById" UUID NOT NULL,
  "reservedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "billedAt" TIMESTAMPTZ(3),
  "releasedById" UUID,
  "releasedAt" TIMESTAMPTZ(3),
  "releaseReason" VARCHAR(500),
  CONSTRAINT "subscription_renewal_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_renewal_reservations_period_chk" CHECK ("periodEndExclusive" > "periodStart"),
  CONSTRAINT "subscription_renewal_reservations_version_chk" CHECK ("subscriptionVersionSnapshot" > 0),
  CONSTRAINT "subscription_renewal_reservations_evidence_chk" CHECK (
    ("status" = 'RESERVED' AND "billedAt" IS NULL AND "releasedById" IS NULL AND "releasedAt" IS NULL AND "releaseReason" IS NULL)
    OR ("status" = 'BILLED' AND "billedAt" IS NOT NULL AND "billedAt" >= "reservedAt"
      AND "releasedById" IS NULL AND "releasedAt" IS NULL AND "releaseReason" IS NULL)
    OR ("status" = 'RELEASED' AND "billedAt" IS NULL AND "releasedById" IS NOT NULL AND "releasedAt" IS NOT NULL
      AND "releasedAt" >= "reservedAt" AND "releaseReason" IS NOT NULL AND btrim("releaseReason") <> '')
  ),
  CONSTRAINT "subscription_renewal_reservations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_renewal_reservations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_renewal_reservations_subscription_company_fkey" FOREIGN KEY ("subscriptionId", "companyId") REFERENCES "subscriptions"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_renewal_reservations_invoice_company_fkey" FOREIGN KEY ("invoiceId", "companyId") REFERENCES "invoices"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_renewal_reservations_reservedById_fkey" FOREIGN KEY ("reservedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_renewal_reservations_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "subscription_renewal_reservations_identity_key"
  ON "subscription_renewal_reservations"("companyId", "subscriptionId", "periodStart")
  WHERE "status" IN ('RESERVED', 'BILLED');
CREATE UNIQUE INDEX "subscription_renewal_reservations_composite_key"
  ON "subscription_renewal_reservations"("id", "companyId", "subscriptionId", "invoiceId", "periodStart");
CREATE INDEX "subscription_renewal_reservations_invoice_id_idx" ON "subscription_renewal_reservations"("invoiceId", "id");
CREATE INDEX "subscription_renewal_reservations_company_period_idx" ON "subscription_renewal_reservations"("companyId", "periodStart", "id");

CREATE TABLE "subscription_renewal_reservation_lines" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "reservationId" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "subscriptionId" UUID NOT NULL,
  "subscriptionLineId" UUID NOT NULL,
  "invoiceId" UUID NOT NULL,
  "invoiceLineId" UUID NOT NULL,
  "periodStart" DATE NOT NULL,
  "reservedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_renewal_reservation_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_renewal_reservation_lines_reservation_fkey"
    FOREIGN KEY ("reservationId", "companyId", "subscriptionId", "invoiceId", "periodStart")
    REFERENCES "subscription_renewal_reservations"("id", "companyId", "subscriptionId", "invoiceId", "periodStart") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_renewal_reservation_lines_subscription_line_fkey"
    FOREIGN KEY ("subscriptionLineId", "subscriptionId") REFERENCES "subscription_lines"("id", "subscriptionId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_renewal_reservation_lines_invoice_line_fkey"
    FOREIGN KEY ("invoiceLineId", "invoiceId") REFERENCES "invoice_lines"("id", "invoiceId") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "subscription_renewal_reservation_lines_reservation_source_key"
  ON "subscription_renewal_reservation_lines"("reservationId", "subscriptionLineId");
CREATE UNIQUE INDEX "subscription_renewal_reservation_lines_invoiceLineId_key"
  ON "subscription_renewal_reservation_lines"("invoiceLineId");
CREATE UNIQUE INDEX "subscription_renewal_reservation_lines_invoice_line_key"
  ON "subscription_renewal_reservation_lines"("invoiceLineId", "invoiceId");
CREATE INDEX "subscription_renewal_reservation_lines_invoice_id_idx"
  ON "subscription_renewal_reservation_lines"("invoiceId", "id");

CREATE FUNCTION "subscription_next_renewal_date"(period_start DATE, periodicity "SubscriptionPeriodicity")
RETURNS DATE
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE periodicity
    WHEN 'MONTHLY' THEN (period_start + INTERVAL '1 month')::date
    WHEN 'QUARTERLY' THEN (period_start + INTERVAL '3 months')::date
    WHEN 'SEMIANNUAL' THEN (period_start + INTERVAL '6 months')::date
    WHEN 'ANNUAL' THEN (period_start + INTERVAL '1 year')::date
  END
$$;

CREATE FUNCTION "enforce_subscription_renewal_reservation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent RECORD;
  draft RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Subscription renewal reservation history cannot be deleted.' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'RESERVED' THEN
      RAISE EXCEPTION 'A renewal reservation must start reserved.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "status", "version", "customerId", "paymentMethod", "periodicity", "nextRenewalDate", "endDate"
      INTO parent FROM "subscriptions"
      WHERE "id" = NEW."subscriptionId" AND "companyId" = NEW."companyId" FOR UPDATE;
    IF NOT FOUND OR parent."status" NOT IN ('ACTIVE', 'RENEWAL_PENDING')
      OR parent."version" <> NEW."subscriptionVersionSnapshot"
      OR parent."customerId" <> NEW."customerId"
      OR parent."paymentMethod" <> NEW."paymentMethod"
      OR parent."nextRenewalDate" <> NEW."periodStart"
      OR "subscription_next_renewal_date"(NEW."periodStart", parent."periodicity") <> NEW."periodEndExclusive"
      OR (parent."endDate" IS NOT NULL AND NEW."periodStart" > parent."endDate") THEN
      RAISE EXCEPTION 'Invalid subscription renewal reservation source.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "origin", "documentType", "status", "companyId", "customerId", "total"
      INTO draft FROM "invoices" WHERE "id" = NEW."invoiceId" FOR UPDATE;
    IF NOT FOUND OR draft."origin" <> 'SUBSCRIPTION' OR draft."documentType" <> 'STANDARD' OR draft."status" <> 'DRAFT'
      OR draft."companyId" <> NEW."companyId" OR draft."customerId" <> NEW."customerId"
      OR NOT EXISTS (
        SELECT 1 FROM "invoice_due_dates" due_date
        WHERE due_date."invoiceId" = NEW."invoiceId" AND due_date."paymentMethod" = NEW."paymentMethod"
        GROUP BY due_date."invoiceId" HAVING sum(due_date."amount") = draft."total"
      ) THEN
      RAISE EXCEPTION 'Invalid subscription renewal invoice draft.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" <> 'RESERVED' OR NEW."status" NOT IN ('BILLED', 'RELEASED') THEN
    RAISE EXCEPTION 'Terminal renewal reservation history is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."customerId", NEW."paymentMethod", NEW."subscriptionId", NEW."invoiceId",
      NEW."periodStart", NEW."periodEndExclusive", NEW."subscriptionVersionSnapshot", NEW."reservedById", NEW."reservedAt")
     IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."customerId", OLD."paymentMethod", OLD."subscriptionId", OLD."invoiceId",
      OLD."periodStart", OLD."periodEndExclusive", OLD."subscriptionVersionSnapshot", OLD."reservedById", OLD."reservedAt") THEN
    RAISE EXCEPTION 'Renewal reservation identity is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'BILLED' AND (
    NOT EXISTS (SELECT 1 FROM "invoices" WHERE "id" = NEW."invoiceId" AND "status" = 'ISSUED' AND "issuedAt" = NEW."billedAt")
    OR NOT EXISTS (SELECT 1 FROM "subscriptions" WHERE "id" = NEW."subscriptionId" AND "companyId" = NEW."companyId"
      AND "status" IN ('ACTIVE', 'RENEWAL_PENDING') AND "nextRenewalDate" = NEW."periodEndExclusive"
      AND "version" = NEW."subscriptionVersionSnapshot" + 1)
  ) THEN
    RAISE EXCEPTION 'A reservation can only be billed by its issued invoice.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'RELEASED' AND NOT EXISTS (
    SELECT 1 FROM "invoices" WHERE "id" = NEW."invoiceId" AND "status" = 'DRAFT'
  ) THEN
    RAISE EXCEPTION 'Only a draft invoice renewal reservation can be released.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_renewal_reservation_history_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "subscription_renewal_reservations"
FOR EACH ROW EXECUTE FUNCTION "enforce_subscription_renewal_reservation"();

CREATE FUNCTION "enforce_subscription_renewal_reservation_line"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Subscription renewal reservation line history is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_renewal_reservation_line_history_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "subscription_renewal_reservation_lines"
FOR EACH ROW EXECUTE FUNCTION "enforce_subscription_renewal_reservation_line"();

CREATE FUNCTION "assert_subscription_renewal_reservation_complete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'subscription_renewal_reservations' THEN
    target_id := NEW."id";
  ELSE
    target_id := NEW."reservationId";
  END IF;
  IF EXISTS (
    SELECT 1 FROM "subscription_renewal_reservations" reservation
    WHERE reservation."id" = target_id AND reservation."status" IN ('RESERVED', 'BILLED')
      AND (
        (SELECT count(*) FROM "subscription_lines" line WHERE line."subscriptionId" = reservation."subscriptionId")
        <> (SELECT count(*) FROM "subscription_renewal_reservation_lines" source WHERE source."reservationId" = reservation."id")
        OR (SELECT count(*) FROM "invoice_lines" line WHERE line."invoiceId" = reservation."invoiceId")
        <> (SELECT count(*) FROM "subscription_renewal_reservation_lines" source
          JOIN "subscription_renewal_reservations" sibling ON sibling."id" = source."reservationId"
          WHERE sibling."invoiceId" = reservation."invoiceId")
        OR EXISTS (
          SELECT 1 FROM "subscription_renewal_reservation_lines" source
          WHERE source."reservationId" = reservation."id" AND source."invoiceId" <> reservation."invoiceId"
        )
        OR EXISTS (
          SELECT 1
          FROM "subscription_renewal_reservation_lines" source
          JOIN "subscription_lines" subscription_line ON subscription_line."id" = source."subscriptionLineId"
          JOIN "invoice_lines" invoice_line ON invoice_line."id" = source."invoiceLineId"
          WHERE source."reservationId" = reservation."id"
            AND (invoice_line."catalogItemId", invoice_line."catalogItemCodeSnapshot", invoice_line."catalogItemKindSnapshot",
              invoice_line."description", invoice_line."quantity", invoice_line."unitPrice", invoice_line."discountPercent",
              invoice_line."discountAmount", invoice_line."taxRateId", invoice_line."taxRateCodeSnapshot",
              invoice_line."taxRateNameSnapshot", invoice_line."taxRateSnapshot")
              IS DISTINCT FROM
              (subscription_line."catalogItemId", subscription_line."catalogItemCodeSnapshot", subscription_line."catalogItemKindSnapshot",
              subscription_line."description", subscription_line."quantity", subscription_line."unitPrice", subscription_line."discountPercent",
              subscription_line."discountAmount", subscription_line."taxRateId", subscription_line."taxRateCodeSnapshot",
              subscription_line."taxRateNameSnapshot", subscription_line."taxRateSnapshot")
        )
      )
  ) THEN
    RAISE EXCEPTION 'A renewal reservation must map every subscription line exactly once.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "subscription_renewal_reservation_complete_trigger"
AFTER INSERT OR UPDATE ON "subscription_renewal_reservations"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_subscription_renewal_reservation_complete"();
CREATE CONSTRAINT TRIGGER "subscription_renewal_reservation_line_complete_trigger"
AFTER INSERT ON "subscription_renewal_reservation_lines"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_subscription_renewal_reservation_complete"();

CREATE FUNCTION "assert_subscription_invoice_reservation_status"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_invoice_id UUID;
  invoice_state RECORD;
BEGIN
  IF TG_TABLE_NAME = 'invoices' THEN
    target_invoice_id := NEW."id";
  ELSE
    target_invoice_id := NEW."invoiceId";
  END IF;
  SELECT "origin", "status" INTO invoice_state FROM "invoices" WHERE "id" = target_invoice_id;
  IF FOUND AND invoice_state."origin" = 'SUBSCRIPTION'
    AND invoice_state."status" = 'ISSUED'
    AND (NOT EXISTS (SELECT 1 FROM "subscription_renewal_reservations" WHERE "invoiceId" = target_invoice_id)
      OR EXISTS (SELECT 1 FROM "subscription_renewal_reservations" WHERE "invoiceId" = target_invoice_id AND "status" <> 'BILLED')) THEN
    RAISE EXCEPTION 'An issued subscription invoice requires every renewal reservation to be billed.' USING ERRCODE = 'check_violation';
  END IF;
  IF FOUND AND invoice_state."origin" = 'SUBSCRIPTION'
    AND invoice_state."status" = 'DRAFT'
    AND EXISTS (SELECT 1 FROM "subscription_renewal_reservations" WHERE "invoiceId" = target_invoice_id AND "status" = 'BILLED') THEN
    RAISE EXCEPTION 'A draft subscription invoice cannot have billed renewal reservations.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "subscription_invoice_reservation_status_trigger"
AFTER INSERT OR UPDATE ON "invoices"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_subscription_invoice_reservation_status"();
CREATE CONSTRAINT TRIGGER "renewal_reservation_invoice_status_trigger"
AFTER INSERT OR UPDATE ON "subscription_renewal_reservations"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_subscription_invoice_reservation_status"();

CREATE FUNCTION "assert_subscription_invoice_reservation_group_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "subscription_renewal_reservations" sibling
    WHERE sibling."invoiceId" = NEW."invoiceId" AND sibling."status" <> NEW."status"
  ) THEN
    RAISE EXCEPTION 'All renewal reservations in one invoice must share the same state.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "renewal_reservation_group_state_trigger"
AFTER INSERT OR UPDATE ON "subscription_renewal_reservations"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_subscription_invoice_reservation_group_state"();

CREATE FUNCTION "prevent_reserved_invoice_detail_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_invoice_id UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    target_invoice_id := NEW."invoiceId";
  ELSIF TG_OP = 'DELETE' THEN
    target_invoice_id := OLD."invoiceId";
  ELSE
    IF EXISTS (SELECT 1 FROM "subscription_renewal_reservations"
      WHERE "invoiceId" IN (OLD."invoiceId", NEW."invoiceId") AND "status" IN ('RESERVED', 'BILLED')) THEN
      RAISE EXCEPTION 'Reserved subscription renewal invoice detail is immutable.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM "subscription_renewal_reservations" WHERE "invoiceId" = target_invoice_id AND "status" IN ('RESERVED', 'BILLED')) THEN
    RAISE EXCEPTION 'Reserved subscription renewal invoice detail is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER "reserved_invoice_lines_immutable_trigger" BEFORE INSERT OR UPDATE OR DELETE ON "invoice_lines"
FOR EACH ROW EXECUTE FUNCTION "prevent_reserved_invoice_detail_mutation"();
CREATE TRIGGER "reserved_invoice_tax_summaries_immutable_trigger" BEFORE INSERT OR UPDATE OR DELETE ON "invoice_tax_summaries"
FOR EACH ROW EXECUTE FUNCTION "prevent_reserved_invoice_detail_mutation"();

CREATE FUNCTION "prevent_reserved_invoice_due_date_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reservation_status "SubscriptionRenewalReservationStatus";
  target_invoice_id UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    target_invoice_id := NEW."invoiceId";
  ELSIF TG_OP = 'DELETE' THEN
    target_invoice_id := OLD."invoiceId";
  ELSE
    target_invoice_id := OLD."invoiceId";
  END IF;
  SELECT "status" INTO reservation_status FROM "subscription_renewal_reservations"
    WHERE "invoiceId" IN (target_invoice_id, CASE WHEN TG_OP = 'UPDATE' THEN NEW."invoiceId" ELSE target_invoice_id END)
      AND "status" IN ('RESERVED', 'BILLED') ORDER BY CASE WHEN "status" = 'RESERVED' THEN 0 ELSE 1 END LIMIT 1;
  IF NOT FOUND THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP <> 'UPDATE'
    OR (NEW."invoiceId", NEW."position", NEW."dueDate", NEW."amount", NEW."paymentMethod")
      IS DISTINCT FROM (OLD."invoiceId", OLD."position", OLD."dueDate", OLD."amount", OLD."paymentMethod")
    OR (reservation_status = 'RESERVED' AND NEW."status" IS DISTINCT FROM OLD."status") THEN
    RAISE EXCEPTION 'Reserved subscription renewal invoice due date is economically immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "reserved_invoice_due_dates_immutable_trigger" BEFORE INSERT OR UPDATE OR DELETE ON "invoice_due_dates"
FOR EACH ROW EXECUTE FUNCTION "prevent_reserved_invoice_due_date_mutation"();

CREATE FUNCTION "prevent_reserved_invoice_header_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "subscription_renewal_reservations" WHERE "invoiceId" = OLD."id" AND "status" IN ('RESERVED', 'BILLED'))
    AND (NEW."companyId", NEW."customerId", NEW."documentType", NEW."origin", NEW."issueDate", NEW."operationDate",
      NEW."subtotal", NEW."discountTotal", NEW."taxableBase", NEW."taxAmount", NEW."total")
      IS DISTINCT FROM
      (OLD."companyId", OLD."customerId", OLD."documentType", OLD."origin", OLD."issueDate", OLD."operationDate",
      OLD."subtotal", OLD."discountTotal", OLD."taxableBase", OLD."taxAmount", OLD."total") THEN
    RAISE EXCEPTION 'Reserved subscription renewal invoice header is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "reserved_invoice_header_immutable_trigger" BEFORE UPDATE ON "invoices"
FOR EACH ROW EXECUTE FUNCTION "prevent_reserved_invoice_header_mutation"();

CREATE OR REPLACE FUNCTION "prevent_subscription_cancel_with_pending_schedule"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" <> 'CANCELLED' AND NEW."status" = 'CANCELLED' AND EXISTS (
    SELECT 1 FROM "subscription_cancellation_schedules"
    WHERE "subscriptionId" = OLD."id" AND "companyId" = OLD."companyId" AND "status" = 'PENDING'
  ) THEN
    RAISE EXCEPTION 'Pending cancellation schedule must be revoked before immediate cancellation.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'CANCELLED' AND NEW."status" = 'CANCELLED' AND EXISTS (
    SELECT 1 FROM "subscription_renewal_reservations"
    WHERE "subscriptionId" = OLD."id" AND "companyId" = OLD."companyId" AND "status" = 'RESERVED'
  ) THEN
    RAISE EXCEPTION 'Active renewal reservation must be released before cancellation.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_subscription_cancellation_schedule_history"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status "SubscriptionStatus";
  parent_version INTEGER;
  parent_renewal_date DATE;
  parent_end_date DATE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Subscription cancellation schedule history cannot be deleted.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'A cancellation schedule must start pending at version one.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "status", "version", "nextRenewalDate", "endDate" INTO parent_status, parent_version, parent_renewal_date, parent_end_date
      FROM "subscriptions" WHERE "id" = NEW."subscriptionId" AND "companyId" = NEW."companyId" FOR UPDATE;
    IF parent_status NOT IN ('ACTIVE', 'RENEWAL_PENDING') OR NEW."createdAgainstVersion" <> parent_version
      OR NEW."effectiveDate" <> parent_renewal_date OR (parent_end_date IS NOT NULL AND NEW."effectiveDate" > parent_end_date)
      OR NEW."effectiveDate" <= (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Madrid')::date
      OR EXISTS (SELECT 1 FROM "subscription_renewal_reservations" WHERE "subscriptionId" = NEW."subscriptionId"
        AND "companyId" = NEW."companyId" AND "periodStart" = NEW."effectiveDate" AND "status" = 'RESERVED') THEN
      RAISE EXCEPTION 'Invalid cancellation schedule request.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'PENDING' OR NEW."status" NOT IN ('REVOKED', 'APPLIED') OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Invalid cancellation schedule transition.' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."subscriptionId", NEW."effectiveDate", NEW."reason", NEW."createdAgainstVersion", NEW."requestedById", NEW."requestedAt")
      IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."subscriptionId", OLD."effectiveDate", OLD."reason", OLD."createdAgainstVersion", OLD."requestedById", OLD."requestedAt") THEN
    RAISE EXCEPTION 'Cancellation schedule request evidence is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'REVOKED' AND (NEW."appliedAt", NEW."appliedBusinessDate", NEW."appliedAgainstVersion", NEW."appliedSubscriptionVersion")
      IS DISTINCT FROM (NULL::timestamptz, NULL::date, NULL::integer, NULL::integer) THEN
    RAISE EXCEPTION 'A revoked cancellation schedule cannot contain application evidence.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'APPLIED' THEN
    SELECT "status", "version", "nextRenewalDate" INTO parent_status, parent_version, parent_renewal_date
      FROM "subscriptions" WHERE "id" = NEW."subscriptionId" AND "companyId" = NEW."companyId";
    IF parent_status NOT IN ('ACTIVE', 'RENEWAL_PENDING') OR NEW."effectiveDate" <> parent_renewal_date
      OR NEW."appliedAt" < OLD."requestedAt" OR NEW."appliedAt" NOT BETWEEN clock_timestamp() - INTERVAL '5 minutes' AND clock_timestamp() + INTERVAL '5 minutes'
      OR NEW."appliedBusinessDate" IS DISTINCT FROM (NEW."appliedAt" AT TIME ZONE 'Europe/Madrid')::date
      OR NEW."effectiveDate" > NEW."appliedBusinessDate" OR NEW."appliedAgainstVersion" IS DISTINCT FROM parent_version
      OR NEW."appliedSubscriptionVersion" IS DISTINCT FROM parent_version + 1 THEN
      RAISE EXCEPTION 'Invalid cancellation schedule application.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
