ALTER TABLE "invoices"
  DROP CONSTRAINT "invoices_issued_fields_chk";

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_numbered_status_fields_chk" CHECK (
    ("status" = 'DRAFT' AND "issuedAt" IS NULL AND "number" IS NULL AND "numberSequence" IS NULL AND "issuedById" IS NULL) OR
    ("status" <> 'DRAFT' AND "issuedAt" IS NOT NULL AND "number" IS NOT NULL AND "numberSequence" IS NOT NULL AND "issuedById" IS NOT NULL)
  );
