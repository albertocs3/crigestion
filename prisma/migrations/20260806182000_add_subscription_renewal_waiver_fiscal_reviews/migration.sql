BEGIN;

CREATE TYPE "SubscriptionRenewalWaiverReviewStatus" AS ENUM (
  'PENDING', 'IN_REVIEW', 'ESCALATED', 'ACTION_REQUIRED', 'CLOSED'
);
CREATE TYPE "SubscriptionRenewalWaiverReviewDecision" AS ENUM (
  'NO_ADDITIONAL_ACTION',
  'MANUAL_ACCOUNTING_ACTION_REQUIRED',
  'BILLING_REGULARIZATION_REQUIRED',
  'EXTERNAL_FISCAL_ACTION_REQUIRED',
  'EXTERNAL_ADVICE_REQUIRED'
);
CREATE TYPE "SubscriptionRenewalWaiverReviewEventType" AS ENUM ('OPENED', 'STARTED', 'DECIDED');
CREATE TYPE "SubscriptionRenewalWaiverReviewSource" AS ENUM ('CURRENT_WORKFLOW', 'BACKFILLED_EXISTING_WAIVER');

CREATE TABLE "subscription_renewal_waiver_reviews" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "exclusionId" UUID NOT NULL,
  "status" "SubscriptionRenewalWaiverReviewStatus" NOT NULL DEFAULT 'PENDING',
  "source" "SubscriptionRenewalWaiverReviewSource" NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "openedById" UUID NOT NULL,
  "openedAt" TIMESTAMPTZ(3) NOT NULL,
  "startedById" UUID,
  "startedAt" TIMESTAMPTZ(3),
  "decision" "SubscriptionRenewalWaiverReviewDecision",
  "decisionDetail" VARCHAR(500),
  "actionDueDate" DATE,
  "decidedById" UUID,
  "decidedAt" TIMESTAMPTZ(3),
  "closedById" UUID,
  "closedAt" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_renewal_waiver_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_renewal_waiver_reviews_exclusionId_key" UNIQUE ("exclusionId"),
  CONSTRAINT "subscription_renewal_waiver_reviews_id_companyId_key" UNIQUE ("id", "companyId"),
  CONSTRAINT "subscription_renewal_waiver_reviews_exclusionId_companyId_key" UNIQUE ("exclusionId", "companyId"),
  CONSTRAINT "subscription_renewal_waiver_reviews_exclusion_fkey"
    FOREIGN KEY ("exclusionId", "companyId") REFERENCES "subscription_renewal_exclusions" ("id", "companyId") ON DELETE RESTRICT,
  CONSTRAINT "subscription_renewal_waiver_reviews_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies" ("id") ON DELETE RESTRICT,
  CONSTRAINT "subscription_renewal_waiver_reviews_openedBy_fkey"
    FOREIGN KEY ("openedById") REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "subscription_renewal_waiver_reviews_startedBy_fkey"
    FOREIGN KEY ("startedById") REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "subscription_renewal_waiver_reviews_decidedBy_fkey"
    FOREIGN KEY ("decidedById") REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "subscription_renewal_waiver_reviews_closedBy_fkey"
    FOREIGN KEY ("closedById") REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "subscription_renewal_waiver_reviews_evidence_chk" CHECK (
    ("status" = 'PENDING' AND "version" = 1
      AND "startedById" IS NULL AND "startedAt" IS NULL
      AND "decision" IS NULL AND "decisionDetail" IS NULL AND "actionDueDate" IS NULL
      AND "decidedById" IS NULL AND "decidedAt" IS NULL AND "closedById" IS NULL AND "closedAt" IS NULL)
    OR
    ("status" = 'IN_REVIEW' AND "version" = 2
      AND "startedById" IS NOT NULL AND "startedById" <> "openedById" AND "startedAt" IS NOT NULL AND "startedAt" >= "openedAt"
      AND "decision" IS NULL AND "decisionDetail" IS NULL AND "actionDueDate" IS NULL
      AND "decidedById" IS NULL AND "decidedAt" IS NULL AND "closedById" IS NULL AND "closedAt" IS NULL)
    OR
    ("status" IN ('ESCALATED', 'ACTION_REQUIRED', 'CLOSED') AND "version" = 3
      AND "startedById" IS NOT NULL AND "startedById" <> "openedById" AND "startedAt" IS NOT NULL AND "startedAt" >= "openedAt"
      AND "decision" IS NOT NULL AND "decisionDetail" IS NOT NULL AND length(btrim("decisionDetail")) >= 10
      AND "decidedById" = "startedById" AND "decidedAt" IS NOT NULL AND "decidedAt" >= "startedAt"
      AND (
        ("status" = 'CLOSED' AND "decision" = 'NO_ADDITIONAL_ACTION' AND "actionDueDate" IS NULL
          AND "closedById" = "decidedById" AND "closedAt" = "decidedAt")
        OR
        ("status" = 'ESCALATED' AND "decision" = 'EXTERNAL_ADVICE_REQUIRED' AND "actionDueDate" IS NOT NULL
          AND "actionDueDate" >= ("decidedAt" AT TIME ZONE 'Europe/Madrid')::date
          AND "closedById" IS NULL AND "closedAt" IS NULL)
        OR
        ("status" = 'ACTION_REQUIRED'
          AND "decision" IN ('MANUAL_ACCOUNTING_ACTION_REQUIRED', 'BILLING_REGULARIZATION_REQUIRED', 'EXTERNAL_FISCAL_ACTION_REQUIRED')
          AND "actionDueDate" IS NOT NULL AND "actionDueDate" >= ("decidedAt" AT TIME ZONE 'Europe/Madrid')::date
          AND "closedById" IS NULL AND "closedAt" IS NULL)
      ))
  )
);

