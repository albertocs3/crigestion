BEGIN;

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'Support.ViewIndicators', 'Consultar indicadores propios de atencion al cliente', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Support.ViewGlobalIndicators', 'Consultar indicadores globales de atencion al cliente', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE
SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador'
  AND permission."code" IN ('Support.ViewIndicators', 'Support.ViewGlobalIndicators')
ON CONFLICT DO NOTHING;

COMMIT;
