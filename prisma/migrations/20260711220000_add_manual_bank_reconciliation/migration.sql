BEGIN;

CREATE TYPE "BankAccountStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "BankMovementSource" AS ENUM ('MANUAL');
CREATE TYPE "BankReconciliationStatus" AS ENUM ('ACTIVE', 'UNDONE');

CREATE TABLE "bank_accounts" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "iban" VARCHAR(34) NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
  "status" "BankAccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bank_accounts_currency_check" CHECK ("currency" = 'EUR')
);

CREATE TABLE "bank_movements" (
  "id" UUID NOT NULL,
  "bankAccountId" UUID NOT NULL,
  "bookingDate" DATE NOT NULL,
  "valueDate" DATE,
  "amount" DECIMAL(14,2) NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
  "reference" VARCHAR(140),
  "counterpartyName" VARCHAR(200),
  "externalMovementNumber" VARCHAR(120),
  "source" "BankMovementSource" NOT NULL DEFAULT 'MANUAL',
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bank_movements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bank_movements_amount_check" CHECK ("amount" <> 0),
  CONSTRAINT "bank_movements_currency_check" CHECK ("currency" = 'EUR')
);

CREATE TABLE "bank_reconciliations" (
  "id" UUID NOT NULL,
  "bankMovementId" UUID NOT NULL,
  "status" "BankReconciliationStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdById" UUID NOT NULL,
  "undoneById" UUID,
  "correlationId" VARCHAR(120),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "undoneAt" TIMESTAMPTZ(3),
  CONSTRAINT "bank_reconciliations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bank_reconciliations_undo_state_check" CHECK (
    ("status" = 'ACTIVE' AND "undoneById" IS NULL AND "undoneAt" IS NULL)
    OR ("status" = 'UNDONE' AND "undoneById" IS NOT NULL AND "undoneAt" IS NOT NULL)
  )
);

CREATE TABLE "bank_reconciliation_applications" (
  "id" UUID NOT NULL,
  "reconciliationId" UUID NOT NULL,
  "customerPaymentId" UUID NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bank_reconciliation_applications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bank_reconciliation_applications_amount_check" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX "bank_accounts_companyId_iban_key" ON "bank_accounts"("companyId", "iban");
CREATE INDEX "bank_accounts_companyId_status_name_id_idx" ON "bank_accounts"("companyId", "status", "name", "id");
CREATE INDEX "bank_movements_bankAccountId_bookingDate_id_idx" ON "bank_movements"("bankAccountId", "bookingDate", "id");
CREATE INDEX "bank_movements_createdById_createdAt_idx" ON "bank_movements"("createdById", "createdAt");
CREATE UNIQUE INDEX "bank_movements_external_number_key" ON "bank_movements"("bankAccountId", "externalMovementNumber") WHERE "externalMovementNumber" IS NOT NULL;
CREATE INDEX "bank_reconciliations_bankMovementId_status_createdAt_id_idx" ON "bank_reconciliations"("bankMovementId", "status", "createdAt", "id");
CREATE INDEX "bank_reconciliations_createdById_createdAt_idx" ON "bank_reconciliations"("createdById", "createdAt");
CREATE UNIQUE INDEX "bank_reconciliation_applications_reconciliationId_customerPaymentId_key" ON "bank_reconciliation_applications"("reconciliationId", "customerPaymentId");
CREATE INDEX "bank_reconciliation_applications_customerPaymentId_createdAt_id_idx" ON "bank_reconciliation_applications"("customerPaymentId", "createdAt", "id");

ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_movements" ADD CONSTRAINT "bank_movements_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_movements" ADD CONSTRAINT "bank_movements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_bankMovementId_fkey" FOREIGN KEY ("bankMovementId") REFERENCES "bank_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_undoneById_fkey" FOREIGN KEY ("undoneById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_reconciliation_applications" ADD CONSTRAINT "bank_reconciliation_applications_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "bank_reconciliations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_reconciliation_applications" ADD CONSTRAINT "bank_reconciliation_applications_customerPaymentId_fkey" FOREIGN KEY ("customerPaymentId") REFERENCES "customer_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
