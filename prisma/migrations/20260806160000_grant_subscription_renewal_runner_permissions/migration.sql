INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" IN ('Subscriptions.RunRenewals', 'Subscriptions.ConfirmRenewals')
WHERE role."code" = 'Administrador' AND role."isProtected" = true
ON CONFLICT DO NOTHING;
