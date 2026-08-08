BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "purchase_invoices"
    WHERE ("documentType" = 'RECTIFICATION' AND "rectificationMode" IS DISTINCT FROM 'FULL')
      OR ("documentType" = 'STANDARD' AND "rectificationMode" IS NOT NULL)
  )
  THEN
    RAISE EXCEPTION 'PURCHASE_RECTIFICATION_MODE_BACKFILL_MISMATCH' USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE "purchase_invoice_lines" ADD COLUMN "sourcePurchaseInvoiceLineId" UUID;
ALTER TABLE "catalog_stock_movements" ADD COLUMN "sourceMovementId" UUID;
ALTER TABLE "accounting_journal_entries" ADD COLUMN "adjustsEntryId" UUID;

ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_sourcePurchaseInvoiceLineId_fkey"
  FOREIGN KEY ("sourcePurchaseInvoiceLineId") REFERENCES "purchase_invoice_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "catalog_stock_movements" ADD CONSTRAINT "catalog_stock_movements_sourceMovementId_fkey"
  FOREIGN KEY ("sourceMovementId") REFERENCES "catalog_stock_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounting_journal_entries" ADD CONSTRAINT "accounting_journal_entries_adjustsEntryId_fkey"
  FOREIGN KEY ("adjustsEntryId") REFERENCES "accounting_journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "purchase_invoice_lines_sourcePurchaseInvoiceLineId_idx" ON "purchase_invoice_lines"("sourcePurchaseInvoiceLineId");
CREATE UNIQUE INDEX "purchase_invoice_lines_partial_source_key"
  ON "purchase_invoice_lines"("purchaseInvoiceId", "sourcePurchaseInvoiceLineId");
CREATE INDEX "catalog_stock_movements_sourceMovementId_idx" ON "catalog_stock_movements"("sourceMovementId");
CREATE INDEX "accounting_journal_entries_adjustsEntryId_idx" ON "accounting_journal_entries"("adjustsEntryId");
ALTER TABLE "accounting_journal_entries" ADD CONSTRAINT "accounting_journal_entries_adjustment_origin_check"
  CHECK ("adjustsEntryId" IS NULL OR "origin" = 'PURCHASE_RECTIFICATION');

ALTER TABLE "catalog_stock_movements" DROP CONSTRAINT "catalog_stock_movements_purchase_source_check";
ALTER TABLE "catalog_stock_movements" ADD CONSTRAINT "catalog_stock_movements_purchase_source_check" CHECK (
  ("type" = 'PURCHASE_RECEIPT' AND "purchaseInvoiceLineId" IS NOT NULL AND "reversesMovementId" IS NULL AND "sourceMovementId" IS NULL AND "purchaseCorrectionOperationId" IS NULL)
  OR ("type" = 'PURCHASE_RETURN' AND "purchaseInvoiceLineId" IS NOT NULL AND (("reversesMovementId" IS NOT NULL AND "sourceMovementId" IS NULL) OR ("reversesMovementId" IS NULL AND "sourceMovementId" IS NOT NULL)) AND "purchaseCorrectionOperationId" IS NULL)
  OR ("type" = 'PURCHASE_INTERNAL_REVERSAL' AND "purchaseInvoiceLineId" IS NULL AND "reversesMovementId" IS NOT NULL AND "sourceMovementId" IS NULL AND "purchaseCorrectionOperationId" IS NOT NULL)
  OR ("type" NOT IN ('PURCHASE_RECEIPT', 'PURCHASE_RETURN', 'PURCHASE_INTERNAL_REVERSAL') AND "purchaseInvoiceLineId" IS NULL AND "reversesMovementId" IS NULL AND "sourceMovementId" IS NULL AND "purchaseCorrectionOperationId" IS NULL)
);

DROP INDEX "purchase_invoices_single_full_rectification_key";
CREATE UNIQUE INDEX "purchase_invoices_single_full_rectification_key"
  ON "purchase_invoices"("rectifiesPurchaseInvoiceId")
  WHERE "rectifiesPurchaseInvoiceId" IS NOT NULL AND "rectificationMode" = 'FULL';
CREATE UNIQUE INDEX "purchase_invoices_partial_source_version_key"
  ON "purchase_invoices"("rectifiesPurchaseInvoiceId", "rectifiesPurchaseVersion");

ALTER TABLE "purchase_invoices" DROP CONSTRAINT "purchase_invoices_rectification_shape_check";
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_rectification_shape_check" CHECK (
  ("documentType" = 'STANDARD' AND "rectifiesPurchaseInvoiceId" IS NULL AND "rectificationReason" IS NULL AND "rectificationMode" IS NULL AND "rectifiesPurchaseVersion" IS NULL)
  OR ("documentType" = 'RECTIFICATION' AND "rectifiesPurchaseInvoiceId" IS NOT NULL AND "rectificationMode" = 'FULL' AND "rectificationReason" IN ('RETURN', 'OPERATION_CANCELLED') AND "rectifiesPurchaseVersion" IS NULL)
  OR ("documentType" = 'RECTIFICATION' AND "rectifiesPurchaseInvoiceId" IS NOT NULL AND "rectificationMode" = 'PARTIAL' AND "rectificationReason" = 'RETURN' AND "rectifiesPurchaseVersion" IS NOT NULL AND "rectifiesPurchaseVersion" > 0)
);

