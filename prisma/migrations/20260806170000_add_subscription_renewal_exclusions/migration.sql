CREATE TYPE "SubscriptionRenewalExclusionStatus" AS ENUM ('OPEN', 'RESOLVED');
CREATE TYPE "SubscriptionRenewalExclusionReasonCode" AS ENUM ('MANUAL_EXCLUSION', 'LEGACY_PENDING');
CREATE TYPE "SubscriptionRenewalExclusionResolution" AS ENUM ('BILLED', 'CANCELLED');

CREATE TABLE "subscription_renewal_exclusions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "subscriptionId" UUID NOT NULL,
  "periodStart" DATE NOT NULL,
  "periodEndExclusive" DATE NOT NULL,
  "status" "SubscriptionRenewalExclusionStatus" NOT NULL DEFAULT 'OPEN',
  "reasonCode" "SubscriptionRenewalExclusionReasonCode" NOT NULL DEFAULT 'MANUAL_EXCLUSION',
  "reasonDetail" VARCHAR(500),
  "openedAgainstVersion" INTEGER NOT NULL,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMPTZ(3),
  "lastErrorCode" VARCHAR(100),
  "openedById" UUID,
  "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMPTZ(3),
  "resolvedById" UUID,
  "resolution" "SubscriptionRenewalExclusionResolution",
  "resolvedInvoiceId" UUID,
  CONSTRAINT "subscription_renewal_exclusions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_renewal_exclusions_period_chk" CHECK ("periodEndExclusive" > "periodStart"),
  CONSTRAINT "subscription_renewal_exclusions_version_chk" CHECK ("openedAgainstVersion" > 0),
  CONSTRAINT "subscription_renewal_exclusions_attempt_chk" CHECK (
    "attemptCount" >= 0
    AND (("attemptCount" = 0 AND "lastAttemptAt" IS NULL AND "lastErrorCode" IS NULL)
      OR ("attemptCount" > 0 AND "lastAttemptAt" IS NOT NULL))
  ),
  CONSTRAINT "subscription_renewal_exclusions_evidence_chk" CHECK (
    ("status" = 'OPEN' AND "resolvedAt" IS NULL AND "resolvedById" IS NULL
      AND "resolution" IS NULL AND "resolvedInvoiceId" IS NULL)
    OR ("status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL AND "resolvedById" IS NOT NULL
      AND "resolution" IS NOT NULL
      AND (("resolution" = 'BILLED' AND "resolvedInvoiceId" IS NOT NULL)
        OR ("resolution" = 'CANCELLED' AND "resolvedInvoiceId" IS NULL)))
  ),
  CONSTRAINT "subscription_renewal_exclusions_company_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_renewal_exclusions_subscription_company_fkey" FOREIGN KEY ("subscriptionId", "companyId") REFERENCES "subscriptions"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_renewal_exclusions_opened_by_fkey" FOREIGN KEY ("openedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_renewal_exclusions_resolved_by_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_renewal_exclusions_resolved_invoice_company_fkey" FOREIGN KEY ("resolvedInvoiceId", "companyId") REFERENCES "invoices"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "subscription_renewal_exclusions_company_subscription_period_key"
  ON "subscription_renewal_exclusions"("companyId", "subscriptionId", "periodStart");
CREATE UNIQUE INDEX "subscription_renewal_exclusions_one_open_key"
  ON "subscription_renewal_exclusions"("companyId", "subscriptionId") WHERE "status" = 'OPEN';
CREATE INDEX "subscription_renewal_exclusions_queue_idx"
  ON "subscription_renewal_exclusions"("companyId", "status", "lastAttemptAt", "id");
CREATE INDEX "subscription_renewal_exclusions_period_idx"
  ON "subscription_renewal_exclusions"("companyId", "status", "periodStart", "id");
CREATE INDEX "subscription_renewal_exclusions_subscription_history_idx"
  ON "subscription_renewal_exclusions"("subscriptionId", "openedAt", "id");

