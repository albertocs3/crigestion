BEGIN;

CREATE TYPE "SubscriptionChangeScheduleStatus" AS ENUM ('PENDING', 'APPLIED', 'REVOKED');

CREATE TABLE "subscription_change_schedules" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "subscriptionId" UUID NOT NULL,
  "status" "SubscriptionChangeScheduleStatus" NOT NULL DEFAULT 'PENDING',
  "effectiveDate" DATE NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "createdAgainstVersion" INTEGER NOT NULL,
  "scheduledSubscriptionVersion" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "requestedById" UUID NOT NULL,
  "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedById" UUID,
  "revokedAt" TIMESTAMPTZ(3),
  "revocationReason" VARCHAR(500),
  "revokedAgainstVersion" INTEGER,
  "revokedSubscriptionVersion" INTEGER,
  "appliedById" UUID,
  "appliedAt" TIMESTAMPTZ(3),
  "appliedAgainstVersion" INTEGER,
  "appliedSubscriptionVersion" INTEGER,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "subscription_change_schedules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_change_schedules_versions_chk" CHECK (
    "createdAgainstVersion" > 0
    AND "scheduledSubscriptionVersion" = "createdAgainstVersion" + 1
    AND "version" > 0
  ),
  CONSTRAINT "subscription_change_schedules_reason_chk" CHECK (
    char_length(btrim("reason")) BETWEEN 3 AND 500
  ),
  CONSTRAINT "subscription_change_schedules_state_chk" CHECK (
    ("status" = 'PENDING'
      AND "version" = 1
      AND "revokedById" IS NULL AND "revokedAt" IS NULL AND "revocationReason" IS NULL
      AND "revokedAgainstVersion" IS NULL AND "revokedSubscriptionVersion" IS NULL
      AND "appliedById" IS NULL AND "appliedAt" IS NULL
      AND "appliedAgainstVersion" IS NULL AND "appliedSubscriptionVersion" IS NULL)
    OR
    ("status" = 'REVOKED'
      AND "version" = 2
      AND "revokedById" IS NOT NULL AND "revokedAt" IS NOT NULL
      AND char_length(btrim("revocationReason")) BETWEEN 3 AND 500
      AND "revokedAgainstVersion" >= "scheduledSubscriptionVersion"
      AND "revokedSubscriptionVersion" = "revokedAgainstVersion" + 1
      AND "appliedById" IS NULL AND "appliedAt" IS NULL
      AND "appliedAgainstVersion" IS NULL AND "appliedSubscriptionVersion" IS NULL)
    OR
    ("status" = 'APPLIED'
      AND "version" = 2
      AND "appliedById" IS NOT NULL AND "appliedAt" IS NOT NULL
      AND "appliedAgainstVersion" >= "scheduledSubscriptionVersion"
      AND "appliedSubscriptionVersion" = "appliedAgainstVersion" + 1
      AND "revokedById" IS NULL AND "revokedAt" IS NULL AND "revocationReason" IS NULL
      AND "revokedAgainstVersion" IS NULL AND "revokedSubscriptionVersion" IS NULL)
  )
);

CREATE TABLE "subscription_change_schedule_lines" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "scheduleId" UUID NOT NULL,
  "subscriptionId" UUID NOT NULL,
  "subscriptionLineId" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "previousQuantity" DECIMAL(12,3) NOT NULL,
  "newQuantity" DECIMAL(12,3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "subscription_change_schedule_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_change_schedule_lines_values_chk" CHECK (
    "position" > 0
    AND "previousQuantity" > 0
    AND "newQuantity" > 0
    AND "newQuantity" <> "previousQuantity"
  )
);

CREATE UNIQUE INDEX "subscription_change_schedules_id_subscriptionId_key"
  ON "subscription_change_schedules"("id", "subscriptionId");
CREATE UNIQUE INDEX "subscription_change_schedules_one_pending_per_subscription"
  ON "subscription_change_schedules"("subscriptionId") WHERE "status" = 'PENDING';
CREATE INDEX "subscription_change_schedules_companyId_status_effectiveDate_id_idx"
  ON "subscription_change_schedules"("companyId", "status", "effectiveDate", "id");
CREATE INDEX "subscription_change_schedules_subscriptionId_requestedAt_id_idx"
  ON "subscription_change_schedules"("subscriptionId", "requestedAt", "id");