DO $migration$
DECLARE definition TEXT; changed TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid = 'accounting_journal_entries'::regclass AND conname = 'accounting_journal_entries_origin_source_check';
  changed := replace(definition,
    '((origin = ''PURCHASE_RECTIFICATION''::"AccountingEntryOrigin") AND ("purchaseInvoiceId" IS NOT NULL) AND ("supplierPaymentId" IS NULL) AND ("supplierCreditRefundId" IS NULL) AND ("invoiceId" IS NULL) AND ("customerPaymentId" IS NULL) AND ("customerPaymentReturnId" IS NULL) AND ("customerCreditRefundId" IS NULL) AND ("voidsInvoiceId" IS NULL) AND ("reversesEntryId" IS NOT NULL) AND ("waiverReviewId" IS NULL))',
    '((origin = ''PURCHASE_RECTIFICATION''::"AccountingEntryOrigin") AND ("purchaseInvoiceId" IS NOT NULL) AND ("supplierPaymentId" IS NULL) AND ("supplierCreditRefundId" IS NULL) AND ("invoiceId" IS NULL) AND ("customerPaymentId" IS NULL) AND ("customerPaymentReturnId" IS NULL) AND ("customerCreditRefundId" IS NULL) AND ("voidsInvoiceId" IS NULL) AND ((("reversesEntryId" IS NOT NULL) AND ("adjustsEntryId" IS NULL)) OR (("reversesEntryId" IS NULL) AND ("adjustsEntryId" IS NOT NULL))) AND ("waiverReviewId" IS NULL))');
  IF changed = definition THEN RAISE EXCEPTION 'Could not patch purchase rectification accounting source'; END IF;
  ALTER TABLE "accounting_journal_entries" DROP CONSTRAINT "accounting_journal_entries_origin_source_check";
  EXECUTE 'ALTER TABLE "accounting_journal_entries" ADD CONSTRAINT "accounting_journal_entries_origin_source_check" ' || changed;
END;
$migration$;

CREATE OR REPLACE FUNCTION prevent_registered_purchase_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid_rectification BOOLEAN; valid_correction BOOLEAN; valid_replacement BOOLEAN; valid_partial_version BOOLEAN;
BEGIN
  IF OLD."status" = 'DRAFT' THEN
    IF NEW."status" NOT IN ('DRAFT', 'REGISTERED') THEN RAISE EXCEPTION 'INVALID_PURCHASE_STATUS_TRANSITION' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  valid_rectification := OLD."status" = 'REGISTERED' AND NEW."status" = 'RECTIFIED' AND OLD."documentType" = 'STANDARD'
    AND ((OLD."paymentStatus" = 'PENDING' AND NEW."paymentStatus" = 'NOT_APPLICABLE') OR (OLD."paymentStatus" = 'PAID' AND NEW."paymentStatus" = 'PAID') OR NEW."paymentStatus" = 'SETTLED')
    AND EXISTS (SELECT 1 FROM "purchase_invoices" r WHERE r."rectifiesPurchaseInvoiceId" = OLD."id" AND r."documentType" = 'RECTIFICATION' AND r."status" = 'REGISTERED'
      AND (r."rectificationMode" = 'FULL' OR (r."rectificationMode" = 'PARTIAL' AND r."rectifiesPurchaseVersion" = OLD."version" AND NEW."version" = OLD."version" + 1
        AND NOT EXISTS (SELECT 1 FROM "purchase_invoice_lines" source WHERE source."purchaseInvoiceId" = OLD."id" AND
          COALESCE((SELECT SUM(abs(partial_line."quantity")) FROM "purchase_invoice_lines" partial_line JOIN "purchase_invoices" partial ON partial."id" = partial_line."purchaseInvoiceId"
            WHERE partial_line."sourcePurchaseInvoiceLineId" = source."id" AND partial."status" = 'REGISTERED' AND partial."rectificationMode" = 'PARTIAL'), 0) <> source."quantity"))));
  valid_correction := OLD."status" = 'REGISTERED' AND NEW."status" = 'VOIDED' AND OLD."documentType" = 'STANDARD'
    AND OLD."paymentStatus" = 'PENDING' AND NEW."paymentStatus" = 'NOT_APPLICABLE' AND NEW."version" = OLD."version" + 1
    AND EXISTS (SELECT 1 FROM "purchase_correction_operations" operation WHERE operation."sourcePurchaseInvoiceId" = OLD."id" AND operation."mode" = 'VOID');
  valid_replacement := OLD."status" = 'REGISTERED' AND NEW."status" = 'SUPERSEDED' AND OLD."documentType" = 'STANDARD'
    AND OLD."paymentStatus" = 'PENDING' AND NEW."paymentStatus" = 'NOT_APPLICABLE' AND NEW."version" = OLD."version" + 1
    AND EXISTS (SELECT 1 FROM "purchase_correction_operations" operation WHERE operation."sourcePurchaseInvoiceId" = OLD."id" AND operation."mode" = 'REPLACE');
  valid_partial_version := (OLD."status" = NEW."status" OR valid_rectification) AND OLD."documentType" = 'STANDARD' AND NEW."version" = OLD."version" + 1
    AND EXISTS (SELECT 1 FROM "purchase_invoices" r WHERE r."rectifiesPurchaseInvoiceId" = OLD."id" AND r."status" = 'REGISTERED' AND r."rectificationMode" = 'PARTIAL' AND r."rectifiesPurchaseVersion" = OLD."version");
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
    OR NEW."rectifiesPurchaseInvoiceId" IS DISTINCT FROM OLD."rectifiesPurchaseInvoiceId" OR NEW."rectifiesPurchaseVersion" IS DISTINCT FROM OLD."rectifiesPurchaseVersion" OR NEW."rectificationReason" IS DISTINCT FROM OLD."rectificationReason"
    OR NEW."rectificationMode" IS DISTINCT FROM OLD."rectificationMode" OR NEW."issueDate" IS DISTINCT FROM OLD."issueDate" OR NEW."receivedDate" IS DISTINCT FROM OLD."receivedDate"
    OR NEW."operationDate" IS DISTINCT FROM OLD."operationDate" OR NEW."accountingDate" IS DISTINCT FROM OLD."accountingDate" OR NEW."subtotal" IS DISTINCT FROM OLD."subtotal"
    OR NEW."discountTotal" IS DISTINCT FROM OLD."discountTotal" OR NEW."taxableBase" IS DISTINCT FROM OLD."taxableBase" OR NEW."taxAmount" IS DISTINCT FROM OLD."taxAmount"
    OR NEW."total" IS DISTINCT FROM OLD."total" OR NEW."notes" IS DISTINCT FROM OLD."notes" OR NEW."registeredAt" IS DISTINCT FROM OLD."registeredAt"
    OR NEW."registeredById" IS DISTINCT FROM OLD."registeredById" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR (NOT valid_correction AND NOT valid_replacement AND NOT valid_partial_version AND NEW."version" IS DISTINCT FROM OLD."version")
  THEN RAISE EXCEPTION 'REGISTERED_PURCHASE_IMMUTABLE' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_supplier_credit_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_row "purchase_invoices"%ROWTYPE; original_row "purchase_invoices"%ROWTYPE; paid_amount NUMERIC;
