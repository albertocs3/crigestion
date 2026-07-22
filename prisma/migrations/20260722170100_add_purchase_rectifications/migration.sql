CREATE TYPE "PurchaseInvoiceDocumentType" AS ENUM ('STANDARD', 'RECTIFICATION');

ALTER TABLE "purchase_invoices"
  ADD COLUMN "documentType" "PurchaseInvoiceDocumentType" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "rectificationReason" VARCHAR(120),
  ADD COLUMN "rectifiesPurchaseInvoiceId" UUID;

CREATE INDEX "purchase_invoices_rectifiesPurchaseInvoiceId_idx"
  ON "purchase_invoices"("rectifiesPurchaseInvoiceId");
CREATE UNIQUE INDEX "purchase_invoices_single_full_rectification_key"
  ON "purchase_invoices"("rectifiesPurchaseInvoiceId")
  WHERE "rectifiesPurchaseInvoiceId" IS NOT NULL;

ALTER TABLE "purchase_invoices"
  ADD CONSTRAINT "purchase_invoices_rectifiesPurchaseInvoiceId_fkey"
  FOREIGN KEY ("rectifiesPurchaseInvoiceId") REFERENCES "purchase_invoices"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "catalog_stock_movements" ADD COLUMN "reversesMovementId" UUID;
CREATE UNIQUE INDEX "catalog_stock_movements_reversesMovementId_key" ON "catalog_stock_movements"("reversesMovementId");
ALTER TABLE "catalog_stock_movements" ADD CONSTRAINT "catalog_stock_movements_reversesMovementId_fkey"
  FOREIGN KEY ("reversesMovementId") REFERENCES "catalog_stock_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_invoices"
  DROP CONSTRAINT "purchase_invoices_amounts_check",
  DROP CONSTRAINT "purchase_invoices_registration_state_check",
  ADD CONSTRAINT "purchase_invoices_amounts_check" CHECK (
    ("documentType" = 'STANDARD' AND "subtotal" >= 0 AND "discountTotal" >= 0 AND "taxableBase" >= 0 AND "taxAmount" >= 0 AND "total" >= 0)
    OR ("documentType" = 'RECTIFICATION' AND "subtotal" <= 0 AND "discountTotal" <= 0 AND "taxableBase" <= 0 AND "taxAmount" <= 0 AND "total" < 0)
  ),
  ADD CONSTRAINT "purchase_invoices_rectification_shape_check" CHECK (
    ("documentType" = 'STANDARD' AND "rectifiesPurchaseInvoiceId" IS NULL AND "rectificationReason" IS NULL)
    OR ("documentType" = 'RECTIFICATION' AND "rectifiesPurchaseInvoiceId" IS NOT NULL AND "rectificationReason" IN ('RETURN', 'OPERATION_CANCELLED'))
  ),
  ADD CONSTRAINT "purchase_invoices_registration_state_check" CHECK (
    ("status" = 'DRAFT' AND "registeredAt" IS NULL AND "registeredById" IS NULL)
    OR ("status" IN ('REGISTERED', 'RECTIFIED', 'VOIDED') AND "registeredAt" IS NOT NULL AND "registeredById" IS NOT NULL)
  );

ALTER TABLE "purchase_invoice_lines"
  DROP CONSTRAINT "purchase_invoice_lines_quantity_check",
  DROP CONSTRAINT "purchase_invoice_lines_amounts_check",
  ADD CONSTRAINT "purchase_invoice_lines_quantity_check" CHECK ("quantity" <> 0),
  ADD CONSTRAINT "purchase_invoice_lines_amounts_check" CHECK (
    ("lineSubtotal" >= 0 AND "lineDiscountTotal" >= 0 AND "lineTaxableBase" >= 0 AND "lineTaxAmount" >= 0 AND "lineTotal" >= 0)
    OR ("lineSubtotal" <= 0 AND "lineDiscountTotal" <= 0 AND "lineTaxableBase" <= 0 AND "lineTaxAmount" <= 0 AND "lineTotal" <= 0)
  );