CREATE INDEX "subscription_change_schedules_requestedById_requestedAt_id_idx"
  ON "subscription_change_schedules"("requestedById", "requestedAt", "id");
CREATE INDEX "subscription_change_schedules_revokedById_revokedAt_id_idx"
  ON "subscription_change_schedules"("revokedById", "revokedAt", "id");
CREATE INDEX "subscription_change_schedules_appliedById_appliedAt_id_idx"
  ON "subscription_change_schedules"("appliedById", "appliedAt", "id");

CREATE UNIQUE INDEX "subscription_change_schedule_lines_scheduleId_position_key"
  ON "subscription_change_schedule_lines"("scheduleId", "position");
CREATE UNIQUE INDEX "subscription_change_schedule_lines_scheduleId_subscriptionLineId_key"
  ON "subscription_change_schedule_lines"("scheduleId", "subscriptionLineId");
CREATE INDEX "subscription_change_schedule_lines_subscriptionLineId_idx"
  ON "subscription_change_schedule_lines"("subscriptionLineId");

ALTER TABLE "subscription_change_schedules"
  ADD CONSTRAINT "subscription_change_schedules_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "subscription_change_schedules_subscriptionId_companyId_fkey"
    FOREIGN KEY ("subscriptionId", "companyId") REFERENCES "subscriptions"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "subscription_change_schedules_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "subscription_change_schedules_revokedById_fkey"
    FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "subscription_change_schedules_appliedById_fkey"
    FOREIGN KEY ("appliedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_change_schedule_lines"
  ADD CONSTRAINT "subscription_change_schedule_lines_scheduleId_subscriptionId_fkey"
    FOREIGN KEY ("scheduleId", "subscriptionId") REFERENCES "subscription_change_schedules"("id", "subscriptionId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "subscription_change_schedule_lines_subscriptionLineId_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionLineId", "subscriptionId") REFERENCES "subscription_lines"("id", "subscriptionId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "enforce_subscription_change_schedule_history"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Subscription change schedules cannot be deleted.' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING'
      OR NEW."requestedAt" < clock_timestamp() - INTERVAL '5 minutes'
      OR NEW."requestedAt" > clock_timestamp() + INTERVAL '5 minutes' THEN
      RAISE EXCEPTION 'Invalid subscription change schedule creation.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" <> 'PENDING' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Terminal subscription change schedules are immutable.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."companyId", NEW."subscriptionId", NEW."effectiveDate", NEW."reason",
      NEW."createdAgainstVersion", NEW."scheduledSubscriptionVersion", NEW."requestedById", NEW."requestedAt")
      IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."subscriptionId", OLD."effectiveDate", OLD."reason",
      OLD."createdAgainstVersion", OLD."scheduledSubscriptionVersion", OLD."requestedById", OLD."requestedAt")
    OR NEW."status" NOT IN ('APPLIED', 'REVOKED')
    OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Invalid subscription change schedule transition.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_change_schedule_history_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "subscription_change_schedules"
FOR EACH ROW EXECUTE FUNCTION "enforce_subscription_change_schedule_history"();

CREATE FUNCTION "enforce_subscription_change_schedule_line_history"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Subscription change schedule lines are immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "subscription_change_schedules" schedule
    JOIN "subscription_lines" line
      ON line."id" = NEW."subscriptionLineId" AND line."subscriptionId" = NEW."subscriptionId"
    WHERE schedule."id" = NEW."scheduleId"
      AND schedule."subscriptionId" = NEW."subscriptionId"
      AND schedule."status" = 'PENDING'
      AND schedule.xmin = pg_current_xact_id()::xid
      AND line."quantity" = NEW."previousQuantity"
  ) THEN
    RAISE EXCEPTION 'Invalid subscription change schedule line.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_change_schedule_line_history_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "subscription_change_schedule_lines"
FOR EACH ROW EXECUTE FUNCTION "enforce_subscription_change_schedule_line_history"();

