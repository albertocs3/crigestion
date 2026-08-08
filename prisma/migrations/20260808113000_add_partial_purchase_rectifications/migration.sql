BEGIN;

CREATE TYPE "PurchaseRectificationMode" AS ENUM ('FULL', 'PARTIAL');

ALTER TABLE "purchase_invoices" ADD COLUMN "rectificationMode" "PurchaseRectificationMode";
ALTER TABLE "purchase_invoices" ADD COLUMN "rectifiesPurchaseVersion" INTEGER;
UPDATE "purchase_invoices" SET "rectificationMode" = 'FULL' WHERE "documentType" = 'RECTIFICATION';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "purchase_invoices"
    WHERE ("documentType" = 'RECTIFICATION' AND "rectificationMode" IS DISTINCT FROM 'FULL')
      OR ("documentType" = 'STANDARD' AND "rectificationMode" IS NOT NULL)
  )
  THEN
    RAISE EXCEPTION 'PURCHASE_RECTIFICATION_MODE_BACKFILL_MISMATCH' USING ERRCODE = '23514';
  END IF;
END;
$$;

COMMIT;
