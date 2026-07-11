ALTER TYPE "AccountingEntryOrigin" ADD VALUE IF NOT EXISTS 'INVOICE';
ALTER TYPE "AccountingEntryOrigin" ADD VALUE IF NOT EXISTS 'CUSTOMER_PAYMENT';

ALTER TABLE "accounting_journal_entries"
ADD COLUMN "invoiceId" UUID;

CREATE UNIQUE INDEX "accounting_journal_entries_invoiceId_key"
ON "accounting_journal_entries"("invoiceId");

ALTER TABLE "accounting_journal_entries"
ADD CONSTRAINT "accounting_journal_entries_invoiceId_fkey"
FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