BEGIN
  SELECT * INTO source_row FROM "purchase_invoices" WHERE "id" = NEW."sourceRectificationPurchaseInvoiceId" FOR SHARE;
  SELECT * INTO original_row FROM "purchase_invoices" WHERE "id" = source_row."rectifiesPurchaseInvoiceId" FOR SHARE;
  SELECT COALESCE(SUM(allocation."amount"), 0) INTO paid_amount FROM "supplier_payment_allocations" allocation
    JOIN "supplier_payments" payment ON payment."id" = allocation."supplierPaymentId"
    WHERE allocation."purchaseInvoiceId" = original_row."id" AND payment."status" = 'POSTED';
  IF source_row."id" IS NULL OR source_row."documentType" <> 'RECTIFICATION' OR source_row."status" <> 'REGISTERED' OR source_row."total" >= 0
     OR source_row."companyId" <> NEW."companyId" OR source_row."supplierId" <> NEW."supplierId" OR NEW."originalAmount" <> abs(source_row."total")
     OR original_row."id" IS NULL OR (
       source_row."rectificationMode" = 'FULL' AND (original_row."status" <> 'RECTIFIED' OR original_row."paymentStatus" <> 'PAID' OR paid_amount <> original_row."total"
         OR EXISTS (SELECT 1 FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = original_row."id" AND "status" <> 'PAID'))
     ) OR (source_row."rectificationMode" = 'PARTIAL' AND original_row."status" NOT IN ('REGISTERED', 'RECTIFIED')) THEN
    RAISE EXCEPTION 'INVALID_SUPPLIER_CREDIT_SOURCE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_purchase_stock_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_item UUID; purchase_type "PurchaseInvoiceDocumentType"; purchase_status "PurchaseInvoiceStatus"; rectification_mode "PurchaseRectificationMode";
  source_movement "catalog_stock_movements"%ROWTYPE; operation_source UUID; source_line UUID; returned_quantity NUMERIC;
