CREATE TYPE "CatalogItemKind" AS ENUM ('PRODUCT', 'SERVICE', 'SOFTWARE', 'LICENSE');

CREATE TYPE "CatalogItemStatus" AS ENUM ('ACTIVE', 'INACTIVE');

CREATE SEQUENCE IF NOT EXISTS catalog_item_code_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE TABLE "catalog_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" VARCHAR(20) NOT NULL,
  "kind" "CatalogItemKind" NOT NULL,
  "status" "CatalogItemStatus" NOT NULL DEFAULT 'ACTIVE',
  "name" VARCHAR(200) NOT NULL,
  "description" VARCHAR(1000),
  "unitName" VARCHAR(40) NOT NULL DEFAULT 'Unidades',
  "salePrice" DECIMAL(12, 2) NOT NULL,
  "costPrice" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "taxRate" DECIMAL(5, 2) NOT NULL DEFAULT 21,
  "stockTracked" BOOLEAN NOT NULL DEFAULT false,
  "stockCurrent" DECIMAL(12, 3) NOT NULL DEFAULT 0,
  "stockMinimum" DECIMAL(12, 3) NOT NULL DEFAULT 0,
  "createdById" UUID NOT NULL,
  "updatedById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "catalog_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "catalog_items_code_key" ON "catalog_items"("code");
CREATE UNIQUE INDEX "catalog_items_name_key" ON "catalog_items"("name");
CREATE INDEX "catalog_items_status_name_id_idx" ON "catalog_items"("status", "name", "id");
CREATE INDEX "catalog_items_kind_status_name_id_idx" ON "catalog_items"("kind", "status", "name", "id");
CREATE INDEX "catalog_items_createdById_createdAt_idx" ON "catalog_items"("createdById", "createdAt");

ALTER TABLE "catalog_items"
  ADD CONSTRAINT "catalog_items_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "catalog_items"
  ADD CONSTRAINT "catalog_items_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
