CREATE TYPE "SubscriptionCancellationScheduleStatus" AS ENUM ('PENDING', 'REVOKED');

CREATE UNIQUE INDEX "subscriptions_id_companyId_key" ON "subscriptions"("id", "companyId");

CREATE TABLE "subscription_cancellation_schedules" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "subscriptionId" UUID NOT NULL,
  "status" "SubscriptionCancellationScheduleStatus" NOT NULL DEFAULT 'PENDING',
  "effectiveDate" DATE NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "createdAgainstVersion" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "requestedById" UUID NOT NULL,
  "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedById" UUID,
  "revokedAt" TIMESTAMPTZ(3),
  "revocationReason" VARCHAR(500),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "subscription_cancellation_schedules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_cancellation_schedules_version_chk" CHECK ("version" > 0),
  CONSTRAINT "subscription_cancellation_schedules_base_version_chk" CHECK ("createdAgainstVersion" > 0),
  CONSTRAINT "subscription_cancellation_schedules_reason_chk" CHECK (btrim("reason") <> ''),
  CONSTRAINT "subscription_cancellation_schedules_evidence_chk" CHECK (
    ("status" = 'PENDING' AND "revokedById" IS NULL AND "revokedAt" IS NULL AND "revocationReason" IS NULL)
    OR ("status" = 'REVOKED' AND "revokedById" IS NOT NULL AND "revokedAt" IS NOT NULL
      AND "revocationReason" IS NOT NULL AND btrim("revocationReason") <> '')
  ),
  CONSTRAINT "subscription_cancellation_schedules_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_cancellation_schedules_subscription_company_fkey"
    FOREIGN KEY ("subscriptionId", "companyId") REFERENCES "subscriptions"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_cancellation_schedules_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_cancellation_schedules_revokedById_fkey"
    FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "subscription_cancellation_schedules_id_subscriptionId_key"
  ON "subscription_cancellation_schedules"("id", "subscriptionId");
CREATE UNIQUE INDEX "subscription_cancellation_schedules_one_pending_key"
  ON "subscription_cancellation_schedules"("companyId", "subscriptionId") WHERE "status" = 'PENDING';
CREATE INDEX "subscription_cancellation_schedules_company_status_effective_idx"
  ON "subscription_cancellation_schedules"("companyId", "status", "effectiveDate", "id");
CREATE INDEX "subscription_cancellation_schedules_subscription_requested_idx"
  ON "subscription_cancellation_schedules"("subscriptionId", "requestedAt", "id");

CREATE FUNCTION "enforce_subscription_cancellation_schedule_history"()
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
  IF NEW."status" <> 'REVOKED' OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Invalid cancellation schedule transition.' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."subscriptionId", NEW."effectiveDate", NEW."reason", NEW."createdAgainstVersion", NEW."requestedById", NEW."requestedAt")
      IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."subscriptionId", OLD."effectiveDate", OLD."reason", OLD."createdAgainstVersion", OLD."requestedById", OLD."requestedAt") THEN
    RAISE EXCEPTION 'Cancellation schedule request evidence is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_cancellation_schedule_history_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "subscription_cancellation_schedules"
FOR EACH ROW EXECUTE FUNCTION "enforce_subscription_cancellation_schedule_history"();

CREATE FUNCTION "prevent_subscription_cancel_with_pending_schedule"()
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_cancel_pending_schedule_trigger"
BEFORE UPDATE OF "status" ON "subscriptions"
FOR EACH ROW EXECUTE FUNCTION "prevent_subscription_cancel_with_pending_schedule"();
