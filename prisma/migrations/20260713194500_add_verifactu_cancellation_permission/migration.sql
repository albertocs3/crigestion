BEGIN;

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Billing.RequestVerifactuCancellation', 'Solicitar anulaciones de registros VeriFactu', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador'
  AND role."isProtected" = true
  AND permission."code" = 'Billing.RequestVerifactuCancellation'
ON CONFLICT DO NOTHING;

COMMIT;
