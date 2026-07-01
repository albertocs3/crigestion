-- Add the session management permission to existing installations.

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES (
    '00000000-0000-4000-8000-000000000005',
    'Platform.ManageSessions',
    'Gestionar sesiones',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE
SET
    "name" = EXCLUDED."name",
    "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT "roles"."id", "permissions"."id"
FROM "roles"
CROSS JOIN "permissions"
WHERE "roles"."code" = 'Administrador'
  AND "permissions"."code" = 'Platform.ManageSessions'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
