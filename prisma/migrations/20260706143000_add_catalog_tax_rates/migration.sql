-- CreateEnum
CREATE TYPE "CatalogTaxRateStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "catalog_tax_rates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" VARCHAR(40) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "rate" DECIMAL(5, 2) NOT NULL,
  "status" "CatalogTaxRateStatus" NOT NULL DEFAULT 'ACTIVE',
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "catalog_tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "catalog_tax_rates_code_key" ON "catalog_tax_rates"("code");

-- CreateIndex
CREATE INDEX "catalog_tax_rates_status_name_id_idx" ON "catalog_tax_rates"("status", "name", "id");

-- Seed stable default IVA types.
INSERT INTO "catalog_tax_rates" ("code", "name", "rate", "status", "isDefault", "updatedAt")
VALUES
  ('IVA_21', 'IVA general 21%', 21.00, 'ACTIVE', true, CURRENT_TIMESTAMP),
  ('IVA_10', 'IVA reducido 10%', 10.00, 'ACTIVE', false, CURRENT_TIMESTAMP),
  ('IVA_4', 'IVA superreducido 4%', 4.00, 'ACTIVE', false, CURRENT_TIMESTAMP),
  ('IVA_0', 'IVA 0%', 0.00, 'ACTIVE', false, CURRENT_TIMESTAMP),
  ('EXEMPT', 'Exento 0%', 0.00, 'ACTIVE', false, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "rate" = EXCLUDED."rate",
  "status" = EXCLUDED."status",
  "isDefault" = EXCLUDED."isDefault",
  "updatedAt" = CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "catalog_items" ADD COLUMN "taxRateId" UUID;

UPDATE "catalog_items"
SET "taxRateId" = (
  SELECT "id"
  FROM "catalog_tax_rates"
  WHERE "code" = CASE
    WHEN "catalog_items"."taxRate" = 21.00 THEN 'IVA_21'
    WHEN "catalog_items"."taxRate" = 10.00 THEN 'IVA_10'
    WHEN "catalog_items"."taxRate" = 4.00 THEN 'IVA_4'
    WHEN "catalog_items"."taxRate" = 0.00 THEN 'IVA_0'
    ELSE 'IVA_21'
  END
);

ALTER TABLE "catalog_items" ALTER COLUMN "taxRateId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "catalog_items_taxRateId_idx" ON "catalog_items"("taxRateId");

-- AddForeignKey
ALTER TABLE "catalog_items"
ADD CONSTRAINT "catalog_items_taxRateId_fkey"
FOREIGN KEY ("taxRateId") REFERENCES "catalog_tax_rates"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
