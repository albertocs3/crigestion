ALTER TABLE "subscription_renewal_exclusions"
  DROP CONSTRAINT "subscription_renewal_exclusions_evidence_chk";

ALTER TABLE "subscription_renewal_exclusions"
  ADD CONSTRAINT "subscription_renewal_exclusions_evidence_chk" CHECK (
    (
      "status" = 'OPEN'
      AND "resolvedAt" IS NULL AND "resolvedById" IS NULL AND "resolution" IS NULL AND "resolvedInvoiceId" IS NULL
      AND "resolutionReasonCode" IS NULL AND "resolutionReasonDetail" IS NULL
      AND "resolvedAgainstVersion" IS NULL AND "resolvedSubscriptionVersion" IS NULL
    )
    OR (
      "status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL AND "resolvedById" IS NOT NULL AND "resolution" IS NOT NULL
      AND "resolvedAt" >= "openedAt"
      AND (
        ("resolution" = 'BILLED' AND "resolvedInvoiceId" IS NOT NULL
          AND "resolutionReasonCode" IS NULL AND "resolutionReasonDetail" IS NULL
          AND "resolvedAgainstVersion" IS NULL AND "resolvedSubscriptionVersion" IS NULL)
        OR ("resolution" = 'CANCELLED' AND "resolvedInvoiceId" IS NULL
          AND "resolutionReasonCode" IS NULL AND "resolutionReasonDetail" IS NULL
          AND "resolvedAgainstVersion" IS NULL AND "resolvedSubscriptionVersion" IS NULL)
        OR ("resolution" = 'WAIVED' AND "resolvedInvoiceId" IS NULL
          AND "resolutionReasonCode" IS NOT NULL
          AND "resolutionReasonDetail" IS NOT NULL AND length(btrim("resolutionReasonDetail")) >= 10
          AND "resolvedAgainstVersion" > 0
          AND "resolvedSubscriptionVersion" = "resolvedAgainstVersion" + 1)
      )
    )
  );

