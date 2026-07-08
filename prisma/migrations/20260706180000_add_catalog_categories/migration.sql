-- CreateEnum
CREATE TYPE "CatalogCategoryStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateSequence
CREATE SEQUENCE IF NOT EXISTS catalog_category_code_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

-- CreateTable
CREATE TABLE "catalog_categories" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" VARCHAR(20) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "description" VARCHAR(500),
  "status" "CatalogCategoryStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "catalog_categories_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "catalog_items" ADD COLUMN "categoryId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "catalog_categories_code_key" ON "catalog_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_categories_name_key" ON "catalog_categories"("name");

-- CreateIndex
CREATE INDEX "catalog_categories_status_name_id_idx" ON "catalog_categories"("status", "name", "id");

-- CreateIndex
CREATE INDEX "catalog_items_categoryId_status_name_id_idx" ON "catalog_items"("categoryId", "status", "name", "id");

-- AddForeignKey
ALTER TABLE "catalog_items"
ADD CONSTRAINT "catalog_items_categoryId_fkey"
FOREIGN KEY ("categoryId") REFERENCES "catalog_categories"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
