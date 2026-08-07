ALTER TABLE "purchase_correction_operations" DROP CONSTRAINT "purchase_correction_operations_replacement_fkey";
ALTER TABLE "purchase_invoices" DROP CONSTRAINT "purchase_invoices_registration_state_check";
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_registration_state_check" CHECK (
  ("status" = 'DRAFT' AND "registeredAt" IS NULL AND "registeredById" IS NULL)
  OR ("status" IN ('REGISTERED', 'RECTIFIED', 'VOIDED', 'SUPERSEDED') AND "registeredAt" IS NOT NULL AND "registeredById" IS NOT NULL)
);
ALTER TABLE "purchase_correction_operations" ADD CONSTRAINT "purchase_correction_operations_replacement_fkey"
  FOREIGN KEY ("replacementPurchaseInvoiceId") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "purchase_correction_operations" DROP CONSTRAINT "purchase_correction_operations_shape_check";
ALTER TABLE "purchase_correction_operations" ADD CONSTRAINT "purchase_correction_operations_shape_check" CHECK (
  "sourceVersion" > 0 AND ("replacementPurchaseInvoiceId" IS NULL OR "sourcePurchaseInvoiceId" <> "replacementPurchaseInvoiceId") AND (
    ("mode" = 'VOID' AND "replacementPurchaseInvoiceId" IS NULL AND "reasonCode" = 'DUPLICATE_DOCUMENT')
    OR ("mode" = 'REPLACE' AND "replacementPurchaseInvoiceId" IS NOT NULL
      AND "reasonCode" IN ('DATA_ENTRY_ERROR', 'WRONG_DATE', 'WRONG_AMOUNT', 'WRONG_TAX', 'OTHER')
      AND ("reasonCode" <> 'OTHER' OR "reason" IS NOT NULL))
  )
);

CREATE OR REPLACE FUNCTION validate_purchase_document_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity_row "purchase_supplier_document_identities"%ROWTYPE;
BEGIN
  SELECT * INTO identity_row FROM "purchase_supplier_document_identities" WHERE "id" = NEW."documentIdentityId";
  IF identity_row."id" IS NULL OR identity_row."companyId" <> NEW."companyId" OR identity_row."supplierId" <> NEW."supplierId"
    OR identity_row."supplierInvoiceNumberNormalized" <> NEW."supplierInvoiceNumberNormalized"
  THEN RAISE EXCEPTION 'PURCHASE_DOCUMENT_IDENTITY_MISMATCH' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM "purchase_invoices" invoice WHERE invoice."documentIdentityId" = NEW."documentIdentityId")
    AND NOT EXISTS (SELECT 1 FROM "purchase_correction_operations" operation JOIN "purchase_invoices" source ON source."id" = operation."sourcePurchaseInvoiceId"
      WHERE operation."mode" = 'REPLACE' AND operation."replacementPurchaseInvoiceId" = NEW."id" AND source."documentIdentityId" = NEW."documentIdentityId")
  THEN RAISE EXCEPTION 'PURCHASE_DOCUMENT_IDENTITY_REUSE_FORBIDDEN' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_purchase_document_identity_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF EXISTS (SELECT 1 FROM "purchase_invoices" invoice WHERE invoice."documentIdentityId" = OLD."id" AND invoice."status" <> 'DRAFT')
    OR (SELECT count(*) FROM "purchase_invoices" invoice WHERE invoice."documentIdentityId" = OLD."id") > 1
    OR NEW."companyId" IS DISTINCT FROM OLD."companyId" OR NEW."supplierId" IS DISTINCT FROM OLD."supplierId"
  THEN RAISE EXCEPTION 'PURCHASE_DOCUMENT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "purchase_document_identity_change_guard" BEFORE UPDATE OR DELETE ON "purchase_supplier_document_identities"
FOR EACH ROW EXECUTE FUNCTION protect_purchase_document_identity_change();

