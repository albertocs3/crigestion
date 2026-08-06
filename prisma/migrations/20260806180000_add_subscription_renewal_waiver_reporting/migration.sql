BEGIN;

CREATE SEQUENCE "subscription_renewal_waiver_sequence" AS BIGINT;

ALTER TABLE "subscription_renewal_exclusions"
  ADD COLUMN "waiverSequence" BIGINT;

ALTER SEQUENCE "subscription_renewal_waiver_sequence"
  OWNED BY "subscription_renewal_exclusions"."waiverSequence";

-- Keep legacy writers outside the backfill window. All trigger disabling and
-- integrity changes below remain invisible until the migration commits.
LOCK TABLE "subscription_renewal_exclusions" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "subscription_renewal_exclusions"
    WHERE "resolution" = 'WAIVED'
      AND (
        "resolvedAgainstVersion" IS NULL OR "resolvedSubscriptionVersion" IS NULL
        OR "waivedSubtotal" IS NULL OR "waivedDiscountTotal" IS NULL
        OR "waivedTaxableBase" IS NULL OR "waivedTaxAmount" IS NULL OR "waivedTotal" IS NULL
        OR "waiverCalculationVersion" IS NULL OR length(btrim("waiverCalculationVersion")) = 0
      )
  ) THEN
    RAISE EXCEPTION 'Existing WAIVED renewal evidence is incomplete; remediate before enabling reporting.';
  END IF;
END;
$$;

-- The terminal history trigger correctly rejects ordinary updates. It is
-- disabled only while this migration backfills the new monotonic key.
ALTER TABLE "subscription_renewal_exclusions" DISABLE TRIGGER USER;

WITH waived AS (
  SELECT "id"
  FROM "subscription_renewal_exclusions"
  WHERE "resolution" = 'WAIVED'
  ORDER BY "resolvedAt", "id"
)
UPDATE "subscription_renewal_exclusions" exclusion
SET "waiverSequence" = nextval('subscription_renewal_waiver_sequence')
FROM waived
WHERE exclusion."id" = waived."id";

ALTER TABLE "subscription_renewal_exclusions" ENABLE TRIGGER USER;

CREATE UNIQUE INDEX "subscription_renewal_exclusions_waiverSequence_key"
  ON "subscription_renewal_exclusions" ("waiverSequence");

ALTER TABLE "subscription_renewal_exclusions"
  DROP CONSTRAINT "subscription_renewal_exclusions_evidence_chk";

