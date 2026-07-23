BEGIN;

CREATE TYPE "AccountingFiscalYearCloseRequestStatus" AS ENUM ('REQUESTED', 'COMPLETED', 'CANCELLED');

ALTER TABLE "accounting_fiscal_years"
  ADD CONSTRAINT "accounting_fiscal_years_id_companyId_key" UNIQUE ("id", "companyId");

CREATE TABLE "accounting_fiscal_year_close_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "fiscalYearId" UUID NOT NULL,
  "status" "AccountingFiscalYearCloseRequestStatus" NOT NULL DEFAULT 'REQUESTED',
  "preflightSnapshot" JSONB NOT NULL,
  "requestedById" UUID NOT NULL,
  "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedById" UUID,
  "approvedAt" TIMESTAMPTZ(3),
  "cancelledById" UUID,
  "cancelledAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "accounting_fiscal_year_close_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "accounting_fiscal_year_close_requests_actor_state_check" CHECK (
    ("status" = 'REQUESTED' AND "approvedById" IS NULL AND "approvedAt" IS NULL AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'COMPLETED' AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'CANCELLED' AND "approvedById" IS NULL AND "approvedAt" IS NULL AND "cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL)
  ),
  CONSTRAINT "accounting_fiscal_year_close_requests_maker_checker_check" CHECK (
    "approvedById" IS NULL OR "approvedById" <> "requestedById"
  )
);

CREATE UNIQUE INDEX "accounting_fiscal_year_close_requests_active_key"
  ON "accounting_fiscal_year_close_requests" ("fiscalYearId")
  WHERE "status" = 'REQUESTED';
CREATE INDEX "accounting_fiscal_year_close_requests_company_status_requested_idx"
  ON "accounting_fiscal_year_close_requests" ("companyId", "status", "requestedAt", "id");
CREATE INDEX "accounting_fiscal_year_close_requests_fiscal_requested_idx"
  ON "accounting_fiscal_year_close_requests" ("fiscalYearId", "requestedAt", "id");
CREATE INDEX "accounting_fiscal_year_close_requests_requester_requested_idx"
  ON "accounting_fiscal_year_close_requests" ("requestedById", "requestedAt");

ALTER TABLE "accounting_fiscal_year_close_requests"
  ADD CONSTRAINT "accounting_fiscal_year_close_requests_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounting_fiscal_year_close_requests_fiscal_company_fkey"
    FOREIGN KEY ("fiscalYearId", "companyId") REFERENCES "accounting_fiscal_years"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounting_fiscal_year_close_requests_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounting_fiscal_year_close_requests_approvedById_fkey"
    FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounting_fiscal_year_close_requests_cancelledById_fkey"
    FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt") VALUES
  (gen_random_uuid(), 'Accounting.RequestExerciseClosures', 'Solicitar cierres de ejercicio', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Accounting.ApproveExerciseClosures', 'Aprobar cierres de ejercicio', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador'
  AND permission."code" IN ('Accounting.RequestExerciseClosures', 'Accounting.ApproveExerciseClosures')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
