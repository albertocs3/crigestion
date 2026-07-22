BEGIN;

ALTER TABLE "purchase_invoices"
  ADD CONSTRAINT "purchase_invoices_id_company_supplier_key" UNIQUE ("id", "companyId", "supplierId");

CREATE TABLE "supplier_credits" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "supplierId" UUID NOT NULL,
  "sourceRectificationPurchaseInvoiceId" UUID NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
  "originalAmount" DECIMAL(14,2) NOT NULL,
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_credits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplier_credits_amount_check" CHECK ("originalAmount" > 0),
  CONSTRAINT "supplier_credits_currency_check" CHECK ("currency" = 'EUR'),
  CONSTRAINT "supplier_credits_id_company_supplier_key" UNIQUE ("id", "companyId", "supplierId")
);
CREATE UNIQUE INDEX "supplier_credits_sourceRectificationPurchaseInvoiceId_key" ON "supplier_credits"("sourceRectificationPurchaseInvoiceId");
CREATE INDEX "supplier_credits_companyId_supplierId_createdAt_id_idx" ON "supplier_credits"("companyId", "supplierId", "createdAt", "id");
CREATE INDEX "supplier_credits_supplierId_createdAt_id_idx" ON "supplier_credits"("supplierId", "createdAt", "id");

CREATE TABLE "supplier_credit_applications" (
  "id" UUID NOT NULL,
  "creditId" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "supplierId" UUID NOT NULL,
  "targetPurchaseInvoiceId" UUID NOT NULL,
  "targetDueDateId" UUID NOT NULL,
  "applicationDate" DATE NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "notes" VARCHAR(500),
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_credit_applications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplier_credit_applications_amount_check" CHECK ("amount" > 0)
);
CREATE INDEX "supplier_credit_applications_creditId_applicationDate_id_idx" ON "supplier_credit_applications"("creditId", "applicationDate", "id");
CREATE INDEX "supplier_credit_applications_targetPurchase_applicationDate_id" ON "supplier_credit_applications"("targetPurchaseInvoiceId", "applicationDate", "id");
CREATE INDEX "supplier_credit_applications_targetDueDateId_createdAt_id_idx" ON "supplier_credit_applications"("targetDueDateId", "createdAt", "id");
CREATE INDEX "supplier_credit_applications_createdById_createdAt_idx" ON "supplier_credit_applications"("createdById", "createdAt");

