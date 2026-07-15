BEGIN;

ALTER TYPE "AccountingEntryOrigin" ADD VALUE IF NOT EXISTS 'CUSTOMER_PAYMENT_RETURN';

ALTER TABLE "accounting_journal_entries"
ADD COLUMN "customerPaymentReturnId" UUID;

CREATE UNIQUE INDEX "accounting_journal_entries_customerPaymentReturnId_key"
ON "accounting_journal_entries"("customerPaymentReturnId");

ALTER TABLE "accounting_journal_entries"
ADD CONSTRAINT "accounting_journal_entries_customerPaymentReturnId_fkey"
FOREIGN KEY ("customerPaymentReturnId") REFERENCES "customer_payment_returns"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