BEGIN
  IF NEW."type" IN ('PURCHASE_RECEIPT', 'PURCHASE_RETURN') THEN
    SELECT line."catalogItemId", line."sourcePurchaseInvoiceLineId", purchase."documentType", purchase."status", purchase."rectificationMode"
      INTO line_item, source_line, purchase_type, purchase_status, rectification_mode
      FROM "purchase_invoice_lines" line JOIN "purchase_invoices" purchase ON purchase."id" = line."purchaseInvoiceId" WHERE line."id" = NEW."purchaseInvoiceLineId";
    IF line_item IS NULL OR line_item <> NEW."itemId" OR purchase_status <> 'DRAFT'
      OR (NEW."type" = 'PURCHASE_RECEIPT' AND purchase_type <> 'STANDARD') OR (NEW."type" = 'PURCHASE_RETURN' AND purchase_type <> 'RECTIFICATION')
    THEN RAISE EXCEPTION 'PURCHASE_STOCK_ITEM_MISMATCH' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW."type" IN ('PURCHASE_RETURN', 'PURCHASE_INTERNAL_REVERSAL') THEN
    SELECT * INTO source_movement FROM "catalog_stock_movements" WHERE "id" = COALESCE(NEW."reversesMovementId", NEW."sourceMovementId");
    IF source_movement."id" IS NULL OR source_movement."type" <> 'PURCHASE_RECEIPT' OR source_movement."itemId" <> NEW."itemId"
      OR (rectification_mode = 'FULL' AND (NEW."reversesMovementId" IS NULL OR source_movement."quantity" <> -NEW."quantity"))
      OR (rectification_mode = 'PARTIAL' AND (NEW."sourceMovementId" IS NULL OR NEW."reversesMovementId" IS NOT NULL OR source_movement."purchaseInvoiceLineId" <> source_line OR NEW."quantity" >= 0))
    THEN RAISE EXCEPTION 'PURCHASE_STOCK_REVERSAL_MISMATCH' USING ERRCODE = '23514'; END IF;
    IF rectification_mode = 'PARTIAL' THEN
      SELECT COALESCE(SUM(abs(movement."quantity")), 0) INTO returned_quantity FROM "catalog_stock_movements" movement
        JOIN "purchase_invoice_lines" line ON line."id" = movement."purchaseInvoiceLineId"
        JOIN "purchase_invoices" invoice ON invoice."id" = line."purchaseInvoiceId"
        WHERE movement."sourceMovementId" = source_movement."id" AND invoice."status" = 'REGISTERED';
      IF returned_quantity + abs(NEW."quantity") > source_movement."quantity" THEN RAISE EXCEPTION 'PURCHASE_STOCK_RETURN_EXCEEDS_RECEIPT' USING ERRCODE = '23514'; END IF;
    END IF;
  END IF;
  IF NEW."type" = 'PURCHASE_INTERNAL_REVERSAL' THEN
    SELECT "sourcePurchaseInvoiceId" INTO operation_source FROM "purchase_correction_operations" WHERE "id" = NEW."purchaseCorrectionOperationId";
    IF NOT EXISTS (SELECT 1 FROM "purchase_invoice_lines" line WHERE line."id" = source_movement."purchaseInvoiceLineId" AND line."purchaseInvoiceId" = operation_source)
    THEN RAISE EXCEPTION 'PURCHASE_STOCK_REVERSAL_SCOPE_MISMATCH' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

DO $migration$
DECLARE definition TEXT; changed TEXT;
BEGIN
  definition := pg_get_functiondef('validate_purchase_registration()'::regprocedure);
  changed := replace(definition, 'IF NEW."documentType" = ''RECTIFICATION'' THEN', 'IF NEW."documentType" = ''RECTIFICATION'' AND NEW."rectificationMode" = ''FULL'' THEN');
  IF changed = definition THEN RAISE EXCEPTION 'Could not scope full purchase registration'; END IF;
  EXECUTE changed;
END;
$migration$;

