BEGIN;

CREATE TABLE "customer_credits" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "sourceRectificationInvoiceId" UUID NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
  "originalAmount" DECIMAL(14,2) NOT NULL,
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_credits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_credits_amount_check" CHECK ("originalAmount" > 0),
  CONSTRAINT "customer_credits_currency_check" CHECK ("currency" = 'EUR'),
  CONSTRAINT "customer_credits_id_company_customer_key" UNIQUE ("id", "companyId", "customerId")
);

CREATE UNIQUE INDEX "customer_credits_sourceRectificationInvoiceId_key"
  ON "customer_credits"("sourceRectificationInvoiceId");
CREATE INDEX "customer_credits_customerId_createdAt_id_idx"
  ON "customer_credits"("customerId", "createdAt", "id");
CREATE INDEX "customer_credits_companyId_createdAt_id_idx"
  ON "customer_credits"("companyId", "createdAt", "id");

CREATE TABLE "customer_credit_applications" (
  "id" UUID NOT NULL,
  "creditId" UUID NOT NULL,
  "targetInvoiceId" UUID NOT NULL,
  "targetDueDateId" UUID NOT NULL,
  "applicationDate" DATE NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "notes" VARCHAR(500),
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_credit_applications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_credit_applications_amount_check" CHECK ("amount" > 0)
);

CREATE INDEX "customer_credit_applications_creditId_applicationDate_id_idx"
  ON "customer_credit_applications"("creditId", "applicationDate", "id");
CREATE INDEX "customer_credit_applications_targetInvoiceId_applicationDate_id_idx"
  ON "customer_credit_applications"("targetInvoiceId", "applicationDate", "id");
CREATE INDEX "customer_credit_applications_targetDueDateId_createdAt_id_idx"
  ON "customer_credit_applications"("targetDueDateId", "createdAt", "id");
CREATE INDEX "customer_credit_applications_createdById_createdAt_idx"
  ON "customer_credit_applications"("createdById", "createdAt");

CREATE TABLE "customer_credit_refunds" (
  "id" UUID NOT NULL,
  "creditId" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "bankAccountId" UUID NOT NULL,
  "status" "CustomerCreditRefundStatus" NOT NULL DEFAULT 'REQUESTED',
  "requestedDate" DATE NOT NULL,
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
  CONSTRAINT "customer_credit_refunds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_credit_refunds_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "customer_credit_refunds_actor_state_check" CHECK (
    ("status" = 'REQUESTED' AND "approvedById" IS NULL AND "approvedAt" IS NULL AND "postedById" IS NULL AND "postedAt" IS NULL AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'APPROVED' AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "postedById" IS NULL AND "postedAt" IS NULL AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'POSTED' AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "postedById" IS NOT NULL AND "postedAt" IS NOT NULL AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'CANCELLED' AND "postedById" IS NULL AND "postedAt" IS NULL AND "cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL)
  ),
  CONSTRAINT "customer_credit_refunds_maker_checker_check" CHECK ("approvedById" IS NULL OR "approvedById" <> "requestedById")
);

CREATE INDEX "customer_credit_refunds_creditId_requestedDate_id_idx"
  ON "customer_credit_refunds"("creditId", "requestedDate", "id");
CREATE INDEX "customer_credit_refunds_companyId_status_requestedDate_id_idx"
  ON "customer_credit_refunds"("companyId", "status", "requestedDate", "id");
CREATE INDEX "customer_credit_refunds_customerId_requestedDate_id_idx"
  ON "customer_credit_refunds"("customerId", "requestedDate", "id");
CREATE INDEX "customer_credit_refunds_bankAccountId_requestedDate_id_idx"
  ON "customer_credit_refunds"("bankAccountId", "requestedDate", "id");
CREATE INDEX "customer_credit_refunds_requestedById_createdAt_idx"
  ON "customer_credit_refunds"("requestedById", "createdAt");

