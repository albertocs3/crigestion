CREATE TABLE "purchase_supplier_document_identities" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "supplierId" UUID NOT NULL,
  "supplierInvoiceNumberNormalized" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "purchase_supplier_document_identities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "purchase_supplier_document_identities_company_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "purchase_supplier_document_identities_supplier_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "purchase_supplier_document_identities_business_key"
  ON "purchase_supplier_document_identities"("companyId", "supplierId", "supplierInvoiceNumberNormalized");
CREATE INDEX "purchase_supplier_document_identities_supplier_created_idx"
  ON "purchase_supplier_document_identities"("supplierId", "createdAt", "id");

INSERT INTO "purchase_supplier_document_identities" ("companyId", "supplierId", "supplierInvoiceNumberNormalized", "createdAt")
SELECT "companyId", "supplierId", "supplierInvoiceNumberNormalized", min("createdAt")
FROM "purchase_invoices"
GROUP BY "companyId", "supplierId", "supplierInvoiceNumberNormalized";

ALTER TABLE "purchase_invoices" ADD COLUMN "documentIdentityId" UUID;
UPDATE "purchase_invoices" invoice SET "documentIdentityId" = identity."id"
FROM "purchase_supplier_document_identities" identity
WHERE identity."companyId" = invoice."companyId" AND identity."supplierId" = invoice."supplierId"
  AND identity."supplierInvoiceNumberNormalized" = invoice."supplierInvoiceNumberNormalized";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "purchase_invoices" WHERE "documentIdentityId" IS NULL)
    OR EXISTS (
      SELECT 1
      FROM "purchase_invoices" invoice
      JOIN "purchase_supplier_document_identities" identity ON identity."id" = invoice."documentIdentityId"
      WHERE identity."companyId" <> invoice."companyId"
        OR identity."supplierId" <> invoice."supplierId"
        OR identity."supplierInvoiceNumberNormalized" <> invoice."supplierInvoiceNumberNormalized"
    )
  THEN
    RAISE EXCEPTION 'PURCHASE_DOCUMENT_IDENTITY_BACKFILL_MISMATCH' USING ERRCODE = '23514';
  END IF;
END;
$$;
