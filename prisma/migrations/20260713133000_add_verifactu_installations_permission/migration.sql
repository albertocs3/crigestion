BEGIN;

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Billing.ManageVerifactuInstallations', 'Gestionar instalaciones SIF VeriFactu', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'Billing.ManageVerifactuInstallations'
WHERE role."code" = 'Administrador' AND role."isProtected" = true
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