CREATE FUNCTION validate_partial_purchase_registration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original "purchase_invoices"%ROWTYPE; original_entry "accounting_journal_entries"%ROWTYPE; correction_entry "accounting_journal_entries"%ROWTYPE;
BEGIN
  IF NEW."status" <> 'REGISTERED' OR OLD."status" <> 'DRAFT' OR NEW."documentType" <> 'RECTIFICATION' OR NEW."rectificationMode" <> 'PARTIAL' THEN RETURN NEW; END IF;
  SELECT * INTO original FROM "purchase_invoices" WHERE "id" = NEW."rectifiesPurchaseInvoiceId" FOR UPDATE;
  IF original."id" IS NULL OR original."documentType" <> 'STANDARD' OR original."status" <> 'REGISTERED' OR NEW."paymentStatus" <> 'NOT_APPLICABLE' OR NEW."rectifiesPurchaseVersion" <> original."version"
    OR NEW."issueDate" < original."issueDate" OR NEW."accountingDate" < original."accountingDate" OR NEW."total" >= 0
    OR EXISTS (SELECT 1 FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = NEW."id")
    OR EXISTS (SELECT 1 FROM "purchase_invoices" WHERE "rectifiesPurchaseInvoiceId" = original."id" AND "status" = 'REGISTERED' AND "rectificationMode" = 'FULL') THEN
    RAISE EXCEPTION 'INVALID_PARTIAL_PURCHASE_RECTIFICATION' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "purchase_invoice_lines" correction
    LEFT JOIN "purchase_invoice_lines" source ON source."id" = correction."sourcePurchaseInvoiceLineId"
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(abs(previous."quantity")), 0) quantity, COALESCE(SUM(previous."discountAmount"), 0) discount_amount,
        COALESCE(SUM(abs(previous."lineSubtotal")), 0) subtotal, COALESCE(SUM(abs(previous."lineDiscountTotal")), 0) discount_total,
        COALESCE(SUM(abs(previous."lineTaxableBase")), 0) taxable_base, COALESCE(SUM(abs(previous."lineTaxAmount")), 0) tax_amount,
        COALESCE(SUM(abs(previous."lineTotal")), 0) total
      FROM "purchase_invoice_lines" previous JOIN "purchase_invoices" invoice ON invoice."id" = previous."purchaseInvoiceId"
      WHERE previous."sourcePurchaseInvoiceLineId" = source."id" AND invoice."status" = 'REGISTERED' AND invoice."rectificationMode" = 'PARTIAL'
    ) prior ON TRUE
    WHERE correction."purchaseInvoiceId" = NEW."id" AND (
      source."id" IS NULL OR source."purchaseInvoiceId" <> original."id" OR correction."quantity" >= 0
      OR abs(correction."quantity") > source."quantity" - prior.quantity
      OR correction."catalogItemId" IS DISTINCT FROM source."catalogItemId" OR correction."catalogItemCodeSnapshot" IS DISTINCT FROM source."catalogItemCodeSnapshot"
      OR correction."catalogItemKindSnapshot" IS DISTINCT FROM source."catalogItemKindSnapshot" OR correction."description" <> source."description"
      OR correction."unitPrice" <> source."unitPrice" OR correction."discountPercent" <> source."discountPercent"
      OR correction."purchaseAccountCode" <> source."purchaseAccountCode" OR correction."taxRateId" <> source."taxRateId"
      OR correction."taxRateCodeSnapshot" <> source."taxRateCodeSnapshot" OR correction."taxRateNameSnapshot" <> source."taxRateNameSnapshot"
      OR correction."taxRateSnapshot" <> source."taxRateSnapshot" OR correction."lineSubtotal" > 0 OR correction."lineDiscountTotal" > 0
      OR correction."lineTaxableBase" > 0 OR correction."lineTaxAmount" > 0 OR correction."lineTotal" >= 0
      OR correction."discountAmount" > source."discountAmount" - prior.discount_amount OR abs(correction."lineSubtotal") > source."lineSubtotal" - prior.subtotal
      OR abs(correction."lineDiscountTotal") > source."lineDiscountTotal" - prior.discount_total OR abs(correction."lineTaxableBase") > source."lineTaxableBase" - prior.taxable_base
      OR abs(correction."lineTaxAmount") > source."lineTaxAmount" - prior.tax_amount OR abs(correction."lineTotal") > source."lineTotal" - prior.total
      OR correction."discountAmount" <> CASE WHEN abs(correction."quantity") = source."quantity" - prior.quantity THEN source."discountAmount" - prior.discount_amount ELSE ROUND(source."discountAmount" * abs(correction."quantity") / source."quantity", 2) END
      OR abs(correction."lineSubtotal") <> CASE WHEN abs(correction."quantity") = source."quantity" - prior.quantity THEN source."lineSubtotal" - prior.subtotal ELSE ROUND(source."lineSubtotal" * abs(correction."quantity") / source."quantity", 2) END
      OR abs(correction."lineDiscountTotal") <> CASE WHEN abs(correction."quantity") = source."quantity" - prior.quantity THEN source."lineDiscountTotal" - prior.discount_total ELSE ROUND(source."lineDiscountTotal" * abs(correction."quantity") / source."quantity", 2) END
      OR abs(correction."lineTaxableBase") <> CASE WHEN abs(correction."quantity") = source."quantity" - prior.quantity THEN source."lineTaxableBase" - prior.taxable_base ELSE ROUND(source."lineTaxableBase" * abs(correction."quantity") / source."quantity", 2) END
      OR abs(correction."lineTaxAmount") <> CASE WHEN abs(correction."quantity") = source."quantity" - prior.quantity THEN source."lineTaxAmount" - prior.tax_amount ELSE ROUND(source."lineTaxAmount" * abs(correction."quantity") / source."quantity", 2) END
      OR abs(correction."lineTotal") <> CASE WHEN abs(correction."quantity") = source."quantity" - prior.quantity THEN source."lineTotal" - prior.total ELSE ROUND(source."lineTotal" * abs(correction."quantity") / source."quantity", 2) END
      OR (abs(correction."quantity") < source."quantity" - prior.quantity AND abs(correction."lineTotal") >= source."lineTotal" - prior.total)
    )
  ) THEN RAISE EXCEPTION 'PARTIAL_PURCHASE_RECTIFICATION_EXCEEDS_SOURCE' USING ERRCODE = '23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT line."taxRateCodeSnapshot" AS code, line."taxRateSnapshot" AS rate, SUM(line."lineTaxableBase") base, SUM(line."lineTaxAmount") tax, SUM(line."lineTotal") total
      FROM "purchase_invoice_lines" line WHERE line."purchaseInvoiceId" = NEW."id" GROUP BY line."taxRateCodeSnapshot", line."taxRateSnapshot"
    ) expected FULL JOIN (SELECT * FROM "purchase_invoice_tax_summaries" WHERE "purchaseInvoiceId" = NEW."id") summary
      ON summary."taxRateCode" = expected.code AND summary."taxRate" = expected.rate
    WHERE expected.code IS NULL OR summary."id" IS NULL OR summary."taxableBase" <> expected.base OR summary."taxAmount" <> expected.tax OR summary."total" <> expected.total
  ) THEN RAISE EXCEPTION 'PARTIAL_PURCHASE_RECTIFICATION_TAX_MISMATCH' USING ERRCODE = '23514'; END IF;
  SELECT * INTO original_entry FROM "accounting_journal_entries" WHERE "purchaseInvoiceId" = original."id" AND "origin" = 'PURCHASE_INVOICE';
  SELECT * INTO correction_entry FROM "accounting_journal_entries" WHERE "purchaseInvoiceId" = NEW."id" AND "origin" = 'PURCHASE_RECTIFICATION';
  IF original_entry."id" IS NULL OR correction_entry."id" IS NULL OR correction_entry."adjustsEntryId" <> original_entry."id" OR correction_entry."reversesEntryId" IS NOT NULL
    OR correction_entry."status" <> 'POSTED' OR correction_entry."fiscalYearId" <> original_entry."fiscalYearId"
    OR NOT EXISTS (SELECT 1 FROM "accounting_fiscal_years" WHERE "id" = original_entry."fiscalYearId" AND "status" = 'OPEN')
    OR correction_entry."totalDebit" <> abs(NEW."total") OR correction_entry."totalCredit" <> abs(NEW."total")
    OR EXISTS (
      WITH expected AS (
        SELECT original."supplierAccountingCodeSnapshot" AS code, abs(NEW."total") AS debit, 0::numeric AS credit
        UNION ALL SELECT line."purchaseAccountCode", 0, SUM(abs(line."lineTaxableBase")) FROM "purchase_invoice_lines" line WHERE line."purchaseInvoiceId" = NEW."id" GROUP BY line."purchaseAccountCode"
        UNION ALL SELECT '472000000', 0, abs(NEW."taxAmount") WHERE NEW."taxAmount" <> 0
      ), actual AS (
        SELECT account."code", SUM(line."debit") debit, SUM(line."credit") credit FROM "accounting_journal_lines" line JOIN "accounting_accounts" account ON account."id" = line."accountId" WHERE line."entryId" = correction_entry."id" GROUP BY account."code"
      ) SELECT 1 FROM expected FULL JOIN actual USING (code) WHERE expected.code IS NULL OR actual.code IS NULL OR expected.debit <> actual.debit OR expected.credit <> actual.credit
    ) OR (SELECT COUNT(*) FROM "purchase_vat_records" WHERE "purchaseInvoiceId" = NEW."id") <> (SELECT COUNT(*) FROM "purchase_invoice_tax_summaries" WHERE "purchaseInvoiceId" = NEW."id")
    OR EXISTS (
      SELECT 1 FROM "purchase_invoice_lines" correction JOIN "purchase_invoice_lines" source ON source."id" = correction."sourcePurchaseInvoiceLineId"
      JOIN "catalog_stock_movements" receipt ON receipt."purchaseInvoiceLineId" = source."id" AND receipt."type" = 'PURCHASE_RECEIPT'
      LEFT JOIN "catalog_stock_movements" movement ON movement."purchaseInvoiceLineId" = correction."id"
      WHERE correction."purchaseInvoiceId" = NEW."id" AND (movement."id" IS NULL OR movement."type" <> 'PURCHASE_RETURN' OR movement."sourceMovementId" <> receipt."id" OR movement."itemId" <> receipt."itemId" OR movement."quantity" <> correction."quantity")
    ) OR EXISTS (
      SELECT 1 FROM "catalog_stock_movements" movement JOIN "purchase_invoice_lines" correction ON correction."id" = movement."purchaseInvoiceLineId"
      WHERE correction."purchaseInvoiceId" = NEW."id" AND movement."type" = 'PURCHASE_RETURN' AND NOT EXISTS (
        SELECT 1 FROM "purchase_invoice_lines" source JOIN "catalog_stock_movements" receipt ON receipt."purchaseInvoiceLineId" = source."id"
        WHERE source."id" = correction."sourcePurchaseInvoiceLineId" AND receipt."id" = movement."sourceMovementId" AND receipt."type" = 'PURCHASE_RECEIPT'
      )
    ) THEN RAISE EXCEPTION 'INVALID_PARTIAL_PURCHASE_RECTIFICATION_EFFECTS' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "partial_purchase_registration_guard" BEFORE UPDATE ON "purchase_invoices" FOR EACH ROW EXECUTE FUNCTION validate_partial_purchase_registration();