CREATE TABLE "supplier_credit_refunds" (
  "id" UUID NOT NULL,
  "creditId" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "supplierId" UUID NOT NULL,
  "bankAccountId" UUID,
  "paymentMethod" "SupplierPaymentMethod" NOT NULL,
  "status" "SupplierCreditRefundStatus" NOT NULL DEFAULT 'REQUESTED',
  "requestedDate" DATE NOT NULL,
  "postingDate" DATE,
  "amount" DECIMAL(14,2) NOT NULL,
  "reasonCode" VARCHAR(80) NOT NULL,
  "reference" VARCHAR(120),
  "notes" VARCHAR(500),
  "requestedById" UUID NOT NULL,
  "approvedById" UUID,
  "approvedAt" TIMESTAMPTZ(3),
  "postedById" UUID,
  "postedAt" TIMESTAMPTZ(3),
  "cancelledById" UUID,
  "cancelledAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "supplier_credit_refunds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplier_credit_refunds_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "supplier_credit_refunds_method_check" CHECK (
    ("paymentMethod" = 'BANK_TRANSFER' AND "bankAccountId" IS NOT NULL)
    OR ("paymentMethod" = 'CASH' AND "bankAccountId" IS NULL)
  ),
  CONSTRAINT "supplier_credit_refunds_actor_state_check" CHECK (
    ("status" = 'REQUESTED' AND "postingDate" IS NULL AND "approvedById" IS NULL AND "approvedAt" IS NULL AND "postedById" IS NULL AND "postedAt" IS NULL AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'APPROVED' AND "postingDate" IS NULL AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "postedById" IS NULL AND "postedAt" IS NULL AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'POSTED' AND "postingDate" IS NOT NULL AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "postedById" IS NOT NULL AND "postedAt" IS NOT NULL AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'CANCELLED' AND "postingDate" IS NULL AND "approvedById" IS NULL AND "approvedAt" IS NULL AND "postedById" IS NULL AND "postedAt" IS NULL AND "cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL)
  ),
  CONSTRAINT "supplier_credit_refunds_maker_checker_check" CHECK ("approvedById" IS NULL OR "approvedById" <> "requestedById")
);
CREATE INDEX "supplier_credit_refunds_creditId_requestedDate_id_idx" ON "supplier_credit_refunds"("creditId", "requestedDate", "id");
CREATE INDEX "supplier_credit_refunds_companyId_status_requestedDate_id_idx" ON "supplier_credit_refunds"("companyId", "status", "requestedDate", "id");
CREATE INDEX "supplier_credit_refunds_supplierId_requestedDate_id_idx" ON "supplier_credit_refunds"("supplierId", "requestedDate", "id");
CREATE INDEX "supplier_credit_refunds_bankAccountId_requestedDate_id_idx" ON "supplier_credit_refunds"("bankAccountId", "requestedDate", "id");
CREATE INDEX "supplier_credit_refunds_requestedById_createdAt_idx" ON "supplier_credit_refunds"("requestedById", "createdAt");
CREATE INDEX "supplier_credit_refunds_active_queue_idx" ON "supplier_credit_refunds"("companyId", "status", "requestedDate", "id") WHERE "status" IN ('REQUESTED', 'APPROVED');

ALTER TABLE "supplier_credits"
  ADD CONSTRAINT "supplier_credits_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_credits_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_credits_sourceRectificationPurchaseInvoiceId_fkey" FOREIGN KEY ("sourceRectificationPurchaseInvoiceId") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_credits_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_credit_applications"
  ADD CONSTRAINT "supplier_credit_applications_credit_company_supplier_fkey" FOREIGN KEY ("creditId", "companyId", "supplierId") REFERENCES "supplier_credits"("id", "companyId", "supplierId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_credit_applications_purchase_company_supplier_fkey" FOREIGN KEY ("targetPurchaseInvoiceId", "companyId", "supplierId") REFERENCES "purchase_invoices"("id", "companyId", "supplierId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_credit_applications_due_purchase_fkey" FOREIGN KEY ("targetDueDateId", "targetPurchaseInvoiceId") REFERENCES "purchase_due_dates"("id", "purchaseInvoiceId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_credit_applications_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_credit_refunds"
  ADD CONSTRAINT "supplier_credit_refunds_credit_company_supplier_fkey" FOREIGN KEY ("creditId", "companyId", "supplierId") REFERENCES "supplier_credits"("id", "companyId", "supplierId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_credit_refunds_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_credit_refunds_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_credit_refunds_bank_company_fkey" FOREIGN KEY ("bankAccountId", "companyId") REFERENCES "bank_accounts"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_credit_refunds_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_credit_refunds_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_credit_refunds_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_credit_refunds_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "accounting_journal_entries" ADD COLUMN "supplierCreditRefundId" UUID;
CREATE UNIQUE INDEX "accounting_journal_entries_supplierCreditRefundId_key" ON "accounting_journal_entries"("supplierCreditRefundId");
ALTER TABLE "accounting_journal_entries" ADD CONSTRAINT "accounting_journal_entries_supplierCreditRefundId_fkey" FOREIGN KEY ("supplierCreditRefundId") REFERENCES "supplier_credit_refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "accounting_journal_entries" DROP CONSTRAINT IF EXISTS "accounting_journal_entries_origin_source_check";
ALTER TABLE "accounting_journal_entries" ADD CONSTRAINT "accounting_journal_entries_origin_source_check" CHECK (
  ("origin" = 'INVOICE' AND "invoiceId" IS NOT NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
  OR ("origin" = 'INVOICE_VOIDING' AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NOT NULL AND "reversesEntryId" IS NOT NULL)
  OR ("origin" = 'CUSTOMER_PAYMENT' AND "customerPaymentId" IS NOT NULL AND "invoiceId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
  OR ("origin" = 'CUSTOMER_PAYMENT_RETURN' AND "customerPaymentReturnId" IS NOT NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
  OR ("origin" = 'CUSTOMER_CREDIT_REFUND' AND "customerCreditRefundId" IS NOT NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
  OR ("origin" = 'PURCHASE_INVOICE' AND "purchaseInvoiceId" IS NOT NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
  OR ("origin" = 'PURCHASE_RECTIFICATION' AND "purchaseInvoiceId" IS NOT NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NOT NULL)
  OR ("origin" = 'SUPPLIER_PAYMENT' AND "supplierPaymentId" IS NOT NULL AND "purchaseInvoiceId" IS NULL AND "supplierCreditRefundId" IS NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
  OR ("origin" = 'SUPPLIER_CREDIT_REFUND' AND "supplierCreditRefundId" IS NOT NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
  OR ("origin" IN ('MANUAL', 'REGULARIZATION', 'CLOSING', 'OPENING') AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "purchaseInvoiceId" IS NULL AND "supplierPaymentId" IS NULL AND "supplierCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
);

CREATE FUNCTION supplier_credit_available(p_credit_id UUID) RETURNS DECIMAL LANGUAGE sql STABLE AS $$
  SELECT credit."originalAmount"
    - COALESCE((SELECT SUM(application."amount") FROM "supplier_credit_applications" application WHERE application."creditId" = credit."id"), 0)
    - COALESCE((SELECT SUM(refund."amount") FROM "supplier_credit_refunds" refund WHERE refund."creditId" = credit."id" AND refund."status" <> 'CANCELLED'), 0)
  FROM "supplier_credits" credit WHERE credit."id" = p_credit_id;
$$;

CREATE FUNCTION validate_supplier_credit_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_row "purchase_invoices"%ROWTYPE; original_row "purchase_invoices"%ROWTYPE; paid_amount NUMERIC;
BEGIN
  SELECT * INTO source_row FROM "purchase_invoices" WHERE "id" = NEW."sourceRectificationPurchaseInvoiceId" FOR SHARE;
  SELECT * INTO original_row FROM "purchase_invoices" WHERE "id" = source_row."rectifiesPurchaseInvoiceId" FOR SHARE;
  SELECT COALESCE(SUM(allocation."amount"), 0) INTO paid_amount FROM "supplier_payment_allocations" allocation
    JOIN "supplier_payments" payment ON payment."id" = allocation."supplierPaymentId"
    WHERE allocation."purchaseInvoiceId" = original_row."id" AND payment."status" = 'POSTED';
  IF source_row."id" IS NULL OR source_row."documentType" <> 'RECTIFICATION' OR source_row."status" <> 'REGISTERED' OR source_row."total" >= 0
     OR source_row."companyId" <> NEW."companyId" OR source_row."supplierId" <> NEW."supplierId" OR NEW."originalAmount" <> abs(source_row."total")
     OR original_row."id" IS NULL OR original_row."status" <> 'RECTIFIED' OR original_row."paymentStatus" <> 'PAID'
     OR paid_amount <> original_row."total" OR EXISTS (SELECT 1 FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = original_row."id" AND "status" <> 'PAID') THEN
    RAISE EXCEPTION 'INVALID_SUPPLIER_CREDIT_SOURCE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "supplier_credits_validate_source" BEFORE INSERT ON "supplier_credits" FOR EACH ROW EXECUTE FUNCTION validate_supplier_credit_source();

CREATE FUNCTION validate_supplier_credit_application() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE credit_row "supplier_credits"%ROWTYPE; source_row "purchase_invoices"%ROWTYPE; target_row "purchase_invoices"%ROWTYPE; due_row "purchase_due_dates"%ROWTYPE; settled NUMERIC;
BEGIN
  SELECT * INTO credit_row FROM "supplier_credits" WHERE "id" = NEW."creditId" FOR UPDATE;
  SELECT * INTO source_row FROM "purchase_invoices" WHERE "id" = credit_row."sourceRectificationPurchaseInvoiceId";
  SELECT * INTO target_row FROM "purchase_invoices" WHERE "id" = NEW."targetPurchaseInvoiceId" FOR UPDATE;
  SELECT * INTO due_row FROM "purchase_due_dates" WHERE "id" = NEW."targetDueDateId" FOR UPDATE;
  SELECT COALESCE(SUM(allocation."amount") FILTER (WHERE payment."status" = 'POSTED'), 0)
       + COALESCE((SELECT SUM(application."amount") FROM "supplier_credit_applications" application WHERE application."targetDueDateId" = due_row."id"), 0)
    INTO settled FROM "supplier_payment_allocations" allocation JOIN "supplier_payments" payment ON payment."id" = allocation."supplierPaymentId"
    WHERE allocation."dueDateId" = due_row."id";
  IF credit_row."id" IS NULL OR target_row."id" IS NULL OR due_row."id" IS NULL OR NEW."companyId" <> credit_row."companyId" OR NEW."supplierId" <> credit_row."supplierId"
     OR target_row."companyId" <> credit_row."companyId" OR target_row."supplierId" <> credit_row."supplierId" OR target_row."documentType" <> 'STANDARD'
     OR target_row."status" <> 'REGISTERED' OR due_row."purchaseInvoiceId" <> target_row."id" OR due_row."status" <> 'PENDING'
     OR NEW."applicationDate" < source_row."issueDate" OR NEW."applicationDate" < target_row."issueDate" THEN
    RAISE EXCEPTION 'INVALID_SUPPLIER_CREDIT_TARGET' USING ERRCODE = '23514';
  END IF;
  IF supplier_credit_available(NEW."creditId") < NEW."amount" THEN RAISE EXCEPTION 'SUPPLIER_CREDIT_AMOUNT_EXCEEDS_AVAILABLE' USING ERRCODE = '23514'; END IF;
  IF NEW."amount" > due_row."amount" - settled THEN RAISE EXCEPTION 'SUPPLIER_CREDIT_AMOUNT_EXCEEDS_PENDING' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "supplier_credit_applications_validate" BEFORE INSERT ON "supplier_credit_applications" FOR EACH ROW EXECUTE FUNCTION validate_supplier_credit_application();

CREATE FUNCTION validate_supplier_credit_refund() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE credit_row "supplier_credits"%ROWTYPE; source_date DATE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO credit_row FROM "supplier_credits" WHERE "id" = NEW."creditId" FOR UPDATE;
    SELECT "issueDate" INTO source_date FROM "purchase_invoices" WHERE "id" = credit_row."sourceRectificationPurchaseInvoiceId";
    IF NEW."status" <> 'REQUESTED' OR credit_row."id" IS NULL OR credit_row."companyId" <> NEW."companyId" OR credit_row."supplierId" <> NEW."supplierId"
       OR NEW."requestedDate" < source_date OR supplier_credit_available(NEW."creditId") < NEW."amount" OR NEW."paymentMethod" NOT IN ('BANK_TRANSFER', 'CASH')
       OR (NEW."paymentMethod" = 'BANK_TRANSFER' AND NOT EXISTS (SELECT 1 FROM "bank_accounts" account WHERE account."id" = NEW."bankAccountId" AND account."companyId" = NEW."companyId" AND account."status" = 'ACTIVE' AND account."currency" = credit_row."currency")) THEN
      RAISE EXCEPTION 'INVALID_SUPPLIER_CREDIT_REFUND' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF OLD."creditId" <> NEW."creditId" OR OLD."companyId" <> NEW."companyId" OR OLD."supplierId" <> NEW."supplierId" OR OLD."bankAccountId" IS DISTINCT FROM NEW."bankAccountId"
       OR OLD."paymentMethod" <> NEW."paymentMethod" OR OLD."requestedDate" <> NEW."requestedDate" OR OLD."amount" <> NEW."amount"
       OR OLD."reasonCode" <> NEW."reasonCode" OR OLD."reference" IS DISTINCT FROM NEW."reference" OR OLD."notes" IS DISTINCT FROM NEW."notes" OR OLD."requestedById" <> NEW."requestedById"
       OR OLD."createdAt" <> NEW."createdAt" THEN
      RAISE EXCEPTION 'SUPPLIER_CREDIT_REFUND_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF NOT ((OLD."status" = 'REQUESTED' AND NEW."status" IN ('APPROVED', 'CANCELLED')) OR (OLD."status" = 'APPROVED' AND NEW."status" = 'POSTED')) THEN
      RAISE EXCEPTION 'INVALID_SUPPLIER_CREDIT_REFUND_TRANSITION' USING ERRCODE = '23514';
    END IF;
    IF OLD."status" = 'APPROVED' AND (NEW."approvedById" IS DISTINCT FROM OLD."approvedById" OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt") THEN
      RAISE EXCEPTION 'SUPPLIER_CREDIT_REFUND_APPROVAL_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF NEW."status" = 'POSTED' AND (NEW."postingDate" < NEW."requestedDate"
       OR NOT EXISTS (SELECT 1 FROM "accounting_fiscal_years" year WHERE year."companyId" = NEW."companyId" AND year."status" = 'OPEN' AND year."startDate" <= NEW."postingDate" AND year."endDate" >= NEW."postingDate")
       OR (NEW."paymentMethod" = 'BANK_TRANSFER' AND NOT EXISTS (SELECT 1 FROM "bank_accounts" account JOIN "supplier_credits" credit ON credit."id" = NEW."creditId" WHERE account."id" = NEW."bankAccountId" AND account."companyId" = NEW."companyId" AND account."status" = 'ACTIVE' AND account."currency" = credit."currency"))) THEN
      RAISE EXCEPTION 'INVALID_SUPPLIER_CREDIT_REFUND_POSTING' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "supplier_credit_refunds_validate" BEFORE INSERT OR UPDATE ON "supplier_credit_refunds" FOR EACH ROW EXECUTE FUNCTION validate_supplier_credit_refund();

CREATE FUNCTION prevent_supplier_credit_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'SUPPLIER_CREDIT_LEDGER_APPEND_ONLY' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER "supplier_credits_append_only" BEFORE UPDATE OR DELETE ON "supplier_credits" FOR EACH ROW EXECUTE FUNCTION prevent_supplier_credit_ledger_mutation();
CREATE TRIGGER "supplier_credit_applications_append_only" BEFORE UPDATE OR DELETE ON "supplier_credit_applications" FOR EACH ROW EXECUTE FUNCTION prevent_supplier_credit_ledger_mutation();
CREATE TRIGGER "supplier_credit_refunds_no_delete" BEFORE DELETE ON "supplier_credit_refunds" FOR EACH ROW EXECUTE FUNCTION prevent_supplier_credit_ledger_mutation();

DO $migration$
DECLARE definition TEXT; changed TEXT;
BEGIN
  definition := pg_get_functiondef('prevent_registered_purchase_change()'::regprocedure);
  changed := replace(definition,
    'AND OLD."documentType" = ''STANDARD'' AND NEW."paymentStatus" = ''NOT_APPLICABLE''',
    'AND OLD."documentType" = ''STANDARD'' AND ((OLD."paymentStatus" = ''PENDING'' AND NEW."paymentStatus" = ''NOT_APPLICABLE'') OR (OLD."paymentStatus" = ''PAID'' AND NEW."paymentStatus" = ''PAID''))');
  IF changed = definition THEN RAISE EXCEPTION 'Could not patch rectification payment transition'; END IF;
  definition := changed;
  changed := replace(definition,
    '(OLD."paymentStatus" = ''PENDING'' AND NEW."paymentStatus" IN (''PENDING'', ''PARTIALLY_PAID'', ''PAID''))
    OR (OLD."paymentStatus" = ''PARTIALLY_PAID'' AND NEW."paymentStatus" IN (''PARTIALLY_PAID'', ''PAID''))
    OR (OLD."paymentStatus" IN (''PAID'', ''NOT_APPLICABLE'') AND NEW."paymentStatus" = OLD."paymentStatus")',
    '(OLD."paymentStatus" = ''PENDING'' AND NEW."paymentStatus" IN (''PENDING'', ''PARTIALLY_PAID'', ''PAID'', ''PARTIALLY_SETTLED'', ''SETTLED''))
    OR (OLD."paymentStatus" = ''PARTIALLY_PAID'' AND NEW."paymentStatus" IN (''PARTIALLY_PAID'', ''PAID'', ''PARTIALLY_SETTLED'', ''SETTLED''))
    OR (OLD."paymentStatus" = ''PARTIALLY_SETTLED'' AND NEW."paymentStatus" IN (''PARTIALLY_SETTLED'', ''SETTLED''))
    OR (OLD."paymentStatus" IN (''PAID'', ''SETTLED'', ''NOT_APPLICABLE'') AND NEW."paymentStatus" = OLD."paymentStatus")');
  IF changed = definition THEN RAISE EXCEPTION 'Could not patch settled payment transitions'; END IF;
  EXECUTE changed;

  definition := pg_get_functiondef('validate_purchase_registration()'::regprocedure);
  changed := replace(definition,
    'OR EXISTS (SELECT 1 FROM "supplier_payment_allocations" WHERE "purchaseInvoiceId" = original."id")',
    'OR (EXISTS (SELECT 1 FROM "supplier_payment_allocations" WHERE "purchaseInvoiceId" = original."id") AND (
           original."paymentStatus" <> ''PAID''
           OR EXISTS (SELECT 1 FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = original."id" AND "status" <> ''PAID'')
           OR EXISTS (SELECT 1 FROM "supplier_payment_allocations" allocation JOIN "supplier_payments" payment ON payment."id" = allocation."supplierPaymentId" WHERE allocation."purchaseInvoiceId" = original."id" AND payment."status" <> ''POSTED'')
           OR (SELECT COALESCE(SUM(allocation."amount"), 0) FROM "supplier_payment_allocations" allocation JOIN "supplier_payments" payment ON payment."id" = allocation."supplierPaymentId" WHERE allocation."purchaseInvoiceId" = original."id" AND payment."status" = ''POSTED'') <> original."total"
         ))');
  IF changed = definition THEN RAISE EXCEPTION 'Could not patch validate_purchase_registration'; END IF;
  EXECUTE changed;
END;
$migration$;

CREATE OR REPLACE FUNCTION validate_supplier_payment_allocation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment_row "supplier_payments"%ROWTYPE; purchase_row "purchase_invoices"%ROWTYPE; due_row "purchase_due_dates"%ROWTYPE; settled NUMERIC;
BEGIN
  SELECT * INTO payment_row FROM "supplier_payments" WHERE "id" = NEW."supplierPaymentId" FOR UPDATE;
  SELECT * INTO purchase_row FROM "purchase_invoices" WHERE "id" = NEW."purchaseInvoiceId" FOR UPDATE;
  SELECT * INTO due_row FROM "purchase_due_dates" WHERE "id" = NEW."dueDateId" FOR UPDATE;
  SELECT COALESCE(SUM(allocation."amount"), 0)
       + COALESCE((SELECT SUM(application."amount") FROM "supplier_credit_applications" application WHERE application."targetDueDateId" = NEW."dueDateId"), 0)
    INTO settled FROM "supplier_payment_allocations" allocation
    WHERE allocation."dueDateId" = NEW."dueDateId" AND allocation."id" <> NEW."id";
  IF payment_row."companyId" <> purchase_row."companyId" OR payment_row."supplierId" <> purchase_row."supplierId"
     OR due_row."purchaseInvoiceId" <> purchase_row."id" OR purchase_row."status" <> 'REGISTERED'
     OR due_row."status" <> 'PENDING' OR payment_row."status" <> 'POSTED' OR settled + NEW."amount" > due_row."amount" THEN
    RAISE EXCEPTION 'INVALID_SUPPLIER_PAYMENT_ALLOCATION' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER "purchase_rectification_state_from_invoice" ON "purchase_invoices";
DROP TRIGGER "purchase_rectification_state_from_due_date" ON "purchase_due_dates";
DROP FUNCTION validate_purchase_rectification_state();
CREATE FUNCTION validate_purchase_rectification_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root_id UUID; original "purchase_invoices"%ROWTYPE; registered_children INTEGER; credit_count INTEGER; paid_amount NUMERIC;
BEGIN
  IF TG_TABLE_NAME = 'purchase_due_dates' THEN
    root_id := COALESCE(NEW."purchaseInvoiceId", OLD."purchaseInvoiceId");
  ELSIF TG_TABLE_NAME = 'supplier_credits' THEN
    SELECT "rectifiesPurchaseInvoiceId" INTO root_id FROM "purchase_invoices" WHERE "id" = COALESCE(NEW."sourceRectificationPurchaseInvoiceId", OLD."sourceRectificationPurchaseInvoiceId");
  ELSE
    root_id := COALESCE(NEW."rectifiesPurchaseInvoiceId", NEW."id", OLD."rectifiesPurchaseInvoiceId", OLD."id");
  END IF;
  SELECT * INTO original FROM "purchase_invoices" WHERE "id" = root_id;
  IF original."id" IS NULL OR original."documentType" <> 'STANDARD' THEN RETURN NULL; END IF;
  SELECT COUNT(*) INTO registered_children FROM "purchase_invoices" WHERE "rectifiesPurchaseInvoiceId" = root_id AND "documentType" = 'RECTIFICATION' AND "status" = 'REGISTERED';
  SELECT COUNT(*) INTO credit_count FROM "supplier_credits" credit JOIN "purchase_invoices" child ON child."id" = credit."sourceRectificationPurchaseInvoiceId" WHERE child."rectifiesPurchaseInvoiceId" = root_id;
  SELECT COALESCE(SUM(allocation."amount"), 0) INTO paid_amount FROM "supplier_payment_allocations" allocation JOIN "supplier_payments" payment ON payment."id" = allocation."supplierPaymentId" WHERE allocation."purchaseInvoiceId" = root_id AND payment."status" = 'POSTED';
  IF registered_children > 0 AND (
    original."status" <> 'RECTIFIED'
    OR NOT (
      (original."paymentStatus" = 'NOT_APPLICABLE' AND credit_count = 0 AND paid_amount = 0 AND NOT EXISTS (SELECT 1 FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = root_id AND "status" <> 'CANCELLED'))
      OR (original."paymentStatus" = 'PAID' AND credit_count = 1 AND paid_amount = original."total" AND NOT EXISTS (SELECT 1 FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = root_id AND "status" <> 'PAID'))
    )
    OR EXISTS (SELECT 1 FROM "purchase_invoices" child WHERE child."rectifiesPurchaseInvoiceId" = root_id AND child."status" = 'REGISTERED' AND (child."paymentStatus" <> 'NOT_APPLICABLE' OR EXISTS (SELECT 1 FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = child."id")))
  ) THEN RAISE EXCEPTION 'PURCHASE_RECTIFICATION_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
  IF original."status" = 'RECTIFIED' AND registered_children <> 1 THEN RAISE EXCEPTION 'PURCHASE_RECTIFICATION_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "purchase_rectification_state_from_invoice" AFTER INSERT OR UPDATE ON "purchase_invoices" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_purchase_rectification_state();
CREATE CONSTRAINT TRIGGER "purchase_rectification_state_from_due_date" AFTER INSERT OR UPDATE OR DELETE ON "purchase_due_dates" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_purchase_rectification_state();
CREATE CONSTRAINT TRIGGER "purchase_rectification_state_from_supplier_credit" AFTER INSERT OR UPDATE OR DELETE ON "supplier_credits" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_purchase_rectification_state();

CREATE FUNCTION validate_supplier_purchase_settlement_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purchase_id UUID; purchase_row "purchase_invoices"%ROWTYPE; due_row RECORD; cash_total NUMERIC := 0; credit_total NUMERIC := 0; due_cash NUMERIC; due_credit NUMERIC; expected_due "PurchaseDueDateStatus"; expected_purchase "PurchasePaymentStatus";
BEGIN
  IF TG_TABLE_NAME = 'purchase_invoices' THEN purchase_id := COALESCE(NEW."id", OLD."id");
  ELSIF TG_TABLE_NAME = 'purchase_due_dates' THEN purchase_id := COALESCE(NEW."purchaseInvoiceId", OLD."purchaseInvoiceId");
  ELSIF TG_TABLE_NAME = 'supplier_payment_allocations' THEN purchase_id := COALESCE(NEW."purchaseInvoiceId", OLD."purchaseInvoiceId");
  ELSE purchase_id := COALESCE(NEW."targetPurchaseInvoiceId", OLD."targetPurchaseInvoiceId"); END IF;
  SELECT * INTO purchase_row FROM "purchase_invoices" WHERE "id" = purchase_id;
  IF purchase_row."id" IS NULL OR purchase_row."documentType" <> 'STANDARD' OR purchase_row."status" NOT IN ('REGISTERED', 'RECTIFIED') THEN RETURN NULL; END IF;
  IF purchase_row."status" = 'RECTIFIED' AND purchase_row."paymentStatus" = 'NOT_APPLICABLE' THEN RETURN NULL; END IF;
  FOR due_row IN SELECT * FROM "purchase_due_dates" WHERE "purchaseInvoiceId" = purchase_id LOOP
    SELECT COALESCE(SUM(allocation."amount") FILTER (WHERE payment."status" = 'POSTED'), 0) INTO due_cash
      FROM "supplier_payment_allocations" allocation JOIN "supplier_payments" payment ON payment."id" = allocation."supplierPaymentId" WHERE allocation."dueDateId" = due_row."id";
    SELECT COALESCE(SUM(application."amount"), 0) INTO due_credit FROM "supplier_credit_applications" application WHERE application."targetDueDateId" = due_row."id";
    IF due_cash + due_credit > due_row."amount" THEN RAISE EXCEPTION 'SUPPLIER_PURCHASE_SETTLEMENT_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
    expected_due := CASE WHEN due_cash + due_credit = due_row."amount" THEN CASE WHEN due_credit > 0 THEN 'SETTLED'::"PurchaseDueDateStatus" ELSE 'PAID'::"PurchaseDueDateStatus" END ELSE 'PENDING'::"PurchaseDueDateStatus" END;
    IF due_row."status" <> expected_due THEN RAISE EXCEPTION 'SUPPLIER_PURCHASE_SETTLEMENT_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
    cash_total := cash_total + due_cash; credit_total := credit_total + due_credit;
  END LOOP;
  IF purchase_row."status" = 'RECTIFIED' THEN
    IF purchase_row."paymentStatus" <> 'PAID' OR credit_total <> 0 OR cash_total <> purchase_row."total" THEN RAISE EXCEPTION 'SUPPLIER_PURCHASE_SETTLEMENT_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
    RETURN NULL;
  END IF;
  expected_purchase := CASE
    WHEN cash_total + credit_total = 0 THEN 'PENDING'::"PurchasePaymentStatus"
    WHEN cash_total + credit_total >= purchase_row."total" AND credit_total > 0 THEN 'SETTLED'::"PurchasePaymentStatus"
    WHEN cash_total + credit_total >= purchase_row."total" THEN 'PAID'::"PurchasePaymentStatus"
    WHEN credit_total > 0 THEN 'PARTIALLY_SETTLED'::"PurchasePaymentStatus"
    ELSE 'PARTIALLY_PAID'::"PurchasePaymentStatus" END;
  IF purchase_row."paymentStatus" <> expected_purchase THEN RAISE EXCEPTION 'SUPPLIER_PURCHASE_SETTLEMENT_STATE_MISMATCH' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "supplier_purchase_settlement_from_purchase" AFTER UPDATE ON "purchase_invoices" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status" OR OLD."paymentStatus" IS DISTINCT FROM NEW."paymentStatus") EXECUTE FUNCTION validate_supplier_purchase_settlement_state();
CREATE CONSTRAINT TRIGGER "supplier_purchase_settlement_from_due" AFTER UPDATE ON "purchase_due_dates" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status") EXECUTE FUNCTION validate_supplier_purchase_settlement_state();
CREATE CONSTRAINT TRIGGER "supplier_purchase_settlement_from_payment" AFTER INSERT OR UPDATE OR DELETE ON "supplier_payment_allocations" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_supplier_purchase_settlement_state();
CREATE CONSTRAINT TRIGGER "supplier_purchase_settlement_from_credit" AFTER INSERT OR UPDATE OR DELETE ON "supplier_credit_applications" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_supplier_purchase_settlement_state();

CREATE FUNCTION prevent_supplier_credit_refund_accounting_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_origin "AccountingEntryOrigin"; refund_status "SupplierCreditRefundStatus";
BEGIN
  IF TG_TABLE_NAME = 'accounting_journal_entries' THEN
    IF TG_OP <> 'INSERT' AND OLD."origin" = 'SUPPLIER_CREDIT_REFUND' THEN RAISE EXCEPTION 'SUPPLIER_CREDIT_REFUND_ACCOUNTING_IMMUTABLE' USING ERRCODE = '23514'; END IF;
  ELSE
    SELECT entry."origin", refund."status" INTO entry_origin, refund_status FROM "accounting_journal_entries" entry LEFT JOIN "supplier_credit_refunds" refund ON refund."id" = entry."supplierCreditRefundId" WHERE entry."id" = COALESCE(NEW."entryId", OLD."entryId");
    IF entry_origin = 'SUPPLIER_CREDIT_REFUND' AND (TG_OP <> 'INSERT' OR refund_status <> 'APPROVED') THEN RAISE EXCEPTION 'SUPPLIER_CREDIT_REFUND_ACCOUNTING_IMMUTABLE' USING ERRCODE = '23514'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "supplier_credit_refund_entries_immutable" BEFORE UPDATE OR DELETE ON "accounting_journal_entries" FOR EACH ROW EXECUTE FUNCTION prevent_supplier_credit_refund_accounting_change();
CREATE TRIGGER "supplier_credit_refund_lines_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "accounting_journal_lines" FOR EACH ROW EXECUTE FUNCTION prevent_supplier_credit_refund_accounting_change();

CREATE FUNCTION validate_supplier_credit_refund_accounting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE refund_id UUID; refund_row "supplier_credit_refunds"%ROWTYPE; entry_row "accounting_journal_entries"%ROWTYPE; entry_count INTEGER; fiscal_company UUID; treasury_code VARCHAR(9); supplier_code VARCHAR(9); valid_lines INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'supplier_credit_refunds' THEN refund_id := COALESCE(NEW."id", OLD."id");
  ELSIF TG_TABLE_NAME = 'accounting_journal_entries' THEN refund_id := COALESCE(NEW."supplierCreditRefundId", OLD."supplierCreditRefundId");
  ELSE SELECT "supplierCreditRefundId" INTO refund_id FROM "accounting_journal_entries" WHERE "id" = COALESCE(NEW."entryId", OLD."entryId"); END IF;
  IF refund_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO refund_row FROM "supplier_credit_refunds" WHERE "id" = refund_id;
  SELECT COUNT(*) INTO entry_count FROM "accounting_journal_entries" WHERE "supplierCreditRefundId" = refund_id;
  IF refund_row."status" <> 'POSTED' THEN
    IF entry_count <> 0 THEN RAISE EXCEPTION 'SUPPLIER_CREDIT_REFUND_ACCOUNTING_MISMATCH' USING ERRCODE = '23514'; END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO entry_row FROM "accounting_journal_entries" WHERE "supplierCreditRefundId" = refund_id;
  SELECT year."companyId" INTO fiscal_company FROM "accounting_fiscal_years" year WHERE year."id" = entry_row."fiscalYearId";
  SELECT "accountingCode" INTO supplier_code FROM "suppliers" WHERE "id" = refund_row."supplierId";
  treasury_code := CASE WHEN refund_row."paymentMethod" = 'CASH' THEN '570000000' ELSE '572000000' END;
  SELECT COUNT(*) INTO valid_lines FROM "accounting_journal_lines" line JOIN "accounting_accounts" account ON account."id" = line."accountId" WHERE line."entryId" = entry_row."id" AND account."status" = 'ACTIVE' AND account."isPostable" = TRUE AND ((account."code" = treasury_code AND line."debit" = refund_row."amount" AND line."credit" = 0) OR (account."code" = supplier_code AND line."debit" = 0 AND line."credit" = refund_row."amount"));
  IF entry_count <> 1 OR entry_row."origin" <> 'SUPPLIER_CREDIT_REFUND' OR entry_row."status" <> 'POSTED' OR fiscal_company <> refund_row."companyId"
     OR entry_row."createdById" <> refund_row."postedById" OR entry_row."accountingDate" <> refund_row."postingDate" OR entry_row."totalDebit" <> refund_row."amount" OR entry_row."totalCredit" <> refund_row."amount"
     OR valid_lines <> 2 OR (SELECT COUNT(*) FROM "accounting_journal_lines" WHERE "entryId" = entry_row."id") <> 2 THEN
    RAISE EXCEPTION 'SUPPLIER_CREDIT_REFUND_ACCOUNTING_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "supplier_credit_refund_accounting_from_refund" AFTER INSERT OR UPDATE OR DELETE ON "supplier_credit_refunds" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_supplier_credit_refund_accounting();
CREATE CONSTRAINT TRIGGER "supplier_credit_refund_accounting_from_entry" AFTER INSERT OR UPDATE OR DELETE ON "accounting_journal_entries" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_supplier_credit_refund_accounting();
CREATE CONSTRAINT TRIGGER "supplier_credit_refund_accounting_from_line" AFTER INSERT OR UPDATE OR DELETE ON "accounting_journal_lines" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_supplier_credit_refund_accounting();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt") VALUES
  (gen_random_uuid(), 'Treasury.ViewSupplierCredits', 'Consultar creditos de proveedores', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Treasury.ApplySupplierCredits', 'Compensar creditos de proveedores', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Treasury.RequestSupplierRefunds', 'Solicitar reembolsos de proveedores', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Treasury.ApproveSupplierRefunds', 'Aprobar reembolsos de proveedores', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Treasury.PostSupplierRefunds', 'Contabilizar reembolsos de proveedores', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id" FROM "roles" role CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador' AND permission."code" IN ('Treasury.ViewSupplierCredits', 'Treasury.ApplySupplierCredits', 'Treasury.RequestSupplierRefunds', 'Treasury.ApproveSupplierRefunds', 'Treasury.PostSupplierRefunds')
ON CONFLICT DO NOTHING;

COMMIT;
