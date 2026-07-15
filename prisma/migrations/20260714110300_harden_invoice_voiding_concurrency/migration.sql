BEGIN;

CREATE OR REPLACE FUNCTION "enforce_active_remittance_line_invoice_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  eligible boolean;
BEGIN
  IF NEW."status" <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  SELECT TRUE
  INTO eligible
  FROM "invoice_due_dates" due_date
  JOIN "invoices" invoice ON invoice."id" = due_date."invoiceId"
  WHERE due_date."id" = NEW."dueDateId"
    AND due_date."invoiceId" = NEW."invoiceId"
    AND due_date."status" = 'PENDING'
    AND invoice."status" = 'ISSUED'
    AND invoice."verifactuStatus" <> 'CANCELLED';

  IF eligible IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'An active remittance line requires an issued invoice and pending due date.'
      USING ERRCODE = '23514', CONSTRAINT = 'customer_remittance_lines_active_invoice_state_check';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "customer_remittance_lines_active_invoice_state_trigger" ON "customer_remittance_lines";
CREATE TRIGGER "customer_remittance_lines_active_invoice_state_trigger"
BEFORE INSERT OR UPDATE OF "invoiceId", "dueDateId", "status"
ON "customer_remittance_lines"
FOR EACH ROW
EXECUTE FUNCTION "enforce_active_remittance_line_invoice_state"();

CREATE OR REPLACE FUNCTION "enforce_invoice_voiding_entry_link"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  valid_link boolean;
BEGIN
  IF NEW."origin" <> 'INVOICE_VOIDING' THEN
    RETURN NEW;
  END IF;

  SELECT TRUE
  INTO valid_link
  FROM "accounting_journal_entries" original
  WHERE original."id" = NEW."reversesEntryId"
    AND original."id" <> NEW."id"
    AND original."origin" = 'INVOICE'
    AND original."status" = 'POSTED'
    AND original."invoiceId" = NEW."voidsInvoiceId"
    AND original."fiscalYearId" = NEW."fiscalYearId";

  IF valid_link IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'An invoice voiding entry must reverse the posted invoice entry in the same fiscal year.'
      USING ERRCODE = '23514', CONSTRAINT = 'accounting_journal_entries_invoice_voiding_link_check';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "accounting_journal_entries_invoice_voiding_link_trigger" ON "accounting_journal_entries";
CREATE TRIGGER "accounting_journal_entries_invoice_voiding_link_trigger"
BEFORE INSERT OR UPDATE OF "origin", "voidsInvoiceId", "reversesEntryId", "fiscalYearId"
ON "accounting_journal_entries"
FOR EACH ROW
EXECUTE FUNCTION "enforce_invoice_voiding_entry_link"();

COMMIT;
