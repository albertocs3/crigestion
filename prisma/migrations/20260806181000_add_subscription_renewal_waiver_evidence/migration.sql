BEGIN;

CREATE TYPE "SubscriptionRenewalWaiverSnapshotSource" AS ENUM (
  'CAPTURED_AT_WAIVER',
  'BACKFILLED_CURRENT_MASTER'
);

ALTER TABLE "subscription_renewal_exclusions"
  ADD CONSTRAINT "subscription_renewal_exclusions_id_companyId_key" UNIQUE ("id", "companyId");

CREATE TABLE "subscription_renewal_waiver_snapshots" (
  "exclusionId" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "customerCodeSnapshot" VARCHAR(20) NOT NULL,
  "customerLegalNameSnapshot" VARCHAR(200) NOT NULL,
  "source" "SubscriptionRenewalWaiverSnapshotSource" NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "capturedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "subscription_renewal_waiver_snapshots_pkey" PRIMARY KEY ("exclusionId"),
  CONSTRAINT "subscription_renewal_waiver_snapshots_identity_chk" CHECK (
    length(btrim("customerCodeSnapshot")) > 0
    AND length(btrim("customerLegalNameSnapshot")) > 0
    AND "currency" = 'EUR'
  ),
  CONSTRAINT "subscription_renewal_waiver_snapshots_exclusionId_companyId_fkey"
    FOREIGN KEY ("exclusionId", "companyId") REFERENCES "subscription_renewal_exclusions" ("id", "companyId") ON DELETE RESTRICT,
  CONSTRAINT "subscription_renewal_waiver_snapshots_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies" ("id") ON DELETE RESTRICT,
  CONSTRAINT "subscription_renewal_waiver_snapshots_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE RESTRICT,
  CONSTRAINT "subscription_renewal_waiver_snapshots_exclusionId_companyId_key" UNIQUE ("exclusionId", "companyId")
);

CREATE INDEX "subscription_renewal_waiver_snapshots_customerId_idx"
  ON "subscription_renewal_waiver_snapshots" ("customerId");

CREATE TABLE "subscription_renewal_waiver_tax_summaries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "exclusionId" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "taxRateCodeSnapshot" VARCHAR(40) NOT NULL,
  "taxRateNameSnapshot" VARCHAR(120) NOT NULL,
  "taxRateSnapshot" DECIMAL(5, 2) NOT NULL,
  "theoreticalTaxableBase" DECIMAL(14, 2) NOT NULL,
  "theoreticalTaxAmount" DECIMAL(14, 2) NOT NULL,
  "theoreticalTotal" DECIMAL(14, 2) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_renewal_waiver_tax_summaries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_renewal_waiver_tax_summaries_values_chk" CHECK (
    length(btrim("taxRateCodeSnapshot")) > 0
    AND length(btrim("taxRateNameSnapshot")) > 0
    AND "taxRateSnapshot" >= 0 AND "taxRateSnapshot" <= 100
    AND "theoreticalTaxableBase" >= 0
    AND "theoreticalTaxAmount" >= 0
    AND "theoreticalTotal" = "theoreticalTaxableBase" + "theoreticalTaxAmount"
  ),
  CONSTRAINT "subscription_renewal_waiver_tax_summaries_snapshot_fkey"
    FOREIGN KEY ("exclusionId", "companyId") REFERENCES "subscription_renewal_waiver_snapshots" ("exclusionId", "companyId") ON DELETE RESTRICT,
  CONSTRAINT "subscription_renewal_waiver_tax_summaries_exclusion_code_rate_key"
    UNIQUE ("exclusionId", "taxRateCodeSnapshot", "taxRateSnapshot")
);

CREATE INDEX "subscription_renewal_waiver_tax_summaries_company_exclusion_idx"
  ON "subscription_renewal_waiver_tax_summaries" ("companyId", "exclusionId");

-- The backfill is deliberately atomic and blocks all sources used to derive
-- evidence. Customer labels are marked as current-master legacy data, never as
-- values captured at the historical waiver instant.
LOCK TABLE "customers", "subscriptions", "subscription_lines", "subscription_renewal_exclusions"
  IN ACCESS EXCLUSIVE MODE;

INSERT INTO "subscription_renewal_waiver_snapshots" (
  "exclusionId", "companyId", "customerId", "customerCodeSnapshot",
  "customerLegalNameSnapshot", "source", "currency", "capturedAt"
)
SELECT exclusion."id", exclusion."companyId", customer."id", customer."code",
  customer."legalName", 'BACKFILLED_CURRENT_MASTER', 'EUR', CURRENT_TIMESTAMP
