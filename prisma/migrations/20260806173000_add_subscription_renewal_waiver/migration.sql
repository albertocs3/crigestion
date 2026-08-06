ALTER TYPE "SubscriptionRenewalExclusionResolution" ADD VALUE IF NOT EXISTS 'WAIVED';

CREATE TYPE "SubscriptionRenewalWaiverReasonCode" AS ENUM ('COMMERCIAL_WAIVER', 'SERVICE_FAILURE', 'OTHER');

ALTER TABLE "subscription_renewal_exclusions"
  ADD COLUMN "resolutionReasonCode" "SubscriptionRenewalWaiverReasonCode",
  ADD COLUMN "resolutionReasonDetail" VARCHAR(500),
  ADD COLUMN "resolvedAgainstVersion" INTEGER,
  ADD COLUMN "resolvedSubscriptionVersion" INTEGER;

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Subscriptions.WaiveRenewals', 'Condonar periodos de renovacion sin facturar', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'Subscriptions.WaiveRenewals'
WHERE role."code" = 'Administrator' OR (role."code" = 'Administrador' AND role."isProtected" = true)
ON CONFLICT DO NOTHING;
