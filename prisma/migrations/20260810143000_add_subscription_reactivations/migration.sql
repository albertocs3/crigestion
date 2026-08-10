CREATE TABLE "subscription_reactivations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "subscriptionId" UUID NOT NULL,
  "reactivatedById" UUID NOT NULL,
  "reactivatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason" VARCHAR(500) NOT NULL,
  "effectiveDate" DATE NOT NULL,
  "nextRenewalDate" DATE NOT NULL,
  "previousNextRenewalDate" DATE NOT NULL,
  "createdAgainstVersion" INTEGER NOT NULL,
  "reactivatedSubscriptionVersion" INTEGER NOT NULL,
  "cancelledByIdSnapshot" UUID NOT NULL,
  "cancelledAtSnapshot" TIMESTAMPTZ(3) NOT NULL,
  "cancellationEffectiveDateSnapshot" DATE NOT NULL,
  "cancellationReasonSnapshot" VARCHAR(500) NOT NULL,
  "cancellationModeSnapshot" "SubscriptionCancellationMode" NOT NULL,
  CONSTRAINT "subscription_reactivations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_reactivations_reason_chk" CHECK (btrim("reason") <> ''),
  CONSTRAINT "subscription_reactivations_cancellation_reason_chk" CHECK (btrim("cancellationReasonSnapshot") <> ''),
  CONSTRAINT "subscription_reactivations_version_chk" CHECK (
    "createdAgainstVersion" > 0
    AND "reactivatedSubscriptionVersion" = "createdAgainstVersion" + 1
  ),
  CONSTRAINT "subscription_reactivations_dates_chk" CHECK (
    "reactivatedAt" >= "cancelledAtSnapshot"
    AND "effectiveDate" >= "cancellationEffectiveDateSnapshot"
    AND "effectiveDate" = ("reactivatedAt" AT TIME ZONE 'Europe/Madrid')::date
    AND "nextRenewalDate" >= "effectiveDate"
    AND "nextRenewalDate" > "cancellationEffectiveDateSnapshot"
  ),
  CONSTRAINT "subscription_reactivations_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_reactivations_subscription_company_fkey"
    FOREIGN KEY ("subscriptionId", "companyId") REFERENCES "subscriptions"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_reactivations_reactivated_by_fkey"
    FOREIGN KEY ("reactivatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_reactivations_cancelled_by_snapshot_fkey"
    FOREIGN KEY ("cancelledByIdSnapshot") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "subscription_reactivations_subscription_version_key"
  ON "subscription_reactivations"("subscriptionId", "reactivatedSubscriptionVersion");
CREATE INDEX "subscription_reactivations_company_history_idx"
  ON "subscription_reactivations"("companyId", "reactivatedAt", "id");
CREATE INDEX "subscription_reactivations_subscription_history_idx"
  ON "subscription_reactivations"("subscriptionId", "reactivatedAt", "id");
CREATE INDEX "subscription_reactivations_reactivated_by_history_idx"
  ON "subscription_reactivations"("reactivatedById", "reactivatedAt", "id");
CREATE INDEX "subscription_reactivations_cancelled_by_history_idx"
  ON "subscription_reactivations"("cancelledByIdSnapshot", "cancelledAtSnapshot", "id");

CREATE FUNCTION "enforce_subscription_reactivation_history"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent RECORD;
  parent_found BOOLEAN;
  customer_is_active BOOLEAN := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Subscription reactivation history is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reactivatedAt" < clock_timestamp() - INTERVAL '5 minutes'
    OR NEW."reactivatedAt" > clock_timestamp() + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'Subscription reactivation timestamp must be immediate.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT subscription."status", subscription."version", subscription."customerId", subscription."nextRenewalDate", subscription."endDate",
    subscription."pricingMode", subscription."cancelledById", subscription."cancelledAt",
    subscription."cancellationEffectiveDate", subscription."cancellationReason", subscription."cancellationMode"
  INTO parent
  FROM "subscriptions" subscription
  WHERE subscription."id" = NEW."subscriptionId" AND subscription."companyId" = NEW."companyId"
  FOR UPDATE;

  parent_found := FOUND;
  IF parent_found THEN
    PERFORM 1 FROM "customers" customer
    WHERE customer."id" = parent."customerId" AND customer."status" = 'ACTIVE'
    FOR SHARE;
    customer_is_active := FOUND;
  END IF;

  IF NOT parent_found
    OR NOT customer_is_active
    OR parent."status" <> 'CANCELLED'
    OR parent."version" <> NEW."createdAgainstVersion"
    OR parent."nextRenewalDate" <> NEW."previousNextRenewalDate"
    OR parent."cancelledById" <> NEW."cancelledByIdSnapshot"
    OR parent."cancelledAt" <> NEW."cancelledAtSnapshot"
    OR parent."cancellationEffectiveDate" <> NEW."cancellationEffectiveDateSnapshot"
    OR parent."cancellationReason" <> NEW."cancellationReasonSnapshot"
    OR parent."cancellationMode" <> NEW."cancellationModeSnapshot"
    OR (parent."endDate" IS NOT NULL AND NEW."nextRenewalDate" > parent."endDate")
    OR NOT EXISTS (SELECT 1 FROM "subscription_lines" line WHERE line."subscriptionId" = NEW."subscriptionId")
    OR (parent."pricingMode" = 'FIXED' AND EXISTS (
      SELECT 1 FROM "subscription_lines" line
      WHERE line."subscriptionId" = NEW."subscriptionId" AND line."quantity" <> 1
    ))
    OR EXISTS (
      SELECT 1 FROM "subscription_renewal_reservations" reservation
      WHERE reservation."companyId" = NEW."companyId"
        AND reservation."subscriptionId" = NEW."subscriptionId"
        AND (reservation."status" = 'RESERVED'
          OR (reservation."status" = 'BILLED' AND (
            reservation."periodStart" = NEW."nextRenewalDate"
            OR reservation."periodEndExclusive" > NEW."nextRenewalDate"
          )))
    )
    OR EXISTS (
      SELECT 1 FROM "subscription_renewal_exclusions" exclusion
      WHERE exclusion."companyId" = NEW."companyId"
        AND exclusion."subscriptionId" = NEW."subscriptionId"
        AND (exclusion."status" = 'OPEN' OR exclusion."periodStart" = NEW."nextRenewalDate")
    ) THEN
    RAISE EXCEPTION 'Invalid subscription reactivation evidence.' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_reactivation_history_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "subscription_reactivations"
FOR EACH ROW EXECUTE FUNCTION "enforce_subscription_reactivation_history"();

CREATE FUNCTION "assert_subscription_reactivation_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "subscriptions" subscription
    WHERE subscription."id" = NEW."subscriptionId"
      AND subscription."companyId" = NEW."companyId"
      AND subscription."status" = 'ACTIVE'
      AND subscription."version" = NEW."reactivatedSubscriptionVersion"
      AND subscription."nextRenewalDate" = NEW."nextRenewalDate"
      AND subscription."updatedById" = NEW."reactivatedById"
      AND subscription."cancelledById" IS NULL
      AND subscription."cancelledAt" IS NULL
      AND subscription."cancellationEffectiveDate" IS NULL
      AND subscription."cancellationReason" IS NULL
      AND subscription."cancellationMode" IS NULL
  ) THEN
    RAISE EXCEPTION 'Subscription reactivation is inconsistent with subscription.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "subscription_reactivation_consistency_trigger"