ALTER TABLE "purchase_invoice_tax_summaries"
  DROP CONSTRAINT "purchase_invoice_tax_summaries_amounts_check",
  ADD CONSTRAINT "purchase_invoice_tax_summaries_amounts_check" CHECK (
    "taxRate" BETWEEN 0 AND 100 AND (
      ("taxableBase" >= 0 AND "taxAmount" >= 0 AND "total" >= 0)
      OR ("taxableBase" <= 0 AND "taxAmount" <= 0 AND "total" <= 0)
    )
  );

ALTER TABLE "catalog_stock_movements"
  DROP CONSTRAINT "catalog_stock_movements_purchase_source_check",
  ADD CONSTRAINT "catalog_stock_movements_purchase_source_check" CHECK (
    ("type" = 'PURCHASE_RECEIPT' AND "purchaseInvoiceLineId" IS NOT NULL AND "reversesMovementId" IS NULL)
    OR ("type" = 'PURCHASE_RETURN' AND "purchaseInvoiceLineId" IS NOT NULL AND "reversesMovementId" IS NOT NULL)
    OR ("type" NOT IN ('PURCHASE_RECEIPT', 'PURCHASE_RETURN') AND "purchaseInvoiceLineId" IS NULL AND "reversesMovementId" IS NULL)
  );

ALTER TABLE "accounting_journal_entries"
  DROP CONSTRAINT IF EXISTS "accounting_journal_entries_origin_source_check";
