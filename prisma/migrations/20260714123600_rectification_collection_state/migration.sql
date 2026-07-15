BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "invoice_due_dates" due_date
    JOIN "invoices" invoice ON invoice."id" = due_date."invoiceId"
    WHERE invoice."documentType" = 'RECTIFICATION'
  ) THEN
    RAISE EXCEPTION 'Rectification due dates require reviewed manual remediation before this migration'
      USING ERRCODE = '23514';
  END IF;
END $$;

UPDATE "invoices" AS invoice
SET "paymentStatus" = 'NOT_APPLICABLE'
WHERE invoice."documentType" = 'RECTIFICATION'
  AND invoice."total" < 0
  AND invoice."paymentStatus" = 'PAID'
  AND NOT EXISTS (SELECT 1 FROM "invoice_due_dates" due_date WHERE due_date."invoiceId" = invoice."id");

UPDATE "invoice_due_dates" AS due_date
SET "status" = 'CANCELLED'
FROM "invoices" AS original
WHERE due_date."invoiceId" = original."id"
  AND original."status" = 'RECTIFIED'
  AND original."paymentStatus" = 'PENDING'
  AND due_date."status" = 'PENDING'
  AND EXISTS (
    SELECT 1 FROM "invoices" rectification
    WHERE rectification."rectifiesInvoiceId" = original."id"
      AND rectification."paymentStatus" = 'NOT_APPLICABLE'
  );

UPDATE "invoices" AS original
SET "paymentStatus" = 'CANCELLED'
WHERE original."status" = 'RECTIFIED'
  AND original."paymentStatus" = 'PENDING'
  AND EXISTS (
    SELECT 1 FROM "invoices" rectification
    WHERE rectification."rectifiesInvoiceId" = original."id"
      AND rectification."paymentStatus" = 'NOT_APPLICABLE'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "invoice_due_dates" due_date
    WHERE due_date."invoiceId" = original."id"
      AND due_date."status" <> 'CANCELLED'
  );

ALTER TABLE "invoice_due_dates"
  ADD CONSTRAINT "invoice_due_dates_amount_positive" CHECK ("amount" > 0);

CREATE OR REPLACE FUNCTION prevent_rectification_due_date()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "invoices" invoice
    WHERE invoice."id" = NEW."invoiceId"
      AND invoice."documentType" = 'RECTIFICATION'
  ) THEN
    RAISE EXCEPTION 'Rectification invoices cannot have collection due dates.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "invoice_due_dates_no_rectification"
BEFORE INSERT OR UPDATE OF "invoiceId" ON "invoice_due_dates"
FOR EACH ROW EXECUTE FUNCTION prevent_rectification_due_date();

COMMIT;
