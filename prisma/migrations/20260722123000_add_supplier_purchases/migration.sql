-- CreateEnum
CREATE TYPE "PurchaseInvoiceStatus" AS ENUM ('DRAFT', 'REGISTERED', 'VOIDED');

-- CreateEnum
CREATE TYPE "PurchasePaymentStatus" AS ENUM ('PENDING', 'PARTIALLY_PAID', 'PAID', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "PurchaseDueDateStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SupplierPaymentStatus" AS ENUM ('POSTED', 'VOIDED');

-- CreateEnum
CREATE TYPE "PurchaseVatRecordStatus" AS ENUM ('ACTIVE', 'REVERSED');

-- AlterTable
ALTER TABLE "accounting_journal_entries" ADD COLUMN     "purchaseInvoiceId" UUID,
ADD COLUMN     "supplierPaymentId" UUID;

-- AlterTable
ALTER TABLE "catalog_items" ADD COLUMN     "purchaseAccountCode" VARCHAR(9);

-- AlterTable
ALTER TABLE "catalog_stock_movements" ADD COLUMN     "purchaseInvoiceLineId" UUID;

-- CreateTable
CREATE TABLE "purchase_invoices" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "supplierCodeSnapshot" VARCHAR(20) NOT NULL,
    "supplierAccountingCodeSnapshot" VARCHAR(9) NOT NULL,
    "supplierLegalNameSnapshot" VARCHAR(200) NOT NULL,
    "supplierTaxIdLast4Snapshot" VARCHAR(4) NOT NULL,
    "supplierTaxIdEncryptedSnapshot" BYTEA NOT NULL,
    "supplierInvoiceNumber" VARCHAR(80) NOT NULL,
    "supplierInvoiceNumberNormalized" VARCHAR(80) NOT NULL,
    "status" "PurchaseInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "paymentStatus" "PurchasePaymentStatus" NOT NULL DEFAULT 'PENDING',
    "issueDate" DATE NOT NULL,
    "receivedDate" DATE NOT NULL,
    "operationDate" DATE NOT NULL,
    "accountingDate" DATE NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxableBase" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID NOT NULL,
    "updatedById" UUID,
    "registeredById" UUID,
    "registeredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_invoice_lines" (
    "id" UUID NOT NULL,
    "purchaseInvoiceId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "catalogItemId" UUID,
    "catalogItemCodeSnapshot" VARCHAR(20),
    "catalogItemKindSnapshot" "CatalogItemKind",
    "description" VARCHAR(500) NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "purchaseAccountCode" VARCHAR(9) NOT NULL,
    "taxRateId" UUID NOT NULL,
    "taxRateCodeSnapshot" VARCHAR(40) NOT NULL,
    "taxRateNameSnapshot" VARCHAR(120) NOT NULL,
    "taxRateSnapshot" DECIMAL(5,2) NOT NULL,
    "lineSubtotal" DECIMAL(14,2) NOT NULL,
    "lineDiscountTotal" DECIMAL(14,2) NOT NULL,
    "lineTaxableBase" DECIMAL(14,2) NOT NULL,
    "lineTaxAmount" DECIMAL(14,2) NOT NULL,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_invoice_tax_summaries" (
    "id" UUID NOT NULL,
    "purchaseInvoiceId" UUID NOT NULL,
    "taxRateCode" VARCHAR(40) NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL,
    "taxableBase" DECIMAL(14,2) NOT NULL,
    "taxAmount" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "purchase_invoice_tax_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_vat_records" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "purchaseInvoiceId" UUID NOT NULL,
    "taxSummaryId" UUID NOT NULL,
    "accountingEntryId" UUID NOT NULL,
    "status" "PurchaseVatRecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "supplierInvoiceNumberSnapshot" VARCHAR(80) NOT NULL,
    "supplierCodeSnapshot" VARCHAR(20) NOT NULL,
    "supplierLegalNameSnapshot" VARCHAR(200) NOT NULL,
    "supplierTaxIdLast4Snapshot" VARCHAR(4) NOT NULL,
    "supplierTaxIdEncryptedSnapshot" BYTEA NOT NULL,
    "issueDate" DATE NOT NULL,
    "accountingDate" DATE NOT NULL,
    "taxRateCode" VARCHAR(40) NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL,
    "taxableBase" DECIMAL(14,2) NOT NULL,
    "taxAmount" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_vat_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_due_dates" (
    "id" UUID NOT NULL,
    "purchaseInvoiceId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paymentMethod" "SupplierPaymentMethod" NOT NULL,
    "status" "PurchaseDueDateStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_due_dates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payments" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "paymentDate" DATE NOT NULL,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "paymentMethod" "SupplierPaymentMethod" NOT NULL,
    "status" "SupplierPaymentStatus" NOT NULL DEFAULT 'POSTED',
    "reference" VARCHAR(120),
    "notes" VARCHAR(500),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payment_allocations" (
    "id" UUID NOT NULL,
    "supplierPaymentId" UUID NOT NULL,
    "purchaseInvoiceId" UUID NOT NULL,
    "dueDateId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_invoices_companyId_status_accountingDate_id_idx" ON "purchase_invoices"("companyId", "status", "accountingDate", "id");

-- CreateIndex
CREATE INDEX "purchase_invoices_companyId_paymentStatus_accountingDate_id_idx" ON "purchase_invoices"("companyId", "paymentStatus", "accountingDate", "id");

-- CreateIndex
CREATE INDEX "purchase_invoices_supplierId_issueDate_id_idx" ON "purchase_invoices"("supplierId", "issueDate", "id");

-- CreateIndex
CREATE INDEX "purchase_invoices_createdById_createdAt_id_idx" ON "purchase_invoices"("createdById", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_invoices_companyId_supplierId_supplierInvoiceNumbe_key" ON "purchase_invoices"("companyId", "supplierId", "supplierInvoiceNumberNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_invoices_id_companyId_key" ON "purchase_invoices"("id", "companyId");

-- CreateIndex
CREATE INDEX "purchase_invoice_lines_catalogItemId_idx" ON "purchase_invoice_lines"("catalogItemId");

-- CreateIndex
CREATE INDEX "purchase_invoice_lines_taxRateId_idx" ON "purchase_invoice_lines"("taxRateId");

-- CreateIndex
CREATE INDEX "purchase_invoice_lines_purchaseAccountCode_idx" ON "purchase_invoice_lines"("purchaseAccountCode");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_invoice_lines_purchaseInvoiceId_position_key" ON "purchase_invoice_lines"("purchaseInvoiceId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_invoice_tax_summaries_purchaseInvoiceId_taxRateCod_key" ON "purchase_invoice_tax_summaries"("purchaseInvoiceId", "taxRateCode", "taxRate");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_vat_records_taxSummaryId_key" ON "purchase_vat_records"("taxSummaryId");

-- CreateIndex
CREATE INDEX "purchase_vat_records_companyId_status_accountingDate_id_idx" ON "purchase_vat_records"("companyId", "status", "accountingDate", "id");

-- CreateIndex
CREATE INDEX "purchase_vat_records_supplierId_issueDate_id_idx" ON "purchase_vat_records"("supplierId", "issueDate", "id");

-- CreateIndex
CREATE INDEX "purchase_vat_records_purchaseInvoiceId_idx" ON "purchase_vat_records"("purchaseInvoiceId");

-- CreateIndex
CREATE INDEX "purchase_vat_records_accountingEntryId_idx" ON "purchase_vat_records"("accountingEntryId");

-- CreateIndex
CREATE INDEX "purchase_due_dates_status_dueDate_id_idx" ON "purchase_due_dates"("status", "dueDate", "id");

-- CreateIndex
CREATE INDEX "purchase_due_dates_purchaseInvoiceId_dueDate_id_idx" ON "purchase_due_dates"("purchaseInvoiceId", "dueDate", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_due_dates_purchaseInvoiceId_position_key" ON "purchase_due_dates"("purchaseInvoiceId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_due_dates_id_purchaseInvoiceId_key" ON "purchase_due_dates"("id", "purchaseInvoiceId");

-- CreateIndex
CREATE INDEX "supplier_payments_companyId_status_paymentDate_id_idx" ON "supplier_payments"("companyId", "status", "paymentDate", "id");

-- CreateIndex
CREATE INDEX "supplier_payments_supplierId_paymentDate_id_idx" ON "supplier_payments"("supplierId", "paymentDate", "id");

-- CreateIndex
CREATE INDEX "supplier_payments_createdById_createdAt_id_idx" ON "supplier_payments"("createdById", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_id_companyId_key" ON "supplier_payments"("id", "companyId");

-- CreateIndex
CREATE INDEX "supplier_payment_allocations_purchaseInvoiceId_createdAt_id_idx" ON "supplier_payment_allocations"("purchaseInvoiceId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "supplier_payment_allocations_dueDateId_createdAt_id_idx" ON "supplier_payment_allocations"("dueDateId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payment_allocations_supplierPaymentId_dueDateId_key" ON "supplier_payment_allocations"("supplierPaymentId", "dueDateId");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_journal_entries_purchaseInvoiceId_key" ON "accounting_journal_entries"("purchaseInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_journal_entries_supplierPaymentId_key" ON "accounting_journal_entries"("supplierPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_stock_movements_purchaseInvoiceLineId_key" ON "catalog_stock_movements"("purchaseInvoiceLineId");

-- AddForeignKey
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_registeredById_fkey" FOREIGN KEY ("registeredById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_purchaseInvoiceId_fkey" FOREIGN KEY ("purchaseInvoiceId") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "catalog_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES "catalog_tax_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_tax_summaries" ADD CONSTRAINT "purchase_invoice_tax_summaries_purchaseInvoiceId_fkey" FOREIGN KEY ("purchaseInvoiceId") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_vat_records" ADD CONSTRAINT "purchase_vat_records_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_vat_records" ADD CONSTRAINT "purchase_vat_records_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_vat_records" ADD CONSTRAINT "purchase_vat_records_purchaseInvoiceId_fkey" FOREIGN KEY ("purchaseInvoiceId") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_vat_records" ADD CONSTRAINT "purchase_vat_records_taxSummaryId_fkey" FOREIGN KEY ("taxSummaryId") REFERENCES "purchase_invoice_tax_summaries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_vat_records" ADD CONSTRAINT "purchase_vat_records_accountingEntryId_fkey" FOREIGN KEY ("accountingEntryId") REFERENCES "accounting_journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_due_dates" ADD CONSTRAINT "purchase_due_dates_purchaseInvoiceId_fkey" FOREIGN KEY ("purchaseInvoiceId") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_supplierPaymentId_fkey" FOREIGN KEY ("supplierPaymentId") REFERENCES "supplier_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_purchaseInvoiceId_fkey" FOREIGN KEY ("purchaseInvoiceId") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_dueDateId_purchaseInvoiceId_fkey" FOREIGN KEY ("dueDateId", "purchaseInvoiceId") REFERENCES "purchase_due_dates"("id", "purchaseInvoiceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_stock_movements" ADD CONSTRAINT "catalog_stock_movements_purchaseInvoiceLineId_fkey" FOREIGN KEY ("purchaseInvoiceLineId") REFERENCES "purchase_invoice_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_journal_entries" ADD CONSTRAINT "accounting_journal_entries_purchaseInvoiceId_fkey" FOREIGN KEY ("purchaseInvoiceId") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_journal_entries" ADD CONSTRAINT "accounting_journal_entries_supplierPaymentId_fkey" FOREIGN KEY ("supplierPaymentId") REFERENCES "supplier_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain invariants that Prisma cannot express.
ALTER TABLE "catalog_items"
  ADD CONSTRAINT "catalog_items_purchase_account_code_check"
  CHECK ("purchaseAccountCode" IS NULL OR "purchaseAccountCode" ~ '^[0-9]{9}$');

ALTER TABLE "purchase_invoices"
  ADD CONSTRAINT "purchase_invoices_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "purchase_invoices_number_normalized_check" CHECK (length(btrim("supplierInvoiceNumberNormalized")) > 0),
  ADD CONSTRAINT "purchase_invoices_amounts_check" CHECK (
    "subtotal" >= 0 AND "discountTotal" >= 0 AND "taxableBase" >= 0 AND "taxAmount" >= 0 AND "total" >= 0
  ),
  ADD CONSTRAINT "purchase_invoices_registration_state_check" CHECK (
    ("status" = 'DRAFT' AND "registeredAt" IS NULL AND "registeredById" IS NULL)
    OR ("status" IN ('REGISTERED', 'VOIDED') AND "registeredAt" IS NOT NULL AND "registeredById" IS NOT NULL)
  );

ALTER TABLE "purchase_invoice_lines"
  ADD CONSTRAINT "purchase_invoice_lines_position_check" CHECK ("position" > 0),
  ADD CONSTRAINT "purchase_invoice_lines_quantity_check" CHECK ("quantity" > 0),
  ADD CONSTRAINT "purchase_invoice_lines_prices_check" CHECK ("unitPrice" >= 0 AND "discountAmount" >= 0 AND "discountPercent" BETWEEN 0 AND 100),
  ADD CONSTRAINT "purchase_invoice_lines_account_check" CHECK ("purchaseAccountCode" ~ '^[0-9]{9}$'),
  ADD CONSTRAINT "purchase_invoice_lines_amounts_check" CHECK (
    "lineSubtotal" >= 0 AND "lineDiscountTotal" >= 0 AND "lineTaxableBase" >= 0 AND "lineTaxAmount" >= 0 AND "lineTotal" >= 0
  );

ALTER TABLE "purchase_invoice_tax_summaries"
  ADD CONSTRAINT "purchase_invoice_tax_summaries_amounts_check" CHECK ("taxRate" BETWEEN 0 AND 100 AND "taxableBase" >= 0 AND "taxAmount" >= 0 AND "total" >= 0);

ALTER TABLE "purchase_due_dates"
  ADD CONSTRAINT "purchase_due_dates_position_check" CHECK ("position" > 0),
  ADD CONSTRAINT "purchase_due_dates_amount_check" CHECK ("amount" > 0);

ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_amount_check" CHECK ("totalAmount" > 0);

ALTER TABLE "supplier_payment_allocations"
  ADD CONSTRAINT "supplier_payment_allocations_amount_check" CHECK ("amount" > 0);

ALTER TABLE "catalog_stock_movements"
  ADD CONSTRAINT "catalog_stock_movements_purchase_source_check" CHECK (
    ("type" = 'PURCHASE_RECEIPT' AND "purchaseInvoiceLineId" IS NOT NULL)
    OR ("type" <> 'PURCHASE_RECEIPT' AND "purchaseInvoiceLineId" IS NULL)
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
    OR ("origin" = 'SUPPLIER_PAYMENT' AND "supplierPaymentId" IS NOT NULL AND "purchaseInvoiceId" IS NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" IN ('MANUAL', 'REGULARIZATION', 'CLOSING', 'OPENING') AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
  );

CREATE FUNCTION validate_purchase_invoice_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE supplier_company UUID;
BEGIN
  SELECT "companyId" INTO supplier_company FROM "suppliers" WHERE "id" = NEW."supplierId";
  IF supplier_company IS NULL OR supplier_company <> NEW."companyId" THEN
    RAISE EXCEPTION 'PURCHASE_SUPPLIER_COMPANY_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "purchase_invoices_owner_check"
BEFORE INSERT OR UPDATE OF "companyId", "supplierId" ON "purchase_invoices"
FOR EACH ROW EXECUTE FUNCTION validate_purchase_invoice_owner();

CREATE FUNCTION prevent_registered_purchase_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'DRAFT' AND NEW."status" NOT IN ('DRAFT', 'REGISTERED') THEN
    RAISE EXCEPTION 'INVALID_PURCHASE_STATUS_TRANSITION' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'DRAFT' AND NOT (
    (OLD."paymentStatus" = 'PENDING' AND NEW."paymentStatus" IN ('PENDING', 'PARTIALLY_PAID', 'PAID'))
    OR (OLD."paymentStatus" = 'PARTIALLY_PAID' AND NEW."paymentStatus" IN ('PARTIALLY_PAID', 'PAID'))
    OR (OLD."paymentStatus" IN ('PAID', 'NOT_APPLICABLE') AND NEW."paymentStatus" = OLD."paymentStatus")
  ) THEN
    RAISE EXCEPTION 'INVALID_PURCHASE_PAYMENT_STATUS_TRANSITION' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'DRAFT' AND (
    NEW."status" IS DISTINCT FROM OLD."status" OR NEW."companyId" IS DISTINCT FROM OLD."companyId" OR NEW."supplierId" IS DISTINCT FROM OLD."supplierId"
    OR NEW."supplierCodeSnapshot" IS DISTINCT FROM OLD."supplierCodeSnapshot" OR NEW."supplierAccountingCodeSnapshot" IS DISTINCT FROM OLD."supplierAccountingCodeSnapshot"
    OR NEW."supplierLegalNameSnapshot" IS DISTINCT FROM OLD."supplierLegalNameSnapshot" OR NEW."supplierTaxIdLast4Snapshot" IS DISTINCT FROM OLD."supplierTaxIdLast4Snapshot"
    OR NEW."supplierTaxIdEncryptedSnapshot" IS DISTINCT FROM OLD."supplierTaxIdEncryptedSnapshot"
    OR NEW."supplierInvoiceNumber" IS DISTINCT FROM OLD."supplierInvoiceNumber" OR NEW."supplierInvoiceNumberNormalized" IS DISTINCT FROM OLD."supplierInvoiceNumberNormalized"
    OR NEW."issueDate" IS DISTINCT FROM OLD."issueDate" OR NEW."receivedDate" IS DISTINCT FROM OLD."receivedDate"
    OR NEW."operationDate" IS DISTINCT FROM OLD."operationDate" OR NEW."accountingDate" IS DISTINCT FROM OLD."accountingDate"
    OR NEW."subtotal" IS DISTINCT FROM OLD."subtotal" OR NEW."discountTotal" IS DISTINCT FROM OLD."discountTotal"
    OR NEW."taxableBase" IS DISTINCT FROM OLD."taxableBase" OR NEW."taxAmount" IS DISTINCT FROM OLD."taxAmount" OR NEW."total" IS DISTINCT FROM OLD."total"
    OR NEW."notes" IS DISTINCT FROM OLD."notes" OR NEW."registeredAt" IS DISTINCT FROM OLD."registeredAt"
    OR NEW."registeredById" IS DISTINCT FROM OLD."registeredById" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."version" IS DISTINCT FROM OLD."version"
  ) THEN
    RAISE EXCEPTION 'REGISTERED_PURCHASE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "purchase_invoices_registered_immutable"
BEFORE UPDATE ON "purchase_invoices" FOR EACH ROW EXECUTE FUNCTION prevent_registered_purchase_change();

CREATE FUNCTION prevent_registered_purchase_child_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id UUID; target_status "PurchaseInvoiceStatus";
BEGIN
  target_id := COALESCE(NEW."purchaseInvoiceId", OLD."purchaseInvoiceId");
  SELECT "status" INTO target_status FROM "purchase_invoices" WHERE "id" = target_id;
  IF target_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'REGISTERED_PURCHASE_CHILD_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "purchase_invoice_lines_registered_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "purchase_invoice_lines" FOR EACH ROW EXECUTE FUNCTION prevent_registered_purchase_child_change();
CREATE TRIGGER "purchase_invoice_tax_summaries_registered_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "purchase_invoice_tax_summaries" FOR EACH ROW EXECUTE FUNCTION prevent_registered_purchase_child_change();

CREATE FUNCTION validate_supplier_payment_allocation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment_row "supplier_payments"%ROWTYPE; purchase_row "purchase_invoices"%ROWTYPE; due_row "purchase_due_dates"%ROWTYPE; allocated NUMERIC;
BEGIN
  SELECT * INTO payment_row FROM "supplier_payments" WHERE "id" = NEW."supplierPaymentId" FOR UPDATE;
  SELECT * INTO purchase_row FROM "purchase_invoices" WHERE "id" = NEW."purchaseInvoiceId" FOR UPDATE;
  SELECT * INTO due_row FROM "purchase_due_dates" WHERE "id" = NEW."dueDateId" FOR UPDATE;
  SELECT COALESCE(SUM("amount"), 0) INTO allocated FROM "supplier_payment_allocations" WHERE "dueDateId" = NEW."dueDateId" AND "id" <> NEW."id";
  IF payment_row."companyId" <> purchase_row."companyId" OR payment_row."supplierId" <> purchase_row."supplierId"
     OR due_row."purchaseInvoiceId" <> purchase_row."id" OR purchase_row."status" <> 'REGISTERED'
     OR payment_row."status" <> 'POSTED' OR allocated + NEW."amount" > due_row."amount" THEN
    RAISE EXCEPTION 'INVALID_SUPPLIER_PAYMENT_ALLOCATION' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "supplier_payment_allocations_validate"
BEFORE INSERT OR UPDATE ON "supplier_payment_allocations" FOR EACH ROW EXECUTE FUNCTION validate_supplier_payment_allocation();

CREATE FUNCTION validate_purchase_registration()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_count INTEGER; due_total NUMERIC; line_subtotal NUMERIC; line_discount NUMERIC; line_base NUMERIC; line_tax NUMERIC; line_total NUMERIC;
BEGIN
  IF NEW."status" = 'REGISTERED' AND OLD."status" = 'DRAFT' THEN
    SELECT COUNT(*), COALESCE(SUM("lineSubtotal"), 0), COALESCE(SUM("lineDiscountTotal"), 0), COALESCE(SUM("lineTaxableBase"), 0), COALESCE(SUM("lineTaxAmount"), 0), COALESCE(SUM("lineTotal"), 0)
      INTO line_count, line_subtotal, line_discount, line_base, line_tax, line_total
      FROM "purchase_invoice_lines" WHERE "purchaseInvoiceId" = NEW."id";
    SELECT COALESCE(SUM("amount"), 0) INTO due_total FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = NEW."id";
    IF line_count = 0 OR line_subtotal <> NEW."subtotal" OR line_discount <> NEW."discountTotal"
       OR line_base <> NEW."taxableBase" OR line_tax <> NEW."taxAmount" OR line_total <> NEW."total"
       OR due_total <> NEW."total" THEN
      RAISE EXCEPTION 'INVALID_PURCHASE_REGISTRATION_TOTALS' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "purchase_invoices_validate_registration"
BEFORE UPDATE OF "status" ON "purchase_invoices" FOR EACH ROW EXECUTE FUNCTION validate_purchase_registration();

CREATE FUNCTION validate_supplier_payment_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE supplier_company UUID;
BEGIN
  SELECT "companyId" INTO supplier_company FROM "suppliers" WHERE "id" = NEW."supplierId";
  IF supplier_company IS NULL OR supplier_company <> NEW."companyId" THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_COMPANY_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "supplier_payments_owner_check"
BEFORE INSERT OR UPDATE OF "companyId", "supplierId" ON "supplier_payments"
FOR EACH ROW EXECUTE FUNCTION validate_supplier_payment_owner();

CREATE FUNCTION validate_supplier_payment_total_from_allocation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment_id UUID; expected_total NUMERIC; allocated_total NUMERIC;
BEGIN
  payment_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."supplierPaymentId" ELSE NEW."supplierPaymentId" END;
  SELECT "totalAmount" INTO expected_total FROM "supplier_payments" WHERE "id" = payment_id;
  SELECT COALESCE(SUM("amount"), 0) INTO allocated_total FROM "supplier_payment_allocations" WHERE "supplierPaymentId" = payment_id;
  IF expected_total IS NOT NULL AND allocated_total <> expected_total THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_TOTAL_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "supplier_payment_allocations_total_check"
AFTER INSERT OR UPDATE OR DELETE ON "supplier_payment_allocations"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_supplier_payment_total_from_allocation();

CREATE FUNCTION validate_supplier_payment_total_from_payment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocated_total NUMERIC;
BEGIN
  SELECT COALESCE(SUM("amount"), 0) INTO allocated_total FROM "supplier_payment_allocations" WHERE "supplierPaymentId" = NEW."id";
  IF allocated_total <> NEW."totalAmount" THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_TOTAL_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "supplier_payments_total_check"
AFTER INSERT OR UPDATE OF "totalAmount" ON "supplier_payments"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_supplier_payment_total_from_payment();

CREATE FUNCTION validate_purchase_vat_record_links()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purchase_row "purchase_invoices"%ROWTYPE; summary_purchase UUID; entry_purchase UUID; entry_origin "AccountingEntryOrigin"; fiscal_company UUID;
BEGIN
  SELECT * INTO purchase_row FROM "purchase_invoices" WHERE "id" = NEW."purchaseInvoiceId";
  SELECT "purchaseInvoiceId" INTO summary_purchase FROM "purchase_invoice_tax_summaries" WHERE "id" = NEW."taxSummaryId";
  SELECT entry."purchaseInvoiceId", entry."origin", year."companyId" INTO entry_purchase, entry_origin, fiscal_company
    FROM "accounting_journal_entries" entry JOIN "accounting_fiscal_years" year ON year."id" = entry."fiscalYearId"
    WHERE entry."id" = NEW."accountingEntryId";
  IF purchase_row."id" IS NULL OR purchase_row."companyId" <> NEW."companyId" OR purchase_row."supplierId" <> NEW."supplierId"
     OR summary_purchase <> purchase_row."id" OR entry_purchase <> purchase_row."id" OR entry_origin <> 'PURCHASE_INVOICE'
     OR fiscal_company <> purchase_row."companyId" THEN
    RAISE EXCEPTION 'PURCHASE_VAT_LINK_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "purchase_vat_records_links_check"
BEFORE INSERT OR UPDATE ON "purchase_vat_records" FOR EACH ROW EXECUTE FUNCTION validate_purchase_vat_record_links();

CREATE FUNCTION prevent_purchase_vat_history_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PURCHASE_VAT_HISTORY_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "purchase_vat_records_immutable" BEFORE UPDATE OR DELETE ON "purchase_vat_records" FOR EACH ROW EXECUTE FUNCTION prevent_purchase_vat_history_change();

CREATE FUNCTION validate_purchase_stock_source()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_item UUID;
BEGIN
  IF NEW."type" = 'PURCHASE_RECEIPT' THEN
    SELECT "catalogItemId" INTO line_item FROM "purchase_invoice_lines" WHERE "id" = NEW."purchaseInvoiceLineId";
    IF line_item IS NULL OR line_item <> NEW."itemId" THEN
      RAISE EXCEPTION 'PURCHASE_STOCK_ITEM_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "catalog_stock_movements_purchase_source_validate"
BEFORE INSERT OR UPDATE OF "itemId", "purchaseInvoiceLineId", "type" ON "catalog_stock_movements"
FOR EACH ROW EXECUTE FUNCTION validate_purchase_stock_source();

CREATE FUNCTION validate_purchase_accounting_company()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fiscal_company UUID; source_company UUID;
BEGIN
  SELECT "companyId" INTO fiscal_company FROM "accounting_fiscal_years" WHERE "id" = NEW."fiscalYearId";
  IF NEW."purchaseInvoiceId" IS NOT NULL THEN SELECT "companyId" INTO source_company FROM "purchase_invoices" WHERE "id" = NEW."purchaseInvoiceId"; END IF;
  IF NEW."supplierPaymentId" IS NOT NULL THEN SELECT "companyId" INTO source_company FROM "supplier_payments" WHERE "id" = NEW."supplierPaymentId"; END IF;
  IF (NEW."purchaseInvoiceId" IS NOT NULL OR NEW."supplierPaymentId" IS NOT NULL) AND source_company IS DISTINCT FROM fiscal_company THEN
    RAISE EXCEPTION 'PURCHASE_ACCOUNTING_COMPANY_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "accounting_journal_entries_purchase_company_check"
BEFORE INSERT OR UPDATE OF "fiscalYearId", "purchaseInvoiceId", "supplierPaymentId" ON "accounting_journal_entries"
FOR EACH ROW EXECUTE FUNCTION validate_purchase_accounting_company();

CREATE FUNCTION protect_registered_purchase_due_date()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id UUID; target_status "PurchaseInvoiceStatus";
BEGIN
  target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."purchaseInvoiceId" ELSE NEW."purchaseInvoiceId" END;
  SELECT "status" INTO target_status FROM "purchase_invoices" WHERE "id" = target_id;
  IF target_status <> 'DRAFT' AND (TG_OP = 'DELETE' OR NEW."purchaseInvoiceId" IS DISTINCT FROM OLD."purchaseInvoiceId" OR NEW."position" IS DISTINCT FROM OLD."position" OR NEW."dueDate" IS DISTINCT FROM OLD."dueDate" OR NEW."amount" IS DISTINCT FROM OLD."amount" OR NEW."paymentMethod" IS DISTINCT FROM OLD."paymentMethod") THEN
    RAISE EXCEPTION 'REGISTERED_PURCHASE_DUE_DATE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "purchase_due_dates_registered_immutable"
BEFORE UPDATE OR DELETE ON "purchase_due_dates" FOR EACH ROW EXECUTE FUNCTION protect_registered_purchase_due_date();

CREATE FUNCTION prevent_supplier_payment_history_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SUPPLIER_PAYMENT_HISTORY_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "supplier_payments_immutable" BEFORE UPDATE OR DELETE ON "supplier_payments" FOR EACH ROW EXECUTE FUNCTION prevent_supplier_payment_history_change();
CREATE TRIGGER "supplier_payment_allocations_immutable" BEFORE UPDATE OR DELETE ON "supplier_payment_allocations" FOR EACH ROW EXECUTE FUNCTION prevent_supplier_payment_history_change();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt") VALUES
  (gen_random_uuid(), 'Purchases.View', 'Consultar compras', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Purchases.ManageDrafts', 'Gestionar borradores de compra', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Purchases.Register', 'Registrar facturas de compra', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Treasury.ManageSupplierPayments', 'Registrar pagos de proveedores', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Treasury.ViewSupplierPayments', 'Consultar vencimientos y pagos de proveedores', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id" FROM "roles" role CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador' AND permission."code" IN ('Purchases.View', 'Purchases.ManageDrafts', 'Purchases.Register', 'Treasury.ManageSupplierPayments', 'Treasury.ViewSupplierPayments')
ON CONFLICT DO NOTHING;