CREATE INDEX "subscription_renewal_waiver_reviews_company_status_opened_idx"
  ON "subscription_renewal_waiver_reviews" ("companyId", "status", "openedAt", "id");
CREATE INDEX "subscription_renewal_waiver_reviews_company_due_idx"
  ON "subscription_renewal_waiver_reviews" ("companyId", "actionDueDate", "id");

CREATE TABLE "subscription_renewal_waiver_review_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "reviewId" UUID NOT NULL,
  "type" "SubscriptionRenewalWaiverReviewEventType" NOT NULL,
  "reviewVersion" INTEGER NOT NULL,
  "actorId" UUID NOT NULL,
  "decision" "SubscriptionRenewalWaiverReviewDecision",
  "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "correlationId" VARCHAR(100),
  CONSTRAINT "subscription_renewal_waiver_review_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_renewal_waiver_review_events_review_version_key" UNIQUE ("reviewId", "reviewVersion"),
  CONSTRAINT "subscription_renewal_waiver_review_events_review_fkey"
    FOREIGN KEY ("reviewId", "companyId") REFERENCES "subscription_renewal_waiver_reviews" ("id", "companyId") ON DELETE RESTRICT,
  CONSTRAINT "subscription_renewal_waiver_review_events_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies" ("id") ON DELETE RESTRICT,
  CONSTRAINT "subscription_renewal_waiver_review_events_actor_fkey"
    FOREIGN KEY ("actorId") REFERENCES "users" ("id") ON DELETE RESTRICT,
  CONSTRAINT "subscription_renewal_waiver_review_events_evidence_chk" CHECK (
    "reviewVersion" > 0
    AND (("type" IN ('OPENED', 'STARTED') AND "decision" IS NULL) OR ("type" = 'DECIDED' AND "decision" IS NOT NULL))
  )
);

CREATE INDEX "subscription_renewal_waiver_review_events_company_occurred_idx"
  ON "subscription_renewal_waiver_review_events" ("companyId", "occurredAt", "id");

LOCK TABLE "subscription_renewal_exclusions", "subscription_renewal_waiver_snapshots",
  "subscription_renewal_waiver_tax_summaries" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "subscription_renewal_exclusions" exclusion
    LEFT JOIN "subscription_renewal_waiver_snapshots" snapshot ON snapshot."exclusionId" = exclusion."id"
    WHERE exclusion."status" = 'RESOLVED' AND exclusion."resolution" = 'WAIVED'
      AND (exclusion."resolvedById" IS NULL OR snapshot."exclusionId" IS NULL
        OR NOT EXISTS (SELECT 1 FROM "subscription_renewal_waiver_tax_summaries" tax WHERE tax."exclusionId" = exclusion."id"))
  ) THEN
    RAISE EXCEPTION 'Existing WAIVED renewal evidence is incomplete for fiscal review backfill.';
  END IF;
