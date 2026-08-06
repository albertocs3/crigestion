CREATE TYPE "SubscriptionRenewalAttemptPhase" AS ENUM ('PREPARE', 'CONFIRM');
CREATE TYPE "SubscriptionRenewalAttemptOutcome" AS ENUM ('SUCCEEDED', 'BLOCKED', 'FAILED');

CREATE TABLE "subscription_renewal_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "phase" "SubscriptionRenewalAttemptPhase" NOT NULL,
  "outcome" "SubscriptionRenewalAttemptOutcome" NOT NULL,
  "deduplicationKey" CHAR(64) NOT NULL,
  "errorCode" VARCHAR(100),
  "actorId" UUID,
  "attemptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "correlationId" VARCHAR(100),
  "invoiceId" UUID,
  CONSTRAINT "subscription_renewal_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_renewal_attempts_id_company_key" UNIQUE ("id", "companyId"),
  CONSTRAINT "subscription_renewal_attempts_deduplication_key" UNIQUE ("deduplicationKey"),
  CONSTRAINT "subscription_renewal_attempts_evidence_chk" CHECK (
    ("phase" = 'PREPARE' AND "outcome" = 'SUCCEEDED' AND "errorCode" IS NULL AND "invoiceId" IS NOT NULL)
    OR ("phase" = 'PREPARE' AND "outcome" = 'BLOCKED' AND "errorCode" IS NOT NULL AND "invoiceId" IS NULL)
    OR ("phase" = 'CONFIRM' AND "outcome" = 'SUCCEEDED' AND "errorCode" IS NULL AND "invoiceId" IS NOT NULL)
    OR ("phase" = 'CONFIRM' AND "outcome" = 'FAILED' AND "errorCode" IS NOT NULL AND "invoiceId" IS NOT NULL)
  ),
  CONSTRAINT "subscription_renewal_attempts_company_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_renewal_attempts_actor_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_renewal_attempts_invoice_company_fkey" FOREIGN KEY ("invoiceId", "companyId") REFERENCES "invoices"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "subscription_renewal_attempts_company_time_idx"
  ON "subscription_renewal_attempts"("companyId", "attemptedAt", "id");
CREATE INDEX "subscription_renewal_attempts_invoice_time_idx"
  ON "subscription_renewal_attempts"("invoiceId", "attemptedAt", "id");

CREATE TABLE "subscription_renewal_attempt_members" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "attemptId" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "subscriptionId" UUID NOT NULL,
  "periodStart" DATE NOT NULL,
  "subscriptionVersionSnapshot" INTEGER NOT NULL,
  "exclusionId" UUID,
  "reservationId" UUID,
  CONSTRAINT "subscription_renewal_attempt_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_renewal_attempt_members_version_chk" CHECK ("subscriptionVersionSnapshot" > 0),
  CONSTRAINT "subscription_renewal_attempt_members_attempt_subscription_key" UNIQUE ("attemptId", "subscriptionId"),
  CONSTRAINT "subscription_renewal_attempt_members_attempt_company_fkey" FOREIGN KEY ("attemptId", "companyId") REFERENCES "subscription_renewal_attempts"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_renewal_attempt_members_subscription_company_fkey" FOREIGN KEY ("subscriptionId", "companyId") REFERENCES "subscriptions"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_renewal_attempt_members_exclusion_fkey" FOREIGN KEY ("exclusionId") REFERENCES "subscription_renewal_exclusions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_renewal_attempt_members_reservation_fkey" FOREIGN KEY ("reservationId") REFERENCES "subscription_renewal_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "subscription_renewal_attempt_members_subscription_period_idx"
  ON "subscription_renewal_attempt_members"("subscriptionId", "periodStart", "id");
CREATE INDEX "subscription_renewal_attempt_members_exclusion_idx"
  ON "subscription_renewal_attempt_members"("exclusionId", "id");
CREATE INDEX "subscription_renewal_attempt_members_reservation_idx"
  ON "subscription_renewal_attempt_members"("reservationId", "id");

CREATE FUNCTION "prevent_subscription_renewal_attempt_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Subscription renewal attempt history is append-only.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_renewal_attempt_append_only_trigger"
BEFORE UPDATE OR DELETE ON "subscription_renewal_attempts"
FOR EACH ROW EXECUTE FUNCTION "prevent_subscription_renewal_attempt_mutation"();
CREATE TRIGGER "subscription_renewal_attempt_member_append_only_trigger"
BEFORE UPDATE OR DELETE ON "subscription_renewal_attempt_members"
FOR EACH ROW EXECUTE FUNCTION "prevent_subscription_renewal_attempt_mutation"();

