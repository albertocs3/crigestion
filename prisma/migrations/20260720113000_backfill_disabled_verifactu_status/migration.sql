UPDATE "invoices" AS invoice
SET "verifactuStatus" = 'NOT_APPLICABLE'::"InvoiceVerifactuStatus"
WHERE invoice."verifactuStatus" = 'PENDING'::"InvoiceVerifactuStatus"
  AND EXISTS (
    SELECT 1
    FROM "invoice_verifactu_records" AS legacy_record
    WHERE legacy_record."invoiceId" = invoice."id"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "verifactu_fiscal_records" AS fiscal_record
    WHERE fiscal_record."invoiceId" = invoice."id"
  );