FROM "subscription_renewal_exclusions" exclusion
JOIN "subscriptions" subscription
  ON subscription."id" = exclusion."subscriptionId" AND subscription."companyId" = exclusion."companyId"
JOIN "customers" customer ON customer."id" = subscription."customerId"
WHERE exclusion."status" = 'RESOLVED' AND exclusion."resolution" = 'WAIVED';

WITH line_subtotals AS (
  SELECT exclusion."id" AS "exclusionId", exclusion."companyId",
    line."taxRateCodeSnapshot", line."taxRateNameSnapshot", line."taxRateSnapshot",
    round(line."quantity" * line."unitPrice", 2) AS subtotal,
    line."discountPercent", line."discountAmount"
  FROM "subscription_renewal_exclusions" exclusion
  JOIN "subscription_lines" line ON line."subscriptionId" = exclusion."subscriptionId"
  WHERE exclusion."status" = 'RESOLVED' AND exclusion."resolution" = 'WAIVED'
    AND exclusion."waiverCalculationVersion" = 'invoice-lines-v1'
), line_percent_discounts AS (
  SELECT *, round(subtotal * "discountPercent" / 100, 2) AS percent_discount
  FROM line_subtotals
), calculated_lines AS (
  SELECT *, round(percent_discount + least("discountAmount", greatest(subtotal - percent_discount, 0)), 2) AS discount_total
  FROM line_percent_discounts
), valued_lines AS (
  SELECT *, round(greatest(subtotal - discount_total, 0), 2) AS taxable_base
  FROM calculated_lines
), taxed_lines AS (
  SELECT *, round(taxable_base * "taxRateSnapshot" / 100, 2) AS tax_amount
  FROM valued_lines
)
INSERT INTO "subscription_renewal_waiver_tax_summaries" (
  "exclusionId", "companyId", "taxRateCodeSnapshot", "taxRateNameSnapshot", "taxRateSnapshot",
  "theoreticalTaxableBase", "theoreticalTaxAmount", "theoreticalTotal"
)
SELECT "exclusionId", "companyId", "taxRateCodeSnapshot", min("taxRateNameSnapshot"), "taxRateSnapshot",
  sum(taxable_base), sum(tax_amount), sum(round(taxable_base + tax_amount, 2))
FROM taxed_lines
GROUP BY "exclusionId", "companyId", "taxRateCodeSnapshot", "taxRateSnapshot";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "subscription_renewal_exclusions" exclusion
    LEFT JOIN "subscription_renewal_waiver_snapshots" snapshot ON snapshot."exclusionId" = exclusion."id"
    LEFT JOIN (
      SELECT "exclusionId", count(*) AS row_count,
        sum("theoreticalTaxableBase") AS taxable_base,
        sum("theoreticalTaxAmount") AS tax_amount,
        sum("theoreticalTotal") AS total
      FROM "subscription_renewal_waiver_tax_summaries"
      GROUP BY "exclusionId"
    ) tax ON tax."exclusionId" = exclusion."id"
    WHERE exclusion."status" = 'RESOLVED' AND exclusion."resolution" = 'WAIVED'
      AND (
        exclusion."waiverCalculationVersion" <> 'invoice-lines-v1'
        OR snapshot."exclusionId" IS NULL OR coalesce(tax.row_count, 0) = 0
        OR tax.taxable_base IS DISTINCT FROM exclusion."waivedTaxableBase"
        OR tax.tax_amount IS DISTINCT FROM exclusion."waivedTaxAmount"
        OR tax.total IS DISTINCT FROM exclusion."waivedTotal"
      )
  ) THEN
    RAISE EXCEPTION 'Existing WAIVED renewal evidence cannot be backfilled exactly.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "protect_subscription_renewal_waiver_snapshot"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE parent RECORD;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'Subscription renewal waiver snapshots are immutable.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT exclusion."status", exclusion."resolution", subscription."customerId"
    INTO parent
  FROM "subscription_renewal_exclusions" exclusion
  JOIN "subscriptions" subscription
    ON subscription."id" = exclusion."subscriptionId" AND subscription."companyId" = exclusion."companyId"
  WHERE exclusion."id" = NEW."exclusionId" AND exclusion."companyId" = NEW."companyId"
  FOR UPDATE OF exclusion;
  IF NEW."source" <> 'CAPTURED_AT_WAIVER'
    OR NOT FOUND OR parent."status" <> 'OPEN' OR parent."resolution" IS NOT NULL
    OR parent."customerId" <> NEW."customerId" THEN
    RAISE EXCEPTION 'Invalid subscription renewal waiver snapshot source.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_renewal_waiver_snapshot_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "subscription_renewal_waiver_snapshots"
