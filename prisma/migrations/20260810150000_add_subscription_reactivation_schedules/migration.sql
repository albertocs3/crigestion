CREATE TYPE "SubscriptionReactivationScheduleStatus" AS ENUM ('PENDING', 'APPLIED', 'REVOKED');

CREATE TABLE "subscription_reactivation_schedules" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "subscriptionId" UUID NOT NULL,
  "status" "SubscriptionReactivationScheduleStatus" NOT NULL DEFAULT 'PENDING',
  "effectiveDate" DATE NOT NULL,
  "nextRenewalDate" DATE NOT NULL,
  "previousNextRenewalDate" DATE NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "createdAgainstVersion" INTEGER NOT NULL,
  "scheduledSubscriptionVersion" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "requestedById" UUID NOT NULL,
  "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelledByIdSnapshot" UUID NOT NULL,
  "cancelledAtSnapshot" TIMESTAMPTZ(3) NOT NULL,
  "cancellationEffectiveDateSnapshot" DATE NOT NULL,
  "cancellationReasonSnapshot" VARCHAR(500) NOT NULL,
  "cancellationModeSnapshot" "SubscriptionCancellationMode" NOT NULL,
  "revokedById" UUID,
  "revokedAt" TIMESTAMPTZ(3),
  "revocationReason" VARCHAR(500),
  "revokedAgainstVersion" INTEGER,
  "revokedSubscriptionVersion" INTEGER,
  "appliedById" UUID,
  "appliedAt" TIMESTAMPTZ(3),
  "appliedBusinessDate" DATE,
  "appliedAgainstVersion" INTEGER,
  "appliedSubscriptionVersion" INTEGER,
  "reactivationId" UUID,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "subscription_reactivation_schedules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_reactivation_schedules_reason_chk" CHECK (btrim("reason") <> ''),
  CONSTRAINT "subscription_reactivation_schedules_cancellation_reason_chk" CHECK (btrim("cancellationReasonSnapshot") <> ''),
  CONSTRAINT "subscription_reactivation_schedules_version_chk" CHECK (
    "version" > 0
    AND "createdAgainstVersion" > 0
    AND "scheduledSubscriptionVersion" = "createdAgainstVersion" + 1
    AND (("revokedAgainstVersion" IS NULL AND "revokedSubscriptionVersion" IS NULL)
      OR ("revokedAgainstVersion" > 0 AND "revokedSubscriptionVersion" = "revokedAgainstVersion" + 1))
    AND (("appliedAgainstVersion" IS NULL AND "appliedSubscriptionVersion" IS NULL)
      OR ("appliedAgainstVersion" > 0 AND "appliedSubscriptionVersion" = "appliedAgainstVersion" + 1))
  ),
  CONSTRAINT "subscription_reactivation_schedules_dates_chk" CHECK (
    "effectiveDate" > ("requestedAt" AT TIME ZONE 'Europe/Madrid')::date
    AND "nextRenewalDate" >= "effectiveDate"
    AND "nextRenewalDate" > "cancellationEffectiveDateSnapshot"
    AND "requestedAt" >= "cancelledAtSnapshot"
  ),
  CONSTRAINT "subscription_reactivation_schedules_evidence_chk" CHECK (
    ("status" = 'PENDING'
      AND "version" = 1
      AND "revokedById" IS NULL AND "revokedAt" IS NULL AND "revocationReason" IS NULL
      AND "revokedAgainstVersion" IS NULL AND "revokedSubscriptionVersion" IS NULL
      AND "appliedById" IS NULL AND "appliedAt" IS NULL AND "appliedBusinessDate" IS NULL
      AND "appliedAgainstVersion" IS NULL AND "appliedSubscriptionVersion" IS NULL
      AND "reactivationId" IS NULL)
    OR ("status" = 'REVOKED'
      AND "revokedById" IS NOT NULL AND "revokedAt" IS NOT NULL
      AND "revocationReason" IS NOT NULL AND btrim("revocationReason") <> ''
      AND "revokedAgainstVersion" IS NOT NULL AND "revokedSubscriptionVersion" IS NOT NULL
      AND "appliedById" IS NULL AND "appliedAt" IS NULL AND "appliedBusinessDate" IS NULL
      AND "appliedAgainstVersion" IS NULL AND "appliedSubscriptionVersion" IS NULL
      AND "reactivationId" IS NULL)
    OR ("status" = 'APPLIED'
      AND "revokedById" IS NULL AND "revokedAt" IS NULL AND "revocationReason" IS NULL
      AND "revokedAgainstVersion" IS NULL AND "revokedSubscriptionVersion" IS NULL
      AND "appliedById" IS NOT NULL AND "appliedAt" IS NOT NULL AND "appliedBusinessDate" IS NOT NULL
      AND "appliedAgainstVersion" IS NOT NULL AND "appliedSubscriptionVersion" IS NOT NULL
      AND "reactivationId" IS NOT NULL)
  ),
  CONSTRAINT "subscription_reactivation_schedules_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_reactivation_schedules_subscription_company_fkey"
    FOREIGN KEY ("subscriptionId", "companyId") REFERENCES "subscriptions"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_reactivation_schedules_requested_by_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_reactivation_schedules_cancelled_by_snapshot_fkey"
    FOREIGN KEY ("cancelledByIdSnapshot") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_reactivation_schedules_revoked_by_fkey"
    FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_reactivation_schedules_applied_by_fkey"
    FOREIGN KEY ("appliedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_reactivation_schedules_reactivation_fkey"
    FOREIGN KEY ("reactivationId") REFERENCES "subscription_reactivations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "subscription_reactivation_schedules_reactivation_key"
  ON "subscription_reactivation_schedules"("reactivationId");
CREATE UNIQUE INDEX "subscription_reactivation_schedules_one_pending_key"
  ON "subscription_reactivation_schedules"("companyId", "subscriptionId") WHERE "status" = 'PENDING';
CREATE INDEX "subscription_reactivation_schedules_company_queue_idx"
  ON "subscription_reactivation_schedules"("companyId", "status", "effectiveDate", "id");
CREATE INDEX "subscription_reactivation_schedules_subscription_history_idx"
  ON "subscription_reactivation_schedules"("subscriptionId", "requestedAt", "id");
CREATE INDEX "subscription_reactivation_schedules_requested_by_idx"
  ON "subscription_reactivation_schedules"("requestedById", "requestedAt", "id");
CREATE INDEX "subscription_reactivation_schedules_cancelled_by_idx"
  ON "subscription_reactivation_schedules"("cancelledByIdSnapshot", "cancelledAtSnapshot", "id");
CREATE INDEX "subscription_reactivation_schedules_revoked_by_idx"
  ON "subscription_reactivation_schedules"("revokedById", "revokedAt", "id");
CREATE INDEX "subscription_reactivation_schedules_applied_by_idx"
  ON "subscription_reactivation_schedules"("appliedById", "appliedAt", "id");

CREATE FUNCTION "enforce_subscription_reactivation_schedule_history"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent RECORD;
  customer_is_active BOOLEAN := false;
  matching_reactivation BOOLEAN := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Subscription reactivation schedule history cannot be deleted.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT subscription."status", subscription."version", subscription."customerId",
    subscription."nextRenewalDate", subscription."endDate", subscription."pricingMode",
    subscription."cancelledById", subscription."cancelledAt", subscription."cancellationEffectiveDate",
    subscription."cancellationReason", subscription."cancellationMode"
  INTO parent
  FROM "subscriptions" subscription
  WHERE subscription."id" = NEW."subscriptionId" AND subscription."companyId" = NEW."companyId"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Subscription reactivation schedule requires a subscription.' USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM "customers" customer
    WHERE customer."id" = parent."customerId" AND customer."status" = 'ACTIVE'
    FOR SHARE;
    customer_is_active := FOUND;

    IF NEW."status" <> 'PENDING'
      OR NEW."version" <> 1
      OR NEW."requestedAt" < clock_timestamp() - INTERVAL '5 minutes'
      OR NEW."requestedAt" > clock_timestamp() + INTERVAL '5 minutes'
      OR parent."status" <> 'CANCELLED'
      OR parent."version" <> NEW."createdAgainstVersion"
      OR NEW."scheduledSubscriptionVersion" <> parent."version" + 1
      OR parent."nextRenewalDate" <> NEW."previousNextRenewalDate"
      OR parent."cancelledById" <> NEW."cancelledByIdSnapshot"
      OR parent."cancelledAt" <> NEW."cancelledAtSnapshot"
      OR parent."cancellationEffectiveDate" <> NEW."cancellationEffectiveDateSnapshot"
      OR parent."cancellationReason" <> NEW."cancellationReasonSnapshot"
      OR parent."cancellationMode" <> NEW."cancellationModeSnapshot"
      OR NOT customer_is_active
      OR (parent."endDate" IS NOT NULL AND NEW."nextRenewalDate" > parent."endDate")
      OR NOT EXISTS (SELECT 1 FROM "subscription_lines" line WHERE line."subscriptionId" = NEW."subscriptionId")
      OR (parent."pricingMode" = 'FIXED' AND EXISTS (
        SELECT 1 FROM "subscription_lines" line
        WHERE line."subscriptionId" = NEW."subscriptionId" AND line."quantity" <> 1
      ))
      OR EXISTS (
        SELECT 1 FROM "subscription_cancellation_schedules" cancellation_schedule
        WHERE cancellation_schedule."companyId" = NEW."companyId"
          AND cancellation_schedule."subscriptionId" = NEW."subscriptionId"
          AND cancellation_schedule."status" = 'PENDING'
      )
      OR EXISTS (
        SELECT 1 FROM "subscription_renewal_reservations" reservation
        WHERE reservation."companyId" = NEW."companyId"
          AND reservation."subscriptionId" = NEW."subscriptionId"
          AND (reservation."status" = 'RESERVED'
            OR (reservation."status" = 'BILLED' AND reservation."periodEndExclusive" > NEW."nextRenewalDate"))
      )
      OR EXISTS (
        SELECT 1 FROM "subscription_renewal_exclusions" exclusion
        WHERE exclusion."companyId" = NEW."companyId"
          AND exclusion."subscriptionId" = NEW."subscriptionId"
          AND (exclusion."status" = 'OPEN' OR exclusion."periodStart" = NEW."nextRenewalDate")
      ) THEN
      RAISE EXCEPTION 'Invalid subscription reactivation schedule request.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'Terminal subscription reactivation schedule history is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" NOT IN ('REVOKED', 'APPLIED') OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Invalid subscription reactivation schedule transition.' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."subscriptionId", NEW."effectiveDate", NEW."nextRenewalDate",
      NEW."previousNextRenewalDate", NEW."reason", NEW."createdAgainstVersion", NEW."scheduledSubscriptionVersion",
      NEW."requestedById", NEW."requestedAt", NEW."cancelledByIdSnapshot", NEW."cancelledAtSnapshot",
      NEW."cancellationEffectiveDateSnapshot", NEW."cancellationReasonSnapshot", NEW."cancellationModeSnapshot")
      IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."subscriptionId", OLD."effectiveDate", OLD."nextRenewalDate",
      OLD."previousNextRenewalDate", OLD."reason", OLD."createdAgainstVersion", OLD."scheduledSubscriptionVersion",
      OLD."requestedById", OLD."requestedAt", OLD."cancelledByIdSnapshot", OLD."cancelledAtSnapshot",
      OLD."cancellationEffectiveDateSnapshot", OLD."cancellationReasonSnapshot", OLD."cancellationModeSnapshot") THEN
    RAISE EXCEPTION 'Subscription reactivation schedule request evidence is immutable.' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'REVOKED' THEN
    IF parent."status" <> 'CANCELLED'
      OR parent."version" <> NEW."revokedAgainstVersion"
      OR NEW."revokedSubscriptionVersion" <> parent."version" + 1
      OR NEW."revokedAt" < OLD."requestedAt"
      OR NEW."revokedAt" < clock_timestamp() - INTERVAL '5 minutes'
      OR NEW."revokedAt" > clock_timestamp() + INTERVAL '5 minutes'
      OR parent."cancelledById" <> NEW."cancelledByIdSnapshot"
      OR parent."cancelledAt" <> NEW."cancelledAtSnapshot"
      OR parent."cancellationEffectiveDate" <> NEW."cancellationEffectiveDateSnapshot"
      OR parent."cancellationReason" <> NEW."cancellationReasonSnapshot"
      OR parent."cancellationMode" <> NEW."cancellationModeSnapshot" THEN
      RAISE EXCEPTION 'Invalid subscription reactivation schedule revocation.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  matching_reactivation := EXISTS (
    SELECT 1 FROM "subscription_reactivations" reactivation
    WHERE reactivation."id" = NEW."reactivationId"
      AND reactivation."companyId" = NEW."companyId"
      AND reactivation."subscriptionId" = NEW."subscriptionId"
      AND reactivation.xmin = pg_current_xact_id()::xid
      AND reactivation."reactivatedById" = NEW."appliedById"
      AND reactivation."reactivatedAt" = NEW."appliedAt"
      AND reactivation."effectiveDate" = NEW."appliedBusinessDate"
      AND reactivation."nextRenewalDate" = NEW."nextRenewalDate"
      AND reactivation."previousNextRenewalDate" = NEW."previousNextRenewalDate"
      AND reactivation."createdAgainstVersion" = NEW."appliedAgainstVersion"
      AND reactivation."reactivatedSubscriptionVersion" = NEW."appliedSubscriptionVersion"
      AND reactivation."cancelledByIdSnapshot" = NEW."cancelledByIdSnapshot"
      AND reactivation."cancelledAtSnapshot" = NEW."cancelledAtSnapshot"
      AND reactivation."cancellationEffectiveDateSnapshot" = NEW."cancellationEffectiveDateSnapshot"
      AND reactivation."cancellationReasonSnapshot" = NEW."cancellationReasonSnapshot"
      AND reactivation."cancellationModeSnapshot" = NEW."cancellationModeSnapshot"
  );

  IF parent."status" <> 'CANCELLED'
    OR parent."version" <> NEW."appliedAgainstVersion"
    OR NEW."appliedSubscriptionVersion" <> parent."version" + 1
    OR NEW."appliedAt" < OLD."requestedAt"
    OR NEW."appliedAt" < clock_timestamp() - INTERVAL '5 minutes'
    OR NEW."appliedAt" > clock_timestamp() + INTERVAL '5 minutes'
    OR NEW."appliedBusinessDate" <> (NEW."appliedAt" AT TIME ZONE 'Europe/Madrid')::date
    OR NEW."effectiveDate" > NEW."appliedBusinessDate"
    OR NEW."nextRenewalDate" < NEW."appliedBusinessDate"
    OR parent."nextRenewalDate" <> NEW."previousNextRenewalDate"
    OR parent."cancelledById" <> NEW."cancelledByIdSnapshot"
    OR parent."cancelledAt" <> NEW."cancelledAtSnapshot"
    OR parent."cancellationEffectiveDate" <> NEW."cancellationEffectiveDateSnapshot"
    OR parent."cancellationReason" <> NEW."cancellationReasonSnapshot"
    OR parent."cancellationMode" <> NEW."cancellationModeSnapshot"
    OR NOT matching_reactivation THEN
    RAISE EXCEPTION 'Invalid subscription reactivation schedule application.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_reactivation_schedule_history_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "subscription_reactivation_schedules"