CREATE FUNCTION "assert_subscription_change_schedule_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  subscription_row "subscriptions"%ROWTYPE;
BEGIN
  SELECT * INTO subscription_row
  FROM "subscriptions"
  WHERE "id" = NEW."subscriptionId" AND "companyId" = NEW."companyId";

  IF NOT FOUND
    OR NOT EXISTS (SELECT 1 FROM "subscription_change_schedule_lines" line WHERE line."scheduleId" = NEW."id") THEN
    RAISE EXCEPTION 'Invalid subscription change schedule consistency.' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'PENDING' THEN
    IF subscription_row."status" <> 'ACTIVE'
      OR subscription_row."pricingMode" <> 'PER_LICENSE'
      OR subscription_row."version" <> NEW."scheduledSubscriptionVersion"
      OR subscription_row."nextRenewalDate" <> NEW."effectiveDate"
      OR EXISTS (
        SELECT 1 FROM "subscription_change_schedule_lines" change_line
        JOIN "subscription_lines" line ON line."id" = change_line."subscriptionLineId"
        WHERE change_line."scheduleId" = NEW."id"
          AND (line."subscriptionId" <> NEW."subscriptionId" OR line."quantity" <> change_line."previousQuantity")
      )
      OR EXISTS (SELECT 1 FROM "subscription_renewal_reservations" reservation
        WHERE reservation."companyId" = NEW."companyId" AND reservation."subscriptionId" = NEW."subscriptionId" AND reservation."status" = 'RESERVED')
      OR EXISTS (SELECT 1 FROM "subscription_renewal_exclusions" exclusion
        WHERE exclusion."companyId" = NEW."companyId" AND exclusion."subscriptionId" = NEW."subscriptionId" AND exclusion."status" = 'OPEN')
      OR EXISTS (SELECT 1 FROM "subscription_cancellation_schedules" cancellation
        WHERE cancellation."companyId" = NEW."companyId" AND cancellation."subscriptionId" = NEW."subscriptionId" AND cancellation."status" = 'PENDING')
      OR EXISTS (SELECT 1 FROM "subscription_reactivation_schedules" reactivation
        WHERE reactivation."companyId" = NEW."companyId" AND reactivation."subscriptionId" = NEW."subscriptionId" AND reactivation."status" = 'PENDING') THEN
      RAISE EXCEPTION 'Invalid pending subscription change schedule.' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'REVOKED' THEN
    IF subscription_row."version" <> NEW."revokedSubscriptionVersion"
      OR subscription_row."status" <> 'ACTIVE'
      OR NEW."revokedAt" < clock_timestamp() - INTERVAL '5 minutes'
      OR NEW."revokedAt" > clock_timestamp() + INTERVAL '5 minutes'
      OR EXISTS (
        SELECT 1 FROM "subscription_change_schedule_lines" change_line
        JOIN "subscription_lines" line ON line."id" = change_line."subscriptionLineId"
        WHERE change_line."scheduleId" = NEW."id" AND line."quantity" <> change_line."previousQuantity"
      ) THEN
      RAISE EXCEPTION 'Invalid revoked subscription change schedule.' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."status" = 'APPLIED' THEN
    IF subscription_row."version" <> NEW."appliedSubscriptionVersion"
      OR subscription_row."status" <> 'ACTIVE'
      OR NEW."effectiveDate" > (NEW."appliedAt" AT TIME ZONE 'Europe/Madrid')::date
      OR NEW."appliedAt" < clock_timestamp() - INTERVAL '5 minutes'
      OR NEW."appliedAt" > clock_timestamp() + INTERVAL '5 minutes'
      OR EXISTS (
        SELECT 1 FROM "subscription_change_schedule_lines" change_line
        JOIN "subscription_lines" line ON line."id" = change_line."subscriptionLineId"
        WHERE change_line."scheduleId" = NEW."id" AND line."quantity" <> change_line."newQuantity"
      ) THEN
      RAISE EXCEPTION 'Invalid applied subscription change schedule.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "subscription_change_schedule_consistency_trigger"
AFTER INSERT OR UPDATE ON "subscription_change_schedules"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_subscription_change_schedule_consistency"();

CREATE FUNCTION "assert_subscription_pending_change_from_subscription"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "subscription_change_schedules" schedule
    WHERE schedule."companyId" = NEW."companyId"
      AND schedule."subscriptionId" = NEW."id"
      AND schedule."status" = 'PENDING'
      AND (NEW."status" <> 'ACTIVE'
        OR NEW."pricingMode" <> 'PER_LICENSE'
        OR NEW."version" <> schedule."scheduledSubscriptionVersion"
        OR NEW."nextRenewalDate" <> schedule."effectiveDate")
  ) THEN
    RAISE EXCEPTION 'Subscription state conflicts with a pending change schedule.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "subscription_pending_change_consistency_trigger"
