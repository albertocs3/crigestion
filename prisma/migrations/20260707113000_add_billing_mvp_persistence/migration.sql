CREATE TYPE "InvoiceDocumentType" AS ENUM ('STANDARD');

CREATE TYPE "InvoiceDocumentStatus" AS ENUM ('DRAFT', 'ISSUED', 'RECTIFIED', 'VOIDED');

CREATE TYPE "InvoicePaymentStatus" AS ENUM ('PENDING', 'PARTIALLY_PAID', 'PAID', 'UNPAID');

CREATE TYPE "InvoiceVerifactuStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'SENT', 'ACCEPTED', 'ACCEPTED_WITH_ERRORS', 'REJECTED');

CREATE TYPE "InvoiceOrigin" AS ENUM ('MANUAL', 'SUBSCRIPTION');

CREATE TYPE "InvoiceDueDateStatus" AS ENUM ('PENDING', 'PAID', 'RETURNED', 'UNPAID');

CREATE TABLE "invoice_number_sequences" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "series" VARCHAR(8) NOT NULL,
  "year" INTEGER NOT NULL,
  "nextNumber" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "invoice_number_sequences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invoice_number_sequences_nextNumber_positive_chk" CHECK ("nextNumber" > 0)
);

CREATE TABLE "invoices" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "documentType" "InvoiceDocumentType" NOT NULL DEFAULT 'STANDARD',
  "origin" "InvoiceOrigin" NOT NULL DEFAULT 'MANUAL',
  "status" "InvoiceDocumentStatus" NOT NULL DEFAULT 'DRAFT',
  "paymentStatus" "InvoicePaymentStatus" NOT NULL DEFAULT 'PENDING',
  "verifactuStatus" "InvoiceVerifactuStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
  "series" VARCHAR(8) NOT NULL DEFAULT 'F',
  "year" INTEGER NOT NULL,
  "numberSequence" INTEGER,
  "number" VARCHAR(20),
  "customerId" UUID NOT NULL,
  "customerCodeSnapshot" VARCHAR(20) NOT NULL,
  "customerLegalNameSnapshot" VARCHAR(200) NOT NULL,
  "customerTaxIdSnapshot" VARCHAR(32) NOT NULL,
  "customerFiscalTreatmentSnapshot" "CustomerFiscalTreatment" NOT NULL,
  "customerFiscalAddressSnapshot" JSONB NOT NULL,
  "issueDate" DATE NOT NULL,
  "operationDate" DATE NOT NULL,
  "issuedAt" TIMESTAMPTZ(3),
  "subtotal" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "discountTotal" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "taxableBase" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "taxAmount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "total" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "notes" VARCHAR(1000),
  "createdById" UUID NOT NULL,
  "updatedById" UUID,
  "issuedById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "invoices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invoices_year_range_chk" CHECK ("year" >= 2000 AND "year" <= 9999),
  CONSTRAINT "invoices_number_sequence_positive_chk" CHECK ("numberSequence" IS NULL OR "numberSequence" > 0),
  CONSTRAINT "invoices_amounts_non_negative_chk" CHECK (
    "subtotal" >= 0 AND
    "discountTotal" >= 0 AND
    "taxableBase" >= 0 AND
    "taxAmount" >= 0 AND
    "total" >= 0
  ),
  CONSTRAINT "invoices_issued_fields_chk" CHECK (
    ("status" <> 'ISSUED' AND "issuedAt" IS NULL AND "number" IS NULL AND "numberSequence" IS NULL AND "issuedById" IS NULL) OR
    ("status" = 'ISSUED' AND "issuedAt" IS NOT NULL AND "number" IS NOT NULL AND "numberSequence" IS NOT NULL AND "issuedById" IS NOT NULL)
  )
);

CREATE TABLE "invoice_lines" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "invoiceId" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "catalogItemId" UUID,
  "catalogItemCodeSnapshot" VARCHAR(20),
  "catalogItemKindSnapshot" "CatalogItemKind",
  "description" VARCHAR(500) NOT NULL,
  "quantity" DECIMAL(12, 3) NOT NULL,
  "unitPrice" DECIMAL(12, 2) NOT NULL,
  "discountPercent" DECIMAL(5, 2) NOT NULL DEFAULT 0,
  "discountAmount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "taxRateId" UUID NOT NULL,
  "taxRateCodeSnapshot" VARCHAR(40) NOT NULL,
  "taxRateNameSnapshot" VARCHAR(120) NOT NULL,
  "taxRateSnapshot" DECIMAL(5, 2) NOT NULL,
  "lineSubtotal" DECIMAL(12, 2) NOT NULL,
  "lineDiscountTotal" DECIMAL(12, 2) NOT NULL,
  "lineTaxableBase" DECIMAL(12, 2) NOT NULL,
  "lineTaxAmount" DECIMAL(12, 2) NOT NULL,
  "lineTotal" DECIMAL(12, 2) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invoice_lines_position_positive_chk" CHECK ("position" > 0),
  CONSTRAINT "invoice_lines_quantity_non_zero_chk" CHECK ("quantity" <> 0),
  CONSTRAINT "invoice_lines_tax_rate_range_chk" CHECK ("taxRateSnapshot" >= 0 AND "taxRateSnapshot" <= 100),
  CONSTRAINT "invoice_lines_discount_percent_range_chk" CHECK ("discountPercent" >= 0 AND "discountPercent" <= 100),
  CONSTRAINT "invoice_lines_amounts_non_negative_chk" CHECK (
    "unitPrice" >= 0 AND
    "discountAmount" >= 0 AND
    "lineSubtotal" >= 0 AND
    "lineDiscountTotal" >= 0 AND
    "lineTaxableBase" >= 0 AND
    "lineTaxAmount" >= 0 AND
    "lineTotal" >= 0
  )
);

