BEGIN;

ALTER TABLE "accounting_journal_entries"
  ADD COLUMN "voidsInvoiceId" UUID,
  ADD COLUMN "reversesEntryId" UUID;

CREATE UNIQUE INDEX "accounting_journal_entries_voidsInvoiceId_key"
  ON "accounting_journal_entries"("voidsInvoiceId");
CREATE UNIQUE INDEX "accounting_journal_entries_reversesEntryId_key"
  ON "accounting_journal_entries"("reversesEntryId");

ALTER TABLE "accounting_journal_entries"
  ADD CONSTRAINT "accounting_journal_entries_voidsInvoiceId_fkey"
  FOREIGN KEY ("voidsInvoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounting_journal_entries_reversesEntryId_fkey"
  FOREIGN KEY ("reversesEntryId") REFERENCES "accounting_journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "accounting_journal_entries"
  DROP CONSTRAINT IF EXISTS "accounting_journal_entries_origin_source_check";

ALTER TABLE "accounting_journal_entries"
  ADD CONSTRAINT "accounting_journal_entries_origin_source_check"
  CHECK (
    (
      "origin" = 'INVOICE'
      AND "invoiceId" IS NOT NULL
      AND "customerPaymentId" IS NULL
      AND "customerPaymentReturnId" IS NULL
      AND "voidsInvoiceId" IS NULL
      AND "reversesEntryId" IS NULL
    )
    OR (
      "origin" = 'INVOICE_VOIDING'
      AND "invoiceId" IS NULL
      AND "customerPaymentId" IS NULL
      AND "customerPaymentReturnId" IS NULL
      AND "voidsInvoiceId" IS NOT NULL
      AND "reversesEntryId" IS NOT NULL
    )
    OR (
      "origin" = 'CUSTOMER_PAYMENT'
      AND "customerPaymentId" IS NOT NULL
      AND "invoiceId" IS NULL
      AND "customerPaymentReturnId" IS NULL
      AND "voidsInvoiceId" IS NULL
      AND "reversesEntryId" IS NULL
    )
    OR (
      "origin" = 'CUSTOMER_PAYMENT_RETURN'
      AND "customerPaymentReturnId" IS NOT NULL
      AND "invoiceId" IS NULL
      AND "customerPaymentId" IS NULL
      AND "voidsInvoiceId" IS NULL
      AND "reversesEntryId" IS NULL
    )
    OR (
      "origin" IN ('MANUAL', 'REGULARIZATION', 'CLOSING', 'OPENING')
      AND "invoiceId" IS NULL
      AND "customerPaymentId" IS NULL
      AND "customerPaymentReturnId" IS NULL
      AND "voidsInvoiceId" IS NULL
      AND "reversesEntryId" IS NULL
    )
  );

COMMIT;
