-- CreateEnum
CREATE TYPE "CatalogStockMovementType" AS ENUM ('ADJUSTMENT');

-- CreateTable
CREATE TABLE "catalog_stock_movements" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "itemId" UUID NOT NULL,
  "type" "CatalogStockMovementType" NOT NULL DEFAULT 'ADJUSTMENT',
  "quantity" DECIMAL(12, 3) NOT NULL,
  "previousStock" DECIMAL(12, 3) NOT NULL,
  "newStock" DECIMAL(12, 3) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "catalog_stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "catalog_stock_movements_itemId_createdAt_id_idx"
ON "catalog_stock_movements"("itemId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "catalog_stock_movements_createdById_createdAt_idx"
ON "catalog_stock_movements"("createdById", "createdAt");

-- AddForeignKey
ALTER TABLE "catalog_stock_movements"
ADD CONSTRAINT "catalog_stock_movements_itemId_fkey"
FOREIGN KEY ("itemId") REFERENCES "catalog_items"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_stock_movements"
ADD CONSTRAINT "catalog_stock_movements_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