CREATE FUNCTION "enforce_subscription_renewal_attempt_member"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent RECORD;
BEGIN
  SELECT "companyId", "phase", "outcome", "invoiceId", xmin::text::bigint AS "createdTransactionId" INTO parent
  FROM "subscription_renewal_attempts" WHERE "id" = NEW."attemptId";
  IF NOT FOUND OR parent."companyId" <> NEW."companyId"
    OR parent."createdTransactionId" <> txid_current()
    OR NOT EXISTS (
      SELECT 1 FROM "subscriptions"
      WHERE "id" = NEW."subscriptionId" AND "companyId" = NEW."companyId"
    )
    OR (NEW."exclusionId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "subscription_renewal_exclusions"
      WHERE "id" = NEW."exclusionId" AND "companyId" = NEW."companyId"
        AND "subscriptionId" = NEW."subscriptionId" AND "periodStart" = NEW."periodStart"
    ))
    OR (parent."phase" = 'PREPARE' AND parent."outcome" = 'BLOCKED' AND NEW."reservationId" IS NOT NULL)
    OR (parent."outcome" = 'SUCCEEDED' AND NEW."reservationId" IS NULL)
    OR (parent."phase" = 'CONFIRM' AND NEW."reservationId" IS NULL)
    OR (NEW."reservationId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "subscription_renewal_reservations" reservation
      WHERE reservation."id" = NEW."reservationId"
        AND reservation."companyId" = NEW."companyId"
        AND reservation."subscriptionId" = NEW."subscriptionId"
        AND reservation."periodStart" = NEW."periodStart"
        AND reservation."subscriptionVersionSnapshot" = NEW."subscriptionVersionSnapshot"
        AND reservation."invoiceId" = parent."invoiceId"
        AND ((parent."phase" = 'PREPARE' AND reservation."status" = 'RESERVED')
          OR (parent."phase" = 'CONFIRM' AND parent."outcome" = 'FAILED' AND reservation."status" = 'RESERVED')
          OR (parent."phase" = 'CONFIRM' AND parent."outcome" = 'SUCCEEDED' AND reservation."status" = 'BILLED'))
    )) THEN
    RAISE EXCEPTION 'Invalid or sealed subscription renewal attempt member evidence.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_renewal_attempt_member_evidence_trigger"
BEFORE INSERT ON "subscription_renewal_attempt_members"
FOR EACH ROW EXECUTE FUNCTION "enforce_subscription_renewal_attempt_member"();

CREATE FUNCTION "assert_subscription_renewal_attempt_complete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_attempt_id UUID;
  target_attempt RECORD;
  member_count INTEGER;
  reservation_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'subscription_renewal_attempts' THEN
    target_attempt_id := NEW."id";
  ELSE
    target_attempt_id := NEW."attemptId";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "subscription_renewal_attempt_members" WHERE "attemptId" = target_attempt_id) THEN
    RAISE EXCEPTION 'A subscription renewal attempt requires at least one member.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT "companyId", "phase", "outcome", "invoiceId" INTO target_attempt
  FROM "subscription_renewal_attempts" WHERE "id" = target_attempt_id;

  IF target_attempt."invoiceId" IS NOT NULL THEN
    SELECT count(*) INTO member_count
    FROM "subscription_renewal_attempt_members" member
    WHERE member."attemptId" = target_attempt_id;

    SELECT count(*) INTO reservation_count
    FROM "subscription_renewal_reservations" reservation
    WHERE reservation."companyId" = target_attempt."companyId"
      AND reservation."invoiceId" = target_attempt."invoiceId"
      AND ((target_attempt."phase" = 'PREPARE' AND reservation."status" = 'RESERVED')
        OR (target_attempt."phase" = 'CONFIRM' AND target_attempt."outcome" = 'FAILED' AND reservation."status" = 'RESERVED')
        OR (target_attempt."phase" = 'CONFIRM' AND target_attempt."outcome" = 'SUCCEEDED' AND reservation."status" = 'BILLED'));

    IF member_count <> reservation_count OR EXISTS (
      SELECT 1
      FROM "subscription_renewal_reservations" reservation
      WHERE reservation."companyId" = target_attempt."companyId"
        AND reservation."invoiceId" = target_attempt."invoiceId"
        AND ((target_attempt."phase" = 'PREPARE' AND reservation."status" = 'RESERVED')
          OR (target_attempt."phase" = 'CONFIRM' AND target_attempt."outcome" = 'FAILED' AND reservation."status" = 'RESERVED')
          OR (target_attempt."phase" = 'CONFIRM' AND target_attempt."outcome" = 'SUCCEEDED' AND reservation."status" = 'BILLED'))
        AND NOT EXISTS (
          SELECT 1 FROM "subscription_renewal_attempt_members" member
          WHERE member."attemptId" = target_attempt_id AND member."reservationId" = reservation."id"
        )
    ) THEN
      RAISE EXCEPTION 'A subscription renewal attempt must cover the complete invoice reservation group.' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF target_attempt."phase" = 'PREPARE' AND target_attempt."outcome" = 'BLOCKED' AND EXISTS (
    SELECT 1
    FROM "subscription_renewal_attempt_members" member
    LEFT JOIN "subscription_renewal_exclusions" exclusion ON exclusion."id" = member."exclusionId"
    WHERE member."attemptId" = target_attempt_id
      AND (member."exclusionId" IS NULL
        OR exclusion."companyId" <> member."companyId"
        OR exclusion."subscriptionId" <> member."subscriptionId"
        OR exclusion."periodStart" <> member."periodStart"
        OR exclusion."status" <> 'OPEN'
        OR exclusion."openedAgainstVersion" > member."subscriptionVersionSnapshot")
  ) THEN
    RAISE EXCEPTION 'A blocked subscription renewal attempt requires complete open exclusion evidence.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "subscription_renewal_attempt_complete_trigger"
