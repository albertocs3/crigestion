BEGIN;

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'Billing.ViewVerifactuOperations', 'Consultar operaciones VeriFactu', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Billing.ManageVerifactuOperations', 'Intervenir operaciones VeriFactu', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador'
  AND role."isProtected" = true
  AND permission."code" IN ('Billing.ViewVerifactuOperations', 'Billing.ManageVerifactuOperations')
ON CONFLICT DO NOTHING;

COMMIT;