AFTER INSERT ON "subscription_reactivations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_subscription_reactivation_consistency"();

DROP INDEX "subscription_cancellation_schedules_one_applied_key";
CREATE UNIQUE INDEX "subscription_cancellation_schedules_applied_effective_key"
  ON "subscription_cancellation_schedules"("companyId", "subscriptionId", "effectiveDate")
  WHERE "status" = 'APPLIED';

CREATE OR REPLACE FUNCTION "enforce_subscription_cancellation_mode_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'CANCELLED'
    AND NEW."cancellationMode" IS DISTINCT FROM OLD."cancellationMode"
    AND NOT (
      NEW."status" = 'ACTIVE'
      AND NEW."cancellationMode" IS NULL
      AND EXISTS (
        SELECT 1 FROM "subscription_reactivations" reactivation
        WHERE reactivation."companyId" = OLD."companyId"
          AND reactivation."subscriptionId" = OLD."id"
        AND reactivation.xmin = pg_current_xact_id()::xid
          AND reactivation."createdAgainstVersion" = OLD."version"
          AND reactivation."reactivatedSubscriptionVersion" = NEW."version"
          AND reactivation."cancellationModeSnapshot" = OLD."cancellationMode"
      )
    ) THEN
    RAISE EXCEPTION 'Subscription cancellation mode is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "enforce_subscription_header_lifecycle"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  is_reactivation BOOLEAN;
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
    AND NEW."version" IS DISTINCT FROM OLD."version" THEN
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