FOR EACH ROW EXECUTE FUNCTION "enforce_subscription_reactivation_schedule_history"();

CREATE FUNCTION "assert_subscription_reactivation_schedule_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  schedule RECORD;
BEGIN
  SELECT * INTO schedule
  FROM "subscription_reactivation_schedules"
  WHERE "id" = NEW."id";

  IF schedule."status" = 'PENDING' AND NOT EXISTS (
    SELECT 1 FROM "subscriptions" subscription
    WHERE subscription."id" = schedule."subscriptionId"
      AND subscription."companyId" = schedule."companyId"
      AND subscription."status" = 'CANCELLED'
      AND subscription."version" = schedule."scheduledSubscriptionVersion"
      AND subscription."updatedById" = schedule."requestedById"
      AND subscription."nextRenewalDate" = schedule."previousNextRenewalDate"
      AND subscription."cancelledById" = schedule."cancelledByIdSnapshot"
      AND subscription."cancelledAt" = schedule."cancelledAtSnapshot"
      AND subscription."cancellationEffectiveDate" = schedule."cancellationEffectiveDateSnapshot"
      AND subscription."cancellationReason" = schedule."cancellationReasonSnapshot"
      AND subscription."cancellationMode" = schedule."cancellationModeSnapshot"
  ) THEN
    RAISE EXCEPTION 'Pending subscription reactivation schedule is inconsistent with subscription.' USING ERRCODE = 'check_violation';
  END IF;

  IF schedule."status" = 'REVOKED' AND NOT EXISTS (
    SELECT 1 FROM "subscriptions" subscription
    WHERE subscription."id" = schedule."subscriptionId"
      AND subscription."companyId" = schedule."companyId"
      AND subscription."status" = 'CANCELLED'
      AND subscription."version" = schedule."revokedSubscriptionVersion"
      AND subscription."updatedById" = schedule."revokedById"
      AND subscription."nextRenewalDate" = schedule."previousNextRenewalDate"
      AND subscription."cancelledById" = schedule."cancelledByIdSnapshot"
      AND subscription."cancelledAt" = schedule."cancelledAtSnapshot"
      AND subscription."cancellationEffectiveDate" = schedule."cancellationEffectiveDateSnapshot"
      AND subscription."cancellationReason" = schedule."cancellationReasonSnapshot"
      AND subscription."cancellationMode" = schedule."cancellationModeSnapshot"
  ) THEN
    RAISE EXCEPTION 'Revoked subscription reactivation schedule is inconsistent with subscription.' USING ERRCODE = 'check_violation';
  END IF;

  IF schedule."status" = 'APPLIED' AND NOT EXISTS (
    SELECT 1
    FROM "subscriptions" subscription
    JOIN "subscription_reactivations" reactivation ON reactivation."id" = schedule."reactivationId"
    WHERE subscription."id" = schedule."subscriptionId"
      AND subscription."companyId" = schedule."companyId"
      AND subscription."status" = 'ACTIVE'
      AND subscription."version" = schedule."appliedSubscriptionVersion"
      AND subscription."updatedById" = schedule."appliedById"
      AND subscription."nextRenewalDate" = schedule."nextRenewalDate"
      AND subscription."cancelledById" IS NULL
      AND subscription."cancelledAt" IS NULL
      AND subscription."cancellationEffectiveDate" IS NULL
      AND subscription."cancellationReason" IS NULL
      AND subscription."cancellationMode" IS NULL
      AND reactivation."companyId" = schedule."companyId"
      AND reactivation."subscriptionId" = schedule."subscriptionId"
      AND reactivation."reactivatedById" = schedule."appliedById"
      AND reactivation."reactivatedAt" = schedule."appliedAt"
      AND reactivation."effectiveDate" = schedule."appliedBusinessDate"
      AND reactivation."nextRenewalDate" = schedule."nextRenewalDate"
      AND reactivation."previousNextRenewalDate" = schedule."previousNextRenewalDate"
      AND reactivation."createdAgainstVersion" = schedule."appliedAgainstVersion"
      AND reactivation."reactivatedSubscriptionVersion" = schedule."appliedSubscriptionVersion"
      AND reactivation."cancelledByIdSnapshot" = schedule."cancelledByIdSnapshot"
      AND reactivation."cancelledAtSnapshot" = schedule."cancelledAtSnapshot"
      AND reactivation."cancellationEffectiveDateSnapshot" = schedule."cancellationEffectiveDateSnapshot"
      AND reactivation."cancellationReasonSnapshot" = schedule."cancellationReasonSnapshot"
      AND reactivation."cancellationModeSnapshot" = schedule."cancellationModeSnapshot"
  ) THEN
    RAISE EXCEPTION 'Applied subscription reactivation schedule is inconsistent with subscription.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "subscription_reactivation_schedule_consistency_trigger"