INSERT INTO "subscription_renewal_exclusions" (
  "companyId", "subscriptionId", "periodStart", "periodEndExclusive", "status",
  "reasonCode", "openedAgainstVersion", "openedAt"
)
SELECT s."companyId", s."id", s."nextRenewalDate",
  "subscription_next_renewal_date"(s."nextRenewalDate", s."periodicity"),
  'OPEN', 'LEGACY_PENDING', s."version", s."updatedAt"
FROM "subscriptions" s
WHERE s."status" = 'RENEWAL_PENDING'
ON CONFLICT ("companyId", "subscriptionId", "periodStart") DO NOTHING;

CREATE FUNCTION "enforce_subscription_renewal_exclusion_history"()
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_renewal_exclusion_history_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "subscription_renewal_exclusions"
FOR EACH ROW EXECUTE FUNCTION "enforce_subscription_renewal_exclusion_history"();

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
    NEW."version" <> OLD."version" + 1
    OR NEW."nextRenewalDate" IS DISTINCT FROM OLD."nextRenewalDate"
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
     (NEW."customerId", NEW."name", NEW."periodicity", NEW."pricingMode", NEW."paymentMethod",
      NEW."startDate", NEW."endDate", NEW."notes")
       IS DISTINCT FROM
     (OLD."customerId", OLD."name", OLD."periodicity", OLD."pricingMode", OLD."paymentMethod",
      OLD."startDate", OLD."endDate", OLD."notes") THEN
    RAISE EXCEPTION 'Active subscription contract fields cannot change.' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."nextRenewalDate" IS DISTINCT FROM OLD."nextRenewalDate" THEN
    IF OLD."status" = 'DRAFT' THEN
      IF NEW."status" <> 'DRAFT' OR NEW."nextRenewalDate" <> NEW."startDate" OR NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION 'Invalid draft renewal date change.' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF OLD."status" NOT IN ('ACTIVE', 'RENEWAL_PENDING')
        OR NEW."status" <> 'ACTIVE'
        OR NEW."version" <> OLD."version" + 1
        OR NEW."nextRenewalDate" <> "subscription_next_renewal_date"(OLD."nextRenewalDate", OLD."periodicity")
        OR NOT EXISTS (
          SELECT 1
          FROM "subscription_renewal_reservations" reservation
          JOIN "invoices" invoice ON invoice."id" = reservation."invoiceId" AND invoice."companyId" = reservation."companyId"
          WHERE reservation."companyId" = OLD."companyId"
            AND reservation."subscriptionId" = OLD."id"
            AND reservation."status" = 'RESERVED'
            AND reservation."periodStart" = OLD."nextRenewalDate"
            AND reservation."periodEndExclusive" = NEW."nextRenewalDate"
            AND reservation."subscriptionVersionSnapshot" = OLD."version"
            AND invoice."origin" = 'SUBSCRIPTION'
            AND invoice."documentType" = 'STANDARD'
            AND invoice."status" = 'ISSUED'
            AND invoice."issuedAt" IS NOT NULL
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

CREATE FUNCTION "assert_subscription_renewal_exclusion_consistency"()
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
          AND ((exclusion."reasonCode" = 'MANUAL_EXCLUSION' AND exclusion."openedAgainstVersion" + 1 <= subscription."version")
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

CREATE CONSTRAINT TRIGGER "subscription_renewal_exclusion_subscription_consistency_trigger"
AFTER UPDATE OF "status", "version", "nextRenewalDate" ON "subscriptions"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_subscription_renewal_exclusion_consistency"();
CREATE CONSTRAINT TRIGGER "subscription_renewal_exclusion_consistency_trigger"
AFTER INSERT OR UPDATE ON "subscription_renewal_exclusions"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_subscription_renewal_exclusion_consistency"();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Subscriptions.ManageRenewalExclusions', 'Excluir renovaciones y consultar sus motivos', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'Subscriptions.ManageRenewalExclusions'
WHERE (role."code" = 'Administrator' OR (role."code" = 'Administrador' AND role."isProtected" = true))
ON CONFLICT DO NOTHING;
