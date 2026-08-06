ALTER TYPE "SubscriptionCancellationScheduleStatus" ADD VALUE IF NOT EXISTS 'APPLIED';

CREATE TYPE "SubscriptionCancellationMode" AS ENUM ('IMMEDIATE', 'SCHEDULED');

ALTER TABLE "subscriptions"
  ADD COLUMN "cancellationMode" "SubscriptionCancellationMode";

UPDATE "subscriptions"
SET "cancellationMode" = 'IMMEDIATE'
WHERE "status" = 'CANCELLED';

ALTER TABLE "subscriptions"
  DROP CONSTRAINT "subscriptions_cancellation_evidence_chk",
  ADD CONSTRAINT "subscriptions_cancellation_evidence_chk" CHECK (
    ("status" = 'CANCELLED' AND "cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL
      AND "cancellationEffectiveDate" IS NOT NULL
      AND "cancellationReason" IS NOT NULL AND btrim("cancellationReason") <> ''
      AND "cancellationMode" IS NOT NULL)
    OR ("status" <> 'CANCELLED' AND "cancelledById" IS NULL AND "cancelledAt" IS NULL
      AND "cancellationEffectiveDate" IS NULL AND "cancellationReason" IS NULL
      AND "cancellationMode" IS NULL)
  );

CREATE FUNCTION "enforce_subscription_cancellation_mode_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'CANCELLED'
    AND NEW."cancellationMode" IS DISTINCT FROM OLD."cancellationMode" THEN
    RAISE EXCEPTION 'Subscription cancellation mode is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_cancellation_mode_immutable_trigger"
BEFORE UPDATE OF "cancellationMode" ON "subscriptions"
FOR EACH ROW EXECUTE FUNCTION "enforce_subscription_cancellation_mode_immutable"();
