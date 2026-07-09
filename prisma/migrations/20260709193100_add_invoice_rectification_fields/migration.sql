ALTER TABLE "invoices"
  ADD COLUMN "rectificationReason" VARCHAR(120),
  ADD COLUMN "rectifiesInvoiceId" UUID;

CREATE UNIQUE INDEX "invoices_rectifiesInvoiceId_key"
  ON "invoices"("rectifiesInvoiceId");

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_rectifiesInvoiceId_fkey"
  FOREIGN KEY ("rectifiesInvoiceId") REFERENCES "invoices"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoices"
  DROP CONSTRAINT "invoices_amounts_non_negative_chk";

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_amounts_supported_chk" CHECK (
    "documentType" = 'RECTIFICATION' OR (
      "subtotal" >= 0 AND
      "discountTotal" >= 0 AND
      "taxableBase" >= 0 AND
      "taxAmount" >= 0 AND
      "total" >= 0
    )
  );

ALTER TABLE "invoice_lines"
  DROP CONSTRAINT "invoice_lines_amounts_non_negative_chk";

ALTER TABLE "invoice_lines"
  ADD CONSTRAINT "invoice_lines_amounts_supported_chk" CHECK (
    "unitPrice" >= 0 AND
    "discountAmount" >= 0
  );

ALTER TABLE "invoice_tax_summaries"
  DROP CONSTRAINT "invoice_tax_summaries_amounts_non_negative_chk";

ALTER TABLE "invoice_due_dates"
  DROP CONSTRAINT "invoice_due_dates_amount_non_negative_chk";