FOR EACH ROW EXECUTE FUNCTION "protect_subscription_renewal_waiver_snapshot"();

CREATE OR REPLACE FUNCTION "protect_subscription_renewal_waiver_tax_summary"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE parent RECORD;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'Subscription renewal waiver tax summaries are immutable.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT exclusion."status", exclusion."resolution"
    INTO parent
  FROM "subscription_renewal_waiver_snapshots" snapshot
  JOIN "subscription_renewal_exclusions" exclusion
    ON exclusion."id" = snapshot."exclusionId" AND exclusion."companyId" = snapshot."companyId"
  WHERE snapshot."exclusionId" = NEW."exclusionId" AND snapshot."companyId" = NEW."companyId"
  FOR UPDATE OF exclusion;
  IF NOT FOUND OR parent."status" <> 'OPEN' OR parent."resolution" IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid subscription renewal waiver tax summary source.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_renewal_waiver_tax_summary_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "subscription_renewal_waiver_tax_summaries"
FOR EACH ROW EXECUTE FUNCTION "protect_subscription_renewal_waiver_tax_summary"();

CREATE OR REPLACE FUNCTION "assert_subscription_renewal_waiver_snapshot_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_exclusion_id UUID;
  parent RECORD;
  snapshot_record RECORD;
  tax_record RECORD;
BEGIN
  IF TG_TABLE_NAME = 'subscription_renewal_exclusions' THEN
    target_exclusion_id := NEW."id";
  ELSE
    target_exclusion_id := NEW."exclusionId";
  END IF;

  SELECT exclusion."status", exclusion."resolution", exclusion."companyId", exclusion."resolvedAt",
    exclusion."waivedTaxableBase", exclusion."waivedTaxAmount", exclusion."waivedTotal",
    subscription."customerId"
    INTO parent
  FROM "subscription_renewal_exclusions" exclusion
  JOIN "subscriptions" subscription
    ON subscription."id" = exclusion."subscriptionId" AND subscription."companyId" = exclusion."companyId"
  WHERE exclusion."id" = target_exclusion_id;

  SELECT * INTO snapshot_record
  FROM "subscription_renewal_waiver_snapshots"
  WHERE "exclusionId" = target_exclusion_id;

  SELECT count(*) AS row_count,
    sum("theoreticalTaxableBase") AS taxable_base,
    sum("theoreticalTaxAmount") AS tax_amount,
    sum("theoreticalTotal") AS total
    INTO tax_record
  FROM "subscription_renewal_waiver_tax_summaries"
  WHERE "exclusionId" = target_exclusion_id;

  IF parent."status" = 'RESOLVED' AND parent."resolution" = 'WAIVED' THEN
    IF snapshot_record."exclusionId" IS NULL
      OR snapshot_record."companyId" <> parent."companyId"
      OR snapshot_record."customerId" <> parent."customerId"
      OR (snapshot_record."source" = 'CAPTURED_AT_WAIVER' AND snapshot_record."capturedAt" <> parent."resolvedAt")
      OR tax_record.row_count = 0
      OR tax_record.taxable_base IS DISTINCT FROM parent."waivedTaxableBase"
      OR tax_record.tax_amount IS DISTINCT FROM parent."waivedTaxAmount"
      OR tax_record.total IS DISTINCT FROM parent."waivedTotal" THEN
      RAISE EXCEPTION 'Waived renewal snapshot does not match terminal evidence.' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF snapshot_record."exclusionId" IS NOT NULL THEN
    RAISE EXCEPTION 'Only waived renewals may contain waiver snapshots.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "subscription_renewal_waiver_snapshot_parent_consistency"
AFTER UPDATE ON "subscription_renewal_exclusions"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "assert_subscription_renewal_waiver_snapshot_consistency"();

CREATE CONSTRAINT TRIGGER "subscription_renewal_waiver_snapshot_consistency"
AFTER INSERT ON "subscription_renewal_waiver_snapshots"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "assert_subscription_renewal_waiver_snapshot_consistency"();

CREATE CONSTRAINT TRIGGER "subscription_renewal_waiver_tax_summary_consistency"
AFTER INSERT ON "subscription_renewal_waiver_tax_summaries"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "assert_subscription_renewal_waiver_snapshot_consistency"();

COMMIT;
