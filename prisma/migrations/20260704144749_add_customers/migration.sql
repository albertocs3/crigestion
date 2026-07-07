-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('COMPANY', 'SELF_EMPLOYED', 'INDIVIDUAL');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "CustomerFiscalTreatment" AS ENUM ('DOMESTIC', 'EU', 'EXPORT', 'CANARY_CEUTA_MELILLA');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "type" "CustomerType" NOT NULL,
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "legalName" VARCHAR(200) NOT NULL,
    "tradeName" VARCHAR(160),
    "taxId" VARCHAR(32) NOT NULL,
    "normalizedTaxId" VARCHAR(64) NOT NULL,
    "fiscalTreatment" "CustomerFiscalTreatment" NOT NULL,
    "email" VARCHAR(254),
    "phone" VARCHAR(40),
    "fiscalAddressLine" VARCHAR(240) NOT NULL,
    "fiscalPostalCode" VARCHAR(20) NOT NULL,
    "fiscalCity" VARCHAR(120) NOT NULL,
    "fiscalProvince" VARCHAR(120),
    "fiscalCountry" VARCHAR(2) NOT NULL,
    "notes" VARCHAR(1000),
    "createdById" UUID NOT NULL,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_code_key" ON "customers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "customers_normalizedTaxId_key" ON "customers"("normalizedTaxId");

-- CreateIndex
CREATE INDEX "customers_status_legalName_id_idx" ON "customers"("status", "legalName", "id");

-- CreateIndex
CREATE INDEX "customers_createdAt_id_idx" ON "customers"("createdAt", "id");

-- CreateIndex
CREATE INDEX "customers_createdById_createdAt_idx" ON "customers"("createdById", "createdAt");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
