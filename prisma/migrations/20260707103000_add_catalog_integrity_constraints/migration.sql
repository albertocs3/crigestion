CREATE UNIQUE INDEX "catalog_tax_rates_single_default_idx"
  ON "catalog_tax_rates" ("isDefault")
  WHERE "isDefault" = true;

ALTER TABLE "catalog_tax_rates"
  ADD CONSTRAINT "catalog_tax_rates_rate_range_chk"
  CHECK ("rate" >= 0 AND "rate" <= 100);

ALTER TABLE "catalog_items"
  ADD CONSTRAINT "catalog_items_sale_price_non_negative_chk"
  CHECK ("salePrice" >= 0),
  ADD CONSTRAINT "catalog_items_cost_price_non_negative_chk"
  CHECK ("costPrice" >= 0),
  ADD CONSTRAINT "catalog_items_tax_rate_range_chk"
  CHECK ("taxRate" >= 0 AND "taxRate" <= 100),
  ADD CONSTRAINT "catalog_items_stock_minimum_non_negative_chk"
  CHECK ("stockMinimum" >= 0);

ALTER TABLE "catalog_stock_movements"
  ADD CONSTRAINT "catalog_stock_movements_quantity_non_zero_chk"
  CHECK ("quantity" <> 0),
  ADD CONSTRAINT "catalog_stock_movements_stock_delta_chk"
  CHECK ("newStock" = "previousStock" + "quantity");
