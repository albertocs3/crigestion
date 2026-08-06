CREATE TYPE "SubscriptionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RENEWAL_PENDING', 'CANCELLED');
CREATE TYPE "SubscriptionPeriodicity" AS ENUM ('MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL');
CREATE TYPE "SubscriptionPricingMode" AS ENUM ('FIXED', 'PER_LICENSE');

CREATE TABLE "subscription_number_sequences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "subscription_number_sequences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscription_number_sequences_year_chk" CHECK ("year" BETWEEN 2000 AND 9999),
    CONSTRAINT "subscription_number_sequences_next_number_chk" CHECK ("nextNumber" > 0),
    CONSTRAINT "subscription_number_sequences_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "subscription_number_sequences_companyId_year_key"
  ON "subscription_number_sequences"("companyId", "year");

CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "numberSequence" INTEGER NOT NULL,
    "number" VARCHAR(24) NOT NULL,
    "customerId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'DRAFT',
    "periodicity" "SubscriptionPeriodicity" NOT NULL,
    "pricingMode" "SubscriptionPricingMode" NOT NULL,
    "paymentMethod" "CustomerPaymentMethod" NOT NULL,
    "startDate" DATE NOT NULL,
    "nextRenewalDate" DATE NOT NULL,
    "endDate" DATE,
    "notes" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID NOT NULL,
    "updatedById" UUID,
    "activatedById" UUID,
    "activatedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscriptions_year_chk" CHECK ("year" BETWEEN 2000 AND 9999),
    CONSTRAINT "subscriptions_number_sequence_chk" CHECK ("numberSequence" > 0),
    CONSTRAINT "subscriptions_number_format_chk" CHECK (
      "number" = 'SUS-' || "year"::text || '-' || lpad("numberSequence"::text, 5, '0')
    ),
    CONSTRAINT "subscriptions_version_chk" CHECK ("version" > 0),
    CONSTRAINT "subscriptions_dates_chk" CHECK (
      "nextRenewalDate" >= "startDate" AND ("endDate" IS NULL OR "endDate" >= "startDate")
    ),
    CONSTRAINT "subscriptions_activation_evidence_chk" CHECK (
      ("status" = 'DRAFT' AND "activatedById" IS NULL AND "activatedAt" IS NULL)
      OR ("status" <> 'DRAFT' AND "activatedById" IS NOT NULL AND "activatedAt" IS NOT NULL)
    ),
    CONSTRAINT "subscriptions_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "subscriptions_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "subscriptions_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "subscriptions_updatedById_fkey"
      FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "subscriptions_activatedById_fkey"
      FOREIGN KEY ("activatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "subscriptions_companyId_number_key" ON "subscriptions"("companyId", "number");
CREATE UNIQUE INDEX "subscriptions_companyId_year_numberSequence_key" ON "subscriptions"("companyId", "year", "numberSequence");
CREATE INDEX "subscriptions_companyId_status_nextRenewalDate_id_idx" ON "subscriptions"("companyId", "status", "nextRenewalDate", "id");
CREATE INDEX "subscriptions_customerId_status_nextRenewalDate_id_idx" ON "subscriptions"("customerId", "status", "nextRenewalDate", "id");
CREATE INDEX "subscriptions_createdAt_id_idx" ON "subscriptions"("createdAt", "id");

CREATE TABLE "subscription_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subscriptionId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "catalogItemId" UUID NOT NULL,
    "catalogItemCodeSnapshot" VARCHAR(20) NOT NULL,
    "catalogItemKindSnapshot" "CatalogItemKind" NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxRateId" UUID NOT NULL,
    "taxRateCodeSnapshot" VARCHAR(40) NOT NULL,
    "taxRateNameSnapshot" VARCHAR(120) NOT NULL,
    "taxRateSnapshot" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "subscription_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscription_lines_position_chk" CHECK ("position" > 0),
    CONSTRAINT "subscription_lines_quantity_chk" CHECK ("quantity" > 0),
    CONSTRAINT "subscription_lines_catalog_kind_chk" CHECK ("catalogItemKindSnapshot" IN ('SERVICE', 'SOFTWARE', 'LICENSE')),
    CONSTRAINT "subscription_lines_unit_price_chk" CHECK ("unitPrice" >= 0),
    CONSTRAINT "subscription_lines_discount_percent_chk" CHECK ("discountPercent" BETWEEN 0 AND 100),
    CONSTRAINT "subscription_lines_discount_amount_chk" CHECK ("discountAmount" >= 0),
    CONSTRAINT "subscription_lines_tax_rate_chk" CHECK ("taxRateSnapshot" BETWEEN 0 AND 100),
    CONSTRAINT "subscription_lines_subscriptionId_fkey"
      FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "subscription_lines_catalogItemId_fkey"
      FOREIGN KEY ("catalogItemId") REFERENCES "catalog_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "subscription_lines_taxRateId_fkey"
      FOREIGN KEY ("taxRateId") REFERENCES "catalog_tax_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "subscription_lines_subscriptionId_position_key" ON "subscription_lines"("subscriptionId", "position");
CREATE UNIQUE INDEX "subscription_lines_subscriptionId_catalogItemId_key" ON "subscription_lines"("subscriptionId", "catalogItemId");
CREATE UNIQUE INDEX "subscription_lines_id_subscriptionId_key" ON "subscription_lines"("id", "subscriptionId");
CREATE INDEX "subscription_lines_catalogItemId_idx" ON "subscription_lines"("catalogItemId");
CREATE INDEX "subscription_lines_taxRateId_idx" ON "subscription_lines"("taxRateId");

CREATE FUNCTION "enforce_subscription_lines_draft_only"()
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
  WHERE "id" = target_subscription_id;

  IF subscription_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Subscription lines can only change while the subscription is DRAFT.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER "subscription_lines_draft_only_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "subscription_lines"
FOR EACH ROW EXECUTE FUNCTION "enforce_subscription_lines_draft_only"();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'Subscriptions.View', 'Consultar suscripciones', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Subscriptions.Manage', 'Gestionar suscripciones', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Subscriptions.ManageEconomics', 'Gestionar datos economicos de suscripciones', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador'
  AND role."isProtected" = true
  AND permission."code" IN ('Subscriptions.View', 'Subscriptions.Manage', 'Subscriptions.ManageEconomics')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
