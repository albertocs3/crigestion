BEGIN;

CREATE TABLE "purchase_correction_operations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "sourcePurchaseInvoiceId" UUID NOT NULL,
  "replacementPurchaseInvoiceId" UUID,
  "mode" "PurchaseCorrectionMode" NOT NULL,
  "accountingDate" DATE NOT NULL,
  "reasonCode" "PurchaseCorrectionReasonCode" NOT NULL,
  "reason" VARCHAR(500),
  "sourceVersion" INTEGER NOT NULL,
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "purchase_correction_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "purchase_correction_operations_source_key" UNIQUE ("sourcePurchaseInvoiceId"),
  CONSTRAINT "purchase_correction_operations_replacement_key" UNIQUE ("replacementPurchaseInvoiceId"),
  CONSTRAINT "purchase_correction_operations_shape_check" CHECK (
    "sourceVersion" > 0 AND (
      ("mode" = 'VOID' AND "replacementPurchaseInvoiceId" IS NULL AND "reasonCode" = 'DUPLICATE_DOCUMENT')
      OR ("mode" = 'REPLACE' AND "replacementPurchaseInvoiceId" IS NOT NULL)
    )
  ),
  CONSTRAINT "purchase_correction_operations_company_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "purchase_correction_operations_source_fkey" FOREIGN KEY ("sourcePurchaseInvoiceId") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "purchase_correction_operations_replacement_fkey" FOREIGN KEY ("replacementPurchaseInvoiceId") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "purchase_correction_operations_created_by_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "purchase_correction_operations_company_created_idx" ON "purchase_correction_operations"("companyId", "createdAt", "id");
CREATE INDEX "purchase_correction_operations_created_by_idx" ON "purchase_correction_operations"("createdById", "createdAt", "id");

ALTER TABLE "accounting_journal_entries"
  ADD COLUMN "purchaseCorrectionOperationId" UUID,
  ADD CONSTRAINT "accounting_journal_entries_purchaseCorrectionOperationId_key" UNIQUE ("purchaseCorrectionOperationId"),
  ADD CONSTRAINT "accounting_journal_entries_purchaseCorrectionOperationId_fkey"
    FOREIGN KEY ("purchaseCorrectionOperationId") REFERENCES "purchase_correction_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_vat_records"
  ALTER COLUMN "taxSummaryId" DROP NOT NULL,
  ADD COLUMN "kind" "PurchaseVatRecordKind" NOT NULL DEFAULT 'DOCUMENT',
  ADD COLUMN "correctionOperationId" UUID,
  ADD COLUMN "reversesVatRecordId" UUID,
  ADD CONSTRAINT "purchase_vat_records_reversesVatRecordId_key" UNIQUE ("reversesVatRecordId"),
  ADD CONSTRAINT "purchase_vat_records_correctionOperationId_fkey"
    FOREIGN KEY ("correctionOperationId") REFERENCES "purchase_correction_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "purchase_vat_records_reversesVatRecordId_fkey"
    FOREIGN KEY ("reversesVatRecordId") REFERENCES "purchase_vat_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "purchase_vat_records_kind_shape_check" CHECK (
    ("kind" = 'DOCUMENT' AND "taxSummaryId" IS NOT NULL AND "correctionOperationId" IS NULL AND "reversesVatRecordId" IS NULL)
    OR ("kind" = 'INTERNAL_CORRECTION_REVERSAL' AND "taxSummaryId" IS NULL AND "correctionOperationId" IS NOT NULL AND "reversesVatRecordId" IS NOT NULL)
  );
CREATE INDEX "purchase_vat_records_correction_operation_idx" ON "purchase_vat_records"("correctionOperationId");

