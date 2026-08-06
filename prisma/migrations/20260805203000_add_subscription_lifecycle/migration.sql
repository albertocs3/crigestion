ALTER TABLE "subscriptions"
  ADD COLUMN "cancelledById" UUID,
  ADD COLUMN "cancelledAt" TIMESTAMPTZ(3),
  ADD COLUMN "cancellationEffectiveDate" DATE,
  ADD COLUMN "cancellationReason" VARCHAR(500),
  ADD CONSTRAINT "subscriptions_cancelledById_fkey"
    FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "subscriptions_cancellation_evidence_chk" CHECK (
    ("status" = 'CANCELLED' AND "cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL
      AND "cancellationEffectiveDate" IS NOT NULL
      AND "cancellationReason" IS NOT NULL AND btrim("cancellationReason") <> '')
    OR ("status" <> 'CANCELLED' AND "cancelledById" IS NULL AND "cancelledAt" IS NULL
      AND "cancellationEffectiveDate" IS NULL AND "cancellationReason" IS NULL)
  ),
  ADD CONSTRAINT "subscriptions_start_year_chk" CHECK (
    "year" = EXTRACT(YEAR FROM "startDate")::integer
  ),
  ADD CONSTRAINT "subscriptions_draft_renewal_chk" CHECK (
    "status" <> 'DRAFT' OR "nextRenewalDate" = "startDate"
  );

CREATE OR REPLACE FUNCTION "enforce_subscription_lines_draft_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  subscription_status "SubscriptionStatus";
  target_subscription_id UUID;
BEGIN
  target_subscription_id := COALESCE(NEW."subscriptionId", OLD."subscriptionId");
  SELECT "status" INTO subscription_status
  FROM "subscriptions"
  WHERE "id" = target_subscription_id
  FOR UPDATE;

  IF subscription_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Subscription lines can only change while the subscription is DRAFT.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE FUNCTION "enforce_subscription_header_lifecycle"()
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
  ELSIF OLD."status" = 'ACTIVE' AND NEW."status" NOT IN ('ACTIVE', 'CANCELLED') THEN
    RAISE EXCEPTION 'Invalid subscription status transition.' USING ERRCODE = 'check_violation';
  ELSIF OLD."status" = 'RENEWAL_PENDING' AND NEW."status" NOT IN ('RENEWAL_PENDING', 'ACTIVE', 'CANCELLED') THEN
    RAISE EXCEPTION 'Invalid subscription status transition.' USING ERRCODE = 'check_violation';
  ELSIF OLD."status" = 'CANCELLED' AND NEW."status" <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Invalid subscription status transition.' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" <> 'DRAFT' AND
     (NEW."customerId", NEW."name", NEW."periodicity", NEW."pricingMode", NEW."paymentMethod",
      NEW."startDate", NEW."nextRenewalDate", NEW."endDate", NEW."notes")
       IS DISTINCT FROM
     (OLD."customerId", OLD."name", OLD."periodicity", OLD."pricingMode", OLD."paymentMethod",
      OLD."startDate", OLD."nextRenewalDate", OLD."endDate", OLD."notes") THEN
    RAISE EXCEPTION 'Active subscription contract fields cannot change.' USING ERRCODE = 'check_violation';
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

CREATE TRIGGER "subscription_header_lifecycle_trigger"
BEFORE UPDATE ON "subscriptions"
FOR EACH ROW EXECUTE FUNCTION "enforce_subscription_header_lifecycle"();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Subscriptions.Cancel', 'Cancelar suscripciones', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador'
  AND role."isProtected" = true
  AND permission."code" = 'Subscriptions.Cancel'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