CREATE OR REPLACE FUNCTION "enforce_subscription_renewal_exclusion_history"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Subscription renewal exclusion history cannot be deleted.' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT "status", "version", "nextRenewalDate", "periodicity", "endDate"
      INTO parent FROM "subscriptions"
      WHERE "id" = NEW."subscriptionId" AND "companyId" = NEW."companyId" FOR UPDATE;
    IF NOT FOUND OR parent."status" NOT IN ('ACTIVE', 'RENEWAL_PENDING')
      OR parent."nextRenewalDate" <> NEW."periodStart"
      OR "subscription_next_renewal_date"(NEW."periodStart", parent."periodicity") <> NEW."periodEndExclusive"
      OR parent."version" <> NEW."openedAgainstVersion"
      OR (parent."endDate" IS NOT NULL AND NEW."periodStart" > parent."endDate")
      OR (NEW."reasonCode" = 'MANUAL_EXCLUSION' AND NEW."openedById" IS NULL) THEN
      RAISE EXCEPTION 'Invalid subscription renewal exclusion source.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'RESOLVED' THEN
    RAISE EXCEPTION 'Resolved subscription renewal exclusion history is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."subscriptionId", NEW."periodStart", NEW."periodEndExclusive",
      NEW."reasonCode", NEW."reasonDetail", NEW."openedAgainstVersion", NEW."openedById", NEW."openedAt")
     IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."subscriptionId", OLD."periodStart", OLD."periodEndExclusive",
      OLD."reasonCode", OLD."reasonDetail", OLD."openedAgainstVersion", OLD."openedById", OLD."openedAt") THEN
    RAISE EXCEPTION 'Subscription renewal exclusion opening evidence is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attemptCount" < OLD."attemptCount" OR NEW."attemptCount" > OLD."attemptCount" + 1 THEN
    RAISE EXCEPTION 'Invalid subscription renewal exclusion attempt counter.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" NOT IN ('OPEN', 'RESOLVED') THEN
    RAISE EXCEPTION 'Invalid subscription renewal exclusion transition.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'RESOLVED' AND NEW."resolution" = 'WAIVED' THEN
    SELECT "status", "version", "nextRenewalDate", "periodicity" INTO parent
    FROM "subscriptions"
    WHERE "id" = NEW."subscriptionId" AND "companyId" = NEW."companyId" FOR UPDATE;
    IF NOT FOUND OR parent."status" <> 'RENEWAL_PENDING'
      OR parent."nextRenewalDate" <> NEW."periodStart"
      OR "subscription_next_renewal_date"(NEW."periodStart", parent."periodicity") <> NEW."periodEndExclusive"
      OR NEW."resolvedAgainstVersion" <> parent."version"
      OR NEW."resolvedSubscriptionVersion" <> parent."version" + 1
      OR EXISTS (
        SELECT 1 FROM "subscription_renewal_reservations" reservation
        WHERE reservation."companyId" = NEW."companyId"
          AND reservation."subscriptionId" = NEW."subscriptionId"
          AND reservation."periodStart" = NEW."periodStart"
          AND reservation."status" IN ('RESERVED', 'BILLED')
      )
      OR EXISTS (
        SELECT 1 FROM "subscription_cancellation_schedules" schedule
        WHERE schedule."companyId" = NEW."companyId"
          AND schedule."subscriptionId" = NEW."subscriptionId"
          AND schedule."status" = 'PENDING'
      ) THEN
      RAISE EXCEPTION 'Invalid subscription renewal waiver evidence.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

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
  ELSIF OLD."status" = 'ACTIVE' AND NEW."status" NOT IN ('ACTIVE', 'RENEWAL_PENDING', 'CANCELLED') THEN
    RAISE EXCEPTION 'Invalid subscription status transition.' USING ERRCODE = 'check_violation';
  ELSIF OLD."status" = 'RENEWAL_PENDING' AND NEW."status" NOT IN ('RENEWAL_PENDING', 'ACTIVE', 'CANCELLED') THEN
    RAISE EXCEPTION 'Invalid subscription status transition.' USING ERRCODE = 'check_violation';
  ELSIF OLD."status" = 'CANCELLED' AND NEW."status" <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Invalid subscription status transition.' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" = 'ACTIVE' AND NEW."status" = 'RENEWAL_PENDING' AND (
    NEW."version" <> OLD."version" + 1 OR NEW."nextRenewalDate" IS DISTINCT FROM OLD."nextRenewalDate"
    OR NOT EXISTS (
      SELECT 1 FROM "subscription_renewal_exclusions" exclusion
      WHERE exclusion."companyId" = OLD."companyId" AND exclusion."subscriptionId" = OLD."id"
        AND exclusion."periodStart" = OLD."nextRenewalDate" AND exclusion."status" = 'OPEN'
        AND exclusion."openedAgainstVersion" = OLD."version"
    )
  ) THEN
    RAISE EXCEPTION 'Renewal pending transition requires matching exclusion evidence.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'RENEWAL_PENDING' AND NEW."status" = 'ACTIVE'
    AND NEW."nextRenewalDate" IS NOT DISTINCT FROM OLD."nextRenewalDate" THEN
    RAISE EXCEPTION 'A renewal pending subscription cannot return active without advancing its period.' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" <> 'DRAFT' AND
     (NEW."customerId", NEW."name", NEW."periodicity", NEW."pricingMode", NEW."paymentMethod", NEW."startDate", NEW."endDate", NEW."notes")
       IS DISTINCT FROM
     (OLD."customerId", OLD."name", OLD."periodicity", OLD."pricingMode", OLD."paymentMethod", OLD."startDate", OLD."endDate", OLD."notes") THEN
    RAISE EXCEPTION 'Active subscription contract fields cannot change.' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."nextRenewalDate" IS DISTINCT FROM OLD."nextRenewalDate" THEN
    IF OLD."status" = 'DRAFT' THEN
      IF NEW."status" <> 'DRAFT' OR NEW."nextRenewalDate" <> NEW."startDate" OR NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION 'Invalid draft renewal date change.' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF OLD."status" NOT IN ('ACTIVE', 'RENEWAL_PENDING') OR NEW."status" <> 'ACTIVE'
        OR NEW."version" <> OLD."version" + 1
        OR NEW."nextRenewalDate" <> "subscription_next_renewal_date"(OLD."nextRenewalDate", OLD."periodicity")
        OR NOT (
          EXISTS (
            SELECT 1 FROM "subscription_renewal_reservations" reservation
            JOIN "invoices" invoice ON invoice."id" = reservation."invoiceId" AND invoice."companyId" = reservation."companyId"
            WHERE reservation."companyId" = OLD."companyId" AND reservation."subscriptionId" = OLD."id"
              AND reservation."status" = 'RESERVED' AND reservation."periodStart" = OLD."nextRenewalDate"
              AND reservation."periodEndExclusive" = NEW."nextRenewalDate"
              AND reservation."subscriptionVersionSnapshot" = OLD."version"
              AND invoice."origin" = 'SUBSCRIPTION' AND invoice."documentType" = 'STANDARD'
              AND invoice."status" = 'ISSUED' AND invoice."issuedAt" IS NOT NULL
          )
          OR EXISTS (
            SELECT 1 FROM "subscription_renewal_exclusions" exclusion
            WHERE exclusion."companyId" = OLD."companyId" AND exclusion."subscriptionId" = OLD."id"
              AND exclusion."status" = 'RESOLVED' AND exclusion."resolution" = 'WAIVED'
              AND exclusion."periodStart" = OLD."nextRenewalDate"
              AND exclusion."periodEndExclusive" = NEW."nextRenewalDate"
              AND exclusion."resolvedAgainstVersion" = OLD."version"
              AND exclusion."resolvedSubscriptionVersion" = NEW."version"
              AND exclusion."resolvedInvoiceId" IS NULL
          )
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

CREATE OR REPLACE FUNCTION "assert_subscription_renewal_advance_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' AND NEW."nextRenewalDate" IS DISTINCT FROM OLD."nextRenewalDate" THEN
    IF NEW."nextRenewalDate" <= OLD."nextRenewalDate" OR NEW."version" <> OLD."version" + 1 OR NEW."status" <> 'ACTIVE'
      OR NOT (
        EXISTS (
          SELECT 1 FROM "subscription_renewal_reservations" reservation
          WHERE reservation."companyId" = NEW."companyId" AND reservation."subscriptionId" = NEW."id"
            AND reservation."status" = 'BILLED' AND reservation."periodStart" = OLD."nextRenewalDate"
            AND reservation."periodEndExclusive" = NEW."nextRenewalDate"
            AND reservation."subscriptionVersionSnapshot" = OLD."version"
        )
        OR EXISTS (
          SELECT 1 FROM "subscription_renewal_exclusions" exclusion
          WHERE exclusion."companyId" = NEW."companyId" AND exclusion."subscriptionId" = NEW."id"
            AND exclusion."status" = 'RESOLVED' AND exclusion."resolution" = 'WAIVED'
            AND exclusion."periodStart" = OLD."nextRenewalDate"
            AND exclusion."periodEndExclusive" = NEW."nextRenewalDate"
            AND exclusion."resolvedAgainstVersion" = OLD."version"
            AND exclusion."resolvedSubscriptionVersion" = NEW."version"
        )
      ) THEN
      RAISE EXCEPTION 'Subscription renewal advancement requires matching billed or waived evidence.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "assert_subscription_renewal_waiver_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_company_id UUID;
  target_subscription_id UUID;
  target_exclusion_id UUID;
  target_period_start DATE;
  target_subscription_version INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'subscriptions' THEN
    target_company_id := NEW."companyId";
    target_subscription_id := NEW."id";
    target_exclusion_id := NULL;
    target_period_start := OLD."nextRenewalDate";
    target_subscription_version := NEW."version";
  ELSE
    target_company_id := NEW."companyId";
    target_subscription_id := NEW."subscriptionId";
    target_exclusion_id := NEW."id";
    target_period_start := NULL;
    target_subscription_version := NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "subscription_renewal_exclusions" exclusion
    JOIN "subscriptions" subscription ON subscription."id" = exclusion."subscriptionId" AND subscription."companyId" = exclusion."companyId"
    WHERE exclusion."companyId" = target_company_id AND exclusion."subscriptionId" = target_subscription_id
      AND exclusion."status" = 'RESOLVED' AND exclusion."resolution" = 'WAIVED'
      AND ((target_exclusion_id IS NOT NULL AND exclusion."id" = target_exclusion_id)
        OR (target_period_start IS NOT NULL AND exclusion."periodStart" = target_period_start
          AND exclusion."resolvedSubscriptionVersion" = target_subscription_version))
      AND (
        subscription."status" <> 'ACTIVE'
        OR subscription."nextRenewalDate" <> exclusion."periodEndExclusive"
        OR subscription."version" <> exclusion."resolvedSubscriptionVersion"
        OR exclusion."resolvedSubscriptionVersion" <> exclusion."resolvedAgainstVersion" + 1
        OR exclusion."resolvedInvoiceId" IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM "subscription_renewal_reservations" reservation
          WHERE reservation."companyId" = exclusion."companyId"
            AND reservation."subscriptionId" = exclusion."subscriptionId"
            AND reservation."periodStart" = exclusion."periodStart"
            AND reservation."status" IN ('RESERVED', 'BILLED')
        )
      )
  ) THEN
    RAISE EXCEPTION 'Waived renewal exclusion requires matching active subscription evidence.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "subscription_renewal_waiver_subscription_consistency_trigger"
AFTER UPDATE OF "status", "version", "nextRenewalDate" ON "subscriptions"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_subscription_renewal_waiver_consistency"();
CREATE CONSTRAINT TRIGGER "subscription_renewal_waiver_exclusion_consistency_trigger"
AFTER UPDATE ON "subscription_renewal_exclusions"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_subscription_renewal_waiver_consistency"();