ALTER TABLE "catalog_stock_movements"
  ADD COLUMN "purchaseCorrectionOperationId" UUID,
  ADD CONSTRAINT "catalog_stock_movements_correctionOperationId_fkey"
    FOREIGN KEY ("purchaseCorrectionOperationId") REFERENCES "purchase_correction_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "catalog_stock_movements_correction_operation_idx" ON "catalog_stock_movements"("purchaseCorrectionOperationId");

DO $migration$
DECLARE previous_definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO previous_definition FROM pg_constraint
  WHERE conrelid = 'accounting_journal_entries'::regclass AND conname = 'accounting_journal_entries_origin_source_check';
  IF previous_definition IS NULL THEN RAISE EXCEPTION 'Missing accounting origin/source constraint'; END IF;
  ALTER TABLE "accounting_journal_entries" DROP CONSTRAINT "accounting_journal_entries_origin_source_check";
  EXECUTE 'ALTER TABLE "accounting_journal_entries" ADD CONSTRAINT "accounting_journal_entries_origin_source_check" CHECK ("origin" = ''PURCHASE_CORRECTION_REVERSAL'' OR '
    || substring(previous_definition FROM 7) || ')';
END;
$migration$;
ALTER TABLE "accounting_journal_entries" ADD CONSTRAINT "accounting_journal_entries_purchase_correction_source_check" CHECK (
  ("origin" = 'PURCHASE_CORRECTION_REVERSAL' AND "purchaseCorrectionOperationId" IS NOT NULL AND "reversesEntryId" IS NOT NULL
    AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL
    AND "customerCreditRefundId" IS NULL AND "supplierCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL
    AND "supplierPaymentId" IS NULL AND "voidsInvoiceId" IS NULL AND "waiverReviewId" IS NULL
    AND "waiverReversalRequestId" IS NULL AND "waiverReplacementRequestId" IS NULL)
  OR ("origin" <> 'PURCHASE_CORRECTION_REVERSAL' AND "purchaseCorrectionOperationId" IS NULL)
);

ALTER TABLE "catalog_stock_movements"
  DROP CONSTRAINT "catalog_stock_movements_purchase_source_check",
  ADD CONSTRAINT "catalog_stock_movements_purchase_source_check" CHECK (
    ("type" = 'PURCHASE_RECEIPT' AND "purchaseInvoiceLineId" IS NOT NULL AND "reversesMovementId" IS NULL AND "purchaseCorrectionOperationId" IS NULL)
    OR ("type" = 'PURCHASE_RETURN' AND "purchaseInvoiceLineId" IS NOT NULL AND "reversesMovementId" IS NOT NULL AND "purchaseCorrectionOperationId" IS NULL)
    OR ("type" = 'PURCHASE_INTERNAL_REVERSAL' AND "purchaseInvoiceLineId" IS NULL AND "reversesMovementId" IS NOT NULL AND "purchaseCorrectionOperationId" IS NOT NULL)
    OR ("type" NOT IN ('PURCHASE_RECEIPT', 'PURCHASE_RETURN', 'PURCHASE_INTERNAL_REVERSAL')
      AND "purchaseInvoiceLineId" IS NULL AND "reversesMovementId" IS NULL AND "purchaseCorrectionOperationId" IS NULL)
  );