CREATE FUNCTION validate_purchase_document_identity_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "purchase_invoices" invoice WHERE invoice."documentIdentityId" = NEW."id"
    AND (invoice."companyId" <> NEW."companyId" OR invoice."supplierId" <> NEW."supplierId" OR invoice."supplierInvoiceNumberNormalized" <> NEW."supplierInvoiceNumberNormalized"))
  THEN RAISE EXCEPTION 'PURCHASE_DOCUMENT_IDENTITY_MISMATCH' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "purchase_document_identity_consistency" AFTER UPDATE ON "purchase_supplier_document_identities"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_purchase_document_identity_consistency();

CREATE OR REPLACE FUNCTION prevent_registered_purchase_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid_rectification BOOLEAN; valid_correction BOOLEAN; valid_replacement BOOLEAN;
BEGIN
  IF OLD."status" = 'DRAFT' THEN
    IF NEW."status" NOT IN ('DRAFT', 'REGISTERED') THEN RAISE EXCEPTION 'INVALID_PURCHASE_STATUS_TRANSITION' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  valid_rectification := OLD."status" = 'REGISTERED' AND NEW."status" = 'RECTIFIED' AND OLD."documentType" = 'STANDARD'
    AND ((OLD."paymentStatus" = 'PENDING' AND NEW."paymentStatus" = 'NOT_APPLICABLE') OR (OLD."paymentStatus" = 'PAID' AND NEW."paymentStatus" = 'PAID'))
    AND EXISTS (SELECT 1 FROM "purchase_invoices" r WHERE r."rectifiesPurchaseInvoiceId" = OLD."id" AND r."documentType" = 'RECTIFICATION' AND r."status" = 'REGISTERED');
  valid_correction := OLD."status" = 'REGISTERED' AND NEW."status" = 'VOIDED' AND OLD."documentType" = 'STANDARD'
    AND OLD."paymentStatus" = 'PENDING' AND NEW."paymentStatus" = 'NOT_APPLICABLE' AND NEW."version" = OLD."version" + 1
    AND EXISTS (SELECT 1 FROM "purchase_correction_operations" operation WHERE operation."sourcePurchaseInvoiceId" = OLD."id" AND operation."mode" = 'VOID');
  valid_replacement := OLD."status" = 'REGISTERED' AND NEW."status" = 'SUPERSEDED' AND OLD."documentType" = 'STANDARD'
    AND OLD."paymentStatus" = 'PENDING' AND NEW."paymentStatus" = 'NOT_APPLICABLE' AND NEW."version" = OLD."version" + 1
    AND EXISTS (SELECT 1 FROM "purchase_correction_operations" operation WHERE operation."sourcePurchaseInvoiceId" = OLD."id" AND operation."mode" = 'REPLACE');
  IF NOT valid_rectification AND NOT valid_correction AND NOT valid_replacement AND NEW."status" <> OLD."status" THEN RAISE EXCEPTION 'REGISTERED_PURCHASE_IMMUTABLE' USING ERRCODE = '23514'; END IF;
  IF NOT valid_rectification AND NOT valid_correction AND NOT valid_replacement AND NOT (
    (OLD."paymentStatus" = 'PENDING' AND NEW."paymentStatus" IN ('PENDING', 'PARTIALLY_PAID', 'PAID', 'PARTIALLY_SETTLED', 'SETTLED'))
    OR (OLD."paymentStatus" = 'PARTIALLY_PAID' AND NEW."paymentStatus" IN ('PARTIALLY_PAID', 'PAID', 'PARTIALLY_SETTLED', 'SETTLED'))
    OR (OLD."paymentStatus" = 'PARTIALLY_SETTLED' AND NEW."paymentStatus" IN ('PARTIALLY_SETTLED', 'SETTLED'))
    OR (OLD."paymentStatus" IN ('PAID', 'SETTLED', 'NOT_APPLICABLE') AND NEW."paymentStatus" = OLD."paymentStatus")
  ) THEN RAISE EXCEPTION 'INVALID_PURCHASE_PAYMENT_STATUS_TRANSITION' USING ERRCODE = '23514'; END IF;
  IF NEW."companyId" IS DISTINCT FROM OLD."companyId" OR NEW."supplierId" IS DISTINCT FROM OLD."supplierId" OR NEW."documentIdentityId" IS DISTINCT FROM OLD."documentIdentityId"
    OR NEW."supplierCodeSnapshot" IS DISTINCT FROM OLD."supplierCodeSnapshot" OR NEW."supplierAccountingCodeSnapshot" IS DISTINCT FROM OLD."supplierAccountingCodeSnapshot"
    OR NEW."supplierLegalNameSnapshot" IS DISTINCT FROM OLD."supplierLegalNameSnapshot" OR NEW."supplierTaxIdLast4Snapshot" IS DISTINCT FROM OLD."supplierTaxIdLast4Snapshot"
    OR NEW."supplierTaxIdEncryptedSnapshot" IS DISTINCT FROM OLD."supplierTaxIdEncryptedSnapshot" OR NEW."supplierInvoiceNumber" IS DISTINCT FROM OLD."supplierInvoiceNumber"
    OR NEW."supplierInvoiceNumberNormalized" IS DISTINCT FROM OLD."supplierInvoiceNumberNormalized" OR NEW."documentType" IS DISTINCT FROM OLD."documentType"
    OR NEW."rectifiesPurchaseInvoiceId" IS DISTINCT FROM OLD."rectifiesPurchaseInvoiceId" OR NEW."rectificationReason" IS DISTINCT FROM OLD."rectificationReason"
    OR NEW."issueDate" IS DISTINCT FROM OLD."issueDate" OR NEW."receivedDate" IS DISTINCT FROM OLD."receivedDate" OR NEW."operationDate" IS DISTINCT FROM OLD."operationDate"
    OR NEW."accountingDate" IS DISTINCT FROM OLD."accountingDate" OR NEW."subtotal" IS DISTINCT FROM OLD."subtotal" OR NEW."discountTotal" IS DISTINCT FROM OLD."discountTotal"
    OR NEW."taxableBase" IS DISTINCT FROM OLD."taxableBase" OR NEW."taxAmount" IS DISTINCT FROM OLD."taxAmount" OR NEW."total" IS DISTINCT FROM OLD."total"
    OR NEW."notes" IS DISTINCT FROM OLD."notes" OR NEW."registeredAt" IS DISTINCT FROM OLD."registeredAt" OR NEW."registeredById" IS DISTINCT FROM OLD."registeredById"
    OR NEW."createdById" IS DISTINCT FROM OLD."createdById" OR (NOT valid_correction AND NOT valid_replacement AND NEW."version" IS DISTINCT FROM OLD."version")
  THEN RAISE EXCEPTION 'REGISTERED_PURCHASE_IMMUTABLE' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_purchase_correction_operation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_row "purchase_invoices"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'PURCHASE_CORRECTION_OPERATION_APPEND_ONLY' USING ERRCODE = '23514'; END IF;
  SELECT * INTO source_row FROM "purchase_invoices" WHERE "id" = NEW."sourcePurchaseInvoiceId" FOR UPDATE;
  IF source_row."id" IS NULL OR source_row."companyId" <> NEW."companyId" OR source_row."documentType" <> 'STANDARD'
    OR source_row."status" <> 'REGISTERED' OR source_row."paymentStatus" <> 'PENDING' OR source_row."version" <> NEW."sourceVersion"
    OR NEW."accountingDate" < source_row."accountingDate" OR EXISTS (SELECT 1 FROM "purchase_invoices" WHERE "rectifiesPurchaseInvoiceId" = source_row."id")
    OR EXISTS (SELECT 1 FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = source_row."id" AND "status" <> 'PENDING')
    OR EXISTS (SELECT 1 FROM "supplier_payment_allocations" WHERE "purchaseInvoiceId" = source_row."id")
    OR EXISTS (SELECT 1 FROM "supplier_credit_applications" WHERE "targetPurchaseInvoiceId" = source_row."id")
  THEN RAISE EXCEPTION 'PURCHASE_CORRECTION_SOURCE_NOT_ELIGIBLE' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_purchase_correction_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE operation_id UUID; operation_row "purchase_correction_operations"%ROWTYPE; source_row "purchase_invoices"%ROWTYPE; replacement_row "purchase_invoices"%ROWTYPE;
  source_entry "accounting_journal_entries"%ROWTYPE; reversal_entry "accounting_journal_entries"%ROWTYPE; replacement_entry "accounting_journal_entries"%ROWTYPE;
  fiscal_row "accounting_fiscal_years"%ROWTYPE; mismatch_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'purchase_correction_operations' THEN operation_id := NEW."id";
  ELSIF TG_TABLE_NAME = 'accounting_journal_entries' THEN operation_id := NEW."purchaseCorrectionOperationId";
  ELSIF TG_TABLE_NAME = 'purchase_vat_records' THEN operation_id := NEW."correctionOperationId";
  ELSIF TG_TABLE_NAME = 'catalog_stock_movements' THEN operation_id := NEW."purchaseCorrectionOperationId";
  ELSIF TG_TABLE_NAME = 'purchase_invoices' THEN SELECT "id" INTO operation_id FROM "purchase_correction_operations" WHERE "sourcePurchaseInvoiceId" = NEW."id";
  ELSE SELECT "id" INTO operation_id FROM "purchase_correction_operations" WHERE "sourcePurchaseInvoiceId" = COALESCE(NEW."purchaseInvoiceId", OLD."purchaseInvoiceId"); END IF;
  IF operation_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO operation_row FROM "purchase_correction_operations" WHERE "id" = operation_id;
  SELECT * INTO source_row FROM "purchase_invoices" WHERE "id" = operation_row."sourcePurchaseInvoiceId";
  SELECT * INTO replacement_row FROM "purchase_invoices" WHERE "id" = operation_row."replacementPurchaseInvoiceId";
  SELECT * INTO source_entry FROM "accounting_journal_entries" WHERE "purchaseInvoiceId" = source_row."id" AND "origin" = 'PURCHASE_INVOICE';
  SELECT * INTO reversal_entry FROM "accounting_journal_entries" WHERE "purchaseCorrectionOperationId" = operation_id;
  SELECT * INTO replacement_entry FROM "accounting_journal_entries" WHERE "purchaseInvoiceId" = replacement_row."id" AND "origin" = 'PURCHASE_INVOICE';
  SELECT * INTO fiscal_row FROM "accounting_fiscal_years" WHERE "id" = source_entry."fiscalYearId";
  IF source_row."version" <> operation_row."sourceVersion" + 1 OR source_entry."status" <> 'POSTED' OR reversal_entry."id" IS NULL
    OR reversal_entry."origin" <> 'PURCHASE_CORRECTION_REVERSAL' OR reversal_entry."reversesEntryId" <> source_entry."id" OR reversal_entry."status" <> 'POSTED'
    OR reversal_entry."fiscalYearId" <> source_entry."fiscalYearId" OR fiscal_row."status" <> 'OPEN' OR fiscal_row."companyId" <> operation_row."companyId"
    OR operation_row."accountingDate" < source_row."accountingDate" OR operation_row."accountingDate" < fiscal_row."startDate" OR operation_row."accountingDate" > fiscal_row."endDate"
    OR reversal_entry."accountingDate" <> operation_row."accountingDate" OR reversal_entry."totalDebit" <> source_entry."totalCredit" OR reversal_entry."totalCredit" <> source_entry."totalDebit"
    OR EXISTS (SELECT 1 FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = source_row."id" AND "status" <> 'CANCELLED')
  THEN RAISE EXCEPTION 'PURCHASE_CORRECTION_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
  IF operation_row."mode" = 'VOID' THEN
    IF source_row."status" <> 'VOIDED' OR source_row."paymentStatus" <> 'NOT_APPLICABLE' OR operation_row."replacementPurchaseInvoiceId" IS NOT NULL
    THEN RAISE EXCEPTION 'PURCHASE_CORRECTION_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
  ELSE
    IF source_row."status" <> 'SUPERSEDED' OR source_row."paymentStatus" <> 'NOT_APPLICABLE' OR replacement_row."id" IS NULL
      OR replacement_row."companyId" <> source_row."companyId" OR replacement_row."supplierId" <> source_row."supplierId"
      OR replacement_row."documentIdentityId" <> source_row."documentIdentityId" OR replacement_row."supplierInvoiceNumberNormalized" <> source_row."supplierInvoiceNumberNormalized"
      OR replacement_row."supplierInvoiceNumber" <> source_row."supplierInvoiceNumber" OR replacement_row."accountingDate" <> operation_row."accountingDate"
      OR replacement_row."documentType" <> 'STANDARD' OR replacement_row."status" <> 'REGISTERED' OR replacement_row."paymentStatus" <> 'PENDING' OR replacement_row."version" <> 2
      OR replacement_entry."id" IS NULL OR replacement_entry."status" <> 'POSTED' OR replacement_entry."fiscalYearId" <> source_entry."fiscalYearId"
      OR replacement_entry."accountingDate" <> operation_row."accountingDate" OR replacement_entry."totalDebit" <> replacement_row."total" OR replacement_entry."totalCredit" <> replacement_row."total"
      OR EXISTS (SELECT 1 FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = replacement_row."id" AND "status" <> 'PENDING')
      OR (SELECT COALESCE(sum("amount"), 0) FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = replacement_row."id") <> replacement_row."total"
      OR EXISTS (SELECT 1 FROM "supplier_payment_allocations" WHERE "purchaseInvoiceId" IN (source_row."id", replacement_row."id"))
      OR EXISTS (SELECT 1 FROM "supplier_credit_applications" WHERE "targetPurchaseInvoiceId" IN (source_row."id", replacement_row."id"))
    THEN RAISE EXCEPTION 'PURCHASE_REPLACEMENT_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
  END IF;
  SELECT count(*) INTO mismatch_count FROM (
    SELECT COALESCE(source."position", reversal."position") FROM
      (SELECT "position", "accountId", "debit", "credit" FROM "accounting_journal_lines" WHERE "entryId" = source_entry."id") source
      FULL JOIN (SELECT "position", "accountId", "debit", "credit" FROM "accounting_journal_lines" WHERE "entryId" = reversal_entry."id") reversal USING ("position")
    WHERE source."position" IS NULL OR reversal."position" IS NULL OR source."accountId" <> reversal."accountId" OR source."debit" <> reversal."credit" OR source."credit" <> reversal."debit"
  ) differences;
  IF operation_row."mode" = 'REPLACE' THEN
    IF mismatch_count <> 0 THEN RAISE EXCEPTION 'PURCHASE_CORRECTION_EFFECTS_MISMATCH' USING ERRCODE = '23514'; END IF;
    SELECT count(*) INTO mismatch_count FROM (
      WITH expected_raw AS (
        SELECT line."purchaseAccountCode" AS code, sum(line."lineTaxableBase") AS debit, 0::numeric AS credit
          FROM "purchase_invoice_lines" line WHERE line."purchaseInvoiceId" = replacement_row."id" GROUP BY line."purchaseAccountCode"
        UNION ALL SELECT '472000000', replacement_row."taxAmount", 0::numeric WHERE replacement_row."taxAmount" <> 0
        UNION ALL SELECT replacement_row."supplierAccountingCodeSnapshot", 0::numeric, replacement_row."total"
      ), expected AS (SELECT code, sum(debit) AS debit, sum(credit) AS credit FROM expected_raw GROUP BY code),
      actual AS (SELECT account."code" AS code, sum(line."debit") AS debit, sum(line."credit") AS credit
        FROM "accounting_journal_lines" line JOIN "accounting_accounts" account ON account."id" = line."accountId"
        WHERE line."entryId" = replacement_entry."id" GROUP BY account."code")
      SELECT COALESCE(expected.code, actual.code) FROM expected FULL JOIN actual USING (code)
      WHERE expected.code IS NULL OR actual.code IS NULL OR expected.debit <> actual.debit OR expected.credit <> actual.credit
    ) differences;
    IF mismatch_count <> 0 THEN RAISE EXCEPTION 'PURCHASE_REPLACEMENT_ACCOUNTING_MISMATCH' USING ERRCODE = '23514'; END IF;
    SELECT count(*) INTO mismatch_count FROM (
      WITH expected AS (SELECT line."taxRateCodeSnapshot" AS code, line."taxRateSnapshot" AS rate, sum(line."lineTaxableBase") AS base,
        sum(line."lineTaxAmount") AS tax, sum(line."lineTotal") AS total FROM "purchase_invoice_lines" line
        WHERE line."purchaseInvoiceId" = replacement_row."id" GROUP BY line."taxRateCodeSnapshot", line."taxRateSnapshot"),
      actual AS (SELECT summary."taxRateCode" AS code, summary."taxRate" AS rate, summary."taxableBase" AS base,
        summary."taxAmount" AS tax, summary."total" FROM "purchase_invoice_tax_summaries" summary WHERE summary."purchaseInvoiceId" = replacement_row."id")
      SELECT COALESCE(expected.code, actual.code) FROM expected FULL JOIN actual USING (code, rate)
      WHERE expected.code IS NULL OR actual.code IS NULL OR expected.base <> actual.base OR expected.tax <> actual.tax OR expected.total <> actual.total
    ) differences;
    IF mismatch_count <> 0 THEN RAISE EXCEPTION 'PURCHASE_REPLACEMENT_TAX_SUMMARY_MISMATCH' USING ERRCODE = '23514'; END IF;
  END IF;
  IF mismatch_count <> 0
    OR EXISTS (SELECT 1 FROM "purchase_vat_records" source WHERE source."purchaseInvoiceId" = source_row."id" AND source."kind" = 'DOCUMENT'
      AND NOT EXISTS (SELECT 1 FROM "purchase_vat_records" reversal WHERE reversal."reversesVatRecordId" = source."id" AND reversal."correctionOperationId" = operation_id AND reversal."kind" = 'INTERNAL_CORRECTION_REVERSAL' AND reversal."status" = 'ACTIVE'))
    OR EXISTS (SELECT 1 FROM "catalog_stock_movements" source JOIN "purchase_invoice_lines" line ON line."id" = source."purchaseInvoiceLineId"
      WHERE line."purchaseInvoiceId" = source_row."id" AND source."type" = 'PURCHASE_RECEIPT' AND NOT EXISTS (SELECT 1 FROM "catalog_stock_movements" reversal
        WHERE reversal."reversesMovementId" = source."id" AND reversal."purchaseCorrectionOperationId" = operation_id AND reversal."type" = 'PURCHASE_INTERNAL_REVERSAL'))
    OR (operation_row."mode" = 'REPLACE' AND EXISTS (SELECT 1 FROM "purchase_invoice_tax_summaries" summary WHERE summary."purchaseInvoiceId" = replacement_row."id"
      AND NOT EXISTS (SELECT 1 FROM "purchase_vat_records" vat WHERE vat."taxSummaryId" = summary."id" AND vat."kind" = 'DOCUMENT' AND vat."status" = 'ACTIVE')))
    OR (operation_row."mode" = 'REPLACE' AND EXISTS (SELECT 1 FROM "purchase_invoice_lines" line JOIN "catalog_items" item ON item."id" = line."catalogItemId"
      WHERE line."purchaseInvoiceId" = replacement_row."id" AND item."kind" = 'PRODUCT' AND item."stockTracked" = TRUE
        AND NOT EXISTS (SELECT 1 FROM "catalog_stock_movements" movement WHERE movement."purchaseInvoiceLineId" = line."id" AND movement."type" = 'PURCHASE_RECEIPT')))
  THEN RAISE EXCEPTION 'PURCHASE_CORRECTION_EFFECTS_MISMATCH' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER "purchase_correction_consistency_invoice" ON "purchase_invoices";
CREATE CONSTRAINT TRIGGER "purchase_correction_consistency_invoice" AFTER INSERT OR UPDATE ON "purchase_invoices" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_purchase_correction_consistency();
DROP TRIGGER "purchase_correction_consistency_due" ON "purchase_due_dates";
CREATE CONSTRAINT TRIGGER "purchase_correction_consistency_due" AFTER INSERT OR UPDATE ON "purchase_due_dates" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_purchase_correction_consistency();