CREATE OR REPLACE FUNCTION "assert_subscription_renewal_advance_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  is_reactivation BOOLEAN;
BEGIN
  is_reactivation := OLD."status" = 'CANCELLED' AND NEW."status" = 'ACTIVE' AND EXISTS (
    SELECT 1 FROM "subscription_reactivations" reactivation
    WHERE reactivation."companyId" = NEW."companyId"
      AND reactivation."subscriptionId" = NEW."id"
      AND reactivation.xmin = pg_current_xact_id()::xid
      AND reactivation."createdAgainstVersion" = OLD."version"
      AND reactivation."reactivatedSubscriptionVersion" = NEW."version"
      AND reactivation."nextRenewalDate" = NEW."nextRenewalDate"
  );

  IF OLD."status" <> 'DRAFT' AND NEW."nextRenewalDate" IS DISTINCT FROM OLD."nextRenewalDate" AND NOT is_reactivation THEN
    IF NEW."nextRenewalDate" <= OLD."nextRenewalDate" OR NEW."version" <> OLD."version" + 1 OR NEW."status" <> 'ACTIVE'
      OR NOT (
        EXISTS (
          SELECT 1 FROM "subscription_renewal_reservations" reservation
          WHERE reservation."companyId" = NEW."companyId" AND reservation."subscriptionId" = NEW."id"
            AND reservation."status" = 'BILLED' AND reservation."periodStart" = OLD."nextRenewalDate"
            AND reservation."periodEndExclusive" = NEW."nextRenewalDate"
            AND reservation."subscriptionVersionSnapshot" = OLD."version"
        )
        OR EXISTS (
          SELECT 1 FROM "subscription_renewal_exclusions" exclusion
          WHERE exclusion."companyId" = NEW."companyId" AND exclusion."subscriptionId" = NEW."id"
            AND exclusion."status" = 'RESOLVED' AND exclusion."resolution" = 'WAIVED'
            AND exclusion."periodStart" = OLD."nextRenewalDate"
            AND exclusion."periodEndExclusive" = NEW."nextRenewalDate"
            AND exclusion."resolvedAgainstVersion" = OLD."version"
            AND exclusion."resolvedSubscriptionVersion" = NEW."version"
        )
      ) THEN
      RAISE EXCEPTION 'Subscription renewal advancement requires matching billed or waived evidence.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

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
          invoice."status" <> 'ISSUED'
          OR subscription."nextRenewalDate" < exclusion."periodEndExclusive"
          OR (exclusion.xmin = pg_current_xact_id()::xid AND (
            subscription."status" <> 'ACTIVE'
            OR subscription."nextRenewalDate" <> exclusion."periodEndExclusive"
          ))
          OR NOT EXISTS (
            SELECT 1 FROM "subscription_renewal_reservations" reservation
            WHERE reservation."companyId" = exclusion."companyId"
              AND reservation."subscriptionId" = exclusion."subscriptionId"
              AND reservation."invoiceId" = exclusion."resolvedInvoiceId"
              AND reservation."periodStart" = exclusion."periodStart"
              AND reservation."status" = 'BILLED'
          )
        ))
        OR (exclusion."resolution" = 'CANCELLED' AND subscription."status" <> 'CANCELLED'
          AND NOT EXISTS (
            SELECT 1 FROM "subscription_reactivations" reactivation
            WHERE reactivation."companyId" = exclusion."companyId"
              AND reactivation."subscriptionId" = exclusion."subscriptionId"
              AND reactivation."cancelledAtSnapshot" = exclusion."resolvedAt"
          ))
      )
  ) THEN
    RAISE EXCEPTION 'Resolved renewal exclusion requires matching terminal evidence.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Subscriptions.Reactivate', 'Reactivar suscripciones', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'Subscriptions.Reactivate'
WHERE role."code" = 'Administrator' OR (role."code" = 'Administrador' AND role."isProtected" = true)
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
