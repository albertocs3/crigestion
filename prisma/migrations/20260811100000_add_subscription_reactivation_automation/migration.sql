BEGIN;

CREATE TYPE "SubscriptionReactivationAutomationOutcome" AS ENUM ('APPLIED', 'BLOCKED');

CREATE TABLE "subscription_reactivation_automation_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "subscriptionId" UUID NOT NULL,
  "scheduleId" UUID NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "workerId" VARCHAR(160) NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3) NOT NULL,
  "outcome" "SubscriptionReactivationAutomationOutcome" NOT NULL,
  "stableCode" VARCHAR(120),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_reactivation_automation_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_reactivation_automation_attempts_number_chk" CHECK ("attemptNumber" > 0),
  CONSTRAINT "subscription_reactivation_automation_attempts_worker_chk" CHECK (btrim("workerId") <> ''),
  CONSTRAINT "subscription_reactivation_automation_attempts_time_chk" CHECK ("completedAt" >= "startedAt"),
  CONSTRAINT "subscription_reactivation_automation_attempts_outcome_chk" CHECK (
    ("outcome" = 'APPLIED' AND "stableCode" IS NULL)
    OR ("outcome" = 'BLOCKED' AND "stableCode" IS NOT NULL AND "stableCode" ~ '^[A-Z0-9_]+$')
  ),
  CONSTRAINT "subscription_reactivation_automation_attempts_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_reactivation_automation_attempts_subscription_company_fkey"
    FOREIGN KEY ("subscriptionId", "companyId") REFERENCES "subscriptions"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_reactivation_automation_attempts_schedule_fkey"
    FOREIGN KEY ("scheduleId") REFERENCES "subscription_reactivation_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "subscription_reactivation_automation_attempts_schedule_number_key"
  ON "subscription_reactivation_automation_attempts"("scheduleId", "attemptNumber");
CREATE INDEX "subscription_reactivation_automation_attempts_company_started_idx"
  ON "subscription_reactivation_automation_attempts"("companyId", "startedAt", "id");
CREATE INDEX "subscription_reactivation_automation_attempts_subscription_started_idx"
  ON "subscription_reactivation_automation_attempts"("subscriptionId", "startedAt", "id");
CREATE INDEX "subscription_reactivation_automation_attempts_schedule_started_idx"
  ON "subscription_reactivation_automation_attempts"("scheduleId", "startedAt", "id");

CREATE FUNCTION "enforce_subscription_reactivation_automation_attempt_history"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  schedule RECORD;
  expected_attempt INTEGER;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Subscription reactivation automation attempt history is append-only.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT
    "companyId",
    "subscriptionId",
    "status",
    xmin = pg_current_xact_id()::xid AS changed_in_transaction
  INTO schedule
  FROM "subscription_reactivation_schedules"
  WHERE "id" = NEW."scheduleId"
  FOR UPDATE;

  IF NOT FOUND
    OR schedule."companyId" <> NEW."companyId"
    OR schedule."subscriptionId" <> NEW."subscriptionId" THEN
    RAISE EXCEPTION 'Subscription reactivation automation attempt has invalid ownership.' USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT COALESCE(MAX(attempt."attemptNumber"), 0) + 1
  INTO expected_attempt
  FROM "subscription_reactivation_automation_attempts" attempt
  WHERE attempt."scheduleId" = NEW."scheduleId";

  IF NEW."attemptNumber" <> expected_attempt
    OR NEW."startedAt" < clock_timestamp() - INTERVAL '5 minutes'
    OR NEW."startedAt" > clock_timestamp() + INTERVAL '5 minutes'
    OR NEW."completedAt" > clock_timestamp() + INTERVAL '5 minutes'
    OR (
      NEW."outcome" = 'APPLIED'
      AND (schedule."status" <> 'APPLIED' OR NOT schedule.changed_in_transaction)
    )
    OR (NEW."outcome" = 'BLOCKED' AND schedule."status" <> 'PENDING') THEN
    RAISE EXCEPTION 'Invalid subscription reactivation automation attempt.' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_reactivation_automation_attempt_history_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "subscription_reactivation_automation_attempts"
FOR EACH ROW EXECUTE FUNCTION "enforce_subscription_reactivation_automation_attempt_history"();

COMMIT;
