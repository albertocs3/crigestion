ALTER TABLE "accounting_journal_entries"
ADD COLUMN "customerPaymentId" UUID;

CREATE UNIQUE INDEX "accounting_journal_entries_customerPaymentId_key"
ON "accounting_journal_entries"("customerPaymentId");

ALTER TABLE "accounting_journal_entries"
ADD CONSTRAINT "accounting_journal_entries_customerPaymentId_fkey"
FOREIGN KEY ("customerPaymentId") REFERENCES "customer_payments"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "accounting_journal_entries"
ADD CONSTRAINT "accounting_journal_entries_origin_source_check"
CHECK (
  ("origin" = 'INVOICE' AND "invoiceId" IS NOT NULL AND "customerPaymentId" IS NULL)
  OR ("origin" = 'CUSTOMER_PAYMENT' AND "customerPaymentId" IS NOT NULL AND "invoiceId" IS NULL)
  OR (
    "origin" IN ('MANUAL', 'REGULARIZATION', 'CLOSING', 'OPENING')
    AND "invoiceId" IS NULL
    AND "customerPaymentId" IS NULL
  )
);