CREATE TABLE "invoice_tax_summaries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "invoiceId" UUID NOT NULL,
  "taxRateCode" VARCHAR(40) NOT NULL,
  "taxRate" DECIMAL(5, 2) NOT NULL,
  "taxableBase" DECIMAL(12, 2) NOT NULL,
  "taxAmount" DECIMAL(12, 2) NOT NULL,
  "total" DECIMAL(12, 2) NOT NULL,

  CONSTRAINT "invoice_tax_summaries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invoice_tax_summaries_tax_rate_range_chk" CHECK ("taxRate" >= 0 AND "taxRate" <= 100),
  CONSTRAINT "invoice_tax_summaries_amounts_non_negative_chk" CHECK (
    "taxableBase" >= 0 AND
    "taxAmount" >= 0 AND
    "total" >= 0
  )
);

CREATE TABLE "invoice_due_dates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "invoiceId" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "dueDate" DATE NOT NULL,
  "amount" DECIMAL(12, 2) NOT NULL,
  "paymentMethod" "CustomerPaymentMethod" NOT NULL,
  "status" "InvoiceDueDateStatus" NOT NULL DEFAULT 'PENDING',

  CONSTRAINT "invoice_due_dates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invoice_due_dates_position_positive_chk" CHECK ("position" > 0),
  CONSTRAINT "invoice_due_dates_amount_non_negative_chk" CHECK ("amount" >= 0)
);

CREATE TABLE "invoice_verifactu_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "invoiceId" UUID NOT NULL,
  "status" "InvoiceVerifactuStatus" NOT NULL DEFAULT 'PENDING',
  "lastErrorCode" VARCHAR(120),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "invoice_verifactu_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invoice_number_sequences_series_year_key" ON "invoice_number_sequences"("series", "year");
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");
CREATE UNIQUE INDEX "invoices_series_year_numberSequence_key" ON "invoices"("series", "year", "numberSequence");
CREATE INDEX "invoices_status_issueDate_id_idx" ON "invoices"("status", "issueDate", "id");
CREATE INDEX "invoices_customerId_issueDate_id_idx" ON "invoices"("customerId", "issueDate", "id");
CREATE INDEX "invoices_paymentStatus_issueDate_id_idx" ON "invoices"("paymentStatus", "issueDate", "id");
CREATE INDEX "invoices_verifactuStatus_issueDate_id_idx" ON "invoices"("verifactuStatus", "issueDate", "id");
CREATE INDEX "invoices_createdById_createdAt_idx" ON "invoices"("createdById", "createdAt");

CREATE UNIQUE INDEX "invoice_lines_invoiceId_position_key" ON "invoice_lines"("invoiceId", "position");
CREATE INDEX "invoice_lines_catalogItemId_idx" ON "invoice_lines"("catalogItemId");
CREATE INDEX "invoice_lines_taxRateId_idx" ON "invoice_lines"("taxRateId");

CREATE UNIQUE INDEX "invoice_tax_summaries_invoiceId_taxRateCode_taxRate_key" ON "invoice_tax_summaries"("invoiceId", "taxRateCode", "taxRate");

CREATE UNIQUE INDEX "invoice_due_dates_invoiceId_position_key" ON "invoice_due_dates"("invoiceId", "position");
CREATE INDEX "invoice_due_dates_status_dueDate_id_idx" ON "invoice_due_dates"("status", "dueDate", "id");

CREATE UNIQUE INDEX "invoice_verifactu_records_invoiceId_key" ON "invoice_verifactu_records"("invoiceId");
CREATE INDEX "invoice_verifactu_records_status_createdAt_idx" ON "invoice_verifactu_records"("status", "createdAt");

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_issuedById_fkey"
  FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoice_lines"
  ADD CONSTRAINT "invoice_lines_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoice_lines"
  ADD CONSTRAINT "invoice_lines_catalogItemId_fkey"
  FOREIGN KEY ("catalogItemId") REFERENCES "catalog_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoice_lines"
  ADD CONSTRAINT "invoice_lines_taxRateId_fkey"
  FOREIGN KEY ("taxRateId") REFERENCES "catalog_tax_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoice_tax_summaries"
  ADD CONSTRAINT "invoice_tax_summaries_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoice_due_dates"
  ADD CONSTRAINT "invoice_due_dates_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoice_verifactu_records"
  ADD CONSTRAINT "invoice_verifactu_records_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