END;
$$;

INSERT INTO "subscription_renewal_waiver_reviews" (
  "companyId", "exclusionId", "source", "openedById", "openedAt", "updatedAt"
)
SELECT "companyId", "id", 'BACKFILLED_EXISTING_WAIVER', "resolvedById", "resolvedAt", CURRENT_TIMESTAMP
FROM "subscription_renewal_exclusions"
WHERE "status" = 'RESOLVED' AND "resolution" = 'WAIVED';

INSERT INTO "subscription_renewal_waiver_review_events" (
  "companyId", "reviewId", "type", "reviewVersion", "actorId", "occurredAt"
)
SELECT review."companyId", review."id", 'OPENED', 1, review."openedById", review."openedAt"
FROM "subscription_renewal_waiver_reviews" review;

CREATE OR REPLACE FUNCTION "enforce_subscription_renewal_waiver_review_history"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE parent RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Subscription renewal waiver reviews cannot be deleted.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT exclusion."status", exclusion."resolution", exclusion."resolvedById"
      INTO parent
    FROM "subscription_renewal_exclusions" exclusion
    WHERE exclusion."id" = NEW."exclusionId" AND exclusion."companyId" = NEW."companyId"
    FOR UPDATE;
    IF NEW."source" <> 'CURRENT_WORKFLOW' OR NOT FOUND
      OR parent."status" <> 'RESOLVED' OR parent."resolution" <> 'WAIVED'
      OR parent."resolvedById" <> NEW."openedById"
      OR NOT EXISTS (SELECT 1 FROM "subscription_renewal_waiver_snapshots" snapshot WHERE snapshot."exclusionId" = NEW."exclusionId")
      OR NOT EXISTS (SELECT 1 FROM "subscription_renewal_waiver_tax_summaries" tax WHERE tax."exclusionId" = NEW."exclusionId") THEN
      RAISE EXCEPTION 'Invalid subscription renewal waiver review source.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" IN ('ESCALATED', 'ACTION_REQUIRED', 'CLOSED') THEN
    RAISE EXCEPTION 'Decided subscription renewal waiver reviews are immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."exclusionId", NEW."source", NEW."openedById", NEW."openedAt")
    IS DISTINCT FROM
    (OLD."id", OLD."companyId", OLD."exclusionId", OLD."source", OLD."openedById", OLD."openedAt")
    OR NEW."version" <> OLD."version" + 1
    OR NOT ((OLD."status" = 'PENDING' AND NEW."status" = 'IN_REVIEW')
      OR (OLD."status" = 'IN_REVIEW' AND NEW."status" IN ('ESCALATED', 'ACTION_REQUIRED', 'CLOSED'))) THEN
    RAISE EXCEPTION 'Invalid subscription renewal waiver review transition.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "resolvedById" INTO parent
  FROM "subscription_renewal_exclusions"
  WHERE "id" = NEW."exclusionId" AND "companyId" = NEW."companyId" FOR UPDATE;
  IF NEW."startedById" = parent."resolvedById" OR NEW."decidedById" = parent."resolvedById" THEN
    RAISE EXCEPTION 'A waiver cannot be fiscally reviewed by its maker.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_renewal_waiver_review_history_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "subscription_renewal_waiver_reviews"
FOR EACH ROW EXECUTE FUNCTION "enforce_subscription_renewal_waiver_review_history"();

CREATE OR REPLACE FUNCTION "enforce_subscription_renewal_waiver_review_event_history"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE review RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Subscription renewal waiver review events are append-only.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "version", "status", "openedById", "openedAt", "startedById", "startedAt",
      "decidedById", "decidedAt", "decision"
    INTO review FROM "subscription_renewal_waiver_reviews"
    WHERE "id" = NEW."reviewId" AND "companyId" = NEW."companyId" FOR UPDATE;
  IF NOT FOUND OR NEW."reviewVersion" <> review."version"
    OR (NEW."type" = 'OPENED' AND (review."version" <> 1 OR NEW."actorId" <> review."openedById"
      OR NEW."occurredAt" IS DISTINCT FROM review."openedAt"))
    OR (NEW."type" = 'STARTED' AND (review."status" <> 'IN_REVIEW' OR NEW."actorId" <> review."startedById"
      OR NEW."occurredAt" IS DISTINCT FROM review."startedAt"))
    OR (NEW."type" = 'DECIDED' AND (review."status" NOT IN ('ESCALATED', 'ACTION_REQUIRED', 'CLOSED')
      OR NEW."actorId" <> review."decidedById" OR NEW."decision" IS DISTINCT FROM review."decision"
      OR NEW."occurredAt" IS DISTINCT FROM review."decidedAt")) THEN
    RAISE EXCEPTION 'Invalid subscription renewal waiver review event.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_renewal_waiver_review_event_history_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "subscription_renewal_waiver_review_events"
