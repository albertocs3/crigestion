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
ALTER TABLE "purchase_invoices" ALTER COLUMN "documentIdentityId" SET NOT NULL;
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_documentIdentityId_fkey"
  FOREIGN KEY ("documentIdentityId") REFERENCES "purchase_supplier_document_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
DROP INDEX "purchase_invoices_companyId_supplierId_supplierInvoiceNumbe_key";
CREATE INDEX "purchase_invoices_document_identity_created_idx" ON "purchase_invoices"("documentIdentityId", "createdAt", "id");
CREATE UNIQUE INDEX "purchase_invoices_one_current_version_per_identity"
  ON "purchase_invoices"("documentIdentityId") WHERE "status" IN ('DRAFT', 'REGISTERED');

CREATE FUNCTION validate_purchase_document_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity_row "purchase_supplier_document_identities"%ROWTYPE;
BEGIN
  SELECT * INTO identity_row FROM "purchase_supplier_document_identities" WHERE "id" = NEW."documentIdentityId";
  IF identity_row."id" IS NULL OR identity_row."companyId" <> NEW."companyId" OR identity_row."supplierId" <> NEW."supplierId"
    OR identity_row."supplierInvoiceNumberNormalized" <> NEW."supplierInvoiceNumberNormalized"
  THEN RAISE EXCEPTION 'PURCHASE_DOCUMENT_IDENTITY_MISMATCH' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "purchase_invoice_document_identity_guard" BEFORE INSERT OR UPDATE ON "purchase_invoices"
FOR EACH ROW EXECUTE FUNCTION validate_purchase_document_identity();