CREATE OR REPLACE FUNCTION prevent_registered_purchase_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid_rectification BOOLEAN; valid_correction BOOLEAN;
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
  IF NOT valid_rectification AND NOT valid_correction AND NEW."status" <> OLD."status" THEN RAISE EXCEPTION 'REGISTERED_PURCHASE_IMMUTABLE' USING ERRCODE = '23514'; END IF;
  IF NOT valid_rectification AND NOT valid_correction AND NOT (
    (OLD."paymentStatus" = 'PENDING' AND NEW."paymentStatus" IN ('PENDING', 'PARTIALLY_PAID', 'PAID', 'PARTIALLY_SETTLED', 'SETTLED'))
    OR (OLD."paymentStatus" = 'PARTIALLY_PAID' AND NEW."paymentStatus" IN ('PARTIALLY_PAID', 'PAID', 'PARTIALLY_SETTLED', 'SETTLED'))
    OR (OLD."paymentStatus" = 'PARTIALLY_SETTLED' AND NEW."paymentStatus" IN ('PARTIALLY_SETTLED', 'SETTLED'))
    OR (OLD."paymentStatus" IN ('PAID', 'SETTLED', 'NOT_APPLICABLE') AND NEW."paymentStatus" = OLD."paymentStatus")
  ) THEN RAISE EXCEPTION 'INVALID_PURCHASE_PAYMENT_STATUS_TRANSITION' USING ERRCODE = '23514'; END IF;
  IF NEW."companyId" IS DISTINCT FROM OLD."companyId" OR NEW."supplierId" IS DISTINCT FROM OLD."supplierId"
    OR NEW."supplierCodeSnapshot" IS DISTINCT FROM OLD."supplierCodeSnapshot" OR NEW."supplierAccountingCodeSnapshot" IS DISTINCT FROM OLD."supplierAccountingCodeSnapshot"
    OR NEW."supplierLegalNameSnapshot" IS DISTINCT FROM OLD."supplierLegalNameSnapshot" OR NEW."supplierTaxIdLast4Snapshot" IS DISTINCT FROM OLD."supplierTaxIdLast4Snapshot"
    OR NEW."supplierTaxIdEncryptedSnapshot" IS DISTINCT FROM OLD."supplierTaxIdEncryptedSnapshot"
    OR NEW."supplierInvoiceNumber" IS DISTINCT FROM OLD."supplierInvoiceNumber" OR NEW."supplierInvoiceNumberNormalized" IS DISTINCT FROM OLD."supplierInvoiceNumberNormalized"
    OR NEW."documentType" IS DISTINCT FROM OLD."documentType" OR NEW."rectifiesPurchaseInvoiceId" IS DISTINCT FROM OLD."rectifiesPurchaseInvoiceId"
    OR NEW."rectificationReason" IS DISTINCT FROM OLD."rectificationReason" OR NEW."issueDate" IS DISTINCT FROM OLD."issueDate"
    OR NEW."receivedDate" IS DISTINCT FROM OLD."receivedDate" OR NEW."operationDate" IS DISTINCT FROM OLD."operationDate"
    OR NEW."accountingDate" IS DISTINCT FROM OLD."accountingDate" OR NEW."subtotal" IS DISTINCT FROM OLD."subtotal"
    OR NEW."discountTotal" IS DISTINCT FROM OLD."discountTotal" OR NEW."taxableBase" IS DISTINCT FROM OLD."taxableBase"
    OR NEW."taxAmount" IS DISTINCT FROM OLD."taxAmount" OR NEW."total" IS DISTINCT FROM OLD."total"
    OR NEW."notes" IS DISTINCT FROM OLD."notes" OR NEW."registeredAt" IS DISTINCT FROM OLD."registeredAt"
    OR NEW."registeredById" IS DISTINCT FROM OLD."registeredById" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR (NOT valid_correction AND NEW."version" IS DISTINCT FROM OLD."version")
  THEN RAISE EXCEPTION 'REGISTERED_PURCHASE_IMMUTABLE' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_purchase_vat_record_links()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purchase_row "purchase_invoices"%ROWTYPE; summary_row "purchase_invoice_tax_summaries"%ROWTYPE;
  source_row "purchase_vat_records"%ROWTYPE; entry_row "accounting_journal_entries"%ROWTYPE; operation_row "purchase_correction_operations"%ROWTYPE; fiscal_company UUID;