AFTER UPDATE ON "subscriptions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_subscription_pending_change_from_subscription"();

CREATE FUNCTION "prevent_subscription_change_schedule_blocker"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "subscription_change_schedules" schedule
    WHERE schedule."companyId" = NEW."companyId"
      AND schedule."subscriptionId" = NEW."subscriptionId"
      AND schedule."status" = 'PENDING'
  ) THEN
    RAISE EXCEPTION 'A pending subscription change schedule conflicts with this operation.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_change_blocks_reserved_renewal_trigger"
BEFORE INSERT OR UPDATE ON "subscription_renewal_reservations"
FOR EACH ROW WHEN (NEW."status" = 'RESERVED')
EXECUTE FUNCTION "prevent_subscription_change_schedule_blocker"();

CREATE TRIGGER "subscription_change_blocks_open_exclusion_trigger"
BEFORE INSERT OR UPDATE ON "subscription_renewal_exclusions"
FOR EACH ROW WHEN (NEW."status" = 'OPEN')
EXECUTE FUNCTION "prevent_subscription_change_schedule_blocker"();

CREATE TRIGGER "subscription_change_blocks_pending_cancellation_trigger"
BEFORE INSERT OR UPDATE ON "subscription_cancellation_schedules"
FOR EACH ROW WHEN (NEW."status" = 'PENDING')
EXECUTE FUNCTION "prevent_subscription_change_schedule_blocker"();

CREATE TRIGGER "subscription_change_blocks_pending_reactivation_trigger"
BEFORE INSERT OR UPDATE ON "subscription_reactivation_schedules"
FOR EACH ROW WHEN (NEW."status" = 'PENDING')
EXECUTE FUNCTION "prevent_subscription_change_schedule_blocker"();

CREATE OR REPLACE FUNCTION "enforce_subscription_lines_draft_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  subscription_status "SubscriptionStatus";
  target_subscription_id UUID;
  is_scheduled_quantity_change BOOLEAN := FALSE;
BEGIN
  target_subscription_id := COALESCE(NEW."subscriptionId", OLD."subscriptionId");
  SELECT "status" INTO subscription_status
  FROM "subscriptions"
  WHERE "id" = target_subscription_id;

  IF subscription_status <> 'DRAFT' AND TG_OP = 'UPDATE' THEN
    is_scheduled_quantity_change :=
      (NEW."id", NEW."subscriptionId", NEW."position", NEW."catalogItemId",
       NEW."catalogItemCodeSnapshot", NEW."catalogItemKindSnapshot", NEW."description",
       NEW."unitPrice", NEW."discountPercent", NEW."discountAmount", NEW."taxRateId",
       NEW."taxRateCodeSnapshot", NEW."taxRateNameSnapshot", NEW."taxRateSnapshot", NEW."createdAt")
      IS NOT DISTINCT FROM
      (OLD."id", OLD."subscriptionId", OLD."position", OLD."catalogItemId",
       OLD."catalogItemCodeSnapshot", OLD."catalogItemKindSnapshot", OLD."description",
       OLD."unitPrice", OLD."discountPercent", OLD."discountAmount", OLD."taxRateId",
       OLD."taxRateCodeSnapshot", OLD."taxRateNameSnapshot", OLD."taxRateSnapshot", OLD."createdAt")
      AND NEW."quantity" IS DISTINCT FROM OLD."quantity"
      AND EXISTS (
        SELECT 1
        FROM "subscription_change_schedules" schedule
        JOIN "subscription_change_schedule_lines" change_line ON change_line."scheduleId" = schedule."id"
        WHERE schedule."subscriptionId" = NEW."subscriptionId"
          AND schedule."status" = 'APPLIED'
          AND schedule.xmin = pg_current_xact_id()::xid
          AND change_line."subscriptionLineId" = NEW."id"
          AND change_line."previousQuantity" = OLD."quantity"
          AND change_line."newQuantity" = NEW."quantity"
      );
  END IF;

  IF subscription_status IS NULL
    OR (subscription_status <> 'DRAFT' AND NOT is_scheduled_quantity_change) THEN
    RAISE EXCEPTION 'Subscription lines can only change while the subscription is DRAFT or through an applied change schedule.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Subscriptions.ScheduleChanges', 'Programar cambios de suscripciones', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'Subscriptions.ScheduleChanges'
WHERE role."code" IN ('Administrator', 'Administrador') AND role."isProtected" = true
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