AFTER INSERT ON "subscription_renewal_attempts"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_subscription_renewal_attempt_complete"();
CREATE CONSTRAINT TRIGGER "subscription_renewal_attempt_member_complete_trigger"
AFTER INSERT ON "subscription_renewal_attempt_members"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_subscription_renewal_attempt_complete"();

CREATE OR REPLACE FUNCTION "assert_subscription_renewal_exclusion_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_company_id UUID;
  target_subscription_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'subscriptions' THEN
    target_company_id := NEW."companyId";
    target_subscription_id := NEW."id";
  ELSE
    target_company_id := NEW."companyId";
    target_subscription_id := NEW."subscriptionId";
  END IF;

  IF EXISTS (
    SELECT 1 FROM "subscriptions" subscription
    WHERE subscription."companyId" = target_company_id AND subscription."id" = target_subscription_id
      AND subscription."status" = 'RENEWAL_PENDING'
      AND NOT EXISTS (
        SELECT 1 FROM "subscription_renewal_exclusions" exclusion
        WHERE exclusion."companyId" = subscription."companyId"
          AND exclusion."subscriptionId" = subscription."id"
          AND exclusion."periodStart" = subscription."nextRenewalDate"
          AND exclusion."status" = 'OPEN'
          AND ((exclusion."reasonCode" IN ('MANUAL_EXCLUSION', 'PREPARATION_FAILED') AND exclusion."openedAgainstVersion" + 1 <= subscription."version")
            OR (exclusion."reasonCode" = 'LEGACY_PENDING' AND exclusion."openedAgainstVersion" <= subscription."version"))
      )
  ) OR EXISTS (
    SELECT 1 FROM "subscription_renewal_exclusions" exclusion
    JOIN "subscriptions" subscription ON subscription."id" = exclusion."subscriptionId" AND subscription."companyId" = exclusion."companyId"
    WHERE exclusion."companyId" = target_company_id AND exclusion."subscriptionId" = target_subscription_id
      AND exclusion."status" = 'OPEN'
      AND (subscription."status" <> 'RENEWAL_PENDING' OR subscription."nextRenewalDate" <> exclusion."periodStart")
  ) THEN
    RAISE EXCEPTION 'Subscription renewal pending state requires matching open exclusion evidence.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "subscription_renewal_exclusions" exclusion
    JOIN "subscriptions" subscription ON subscription."id" = exclusion."subscriptionId" AND subscription."companyId" = exclusion."companyId"
    LEFT JOIN "invoices" invoice ON invoice."id" = exclusion."resolvedInvoiceId" AND invoice."companyId" = exclusion."companyId"
    WHERE exclusion."companyId" = target_company_id AND exclusion."subscriptionId" = target_subscription_id
      AND exclusion."status" = 'RESOLVED'
      AND (
        (exclusion."resolution" = 'BILLED' AND (
          invoice."status" <> 'ISSUED' OR subscription."status" <> 'ACTIVE'
          OR subscription."nextRenewalDate" <> exclusion."periodEndExclusive"
          OR NOT EXISTS (
            SELECT 1 FROM "subscription_renewal_reservations" reservation
            WHERE reservation."companyId" = exclusion."companyId"
              AND reservation."subscriptionId" = exclusion."subscriptionId"
              AND reservation."invoiceId" = exclusion."resolvedInvoiceId"
              AND reservation."periodStart" = exclusion."periodStart"
              AND reservation."status" = 'BILLED'
          )
        ))
        OR (exclusion."resolution" = 'CANCELLED' AND subscription."status" <> 'CANCELLED')
      )
  ) THEN
    RAISE EXCEPTION 'Resolved renewal exclusion requires matching terminal evidence.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