BEGIN
  SELECT * INTO purchase_row FROM "purchase_invoices" WHERE "id" = NEW."purchaseInvoiceId";
  SELECT * INTO entry_row FROM "accounting_journal_entries" WHERE "id" = NEW."accountingEntryId";
  SELECT "companyId" INTO fiscal_company FROM "accounting_fiscal_years" WHERE "id" = entry_row."fiscalYearId";
  IF NEW."kind" = 'DOCUMENT' THEN
    SELECT * INTO summary_row FROM "purchase_invoice_tax_summaries" WHERE "id" = NEW."taxSummaryId";
    IF purchase_row."id" IS NULL OR purchase_row."companyId" <> NEW."companyId" OR purchase_row."supplierId" <> NEW."supplierId"
      OR summary_row."purchaseInvoiceId" <> purchase_row."id" OR entry_row."purchaseInvoiceId" <> purchase_row."id"
      OR entry_row."origin" <> (CASE WHEN purchase_row."documentType" = 'RECTIFICATION' THEN 'PURCHASE_RECTIFICATION'::"AccountingEntryOrigin" ELSE 'PURCHASE_INVOICE'::"AccountingEntryOrigin" END)
      OR fiscal_company <> purchase_row."companyId" OR NEW."supplierInvoiceNumberSnapshot" <> purchase_row."supplierInvoiceNumber"
      OR NEW."supplierCodeSnapshot" <> purchase_row."supplierCodeSnapshot" OR NEW."supplierLegalNameSnapshot" <> purchase_row."supplierLegalNameSnapshot"
      OR NEW."supplierTaxIdLast4Snapshot" <> purchase_row."supplierTaxIdLast4Snapshot" OR NEW."supplierTaxIdEncryptedSnapshot" <> purchase_row."supplierTaxIdEncryptedSnapshot"
      OR NEW."issueDate" <> purchase_row."issueDate" OR NEW."accountingDate" <> purchase_row."accountingDate"
      OR NEW."taxRateCode" <> summary_row."taxRateCode" OR NEW."taxRate" <> summary_row."taxRate"
      OR NEW."taxableBase" <> summary_row."taxableBase" OR NEW."taxAmount" <> summary_row."taxAmount" OR NEW."total" <> summary_row."total"
    THEN RAISE EXCEPTION 'PURCHASE_VAT_LINK_MISMATCH' USING ERRCODE = '23514'; END IF;
  ELSE
    SELECT * INTO source_row FROM "purchase_vat_records" WHERE "id" = NEW."reversesVatRecordId";
    SELECT * INTO operation_row FROM "purchase_correction_operations" WHERE "id" = NEW."correctionOperationId";
    IF source_row."id" IS NULL OR source_row."kind" <> 'DOCUMENT' OR source_row."purchaseInvoiceId" <> purchase_row."id"
      OR operation_row."sourcePurchaseInvoiceId" <> purchase_row."id" OR operation_row."companyId" <> purchase_row."companyId"
      OR entry_row."origin" <> 'PURCHASE_CORRECTION_REVERSAL' OR entry_row."purchaseCorrectionOperationId" <> operation_row."id"
      OR entry_row."reversesEntryId" <> source_row."accountingEntryId" OR fiscal_company <> purchase_row."companyId"
      OR NEW."companyId" <> source_row."companyId" OR NEW."supplierId" <> source_row."supplierId"
      OR NEW."supplierInvoiceNumberSnapshot" <> source_row."supplierInvoiceNumberSnapshot"
      OR NEW."supplierCodeSnapshot" <> source_row."supplierCodeSnapshot" OR NEW."supplierLegalNameSnapshot" <> source_row."supplierLegalNameSnapshot"
      OR NEW."supplierTaxIdLast4Snapshot" <> source_row."supplierTaxIdLast4Snapshot" OR NEW."supplierTaxIdEncryptedSnapshot" <> source_row."supplierTaxIdEncryptedSnapshot"
      OR NEW."issueDate" <> source_row."issueDate" OR NEW."accountingDate" <> operation_row."accountingDate"
      OR NEW."taxRateCode" <> source_row."taxRateCode" OR NEW."taxRate" <> source_row."taxRate"
      OR NEW."taxableBase" <> -source_row."taxableBase" OR NEW."taxAmount" <> -source_row."taxAmount" OR NEW."total" <> -source_row."total"
    THEN RAISE EXCEPTION 'PURCHASE_VAT_REVERSAL_MISMATCH' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_purchase_stock_source()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_item UUID; purchase_type "PurchaseInvoiceDocumentType"; purchase_status "PurchaseInvoiceStatus";
  source_movement "catalog_stock_movements"%ROWTYPE; operation_source UUID;