AFTER INSERT OR UPDATE ON "subscription_reactivation_schedules"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_subscription_reactivation_schedule_consistency"();

CREATE OR REPLACE FUNCTION "enforce_subscription_header_lifecycle"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  is_reactivation BOOLEAN;
  is_schedule_version_change BOOLEAN;
BEGIN
  is_reactivation := OLD."status" = 'CANCELLED' AND NEW."status" = 'ACTIVE' AND EXISTS (
    SELECT 1 FROM "subscription_reactivations" reactivation
    WHERE reactivation."companyId" = OLD."companyId"
      AND reactivation."subscriptionId" = OLD."id"
      AND reactivation.xmin = pg_current_xact_id()::xid
      AND reactivation."createdAgainstVersion" = OLD."version"
      AND reactivation."reactivatedSubscriptionVersion" = NEW."version"
      AND reactivation."reactivatedSubscriptionVersion" = OLD."version" + 1
      AND reactivation."reactivatedById" = NEW."updatedById"
      AND reactivation."nextRenewalDate" = NEW."nextRenewalDate"
      AND reactivation."previousNextRenewalDate" = OLD."nextRenewalDate"
      AND reactivation."cancelledByIdSnapshot" = OLD."cancelledById"
      AND reactivation."cancelledAtSnapshot" = OLD."cancelledAt"
      AND reactivation."cancellationEffectiveDateSnapshot" = OLD."cancellationEffectiveDate"
      AND reactivation."cancellationReasonSnapshot" = OLD."cancellationReason"
      AND reactivation."cancellationModeSnapshot" = OLD."cancellationMode"
      AND NEW."cancelledById" IS NULL
      AND NEW."cancelledAt" IS NULL
      AND NEW."cancellationEffectiveDate" IS NULL
      AND NEW."cancellationReason" IS NULL
      AND NEW."cancellationMode" IS NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM "subscription_reactivation_schedules" schedule
    WHERE schedule."companyId" = OLD."companyId"
      AND schedule."subscriptionId" = OLD."id"
      AND schedule."status" = 'PENDING'
  );

  is_schedule_version_change := OLD."status" = 'CANCELLED' AND NEW."status" = 'CANCELLED'
    AND NEW."version" = OLD."version" + 1
    AND EXISTS (
      SELECT 1 FROM "subscription_reactivation_schedules" schedule
      WHERE schedule."companyId" = OLD."companyId"
        AND schedule."subscriptionId" = OLD."id"
        AND schedule.xmin = pg_current_xact_id()::xid
        AND (
          (schedule."status" = 'PENDING'
            AND schedule."createdAgainstVersion" = OLD."version"
            AND schedule."scheduledSubscriptionVersion" = NEW."version"
            AND schedule."requestedById" = NEW."updatedById")
          OR (schedule."status" = 'REVOKED'
            AND schedule."revokedAgainstVersion" = OLD."version"
            AND schedule."revokedSubscriptionVersion" = NEW."version"
            AND schedule."revokedById" = NEW."updatedById")
        )
    );

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
  ELSIF OLD."status" = 'CANCELLED' AND NEW."status" <> 'CANCELLED' AND NOT is_reactivation THEN
    RAISE EXCEPTION 'Invalid subscription status transition.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'CANCELLED' AND NEW."status" = 'CANCELLED'
    AND NEW."version" IS DISTINCT FROM OLD."version" AND NOT is_schedule_version_change THEN
    RAISE EXCEPTION 'Cancelled subscription version is immutable.' USING ERRCODE = 'check_violation';
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
    IF is_reactivation THEN
      NULL;
    ELSIF OLD."status" = 'DRAFT' THEN
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
  IF OLD."cancelledAt" IS NOT NULL AND NOT is_reactivation AND
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

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Subscriptions.ScheduleReactivations', 'Programar reactivaciones de suscripciones', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'Subscriptions.ScheduleReactivations'
WHERE role."code" IN ('Administrator', 'Administrador') AND role."isProtected" = true
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