CREATE OR REPLACE FUNCTION validate_purchase_rectification_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root_id UUID; original "purchase_invoices"%ROWTYPE; full_count INTEGER; partial_count INTEGER; partial_credit_count INTEGER; full_credit_count INTEGER;
  paid_amount NUMERIC; partial_total NUMERIC; partial_credit_total NUMERIC; self_application_total NUMERIC; external_credit_total NUMERIC; expected_self_application NUMERIC; partial_complete BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'purchase_due_dates' THEN root_id := COALESCE(NEW."purchaseInvoiceId", OLD."purchaseInvoiceId");
  ELSIF TG_TABLE_NAME = 'supplier_credits' THEN SELECT "rectifiesPurchaseInvoiceId" INTO root_id FROM "purchase_invoices" WHERE "id" = COALESCE(NEW."sourceRectificationPurchaseInvoiceId", OLD."sourceRectificationPurchaseInvoiceId");
  ELSE root_id := COALESCE(NEW."rectifiesPurchaseInvoiceId", NEW."id", OLD."rectifiesPurchaseInvoiceId", OLD."id"); END IF;
  SELECT * INTO original FROM "purchase_invoices" WHERE "id" = root_id;
  IF original."id" IS NULL OR original."documentType" <> 'STANDARD' THEN RETURN NULL; END IF;
  SELECT COUNT(*) FILTER (WHERE "rectificationMode" = 'FULL'), COUNT(*) FILTER (WHERE "rectificationMode" = 'PARTIAL'),
         COALESCE(SUM(abs("total")) FILTER (WHERE "rectificationMode" = 'PARTIAL'), 0)
    INTO full_count, partial_count, partial_total FROM "purchase_invoices" WHERE "rectifiesPurchaseInvoiceId" = root_id AND "documentType" = 'RECTIFICATION' AND "status" = 'REGISTERED';
  SELECT COUNT(*) FILTER (WHERE child."rectificationMode" = 'PARTIAL'), COUNT(*) FILTER (WHERE child."rectificationMode" = 'FULL'),
         COALESCE(SUM(credit."originalAmount") FILTER (WHERE child."rectificationMode" = 'PARTIAL'), 0)
    INTO partial_credit_count, full_credit_count, partial_credit_total FROM "supplier_credits" credit JOIN "purchase_invoices" child ON child."id" = credit."sourceRectificationPurchaseInvoiceId" WHERE child."rectifiesPurchaseInvoiceId" = root_id;
  SELECT COALESCE(SUM(allocation."amount"), 0) INTO paid_amount FROM "supplier_payment_allocations" allocation JOIN "supplier_payments" payment ON payment."id" = allocation."supplierPaymentId" WHERE allocation."purchaseInvoiceId" = root_id AND payment."status" = 'POSTED';
  SELECT COALESCE(SUM(application."amount"), 0) INTO self_application_total FROM "supplier_credit_applications" application
    JOIN "supplier_credits" credit ON credit."id" = application."creditId" JOIN "purchase_invoices" child ON child."id" = credit."sourceRectificationPurchaseInvoiceId"
    WHERE application."targetPurchaseInvoiceId" = root_id AND child."rectifiesPurchaseInvoiceId" = root_id AND child."rectificationMode" = 'PARTIAL';
  SELECT COALESCE(SUM(application."amount"), 0) INTO external_credit_total FROM "supplier_credit_applications" application
    JOIN "supplier_credits" credit ON credit."id" = application."creditId" JOIN "purchase_invoices" child ON child."id" = credit."sourceRectificationPurchaseInvoiceId"
    WHERE application."targetPurchaseInvoiceId" = root_id AND NOT (child."rectifiesPurchaseInvoiceId" = root_id AND child."rectificationMode" = 'PARTIAL');
  expected_self_application := LEAST(partial_credit_total, GREATEST(original."total" - paid_amount - external_credit_total, 0));
  SELECT NOT EXISTS (
    SELECT 1 FROM "purchase_invoice_lines" source WHERE source."purchaseInvoiceId" = root_id AND
      COALESCE((SELECT SUM(abs(partial_line."quantity")) FROM "purchase_invoice_lines" partial_line JOIN "purchase_invoices" partial ON partial."id" = partial_line."purchaseInvoiceId"
        WHERE partial_line."sourcePurchaseInvoiceLineId" = source."id" AND partial."status" = 'REGISTERED' AND partial."rectificationMode" = 'PARTIAL'), 0) <> source."quantity"
  ) AND partial_total = original."total" INTO partial_complete;
  IF full_count > 0 AND partial_count > 0 THEN RAISE EXCEPTION 'PURCHASE_RECTIFICATION_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
  IF full_count = 1 AND (original."status" <> 'RECTIFIED' OR NOT (
      (original."paymentStatus" = 'NOT_APPLICABLE' AND full_credit_count = 0 AND paid_amount = 0 AND NOT EXISTS (SELECT 1 FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = root_id AND "status" <> 'CANCELLED'))
      OR (original."paymentStatus" = 'PAID' AND full_credit_count = 1 AND paid_amount = original."total" AND NOT EXISTS (SELECT 1 FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = root_id AND "status" <> 'PAID'))
    )) THEN RAISE EXCEPTION 'PURCHASE_RECTIFICATION_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
  IF partial_count > 0 AND (partial_total > original."total" OR partial_credit_count <> partial_count OR self_application_total <> expected_self_application
    OR (partial_complete AND original."status" <> 'RECTIFIED') OR (NOT partial_complete AND original."status" <> 'REGISTERED'))
    THEN RAISE EXCEPTION 'PURCHASE_RECTIFICATION_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM "purchase_invoices" child WHERE child."rectifiesPurchaseInvoiceId" = root_id AND child."status" = 'REGISTERED'
    AND (child."paymentStatus" <> 'NOT_APPLICABLE' OR EXISTS (SELECT 1 FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = child."id")))
    THEN RAISE EXCEPTION 'PURCHASE_RECTIFICATION_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
  IF original."status" = 'RECTIFIED' AND full_count = 0 AND NOT partial_complete THEN RAISE EXCEPTION 'PURCHASE_RECTIFICATION_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION validate_supplier_purchase_settlement_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purchase_id UUID; purchase_row "purchase_invoices"%ROWTYPE; due_row RECORD; cash_total NUMERIC := 0; credit_total NUMERIC := 0; due_cash NUMERIC; due_credit NUMERIC; expected_due "PurchaseDueDateStatus"; expected_purchase "PurchasePaymentStatus"; has_full_rectification BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'purchase_invoices' THEN purchase_id := COALESCE(NEW."id", OLD."id");
  ELSIF TG_TABLE_NAME = 'purchase_due_dates' THEN purchase_id := COALESCE(NEW."purchaseInvoiceId", OLD."purchaseInvoiceId");
  ELSIF TG_TABLE_NAME = 'supplier_payment_allocations' THEN purchase_id := COALESCE(NEW."purchaseInvoiceId", OLD."purchaseInvoiceId");
  ELSE purchase_id := COALESCE(NEW."targetPurchaseInvoiceId", OLD."targetPurchaseInvoiceId"); END IF;
  SELECT * INTO purchase_row FROM "purchase_invoices" WHERE "id" = purchase_id;
  IF purchase_row."id" IS NULL OR purchase_row."documentType" <> 'STANDARD' OR purchase_row."status" NOT IN ('REGISTERED', 'RECTIFIED') THEN RETURN NULL; END IF;
  SELECT EXISTS (SELECT 1 FROM "purchase_invoices" WHERE "rectifiesPurchaseInvoiceId" = purchase_id AND "status" = 'REGISTERED' AND "rectificationMode" = 'FULL') INTO has_full_rectification;
  IF has_full_rectification AND purchase_row."paymentStatus" = 'NOT_APPLICABLE' THEN RETURN NULL; END IF;
  FOR due_row IN SELECT * FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = purchase_id LOOP
    SELECT COALESCE(SUM(allocation."amount") FILTER (WHERE payment."status" = 'POSTED'), 0) INTO due_cash FROM "supplier_payment_allocations" allocation JOIN "supplier_payments" payment ON payment."id" = allocation."supplierPaymentId" WHERE allocation."dueDateId" = due_row."id";
    SELECT COALESCE(SUM(application."amount"), 0) INTO due_credit FROM "supplier_credit_applications" application WHERE application."targetDueDateId" = due_row."id";
    IF due_cash + due_credit > due_row."amount" THEN RAISE EXCEPTION 'SUPPLIER_PURCHASE_SETTLEMENT_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
    expected_due := CASE WHEN due_cash + due_credit = due_row."amount" THEN CASE WHEN due_credit > 0 THEN 'SETTLED'::"PurchaseDueDateStatus" ELSE 'PAID'::"PurchaseDueDateStatus" END ELSE 'PENDING'::"PurchaseDueDateStatus" END;
    IF due_row."status" <> expected_due THEN RAISE EXCEPTION 'SUPPLIER_PURCHASE_SETTLEMENT_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
    cash_total := cash_total + due_cash; credit_total := credit_total + due_credit;
  END LOOP;
  IF has_full_rectification THEN
    IF purchase_row."paymentStatus" <> 'PAID' OR credit_total <> 0 OR cash_total <> purchase_row."total" THEN RAISE EXCEPTION 'SUPPLIER_PURCHASE_SETTLEMENT_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
    RETURN NULL;
  END IF;
  expected_purchase := CASE WHEN cash_total + credit_total = 0 THEN 'PENDING'::"PurchasePaymentStatus"
    WHEN cash_total + credit_total >= purchase_row."total" AND credit_total > 0 THEN 'SETTLED'::"PurchasePaymentStatus"
    WHEN cash_total + credit_total >= purchase_row."total" THEN 'PAID'::"PurchasePaymentStatus"
    WHEN credit_total > 0 THEN 'PARTIALLY_SETTLED'::"PurchasePaymentStatus" ELSE 'PARTIALLY_PAID'::"PurchasePaymentStatus" END;
  IF purchase_row."paymentStatus" <> expected_purchase THEN RAISE EXCEPTION 'SUPPLIER_PURCHASE_SETTLEMENT_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION prevent_partial_rectification_source_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD."sourcePurchaseInvoiceLineId" IS NOT NULL AND NEW."sourcePurchaseInvoiceLineId" IS DISTINCT FROM OLD."sourcePurchaseInvoiceLineId" THEN
    RAISE EXCEPTION 'PURCHASE_RECTIFICATION_LINE_SOURCE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "purchase_rectification_line_source_immutable" BEFORE UPDATE ON "purchase_invoice_lines" FOR EACH ROW EXECUTE FUNCTION prevent_partial_rectification_source_change();

COMMIT;