BEGIN
  IF NEW."type" IN ('PURCHASE_RECEIPT', 'PURCHASE_RETURN') THEN
    SELECT line."catalogItemId", purchase."documentType", purchase."status" INTO line_item, purchase_type, purchase_status
      FROM "purchase_invoice_lines" line JOIN "purchase_invoices" purchase ON purchase."id" = line."purchaseInvoiceId" WHERE line."id" = NEW."purchaseInvoiceLineId";
    IF line_item IS NULL OR line_item <> NEW."itemId" OR purchase_status <> 'DRAFT'
      OR (NEW."type" = 'PURCHASE_RECEIPT' AND purchase_type <> 'STANDARD') OR (NEW."type" = 'PURCHASE_RETURN' AND purchase_type <> 'RECTIFICATION')
    THEN RAISE EXCEPTION 'PURCHASE_STOCK_ITEM_MISMATCH' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW."type" IN ('PURCHASE_RETURN', 'PURCHASE_INTERNAL_REVERSAL') THEN
    SELECT * INTO source_movement FROM "catalog_stock_movements" WHERE "id" = NEW."reversesMovementId";
    IF source_movement."id" IS NULL OR source_movement."type" <> 'PURCHASE_RECEIPT' OR source_movement."itemId" <> NEW."itemId" OR source_movement."quantity" <> -NEW."quantity"
    THEN RAISE EXCEPTION 'PURCHASE_STOCK_REVERSAL_MISMATCH' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW."type" = 'PURCHASE_INTERNAL_REVERSAL' THEN
    SELECT "sourcePurchaseInvoiceId" INTO operation_source FROM "purchase_correction_operations" WHERE "id" = NEW."purchaseCorrectionOperationId";
    IF NOT EXISTS (SELECT 1 FROM "purchase_invoice_lines" line WHERE line."id" = source_movement."purchaseInvoiceLineId" AND line."purchaseInvoiceId" = operation_source)
    THEN RAISE EXCEPTION 'PURCHASE_STOCK_REVERSAL_SCOPE_MISMATCH' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_purchase_automatic_entry_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_status "PurchaseInvoiceStatus"; source_origin "AccountingEntryOrigin"; source_purchase UUID;
