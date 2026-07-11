CREATE TYPE "AccountingFiscalYearStatus" AS ENUM ('OPEN', 'CLOSED');

CREATE TABLE "accounting_fiscal_years" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "AccountingFiscalYearStatus" NOT NULL DEFAULT 'OPEN',
    "planCode" VARCHAR(40) NOT NULL,
    "planVersion" VARCHAR(20) NOT NULL,
    "sourceFiscalYearId" UUID,
    "createdById" UUID NOT NULL,
    "closedById" UUID,
    "closedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "accounting_fiscal_years_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "accounting_fiscal_year_dates_check" CHECK ("startDate" <= "endDate"),
    CONSTRAINT "accounting_fiscal_year_closed_check" CHECK (
      ("status" = 'OPEN' AND "closedAt" IS NULL AND "closedById" IS NULL)
      OR ("status" = 'CLOSED' AND "closedAt" IS NOT NULL AND "closedById" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "accounting_fiscal_years_companyId_year_key"
  ON "accounting_fiscal_years"("companyId", "year");
CREATE INDEX "accounting_fiscal_years_companyId_status_year_idx"
  ON "accounting_fiscal_years"("companyId", "status", "year");
CREATE INDEX "accounting_fiscal_years_sourceFiscalYearId_idx"
  ON "accounting_fiscal_years"("sourceFiscalYearId");

INSERT INTO "accounting_fiscal_years" (
  "companyId", "year", "startDate", "endDate", "planCode", "planVersion", "createdById"
)
SELECT DISTINCT
  i."companyId",
  years."year",
  make_date(years."year", 1, 1),
  make_date(years."year", 12, 31),
  'PGC_PYMES',
  '2021.1',
  i."initialAdministratorId"
FROM "installations" i
CROSS JOIN LATERAL (
  SELECT "year" FROM "accounting_journal_entries"
  UNION
  SELECT EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER
  WHERE EXISTS (SELECT 1 FROM "accounting_accounts")
) years
WHERE i."status" = 'INITIALIZED'
  AND i."companyId" IS NOT NULL
  AND i."initialAdministratorId" IS NOT NULL;

ALTER TABLE "accounting_accounts" ADD COLUMN "fiscalYearId" UUID;
ALTER TABLE "accounting_accounts" ADD COLUMN "sourceAccountId" UUID;
ALTER TABLE "accounting_journal_entries" ADD COLUMN "fiscalYearId" UUID;

UPDATE "accounting_journal_entries" e
SET "fiscalYearId" = fy."id"
FROM "accounting_fiscal_years" fy
JOIN "installations" i ON i."companyId" = fy."companyId"
WHERE e."year" = fy."year" AND i."status" = 'INITIALIZED';

CREATE TEMP TABLE accounting_account_year_map (
  old_account_id UUID NOT NULL,
  year INTEGER NOT NULL,
  new_account_id UUID NOT NULL,
  PRIMARY KEY (old_account_id, year)
) ON COMMIT DROP;

INSERT INTO accounting_account_year_map (old_account_id, year, new_account_id)
SELECT DISTINCT l."accountId", e."year", l."accountId"
FROM "accounting_journal_lines" l
JOIN "accounting_journal_entries" e ON e."id" = l."entryId";

INSERT INTO accounting_account_year_map (old_account_id, year, new_account_id)
SELECT a."id", fy."year", a."id"
FROM "accounting_accounts" a
CROSS JOIN LATERAL (
  SELECT "year" FROM "accounting_fiscal_years" ORDER BY "year" DESC LIMIT 1
) fy
WHERE NOT EXISTS (
  SELECT 1 FROM accounting_account_year_map m WHERE m.old_account_id = a."id"
);

UPDATE "accounting_accounts" a
SET "fiscalYearId" = fy."id"
FROM (
  SELECT old_account_id, MIN(year) AS year
  FROM accounting_account_year_map
  GROUP BY old_account_id
) base
JOIN "accounting_fiscal_years" fy ON fy."year" = base.year
WHERE a."id" = base.old_account_id;

-- El codigo deja de ser global antes de clonar cuentas usadas en varios anos.
-- La unicidad por ejercicio se crea despues de completar el backfill.
DROP INDEX "accounting_accounts_code_key";

WITH copies AS (
  SELECT
    m.old_account_id,
    m.year,
    gen_random_uuid() AS new_account_id
  FROM accounting_account_year_map m
  JOIN "accounting_accounts" a ON a."id" = m.old_account_id
  JOIN "accounting_fiscal_years" fy ON fy."year" = m.year
  WHERE a."fiscalYearId" <> fy."id"
), inserted AS (
  INSERT INTO "accounting_accounts" (
    "id", "fiscalYearId", "sourceAccountId", "code", "name", "status", "type",
    "level", "isPostable", "createdById", "createdAt", "updatedAt"
  )
  SELECT
    c.new_account_id, fy."id", a."id", a."code", a."name", a."status", a."type",
    a."level", a."isPostable", a."createdById", a."createdAt", a."updatedAt"
  FROM copies c
  JOIN "accounting_accounts" a ON a."id" = c.old_account_id
  JOIN "accounting_fiscal_years" fy ON fy."year" = c.year
  RETURNING "id", "sourceAccountId", "fiscalYearId"
)
UPDATE accounting_account_year_map m
SET new_account_id = i."id"
FROM inserted i
JOIN "accounting_fiscal_years" fy ON fy."id" = i."fiscalYearId"
WHERE m.old_account_id = i."sourceAccountId" AND m.year = fy."year";

UPDATE "accounting_journal_lines" l
SET "accountId" = m.new_account_id
FROM "accounting_journal_entries" e, accounting_account_year_map m
WHERE l."entryId" = e."id"
  AND m.old_account_id = l."accountId"
  AND m.year = e."year";

ALTER TABLE "accounting_accounts" ALTER COLUMN "fiscalYearId" SET NOT NULL;
ALTER TABLE "accounting_journal_entries" ALTER COLUMN "fiscalYearId" SET NOT NULL;

DROP INDEX "accounting_accounts_status_code_idx";
DROP INDEX "accounting_journal_entries_year_sequence_key";

CREATE UNIQUE INDEX "accounting_accounts_fiscalYearId_code_key"
  ON "accounting_accounts"("fiscalYearId", "code");
CREATE INDEX "accounting_accounts_fiscalYearId_status_code_idx"
  ON "accounting_accounts"("fiscalYearId", "status", "code");
CREATE INDEX "accounting_accounts_sourceAccountId_idx"
  ON "accounting_accounts"("sourceAccountId");
CREATE UNIQUE INDEX "accounting_journal_entries_fiscalYearId_sequence_key"
  ON "accounting_journal_entries"("fiscalYearId", "sequence");
CREATE INDEX "accounting_journal_entries_fiscalYearId_accountingDate_id_idx"
  ON "accounting_journal_entries"("fiscalYearId", "accountingDate", "id");

ALTER TABLE "accounting_fiscal_years"
  ADD CONSTRAINT "accounting_fiscal_years_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounting_fiscal_years"
  ADD CONSTRAINT "accounting_fiscal_years_sourceFiscalYearId_fkey"
  FOREIGN KEY ("sourceFiscalYearId") REFERENCES "accounting_fiscal_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounting_fiscal_years"
  ADD CONSTRAINT "accounting_fiscal_years_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounting_fiscal_years"
  ADD CONSTRAINT "accounting_fiscal_years_closedById_fkey"
  FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounting_accounts"
  ADD CONSTRAINT "accounting_accounts_fiscalYearId_fkey"
  FOREIGN KEY ("fiscalYearId") REFERENCES "accounting_fiscal_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounting_accounts"
  ADD CONSTRAINT "accounting_accounts_sourceAccountId_fkey"
  FOREIGN KEY ("sourceAccountId") REFERENCES "accounting_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounting_journal_entries"
  ADD CONSTRAINT "accounting_journal_entries_fiscalYearId_fkey"
  FOREIGN KEY ("fiscalYearId") REFERENCES "accounting_fiscal_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'Accounting.ManageExercises', 'Gestionar ejercicios contables', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Accounting.CloseExercises', 'Cerrar ejercicios contables', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."code" = 'Administrador'
  AND p."code" IN ('Accounting.ManageExercises', 'Accounting.CloseExercises')
ON CONFLICT DO NOTHING;
