-- Materializa las subcuentas 430 de clientes creados antes de introducir la
-- integracion contable. Si la subcuenta ya existe se conserva, porque el
-- codigo 430 + cliente es la asociacion funcional estable.
INSERT INTO "accounting_accounts" (
  "id", "fiscalYearId", "code", "name", "status", "type", "level",
  "isPostable", "createdById", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(),
  fy."id",
  '430' || lpad(c."code", 6, '0'),
  left(c."legalName", 180),
  'ACTIVE'::"AccountingAccountStatus",
  'ACTIVO',
  9,
  true,
  c."createdById",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "customers" c
CROSS JOIN LATERAL (
  SELECT "id"
  FROM "accounting_fiscal_years"
  WHERE "status" = 'OPEN'
  ORDER BY "year" DESC
  LIMIT 1
) fy
WHERE c."code" ~ '^[0-9]{1,6}$'
  AND NOT EXISTS (
    SELECT 1
    FROM "accounting_accounts" a
    WHERE a."fiscalYearId" = fy."id"
      AND a."code" = '430' || lpad(c."code", 6, '0')
  );