BEGIN
  IF TG_TABLE_NAME = 'accounting_journal_entries' THEN
    IF TG_OP = 'INSERT' AND NEW."origin" IN ('PURCHASE_INVOICE', 'PURCHASE_RECTIFICATION', 'PURCHASE_CORRECTION_REVERSAL') THEN
      IF NEW."origin" = 'PURCHASE_CORRECTION_REVERSAL' THEN SELECT "sourcePurchaseInvoiceId" INTO source_purchase FROM "purchase_correction_operations" WHERE "id" = NEW."purchaseCorrectionOperationId";
      ELSE source_purchase := NEW."purchaseInvoiceId"; END IF;
      SELECT "status" INTO source_status FROM "purchase_invoices" WHERE "id" = source_purchase;
      IF (NEW."origin" = 'PURCHASE_CORRECTION_REVERSAL' AND source_status <> 'REGISTERED') OR (NEW."origin" <> 'PURCHASE_CORRECTION_REVERSAL' AND source_status <> 'DRAFT')
      THEN RAISE EXCEPTION 'PURCHASE_ACCOUNTING_HISTORY_IMMUTABLE' USING ERRCODE = '23514'; END IF;
    ELSIF TG_OP <> 'INSERT' AND OLD."origin" IN ('PURCHASE_INVOICE', 'PURCHASE_RECTIFICATION', 'PURCHASE_CORRECTION_REVERSAL') THEN
      RAISE EXCEPTION 'PURCHASE_ACCOUNTING_HISTORY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT entry."origin", COALESCE(entry."purchaseInvoiceId", operation."sourcePurchaseInvoiceId") INTO source_origin, source_purchase
      FROM "accounting_journal_entries" entry LEFT JOIN "purchase_correction_operations" operation ON operation."id" = entry."purchaseCorrectionOperationId"
      WHERE entry."id" = COALESCE(NEW."entryId", OLD."entryId");
    IF source_origin IN ('PURCHASE_INVOICE', 'PURCHASE_RECTIFICATION', 'PURCHASE_CORRECTION_REVERSAL') THEN
      IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'PURCHASE_ACCOUNTING_HISTORY_IMMUTABLE' USING ERRCODE = '23514'; END IF;
      SELECT "status" INTO source_status FROM "purchase_invoices" WHERE "id" = source_purchase;
      IF (source_origin = 'PURCHASE_CORRECTION_REVERSAL' AND source_status <> 'REGISTERED') OR (source_origin <> 'PURCHASE_CORRECTION_REVERSAL' AND source_status <> 'DRAFT')
      THEN RAISE EXCEPTION 'PURCHASE_ACCOUNTING_HISTORY_IMMUTABLE' USING ERRCODE = '23514'; END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_registered_purchase_due_date()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id UUID; target_status "PurchaseInvoiceStatus";
BEGIN
  target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."purchaseInvoiceId" ELSE NEW."purchaseInvoiceId" END;
  SELECT "status" INTO target_status FROM "purchase_invoices" WHERE "id" = target_id;
  IF target_status <> 'DRAFT' AND TG_OP IN ('INSERT', 'DELETE') THEN
    RAISE EXCEPTION 'REGISTERED_PURCHASE_DUE_DATE_IMMUTABLE' USING ERRCODE = '23514';
  ELSIF target_status <> 'DRAFT' AND TG_OP = 'UPDATE' AND (
    NEW."purchaseInvoiceId" IS DISTINCT FROM OLD."purchaseInvoiceId" OR NEW."position" IS DISTINCT FROM OLD."position"
    OR NEW."dueDate" IS DISTINCT FROM OLD."dueDate" OR NEW."amount" IS DISTINCT FROM OLD."amount"
    OR NEW."paymentMethod" IS DISTINCT FROM OLD."paymentMethod") THEN
    RAISE EXCEPTION 'REGISTERED_PURCHASE_DUE_DATE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER "purchase_due_dates_registered_immutable" ON "purchase_due_dates";
CREATE TRIGGER "purchase_due_dates_registered_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "purchase_due_dates"
FOR EACH ROW EXECUTE FUNCTION protect_registered_purchase_due_date();

CREATE FUNCTION protect_purchase_correction_operation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_row "purchase_invoices"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'PURCHASE_CORRECTION_OPERATION_APPEND_ONLY' USING ERRCODE = '23514'; END IF;
  SELECT * INTO source_row FROM "purchase_invoices" WHERE "id" = NEW."sourcePurchaseInvoiceId" FOR UPDATE;
  IF source_row."id" IS NULL OR source_row."companyId" <> NEW."companyId" OR source_row."documentType" <> 'STANDARD'
    OR source_row."status" <> 'REGISTERED' OR source_row."paymentStatus" <> 'PENDING' OR source_row."version" <> NEW."sourceVersion"
    OR NEW."accountingDate" < source_row."accountingDate"
    OR EXISTS (SELECT 1 FROM "purchase_invoices" WHERE "rectifiesPurchaseInvoiceId" = source_row."id")
    OR EXISTS (SELECT 1 FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = source_row."id" AND "status" <> 'PENDING')
    OR EXISTS (SELECT 1 FROM "supplier_payment_allocations" WHERE "purchaseInvoiceId" = source_row."id")
    OR EXISTS (SELECT 1 FROM "supplier_credit_applications" WHERE "targetPurchaseInvoiceId" = source_row."id")
  THEN RAISE EXCEPTION 'PURCHASE_CORRECTION_SOURCE_NOT_ELIGIBLE' USING ERRCODE = '23514'; END IF;
  IF NEW."mode" = 'REPLACE' THEN RAISE EXCEPTION 'PURCHASE_REPLACEMENT_NOT_IMPLEMENTED' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "purchase_correction_operation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "purchase_correction_operations"
