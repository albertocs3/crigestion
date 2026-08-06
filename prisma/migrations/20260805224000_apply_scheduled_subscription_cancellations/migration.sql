ALTER TABLE "subscription_cancellation_schedules"
  ADD COLUMN "appliedAt" TIMESTAMPTZ(3),
  ADD COLUMN "appliedBusinessDate" DATE,
  ADD COLUMN "appliedAgainstVersion" INTEGER,
  ADD COLUMN "appliedSubscriptionVersion" INTEGER,
  DROP CONSTRAINT "subscription_cancellation_schedules_evidence_chk",
  ADD CONSTRAINT "subscription_cancellation_schedules_applied_version_chk" CHECK (
    ("appliedAgainstVersion" IS NULL AND "appliedSubscriptionVersion" IS NULL)
    OR ("appliedAgainstVersion" IS NOT NULL AND "appliedSubscriptionVersion" IS NOT NULL
      AND "appliedAgainstVersion" > 0
      AND "appliedSubscriptionVersion" = "appliedAgainstVersion" + 1)
  ),
  ADD CONSTRAINT "subscription_cancellation_schedules_evidence_chk" CHECK (
    ("status" = 'PENDING'
      AND "revokedById" IS NULL AND "revokedAt" IS NULL AND "revocationReason" IS NULL
      AND "appliedAt" IS NULL AND "appliedBusinessDate" IS NULL
      AND "appliedAgainstVersion" IS NULL AND "appliedSubscriptionVersion" IS NULL)
    OR ("status" = 'REVOKED'
      AND "revokedById" IS NOT NULL AND "revokedAt" IS NOT NULL
      AND "revocationReason" IS NOT NULL AND btrim("revocationReason") <> ''
      AND "appliedAt" IS NULL AND "appliedBusinessDate" IS NULL
      AND "appliedAgainstVersion" IS NULL AND "appliedSubscriptionVersion" IS NULL)
    OR ("status" = 'APPLIED'
      AND "revokedById" IS NULL AND "revokedAt" IS NULL AND "revocationReason" IS NULL
      AND "appliedAt" IS NOT NULL AND "appliedBusinessDate" IS NOT NULL
      AND "appliedAgainstVersion" IS NOT NULL AND "appliedSubscriptionVersion" IS NOT NULL
      AND "appliedAgainstVersion" > 0
      AND "appliedSubscriptionVersion" = "appliedAgainstVersion" + 1)
  );

CREATE UNIQUE INDEX "subscription_cancellation_schedules_one_applied_key"
  ON "subscription_cancellation_schedules"("companyId", "subscriptionId") WHERE "status" = 'APPLIED';

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
    SELECT "status", "version", "nextRenewalDate", "endDate"
      INTO parent_status, parent_version, parent_renewal_date, parent_end_date
    FROM "subscriptions"
    WHERE "id" = NEW."subscriptionId" AND "companyId" = NEW."companyId"
    FOR UPDATE;
    IF parent_status NOT IN ('ACTIVE', 'RENEWAL_PENDING')
      OR NEW."createdAgainstVersion" <> parent_version
      OR NEW."effectiveDate" <> parent_renewal_date
      OR (parent_end_date IS NOT NULL AND NEW."effectiveDate" > parent_end_date)
      OR NEW."effectiveDate" <= (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Madrid')::date THEN
      RAISE EXCEPTION 'Invalid cancellation schedule request.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'Terminal cancellation schedule history is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" NOT IN ('REVOKED', 'APPLIED') OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Invalid cancellation schedule transition.' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."subscriptionId", NEW."effectiveDate", NEW."reason", NEW."createdAgainstVersion", NEW."requestedById", NEW."requestedAt")
      IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."subscriptionId", OLD."effectiveDate", OLD."reason", OLD."createdAgainstVersion", OLD."requestedById", OLD."requestedAt") THEN
    RAISE EXCEPTION 'Cancellation schedule request evidence is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'REVOKED'
    AND (NEW."appliedAt", NEW."appliedBusinessDate", NEW."appliedAgainstVersion", NEW."appliedSubscriptionVersion")
      IS DISTINCT FROM (NULL::timestamptz, NULL::date, NULL::integer, NULL::integer) THEN
    RAISE EXCEPTION 'A revoked cancellation schedule cannot contain application evidence.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'APPLIED' THEN
    SELECT "status", "version", "nextRenewalDate"
      INTO parent_status, parent_version, parent_renewal_date
    FROM "subscriptions"
    WHERE "id" = NEW."subscriptionId" AND "companyId" = NEW."companyId";
    IF parent_status NOT IN ('ACTIVE', 'RENEWAL_PENDING')
      OR NEW."effectiveDate" <> parent_renewal_date
      OR NEW."appliedAt" < OLD."requestedAt"
      OR NEW."appliedAt" NOT BETWEEN clock_timestamp() - INTERVAL '5 minutes'
        AND clock_timestamp() + INTERVAL '5 minutes'
      OR NEW."appliedBusinessDate" IS DISTINCT FROM (NEW."appliedAt" AT TIME ZONE 'Europe/Madrid')::date
      OR NEW."effectiveDate" > NEW."appliedBusinessDate"
      OR NEW."appliedAgainstVersion" IS NULL
      OR NEW."appliedSubscriptionVersion" IS NULL
      OR NEW."appliedAgainstVersion" IS DISTINCT FROM parent_version
      OR NEW."appliedSubscriptionVersion" IS DISTINCT FROM parent_version + 1 THEN
      RAISE EXCEPTION 'Invalid cancellation schedule application.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "assert_applied_cancellation_schedule_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" = 'APPLIED' AND NOT EXISTS (
    SELECT 1
    FROM "subscriptions" subscription
    WHERE subscription."id" = NEW."subscriptionId"
      AND subscription."companyId" = NEW."companyId"
      AND subscription."status" = 'CANCELLED'
      AND subscription."cancellationMode" = 'SCHEDULED'
      AND subscription."cancellationEffectiveDate" = NEW."effectiveDate"
      AND subscription."cancellationReason" = NEW."reason"
      AND subscription."cancelledById" = NEW."requestedById"
      AND subscription."cancelledAt" = NEW."appliedAt"
      AND subscription."version" = NEW."appliedSubscriptionVersion"
  ) THEN
    RAISE EXCEPTION 'Applied cancellation schedule is inconsistent with subscription.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "applied_cancellation_schedule_consistency_trigger"
AFTER INSERT OR UPDATE ON "subscription_cancellation_schedules"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_applied_cancellation_schedule_consistency"();

CREATE FUNCTION "assert_scheduled_subscription_cancellation_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" = 'CANCELLED' AND NEW."cancellationMode" = 'SCHEDULED' AND NOT EXISTS (
    SELECT 1
    FROM "subscription_cancellation_schedules" schedule
    WHERE schedule."subscriptionId" = NEW."id"
      AND schedule."companyId" = NEW."companyId"
      AND schedule."status" = 'APPLIED'
      AND schedule."effectiveDate" = NEW."cancellationEffectiveDate"
      AND schedule."reason" = NEW."cancellationReason"
      AND schedule."requestedById" = NEW."cancelledById"
      AND schedule."appliedAt" = NEW."cancelledAt"
      AND schedule."appliedSubscriptionVersion" = NEW."version"
  ) THEN
    RAISE EXCEPTION 'Scheduled subscription cancellation is inconsistent with applied schedule.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "scheduled_subscription_cancellation_consistency_trigger"
AFTER INSERT OR UPDATE ON "subscriptions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_scheduled_subscription_cancellation_consistency"();