ALTER TABLE "subscription_renewal_exclusions"
  ADD CONSTRAINT "subscription_renewal_exclusions_evidence_chk" CHECK (
    (
      "status" = 'OPEN'
      AND "resolvedAt" IS NULL AND "resolvedById" IS NULL AND "resolution" IS NULL AND "resolvedInvoiceId" IS NULL
      AND "resolutionReasonCode" IS NULL AND "resolutionReasonDetail" IS NULL
      AND "resolvedAgainstVersion" IS NULL AND "resolvedSubscriptionVersion" IS NULL
      AND "waivedSubtotal" IS NULL AND "waivedDiscountTotal" IS NULL
      AND "waivedTaxableBase" IS NULL AND "waivedTaxAmount" IS NULL AND "waivedTotal" IS NULL
      AND "waiverCalculationVersion" IS NULL AND "waiverSequence" IS NULL
    )
    OR (
      "status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL AND "resolvedById" IS NOT NULL AND "resolution" IS NOT NULL
      AND "resolvedAt" >= "openedAt"
      AND (
        ("resolution" = 'BILLED' AND "resolvedInvoiceId" IS NOT NULL
          AND "resolutionReasonCode" IS NULL AND "resolutionReasonDetail" IS NULL
          AND "resolvedAgainstVersion" IS NULL AND "resolvedSubscriptionVersion" IS NULL
          AND "waivedSubtotal" IS NULL AND "waivedDiscountTotal" IS NULL
          AND "waivedTaxableBase" IS NULL AND "waivedTaxAmount" IS NULL AND "waivedTotal" IS NULL
          AND "waiverCalculationVersion" IS NULL AND "waiverSequence" IS NULL)
        OR ("resolution" = 'CANCELLED' AND "resolvedInvoiceId" IS NULL
          AND "resolutionReasonCode" IS NULL AND "resolutionReasonDetail" IS NULL
          AND "resolvedAgainstVersion" IS NULL AND "resolvedSubscriptionVersion" IS NULL
          AND "waivedSubtotal" IS NULL AND "waivedDiscountTotal" IS NULL
          AND "waivedTaxableBase" IS NULL AND "waivedTaxAmount" IS NULL AND "waivedTotal" IS NULL
          AND "waiverCalculationVersion" IS NULL AND "waiverSequence" IS NULL)
        OR ("resolution" = 'WAIVED' AND "resolvedInvoiceId" IS NULL
          AND "resolutionReasonCode" IS NOT NULL
          AND "resolutionReasonDetail" IS NOT NULL AND length(btrim("resolutionReasonDetail")) >= 10
          AND "resolvedAgainstVersion" IS NOT NULL AND "resolvedAgainstVersion" > 0
          AND "resolvedSubscriptionVersion" IS NOT NULL AND "resolvedSubscriptionVersion" = "resolvedAgainstVersion" + 1
          AND "waivedSubtotal" IS NOT NULL AND "waivedSubtotal" >= 0
          AND "waivedDiscountTotal" IS NOT NULL AND "waivedDiscountTotal" >= 0
          AND "waivedTaxableBase" IS NOT NULL AND "waivedTaxableBase" >= 0
          AND "waivedTaxAmount" IS NOT NULL AND "waivedTaxAmount" >= 0
          AND "waivedTotal" IS NOT NULL AND "waivedTotal" >= 0
          AND "waivedTaxableBase" = "waivedSubtotal" - "waivedDiscountTotal"
          AND "waivedTotal" = "waivedTaxableBase" + "waivedTaxAmount"
          AND "waiverCalculationVersion" IS NOT NULL AND length(btrim("waiverCalculationVersion")) > 0
          AND "waiverSequence" IS NOT NULL AND "waiverSequence" > 0)
      )
    )
  );

CREATE OR REPLACE FUNCTION "reject_terminal_subscription_renewal_exclusion_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" <> 'OPEN' OR NEW."resolution" IS NOT NULL THEN
    RAISE EXCEPTION 'Subscription renewal exclusions must be opened before resolution.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subscription_renewal_exclusion_terminal_insert_guard"
BEFORE INSERT ON "subscription_renewal_exclusions"
FOR EACH ROW EXECUTE FUNCTION "reject_terminal_subscription_renewal_exclusion_insert"();

CREATE INDEX "subscription_renewal_exclusions_waived_history_idx"
  ON "subscription_renewal_exclusions" ("companyId", "resolvedAt" DESC, "id" DESC)
  INCLUDE ("subscriptionId", "periodStart", "periodEndExclusive", "resolutionReasonCode", "waiverSequence",
    "waivedSubtotal", "waivedDiscountTotal", "waivedTaxableBase", "waivedTaxAmount", "waivedTotal")
  WHERE "status" = 'RESOLVED' AND "resolution" = 'WAIVED';

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'Subscriptions.ViewRenewalWaivers', 'Consultar el historial de periodos condonados', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Subscriptions.ExportRenewalWaivers', 'Exportar el historial de periodos condonados', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" IN (
  'Subscriptions.ViewRenewalWaivers',
  'Subscriptions.ExportRenewalWaivers'
)
WHERE role."isProtected" = true
  AND role."code" IN ('Administrator', 'Administrador')
ON CONFLICT DO NOTHING;

COMMIT;