FOR EACH ROW EXECUTE FUNCTION protect_purchase_correction_operation();

CREATE FUNCTION validate_purchase_correction_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE operation_id UUID; operation_row "purchase_correction_operations"%ROWTYPE; source_row "purchase_invoices"%ROWTYPE;
  source_entry "accounting_journal_entries"%ROWTYPE; reversal_entry "accounting_journal_entries"%ROWTYPE;
  fiscal_row "accounting_fiscal_years"%ROWTYPE; mismatch_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'purchase_correction_operations' THEN operation_id := NEW."id";
  ELSIF TG_TABLE_NAME = 'accounting_journal_entries' THEN operation_id := NEW."purchaseCorrectionOperationId";
  ELSIF TG_TABLE_NAME = 'purchase_vat_records' THEN operation_id := NEW."correctionOperationId";
  ELSIF TG_TABLE_NAME = 'catalog_stock_movements' THEN operation_id := NEW."purchaseCorrectionOperationId";
  ELSIF TG_TABLE_NAME = 'purchase_invoices' THEN
    SELECT "id" INTO operation_id FROM "purchase_correction_operations" WHERE "sourcePurchaseInvoiceId" = NEW."id";
  ELSE
    SELECT "id" INTO operation_id FROM "purchase_correction_operations" WHERE "sourcePurchaseInvoiceId" = COALESCE(NEW."purchaseInvoiceId", OLD."purchaseInvoiceId");
  END IF;
  IF operation_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO operation_row FROM "purchase_correction_operations" WHERE "id" = operation_id;
  SELECT * INTO source_row FROM "purchase_invoices" WHERE "id" = operation_row."sourcePurchaseInvoiceId";
  SELECT * INTO source_entry FROM "accounting_journal_entries" WHERE "purchaseInvoiceId" = source_row."id" AND "origin" = 'PURCHASE_INVOICE';
  SELECT * INTO reversal_entry FROM "accounting_journal_entries" WHERE "purchaseCorrectionOperationId" = operation_id;
  SELECT * INTO fiscal_row FROM "accounting_fiscal_years" WHERE "id" = source_entry."fiscalYearId";
  IF operation_row."mode" <> 'VOID' OR source_row."status" <> 'VOIDED' OR source_row."paymentStatus" <> 'NOT_APPLICABLE'
    OR source_row."version" <> operation_row."sourceVersion" + 1 OR source_entry."status" <> 'POSTED'
    OR reversal_entry."id" IS NULL OR reversal_entry."origin" <> 'PURCHASE_CORRECTION_REVERSAL' OR reversal_entry."reversesEntryId" <> source_entry."id"
    OR reversal_entry."status" <> 'POSTED' OR reversal_entry."fiscalYearId" <> source_entry."fiscalYearId"
    OR fiscal_row."status" <> 'OPEN' OR fiscal_row."companyId" <> operation_row."companyId"
    OR operation_row."accountingDate" < source_row."accountingDate" OR operation_row."accountingDate" < fiscal_row."startDate"
    OR operation_row."accountingDate" > fiscal_row."endDate" OR reversal_entry."accountingDate" <> operation_row."accountingDate"
    OR reversal_entry."totalDebit" <> source_entry."totalCredit" OR reversal_entry."totalCredit" <> source_entry."totalDebit"
    OR EXISTS (SELECT 1 FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = source_row."id" AND "status" <> 'CANCELLED')
  THEN RAISE EXCEPTION 'PURCHASE_CORRECTION_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
  SELECT count(*) INTO mismatch_count FROM (
    SELECT COALESCE(source."position", reversal."position") FROM
      (SELECT "position", "accountId", "debit", "credit" FROM "accounting_journal_lines" WHERE "entryId" = source_entry."id") source
      FULL JOIN (SELECT "position", "accountId", "debit", "credit" FROM "accounting_journal_lines" WHERE "entryId" = reversal_entry."id") reversal USING ("position")
    WHERE source."position" IS NULL OR reversal."position" IS NULL OR source."accountId" <> reversal."accountId"
      OR source."debit" <> reversal."credit" OR source."credit" <> reversal."debit"
  ) differences;
  IF mismatch_count <> 0
    OR EXISTS (SELECT 1 FROM "purchase_vat_records" source WHERE source."purchaseInvoiceId" = source_row."id" AND source."kind" = 'DOCUMENT'
      AND NOT EXISTS (SELECT 1 FROM "purchase_vat_records" reversal WHERE reversal."reversesVatRecordId" = source."id"
        AND reversal."correctionOperationId" = operation_id AND reversal."kind" = 'INTERNAL_CORRECTION_REVERSAL' AND reversal."status" = 'ACTIVE'))
    OR EXISTS (SELECT 1 FROM "catalog_stock_movements" source JOIN "purchase_invoice_lines" line ON line."id" = source."purchaseInvoiceLineId"
      WHERE line."purchaseInvoiceId" = source_row."id" AND source."type" = 'PURCHASE_RECEIPT'
        AND NOT EXISTS (SELECT 1 FROM "catalog_stock_movements" reversal WHERE reversal."reversesMovementId" = source."id"
          AND reversal."purchaseCorrectionOperationId" = operation_id AND reversal."type" = 'PURCHASE_INTERNAL_REVERSAL'))
  THEN RAISE EXCEPTION 'PURCHASE_CORRECTION_EFFECTS_MISMATCH' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "purchase_correction_consistency_operation" AFTER INSERT ON "purchase_correction_operations" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_purchase_correction_consistency();
