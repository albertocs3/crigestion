INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES (
    gen_random_uuid(),
    'Platform.ManageMaintenance',
    'Gestionar modo mantenimiento',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE SET
    "name" = EXCLUDED."name",
    "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT "roles"."id", "permissions"."id"
FROM "roles"
CROSS JOIN "permissions"
WHERE "roles"."code" = 'Administrador'
  AND "permissions"."code" = 'Platform.ManageMaintenance'
ON CONFLICT DO NOTHING;

ALTER TABLE "platform_maintenance_state"
ADD CONSTRAINT "platform_maintenance_state_singleton_key_check"
CHECK ("singletonKey" = 1);

ALTER TABLE "platform_maintenance_state"
ADD CONSTRAINT "platform_maintenance_state_enabled_fields_check"
CHECK (
    "enabled" = false
    OR (
        "mode" IS NOT NULL
        AND "enabledAt" IS NOT NULL
        AND "enabledById" IS NOT NULL
    )
);

ALTER TABLE "platform_maintenance_state"
ADD CONSTRAINT "platform_maintenance_state_restore_fields_check"
CHECK (
    "mode" IS DISTINCT FROM 'RESTORE'::"PlatformMaintenanceMode"
    OR "restoreOperationId" IS NOT NULL
);
