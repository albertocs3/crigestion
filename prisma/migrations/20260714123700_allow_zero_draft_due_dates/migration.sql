BEGIN;

ALTER TABLE "invoice_due_dates"
  DROP CONSTRAINT "invoice_due_dates_amount_positive";

ALTER TABLE "invoice_due_dates"
  ADD CONSTRAINT "invoice_due_dates_amount_nonnegative" CHECK ("amount" >= 0);

COMMIT;