CREATE CONSTRAINT TRIGGER "purchase_correction_consistency_invoice" AFTER UPDATE ON "purchase_invoices" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_purchase_correction_consistency();
CREATE CONSTRAINT TRIGGER "purchase_correction_consistency_due" AFTER UPDATE ON "purchase_due_dates" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_purchase_correction_consistency();
CREATE CONSTRAINT TRIGGER "purchase_correction_consistency_entry" AFTER INSERT ON "accounting_journal_entries" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."purchaseCorrectionOperationId" IS NOT NULL) EXECUTE FUNCTION validate_purchase_correction_consistency();
CREATE CONSTRAINT TRIGGER "purchase_correction_consistency_vat" AFTER INSERT ON "purchase_vat_records" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."correctionOperationId" IS NOT NULL) EXECUTE FUNCTION validate_purchase_correction_consistency();
CREATE CONSTRAINT TRIGGER "purchase_correction_consistency_stock" AFTER INSERT ON "catalog_stock_movements" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."purchaseCorrectionOperationId" IS NOT NULL) EXECUTE FUNCTION validate_purchase_correction_consistency();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt") VALUES
  (gen_random_uuid(), 'Purchases.Correct', 'Corregir o anular compras registradas sin actividad financiera', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;
INSERT INTO "role_permissions" ("roleId", "permissionId") SELECT role."id", permission."id" FROM "roles" role CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador' AND permission."code" = 'Purchases.Correct' ON CONFLICT DO NOTHING;

COMMIT;
