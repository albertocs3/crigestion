BEGIN;

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
  )
  OR (
    "origin" = 'CUSTOMER_PAYMENT'
    AND "customerPaymentId" IS NOT NULL
    AND "invoiceId" IS NULL
    AND "customerPaymentReturnId" IS NULL
  )
  OR (
    "origin" = 'CUSTOMER_PAYMENT_RETURN'
    AND "customerPaymentReturnId" IS NOT NULL
    AND "invoiceId" IS NULL
    AND "customerPaymentId" IS NULL
  )
  OR (
    "origin" IN ('MANUAL', 'REGULARIZATION', 'CLOSING', 'OPENING')
    AND "invoiceId" IS NULL
    AND "customerPaymentId" IS NULL
    AND "customerPaymentReturnId" IS NULL
  )
);

COMMIT;
