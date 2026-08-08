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

ALTER TABLE "purchase_invoices" ALTER COLUMN "documentIdentityId" SET NOT NULL;
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_documentIdentityId_fkey"
  FOREIGN KEY ("documentIdentityId") REFERENCES "purchase_supplier_document_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "purchase_invoices_document_identity_created_idx" ON "purchase_invoices"("documentIdentityId", "createdAt", "id");
CREATE UNIQUE INDEX "purchase_invoices_one_current_version_per_identity"
  ON "purchase_invoices"("documentIdentityId") WHERE "status" IN ('DRAFT', 'REGISTERED');
DROP INDEX "purchase_invoices_companyId_supplierId_supplierInvoiceNumbe_key";

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