ALTER TABLE "accounting_journal_entries"
  ADD CONSTRAINT "accounting_journal_entries_origin_source_check" CHECK (
    ("origin" = 'INVOICE' AND "invoiceId" IS NOT NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" = 'INVOICE_VOIDING' AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "voidsInvoiceId" IS NOT NULL AND "reversesEntryId" IS NOT NULL)
    OR ("origin" = 'CUSTOMER_PAYMENT' AND "customerPaymentId" IS NOT NULL AND "invoiceId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" = 'CUSTOMER_PAYMENT_RETURN' AND "customerPaymentReturnId" IS NOT NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" = 'CUSTOMER_CREDIT_REFUND' AND "customerCreditRefundId" IS NOT NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" = 'PURCHASE_INVOICE' AND "purchaseInvoiceId" IS NOT NULL AND "supplierPaymentId" IS NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" = 'PURCHASE_RECTIFICATION' AND "purchaseInvoiceId" IS NOT NULL AND "supplierPaymentId" IS NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NOT NULL)
    OR ("origin" = 'SUPPLIER_PAYMENT' AND "supplierPaymentId" IS NOT NULL AND "purchaseInvoiceId" IS NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" IN ('MANUAL', 'REGULARIZATION', 'CLOSING', 'OPENING') AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
  );

CREATE OR REPLACE FUNCTION validate_purchase_invoice_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE supplier_company UUID; original "purchase_invoices"%ROWTYPE;
BEGIN
  SELECT "companyId" INTO supplier_company FROM "suppliers" WHERE "id" = NEW."supplierId";
  IF supplier_company IS NULL OR supplier_company <> NEW."companyId" THEN
    RAISE EXCEPTION 'PURCHASE_SUPPLIER_COMPANY_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF NEW."rectifiesPurchaseInvoiceId" IS NOT NULL THEN
    SELECT * INTO original FROM "purchase_invoices" WHERE "id" = NEW."rectifiesPurchaseInvoiceId";
    IF original."id" IS NULL OR original."id" = NEW."id" OR original."companyId" <> NEW."companyId"
       OR original."supplierId" <> NEW."supplierId" OR original."documentType" <> 'STANDARD' THEN
      RAISE EXCEPTION 'PURCHASE_RECTIFICATION_SCOPE_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER "purchase_invoices_owner_check" ON "purchase_invoices";
CREATE TRIGGER "purchase_invoices_owner_check"
BEFORE INSERT OR UPDATE OF "companyId", "supplierId", "rectifiesPurchaseInvoiceId" ON "purchase_invoices"
FOR EACH ROW EXECUTE FUNCTION validate_purchase_invoice_owner();

CREATE OR REPLACE FUNCTION prevent_registered_purchase_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid_rectification BOOLEAN;
BEGIN
  IF OLD."status" = 'DRAFT' THEN
    IF NEW."status" NOT IN ('DRAFT', 'REGISTERED') THEN
      RAISE EXCEPTION 'INVALID_PURCHASE_STATUS_TRANSITION' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  valid_rectification := OLD."status" = 'REGISTERED' AND NEW."status" = 'RECTIFIED'
    AND OLD."documentType" = 'STANDARD' AND NEW."paymentStatus" = 'NOT_APPLICABLE'
    AND EXISTS (
      SELECT 1 FROM "purchase_invoices" r
      WHERE r."rectifiesPurchaseInvoiceId" = OLD."id" AND r."documentType" = 'RECTIFICATION' AND r."status" = 'REGISTERED'
    );

  IF NOT valid_rectification AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'REGISTERED_PURCHASE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NOT valid_rectification AND NOT (
    (OLD."paymentStatus" = 'PENDING' AND NEW."paymentStatus" IN ('PENDING', 'PARTIALLY_PAID', 'PAID'))
    OR (OLD."paymentStatus" = 'PARTIALLY_PAID' AND NEW."paymentStatus" IN ('PARTIALLY_PAID', 'PAID'))
    OR (OLD."paymentStatus" IN ('PAID', 'NOT_APPLICABLE') AND NEW."paymentStatus" = OLD."paymentStatus")
  ) THEN
    RAISE EXCEPTION 'INVALID_PURCHASE_PAYMENT_STATUS_TRANSITION' USING ERRCODE = '23514';
  END IF;

  IF NEW."companyId" IS DISTINCT FROM OLD."companyId" OR NEW."supplierId" IS DISTINCT FROM OLD."supplierId"
    OR NEW."supplierCodeSnapshot" IS DISTINCT FROM OLD."supplierCodeSnapshot" OR NEW."supplierAccountingCodeSnapshot" IS DISTINCT FROM OLD."supplierAccountingCodeSnapshot"
    OR NEW."supplierLegalNameSnapshot" IS DISTINCT FROM OLD."supplierLegalNameSnapshot" OR NEW."supplierTaxIdLast4Snapshot" IS DISTINCT FROM OLD."supplierTaxIdLast4Snapshot"
    OR NEW."supplierTaxIdEncryptedSnapshot" IS DISTINCT FROM OLD."supplierTaxIdEncryptedSnapshot"
    OR NEW."supplierInvoiceNumber" IS DISTINCT FROM OLD."supplierInvoiceNumber" OR NEW."supplierInvoiceNumberNormalized" IS DISTINCT FROM OLD."supplierInvoiceNumberNormalized"
    OR NEW."documentType" IS DISTINCT FROM OLD."documentType" OR NEW."rectifiesPurchaseInvoiceId" IS DISTINCT FROM OLD."rectifiesPurchaseInvoiceId"
    OR NEW."rectificationReason" IS DISTINCT FROM OLD."rectificationReason"
    OR NEW."issueDate" IS DISTINCT FROM OLD."issueDate" OR NEW."receivedDate" IS DISTINCT FROM OLD."receivedDate"
    OR NEW."operationDate" IS DISTINCT FROM OLD."operationDate" OR NEW."accountingDate" IS DISTINCT FROM OLD."accountingDate"
    OR NEW."subtotal" IS DISTINCT FROM OLD."subtotal" OR NEW."discountTotal" IS DISTINCT FROM OLD."discountTotal"
    OR NEW."taxableBase" IS DISTINCT FROM OLD."taxableBase" OR NEW."taxAmount" IS DISTINCT FROM OLD."taxAmount" OR NEW."total" IS DISTINCT FROM OLD."total"
    OR NEW."notes" IS DISTINCT FROM OLD."notes" OR NEW."registeredAt" IS DISTINCT FROM OLD."registeredAt"
    OR NEW."registeredById" IS DISTINCT FROM OLD."registeredById" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."version" IS DISTINCT FROM OLD."version"
  THEN
    RAISE EXCEPTION 'REGISTERED_PURCHASE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_purchase_registration()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_count INTEGER; due_total NUMERIC; line_subtotal NUMERIC; line_discount NUMERIC; line_base NUMERIC; line_tax NUMERIC; line_total NUMERIC; original "purchase_invoices"%ROWTYPE; original_entry "accounting_journal_entries"%ROWTYPE; correction_entry "accounting_journal_entries"%ROWTYPE;
BEGIN
  IF NEW."status" = 'REGISTERED' AND OLD."status" = 'DRAFT' THEN
    SELECT COUNT(*), COALESCE(SUM("lineSubtotal"), 0), COALESCE(SUM("lineDiscountTotal"), 0), COALESCE(SUM("lineTaxableBase"), 0), COALESCE(SUM("lineTaxAmount"), 0), COALESCE(SUM("lineTotal"), 0)
      INTO line_count, line_subtotal, line_discount, line_base, line_tax, line_total
      FROM "purchase_invoice_lines" WHERE "purchaseInvoiceId" = NEW."id";
    SELECT COALESCE(SUM("amount"), 0) INTO due_total FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = NEW."id";
    IF line_count = 0 OR line_subtotal <> NEW."subtotal" OR line_discount <> NEW."discountTotal"
       OR line_base <> NEW."taxableBase" OR line_tax <> NEW."taxAmount" OR line_total <> NEW."total" THEN
      RAISE EXCEPTION 'INVALID_PURCHASE_REGISTRATION_TOTALS' USING ERRCODE = '23514';
    END IF;
    IF NEW."documentType" = 'STANDARD' AND due_total <> NEW."total" THEN
      RAISE EXCEPTION 'INVALID_PURCHASE_REGISTRATION_TOTALS' USING ERRCODE = '23514';
    END IF;
    IF NEW."documentType" = 'RECTIFICATION' THEN
      SELECT * INTO original FROM "purchase_invoices" WHERE "id" = NEW."rectifiesPurchaseInvoiceId" FOR UPDATE;
      IF due_total <> 0 OR original."id" IS NULL OR original."status" <> 'REGISTERED' OR original."documentType" <> 'STANDARD'
         OR NEW."paymentStatus" <> 'NOT_APPLICABLE' OR NEW."issueDate" < original."issueDate" OR NEW."accountingDate" < original."accountingDate"
         OR EXISTS (SELECT 1 FROM "supplier_payment_allocations" WHERE "purchaseInvoiceId" = original."id")
         OR NEW."subtotal" <> -original."subtotal" OR NEW."discountTotal" <> -original."discountTotal"
         OR NEW."taxableBase" <> -original."taxableBase" OR NEW."taxAmount" <> -original."taxAmount" OR NEW."total" <> -original."total"
         OR EXISTS (
           SELECT 1
           FROM (SELECT * FROM "purchase_invoice_lines" WHERE "purchaseInvoiceId" = original."id") source
           FULL JOIN (SELECT * FROM "purchase_invoice_lines" WHERE "purchaseInvoiceId" = NEW."id") correction USING ("position")
           WHERE source."id" IS NULL OR correction."id" IS NULL
             OR correction."catalogItemId" IS DISTINCT FROM source."catalogItemId"
             OR correction."catalogItemCodeSnapshot" IS DISTINCT FROM source."catalogItemCodeSnapshot"
             OR correction."catalogItemKindSnapshot" IS DISTINCT FROM source."catalogItemKindSnapshot"
             OR correction."description" <> source."description" OR correction."quantity" <> -source."quantity"
             OR correction."unitPrice" <> source."unitPrice" OR correction."discountPercent" <> source."discountPercent"
             OR correction."discountAmount" <> source."discountAmount" OR correction."purchaseAccountCode" <> source."purchaseAccountCode"
             OR correction."taxRateId" <> source."taxRateId" OR correction."taxRateCodeSnapshot" <> source."taxRateCodeSnapshot"
             OR correction."taxRateNameSnapshot" <> source."taxRateNameSnapshot" OR correction."taxRateSnapshot" <> source."taxRateSnapshot"
             OR correction."lineSubtotal" <> -source."lineSubtotal" OR correction."lineDiscountTotal" <> -source."lineDiscountTotal"
             OR correction."lineTaxableBase" <> -source."lineTaxableBase" OR correction."lineTaxAmount" <> -source."lineTaxAmount"
             OR correction."lineTotal" <> -source."lineTotal"
         )
         OR EXISTS (
           SELECT 1
           FROM (SELECT * FROM "purchase_invoice_tax_summaries" WHERE "purchaseInvoiceId" = original."id") source
           FULL JOIN (SELECT * FROM "purchase_invoice_tax_summaries" WHERE "purchaseInvoiceId" = NEW."id") correction
             USING ("taxRateCode", "taxRate")
           WHERE source."id" IS NULL OR correction."id" IS NULL OR correction."taxableBase" <> -source."taxableBase"
             OR correction."taxAmount" <> -source."taxAmount" OR correction."total" <> -source."total"
         ) THEN
        RAISE EXCEPTION 'INVALID_PURCHASE_RECTIFICATION' USING ERRCODE = '23514';
      END IF;
      SELECT * INTO original_entry FROM "accounting_journal_entries" WHERE "purchaseInvoiceId" = original."id" AND "origin" = 'PURCHASE_INVOICE';
      SELECT * INTO correction_entry FROM "accounting_journal_entries" WHERE "purchaseInvoiceId" = NEW."id" AND "origin" = 'PURCHASE_RECTIFICATION';
      IF original_entry."id" IS NULL OR correction_entry."id" IS NULL OR correction_entry."reversesEntryId" <> original_entry."id"
      OR correction_entry."status" <> 'POSTED' OR correction_entry."fiscalYearId" <> original_entry."fiscalYearId"
      OR NOT EXISTS (SELECT 1 FROM "accounting_fiscal_years" WHERE "id" = original_entry."fiscalYearId" AND "status" = 'OPEN')
      OR correction_entry."totalDebit" <> original_entry."totalCredit" OR correction_entry."totalCredit" <> original_entry."totalDebit"
      OR EXISTS (
        SELECT 1
        FROM (SELECT * FROM "accounting_journal_lines" WHERE "entryId" = original_entry."id") source
        FULL JOIN (SELECT * FROM "accounting_journal_lines" WHERE "entryId" = correction_entry."id") correction USING ("position")
        WHERE source."id" IS NULL OR correction."id" IS NULL OR correction."accountId" <> source."accountId"
          OR correction."debit" <> source."credit" OR correction."credit" <> source."debit"
      )
      OR (SELECT COUNT(*) FROM "purchase_vat_records" WHERE "purchaseInvoiceId" = NEW."id") <> (SELECT COUNT(*) FROM "purchase_invoice_tax_summaries" WHERE "purchaseInvoiceId" = NEW."id")
      OR EXISTS (
        SELECT 1
        FROM "purchase_invoice_lines" source_line
        JOIN "catalog_stock_movements" source_movement ON source_movement."purchaseInvoiceLineId" = source_line."id" AND source_movement."type" = 'PURCHASE_RECEIPT'
        JOIN "purchase_invoice_lines" correction_line ON correction_line."purchaseInvoiceId" = NEW."id" AND correction_line."position" = source_line."position"
        LEFT JOIN "catalog_stock_movements" correction_movement ON correction_movement."purchaseInvoiceLineId" = correction_line."id"
        WHERE source_line."purchaseInvoiceId" = original."id" AND (
          correction_movement."id" IS NULL OR correction_movement."type" <> 'PURCHASE_RETURN'
          OR correction_movement."reversesMovementId" <> source_movement."id"
          OR correction_movement."itemId" <> source_movement."itemId" OR correction_movement."quantity" <> -source_movement."quantity"
        )
      ) OR EXISTS (
        SELECT 1 FROM "catalog_stock_movements" correction_movement
        JOIN "purchase_invoice_lines" correction_line ON correction_line."id" = correction_movement."purchaseInvoiceLineId"
        WHERE correction_line."purchaseInvoiceId" = NEW."id" AND correction_movement."type" = 'PURCHASE_RETURN'
          AND NOT EXISTS (
            SELECT 1 FROM "catalog_stock_movements" source_movement
            JOIN "purchase_invoice_lines" source_line ON source_line."id" = source_movement."purchaseInvoiceLineId"
            WHERE source_movement."id" = correction_movement."reversesMovementId" AND source_line."purchaseInvoiceId" = original."id"
          )
      ) THEN
        RAISE EXCEPTION 'INVALID_PURCHASE_RECTIFICATION_EFFECTS' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_supplier_payment_allocation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment_row "supplier_payments"%ROWTYPE; purchase_row "purchase_invoices"%ROWTYPE; due_row "purchase_due_dates"%ROWTYPE; allocated NUMERIC;
BEGIN
  SELECT * INTO payment_row FROM "supplier_payments" WHERE "id" = NEW."supplierPaymentId" FOR UPDATE;
  SELECT * INTO purchase_row FROM "purchase_invoices" WHERE "id" = NEW."purchaseInvoiceId" FOR UPDATE;
  SELECT * INTO due_row FROM "purchase_due_dates" WHERE "id" = NEW."dueDateId" FOR UPDATE;
  SELECT COALESCE(SUM("amount"), 0) INTO allocated FROM "supplier_payment_allocations" WHERE "dueDateId" = NEW."dueDateId" AND "id" <> NEW."id";
  IF payment_row."companyId" <> purchase_row."companyId" OR payment_row."supplierId" <> purchase_row."supplierId"
     OR due_row."purchaseInvoiceId" <> purchase_row."id" OR purchase_row."status" <> 'REGISTERED'
     OR due_row."status" = 'CANCELLED' OR payment_row."status" <> 'POSTED' OR allocated + NEW."amount" > due_row."amount" THEN
    RAISE EXCEPTION 'INVALID_SUPPLIER_PAYMENT_ALLOCATION' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_purchase_vat_record_links()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purchase_row "purchase_invoices"%ROWTYPE; summary_row "purchase_invoice_tax_summaries"%ROWTYPE; entry_purchase UUID; entry_origin "AccountingEntryOrigin"; fiscal_company UUID;
BEGIN
  SELECT * INTO purchase_row FROM "purchase_invoices" WHERE "id" = NEW."purchaseInvoiceId";
  SELECT * INTO summary_row FROM "purchase_invoice_tax_summaries" WHERE "id" = NEW."taxSummaryId";
  SELECT entry."purchaseInvoiceId", entry."origin", year."companyId" INTO entry_purchase, entry_origin, fiscal_company
    FROM "accounting_journal_entries" entry JOIN "accounting_fiscal_years" year ON year."id" = entry."fiscalYearId"
    WHERE entry."id" = NEW."accountingEntryId";
  IF purchase_row."id" IS NULL OR purchase_row."companyId" <> NEW."companyId" OR purchase_row."supplierId" <> NEW."supplierId"
     OR summary_row."purchaseInvoiceId" <> purchase_row."id" OR entry_purchase <> purchase_row."id"
     OR entry_origin <> (CASE WHEN purchase_row."documentType" = 'RECTIFICATION' THEN 'PURCHASE_RECTIFICATION'::"AccountingEntryOrigin" ELSE 'PURCHASE_INVOICE'::"AccountingEntryOrigin" END)
     OR fiscal_company <> purchase_row."companyId"
     OR NEW."supplierInvoiceNumberSnapshot" <> purchase_row."supplierInvoiceNumber"
     OR NEW."supplierCodeSnapshot" <> purchase_row."supplierCodeSnapshot" OR NEW."supplierLegalNameSnapshot" <> purchase_row."supplierLegalNameSnapshot"
     OR NEW."supplierTaxIdLast4Snapshot" <> purchase_row."supplierTaxIdLast4Snapshot" OR NEW."supplierTaxIdEncryptedSnapshot" <> purchase_row."supplierTaxIdEncryptedSnapshot"
     OR NEW."issueDate" <> purchase_row."issueDate" OR NEW."accountingDate" <> purchase_row."accountingDate"
     OR NEW."taxRateCode" <> summary_row."taxRateCode" OR NEW."taxRate" <> summary_row."taxRate"
     OR NEW."taxableBase" <> summary_row."taxableBase" OR NEW."taxAmount" <> summary_row."taxAmount" OR NEW."total" <> summary_row."total" THEN
    RAISE EXCEPTION 'PURCHASE_VAT_LINK_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_purchase_stock_source()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_item UUID; purchase_type "PurchaseInvoiceDocumentType"; purchase_status "PurchaseInvoiceStatus"; source_movement "catalog_stock_movements"%ROWTYPE;
BEGIN
  IF NEW."type" IN ('PURCHASE_RECEIPT', 'PURCHASE_RETURN') THEN
    SELECT line."catalogItemId", purchase."documentType", purchase."status" INTO line_item, purchase_type, purchase_status
      FROM "purchase_invoice_lines" line JOIN "purchase_invoices" purchase ON purchase."id" = line."purchaseInvoiceId"
      WHERE line."id" = NEW."purchaseInvoiceLineId";
    IF line_item IS NULL OR line_item <> NEW."itemId"
       OR (NEW."type" = 'PURCHASE_RECEIPT' AND purchase_type <> 'STANDARD')
       OR (NEW."type" = 'PURCHASE_RETURN' AND purchase_type <> 'RECTIFICATION') OR purchase_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'PURCHASE_STOCK_ITEM_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF NEW."type" = 'PURCHASE_RETURN' THEN
      SELECT * INTO source_movement FROM "catalog_stock_movements" WHERE "id" = NEW."reversesMovementId";
      IF source_movement."id" IS NULL OR source_movement."type" <> 'PURCHASE_RECEIPT'
         OR source_movement."itemId" <> NEW."itemId" OR source_movement."quantity" <> -NEW."quantity" THEN
        RAISE EXCEPTION 'PURCHASE_STOCK_REVERSAL_MISMATCH' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION prevent_purchase_automatic_entry_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_status "PurchaseInvoiceStatus"; source_origin "AccountingEntryOrigin"; source_purchase UUID;
BEGIN
  IF TG_TABLE_NAME = 'accounting_journal_entries' THEN
    IF TG_OP = 'INSERT' AND NEW."origin" IN ('PURCHASE_INVOICE', 'PURCHASE_RECTIFICATION') THEN
      SELECT "status" INTO source_status FROM "purchase_invoices" WHERE "id" = NEW."purchaseInvoiceId";
      IF source_status <> 'DRAFT' THEN RAISE EXCEPTION 'PURCHASE_ACCOUNTING_HISTORY_IMMUTABLE' USING ERRCODE = '23514'; END IF;
    ELSIF TG_OP <> 'INSERT' AND OLD."origin" IN ('PURCHASE_INVOICE', 'PURCHASE_RECTIFICATION') THEN
      RAISE EXCEPTION 'PURCHASE_ACCOUNTING_HISTORY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT entry."origin", entry."purchaseInvoiceId" INTO source_origin, source_purchase FROM "accounting_journal_entries" entry
      WHERE entry."id" = COALESCE(NEW."entryId", OLD."entryId");
    IF source_origin IN ('PURCHASE_INVOICE', 'PURCHASE_RECTIFICATION') THEN
      IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'PURCHASE_ACCOUNTING_HISTORY_IMMUTABLE' USING ERRCODE = '23514'; END IF;
      SELECT "status" INTO source_status FROM "purchase_invoices" WHERE "id" = source_purchase;
      IF source_status <> 'DRAFT' THEN RAISE EXCEPTION 'PURCHASE_ACCOUNTING_HISTORY_IMMUTABLE' USING ERRCODE = '23514'; END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "purchase_accounting_entries_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "accounting_journal_entries"
FOR EACH ROW EXECUTE FUNCTION prevent_purchase_automatic_entry_change();
CREATE TRIGGER "purchase_accounting_lines_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "accounting_journal_lines"
FOR EACH ROW EXECUTE FUNCTION prevent_purchase_automatic_entry_change();

CREATE FUNCTION prevent_purchase_stock_history_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."type" IN ('PURCHASE_RECEIPT', 'PURCHASE_RETURN') THEN
    RAISE EXCEPTION 'PURCHASE_STOCK_HISTORY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "purchase_stock_movements_immutable" BEFORE UPDATE OR DELETE ON "catalog_stock_movements"
FOR EACH ROW EXECUTE FUNCTION prevent_purchase_stock_history_change();

CREATE FUNCTION validate_purchase_rectification_state()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root_id UUID; original "purchase_invoices"%ROWTYPE; registered_children INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'purchase_due_dates' THEN
    root_id := COALESCE(NEW."purchaseInvoiceId", OLD."purchaseInvoiceId");
  ELSE
    root_id := COALESCE(NEW."rectifiesPurchaseInvoiceId", NEW."id", OLD."rectifiesPurchaseInvoiceId", OLD."id");
  END IF;
  SELECT * INTO original FROM "purchase_invoices" WHERE "id" = root_id;
  IF original."id" IS NULL OR original."documentType" <> 'STANDARD' THEN RETURN NULL; END IF;
  SELECT COUNT(*) INTO registered_children FROM "purchase_invoices"
    WHERE "rectifiesPurchaseInvoiceId" = root_id AND "documentType" = 'RECTIFICATION' AND "status" = 'REGISTERED';
  IF registered_children > 0 AND (
    original."status" <> 'RECTIFIED' OR original."paymentStatus" <> 'NOT_APPLICABLE'
    OR EXISTS (SELECT 1 FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = root_id AND "status" <> 'CANCELLED')
    OR EXISTS (SELECT 1 FROM "supplier_payment_allocations" WHERE "purchaseInvoiceId" = root_id)
    OR EXISTS (SELECT 1 FROM "purchase_invoices" child WHERE child."rectifiesPurchaseInvoiceId" = root_id AND child."status" = 'REGISTERED'
      AND (child."paymentStatus" <> 'NOT_APPLICABLE' OR EXISTS (SELECT 1 FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = child."id")))
  ) THEN
    RAISE EXCEPTION 'PURCHASE_RECTIFICATION_STATE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF original."status" = 'RECTIFIED' AND registered_children <> 1 THEN
    RAISE EXCEPTION 'PURCHASE_RECTIFICATION_STATE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "purchase_rectification_state_from_invoice" AFTER INSERT OR UPDATE ON "purchase_invoices"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_purchase_rectification_state();
CREATE CONSTRAINT TRIGGER "purchase_rectification_state_from_due_date" AFTER INSERT OR UPDATE OR DELETE ON "purchase_due_dates"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_purchase_rectification_state();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt") VALUES
  (gen_random_uuid(), 'Purchases.Rectify', 'Registrar facturas rectificativas de compra', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id" FROM "roles" role CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador' AND permission."code" = 'Purchases.Rectify'
ON CONFLICT DO NOTHING;