ALTER TABLE "customer_credits"
  ADD CONSTRAINT "customer_credits_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "customer_credits_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "customer_credits_sourceRectificationInvoiceId_fkey" FOREIGN KEY ("sourceRectificationInvoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "customer_credits_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_credit_applications"
  ADD CONSTRAINT "customer_credit_applications_creditId_fkey" FOREIGN KEY ("creditId") REFERENCES "customer_credits"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "customer_credit_applications_targetInvoiceId_fkey" FOREIGN KEY ("targetInvoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "customer_credit_applications_targetDueDateId_fkey" FOREIGN KEY ("targetDueDateId") REFERENCES "invoice_due_dates"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "customer_credit_applications_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_credit_refunds"
  ADD CONSTRAINT "customer_credit_refunds_credit_company_customer_fkey" FOREIGN KEY ("creditId", "companyId", "customerId") REFERENCES "customer_credits"("id", "companyId", "customerId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "customer_credit_refunds_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "customer_credit_refunds_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "customer_credit_refunds_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "customer_credit_refunds_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "customer_credit_refunds_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "customer_credit_refunds_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "customer_credit_refunds_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "accounting_journal_entries"
  ADD COLUMN "customerCreditRefundId" UUID;
CREATE UNIQUE INDEX "accounting_journal_entries_customerCreditRefundId_key"
  ON "accounting_journal_entries"("customerCreditRefundId");
ALTER TABLE "accounting_journal_entries"
  ADD CONSTRAINT "accounting_journal_entries_customerCreditRefundId_fkey"
  FOREIGN KEY ("customerCreditRefundId") REFERENCES "customer_credit_refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "accounting_journal_entries"
  DROP CONSTRAINT IF EXISTS "accounting_journal_entries_origin_source_check";
ALTER TABLE "accounting_journal_entries"
  ADD CONSTRAINT "accounting_journal_entries_origin_source_check" CHECK (
    ("origin" = 'INVOICE' AND "invoiceId" IS NOT NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" = 'INVOICE_VOIDING' AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NOT NULL AND "reversesEntryId" IS NOT NULL)
    OR ("origin" = 'CUSTOMER_PAYMENT' AND "customerPaymentId" IS NOT NULL AND "invoiceId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" = 'CUSTOMER_PAYMENT_RETURN' AND "customerPaymentReturnId" IS NOT NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" = 'CUSTOMER_CREDIT_REFUND' AND "customerCreditRefundId" IS NOT NULL AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
    OR ("origin" IN ('MANUAL', 'REGULARIZATION', 'CLOSING', 'OPENING') AND "invoiceId" IS NULL AND "customerPaymentId" IS NULL AND "customerPaymentReturnId" IS NULL AND "customerCreditRefundId" IS NULL AND "voidsInvoiceId" IS NULL AND "reversesEntryId" IS NULL)
  );

CREATE OR REPLACE FUNCTION validate_customer_credit_source()
RETURNS trigger AS $$
DECLARE source_invoice "invoices"%ROWTYPE;
BEGIN
  SELECT * INTO source_invoice FROM "invoices" WHERE "id" = NEW."sourceRectificationInvoiceId" FOR SHARE;
  IF NOT FOUND OR source_invoice."documentType" <> 'RECTIFICATION' OR source_invoice."status" <> 'ISSUED' OR source_invoice."total" >= 0
     OR source_invoice."companyId" IS DISTINCT FROM NEW."companyId" OR source_invoice."customerId" <> NEW."customerId"
     OR NEW."originalAmount" <> abs(source_invoice."total") THEN
    RAISE EXCEPTION 'Invalid customer credit source.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "customer_credits_validate_source"
BEFORE INSERT ON "customer_credits"
FOR EACH ROW EXECUTE FUNCTION validate_customer_credit_source();

CREATE OR REPLACE FUNCTION customer_credit_available(p_credit_id UUID)
RETURNS DECIMAL AS $$
  SELECT credit."originalAmount"
    - COALESCE((SELECT SUM(application."amount") FROM "customer_credit_applications" application WHERE application."creditId" = credit."id"), 0)
    - COALESCE((SELECT SUM(refund."amount") FROM "customer_credit_refunds" refund WHERE refund."creditId" = credit."id" AND refund."status" <> 'CANCELLED'), 0)
  FROM "customer_credits" credit WHERE credit."id" = p_credit_id;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION validate_customer_credit_application()
RETURNS trigger AS $$
DECLARE credit_row "customer_credits"%ROWTYPE;
DECLARE target_invoice "invoices"%ROWTYPE;
DECLARE target_due_date "invoice_due_dates"%ROWTYPE;
DECLARE settled DECIMAL;
BEGIN
  SELECT * INTO credit_row FROM "customer_credits" WHERE "id" = NEW."creditId" FOR UPDATE;
  SELECT * INTO target_invoice FROM "invoices" WHERE "id" = NEW."targetInvoiceId" FOR UPDATE;
  SELECT * INTO target_due_date FROM "invoice_due_dates" WHERE "id" = NEW."targetDueDateId" FOR UPDATE;
  IF credit_row."id" IS NULL OR target_invoice."id" IS NULL OR target_due_date."id" IS NULL
     OR target_due_date."invoiceId" <> NEW."targetInvoiceId" OR target_invoice."status" <> 'ISSUED'
     OR target_invoice."documentType" <> 'STANDARD' OR target_invoice."companyId" IS DISTINCT FROM credit_row."companyId"
     OR target_invoice."customerId" <> credit_row."customerId" OR target_due_date."status" <> 'PENDING'
     OR NOT EXISTS (
       SELECT 1 FROM "invoices" source_invoice
       WHERE source_invoice."id" = credit_row."sourceRectificationInvoiceId"
         AND source_invoice."verifactuStatus" IN ('ACCEPTED', 'ACCEPTED_WITH_ERRORS', 'NOT_APPLICABLE')
     )
     OR EXISTS (SELECT 1 FROM "customer_remittance_lines" line WHERE line."dueDateId" = target_due_date."id" AND line."status" = 'ACTIVE') THEN
    RAISE EXCEPTION 'Invalid customer credit target.' USING ERRCODE = '23514';
  END IF;
  IF customer_credit_available(NEW."creditId") < NEW."amount" THEN
    RAISE EXCEPTION 'Customer credit amount exceeds available balance.' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(SUM(payment."amount" - COALESCE((SELECT SUM(payment_return."amount") FROM "customer_payment_returns" payment_return WHERE payment_return."paymentId" = payment."id"), 0)), 0)
    + COALESCE((SELECT SUM(application."amount") FROM "customer_credit_applications" application WHERE application."targetDueDateId" = target_due_date."id"), 0)
    INTO settled
    FROM "customer_payments" payment WHERE payment."dueDateId" = target_due_date."id";
  IF NEW."amount" > target_due_date."amount" - settled THEN
    RAISE EXCEPTION 'Customer credit amount exceeds target pending balance.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "customer_credit_applications_validate"
BEFORE INSERT ON "customer_credit_applications"
FOR EACH ROW EXECUTE FUNCTION validate_customer_credit_application();

CREATE OR REPLACE FUNCTION validate_customer_credit_refund()
RETURNS trigger AS $$
DECLARE credit_row "customer_credits"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'REQUESTED' THEN
      RAISE EXCEPTION 'Customer credit refunds must be inserted as requested.' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO credit_row FROM "customer_credits" WHERE "id" = NEW."creditId" FOR UPDATE;
    IF NOT FOUND OR credit_row."companyId" <> NEW."companyId" OR credit_row."customerId" <> NEW."customerId"
       OR NOT EXISTS (
         SELECT 1 FROM "invoices" source_invoice
         WHERE source_invoice."id" = credit_row."sourceRectificationInvoiceId"
           AND source_invoice."verifactuStatus" IN ('ACCEPTED', 'ACCEPTED_WITH_ERRORS', 'NOT_APPLICABLE')
       )
       OR customer_credit_available(NEW."creditId") < NEW."amount"
       OR NOT EXISTS (SELECT 1 FROM "bank_accounts" account WHERE account."id" = NEW."bankAccountId" AND account."companyId" = NEW."companyId" AND account."status" = 'ACTIVE') THEN
      RAISE EXCEPTION 'Invalid customer credit refund.' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF OLD."creditId" <> NEW."creditId" OR OLD."companyId" <> NEW."companyId" OR OLD."customerId" <> NEW."customerId"
       OR OLD."bankAccountId" <> NEW."bankAccountId" OR OLD."requestedDate" <> NEW."requestedDate"
       OR OLD."amount" <> NEW."amount" OR OLD."reasonCode" <> NEW."reasonCode"
       OR OLD."requestedById" <> NEW."requestedById" THEN
      RAISE EXCEPTION 'Customer credit refund economic fields are immutable.' USING ERRCODE = '23514';
    END IF;
    IF NOT ((OLD."status" = 'REQUESTED' AND NEW."status" IN ('APPROVED', 'CANCELLED')) OR (OLD."status" = 'APPROVED' AND NEW."status" = 'POSTED')) THEN
      RAISE EXCEPTION 'Invalid customer credit refund transition.' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "customer_credit_refunds_validate"
BEFORE INSERT OR UPDATE ON "customer_credit_refunds"
FOR EACH ROW EXECUTE FUNCTION validate_customer_credit_refund();

CREATE OR REPLACE FUNCTION prevent_customer_credit_ledger_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Customer credit ledger rows are append-only.' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "customer_credits_append_only"
BEFORE UPDATE OR DELETE ON "customer_credits"
FOR EACH ROW EXECUTE FUNCTION prevent_customer_credit_ledger_mutation();
CREATE TRIGGER "customer_credit_applications_append_only"
BEFORE UPDATE OR DELETE ON "customer_credit_applications"
FOR EACH ROW EXECUTE FUNCTION prevent_customer_credit_ledger_mutation();
CREATE TRIGGER "customer_credit_refunds_no_delete"
BEFORE DELETE ON "customer_credit_refunds"
FOR EACH ROW EXECUTE FUNCTION prevent_customer_credit_ledger_mutation();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt") VALUES
  (gen_random_uuid(), 'Treasury.ViewCustomerCredits', 'Consultar creditos de clientes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Treasury.ApplyCustomerCredits', 'Compensar creditos de clientes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Treasury.RequestCustomerRefunds', 'Solicitar reembolsos de creditos', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Treasury.ApproveCustomerRefunds', 'Aprobar reembolsos de creditos', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Treasury.PostCustomerRefunds', 'Contabilizar reembolsos de creditos', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT DISTINCT existing."roleId", added."id"
FROM "role_permissions" existing
JOIN "permissions" manage ON manage."id" = existing."permissionId" AND manage."code" = 'Treasury.ManagePayments'
CROSS JOIN "permissions" added
WHERE added."code" IN ('Treasury.ViewCustomerCredits', 'Treasury.ApplyCustomerCredits', 'Treasury.RequestCustomerRefunds', 'Treasury.ApproveCustomerRefunds', 'Treasury.PostCustomerRefunds')
ON CONFLICT DO NOTHING;

COMMIT;