FOR EACH ROW EXECUTE FUNCTION "enforce_subscription_renewal_waiver_review_event_history"();

CREATE OR REPLACE FUNCTION "assert_subscription_renewal_waiver_review_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE target_exclusion_id UUID; target_review_id UUID; parent RECORD; review_count INTEGER;
  current_review_version INTEGER; event_count INTEGER; minimum_event_version INTEGER; maximum_event_version INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'subscription_renewal_exclusions' THEN
    target_exclusion_id := NEW."id";
    SELECT "id" INTO target_review_id FROM "subscription_renewal_waiver_reviews" WHERE "exclusionId" = target_exclusion_id;
  ELSIF TG_TABLE_NAME = 'subscription_renewal_waiver_reviews' THEN
    target_exclusion_id := NEW."exclusionId";
    target_review_id := NEW."id";
  ELSE
    target_review_id := NEW."reviewId";
    SELECT "exclusionId" INTO target_exclusion_id FROM "subscription_renewal_waiver_reviews" WHERE "id" = target_review_id;
  END IF;
  SELECT "status", "resolution" INTO parent FROM "subscription_renewal_exclusions" WHERE "id" = target_exclusion_id;
  SELECT count(*) INTO review_count FROM "subscription_renewal_waiver_reviews" WHERE "exclusionId" = target_exclusion_id;
  IF parent."status" = 'RESOLVED' AND parent."resolution" = 'WAIVED' THEN
    IF review_count <> 1 THEN RAISE EXCEPTION 'Waived renewal requires exactly one fiscal review.' USING ERRCODE = 'check_violation'; END IF;
  ELSIF review_count <> 0 THEN
    RAISE EXCEPTION 'Only waived renewals may have fiscal reviews.' USING ERRCODE = 'check_violation';
  END IF;
  IF target_review_id IS NOT NULL THEN
    SELECT "version" INTO current_review_version
      FROM "subscription_renewal_waiver_reviews" WHERE "id" = target_review_id;
    SELECT count(*), min("reviewVersion"), max("reviewVersion")
      INTO event_count, minimum_event_version, maximum_event_version
      FROM "subscription_renewal_waiver_review_events" WHERE "reviewId" = target_review_id;
    IF event_count <> current_review_version OR minimum_event_version <> 1 OR maximum_event_version <> current_review_version THEN
      RAISE EXCEPTION 'Every fiscal review version requires one ledger event.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "subscription_renewal_waiver_review_parent_consistency"
AFTER UPDATE ON "subscription_renewal_exclusions"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_subscription_renewal_waiver_review_consistency"();
CREATE CONSTRAINT TRIGGER "subscription_renewal_waiver_review_consistency"
AFTER INSERT OR UPDATE ON "subscription_renewal_waiver_reviews"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_subscription_renewal_waiver_review_consistency"();
CREATE CONSTRAINT TRIGGER "subscription_renewal_waiver_review_event_consistency"
AFTER INSERT ON "subscription_renewal_waiver_review_events"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_subscription_renewal_waiver_review_consistency"();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'Subscriptions.ViewRenewalWaiverFiscalReviews', 'Consultar revisiones fiscales de periodos condonados', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Subscriptions.DecideRenewalWaiverFiscalReviews', 'Iniciar y decidir revisiones fiscales de periodos condonados', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" IN (
  'Subscriptions.ViewRenewalWaiverFiscalReviews',
  'Subscriptions.DecideRenewalWaiverFiscalReviews'
)
WHERE role."isProtected" = true AND role."code" IN ('Administrator', 'Administrador')
ON CONFLICT DO NOTHING;

COMMIT;
