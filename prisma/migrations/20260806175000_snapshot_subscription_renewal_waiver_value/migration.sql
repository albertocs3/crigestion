ALTER TABLE "subscription_renewal_exclusions"
  ADD COLUMN "waivedSubtotal" DECIMAL(14, 2),
  ADD COLUMN "waivedDiscountTotal" DECIMAL(14, 2),
  ADD COLUMN "waivedTaxableBase" DECIMAL(14, 2),
  ADD COLUMN "waivedTaxAmount" DECIMAL(14, 2),
  ADD COLUMN "waivedTotal" DECIMAL(14, 2),
  ADD COLUMN "waiverCalculationVersion" VARCHAR(40);

-- Correct the legacy grant from migration 110: only protected administrator
-- roles may receive this irreversible permission automatically.
DELETE FROM "role_permissions" role_permission
USING "roles" role, "permissions" permission
WHERE role_permission."roleId" = role."id"
  AND role_permission."permissionId" = permission."id"
  AND permission."code" = 'Subscriptions.WaiveRenewals'
  AND role."code" = 'Administrator'
  AND role."isProtected" = false;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'Subscriptions.WaiveRenewals'
WHERE role."isProtected" = true
  AND role."code" IN ('Administrator', 'Administrador')
ON CONFLICT DO NOTHING;

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
      AND "waiverCalculationVersion" IS NULL
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
          AND "waiverCalculationVersion" IS NULL)
        OR ("resolution" = 'CANCELLED' AND "resolvedInvoiceId" IS NULL
          AND "resolutionReasonCode" IS NULL AND "resolutionReasonDetail" IS NULL
          AND "resolvedAgainstVersion" IS NULL AND "resolvedSubscriptionVersion" IS NULL
          AND "waivedSubtotal" IS NULL AND "waivedDiscountTotal" IS NULL
          AND "waivedTaxableBase" IS NULL AND "waivedTaxAmount" IS NULL AND "waivedTotal" IS NULL
          AND "waiverCalculationVersion" IS NULL)
        OR ("resolution" = 'WAIVED' AND "resolvedInvoiceId" IS NULL
          AND "resolutionReasonCode" IS NOT NULL
          AND "resolutionReasonDetail" IS NOT NULL AND length(btrim("resolutionReasonDetail")) >= 10
          AND "resolvedAgainstVersion" > 0
          AND "resolvedSubscriptionVersion" = "resolvedAgainstVersion" + 1
          AND "waivedSubtotal" >= 0 AND "waivedDiscountTotal" >= 0
          AND "waivedTaxableBase" >= 0 AND "waivedTaxAmount" >= 0 AND "waivedTotal" >= 0
          AND "waivedTaxableBase" = "waivedSubtotal" - "waivedDiscountTotal"
          AND "waivedTotal" = "waivedTaxableBase" + "waivedTaxAmount"
          AND "waiverCalculationVersion" IS NOT NULL AND length(btrim("waiverCalculationVersion")) > 0)
      )
    )
  );
