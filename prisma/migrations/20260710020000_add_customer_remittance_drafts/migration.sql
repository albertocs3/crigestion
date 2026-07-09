CREATE TYPE "CustomerRemittanceStatus" AS ENUM (
    'DRAFT',
    'GENERATED',
    'SENT',
    'PROCESSED',
    'PARTIALLY_RETURNED',
    'CLOSED',
    'CANCELLED'
);

CREATE TYPE "CustomerRemittanceLineStatus" AS ENUM ('ACTIVE', 'CANCELLED');

CREATE TABLE "customer_remittances" (
    "id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "number" VARCHAR(24) NOT NULL,
    "status" "CustomerRemittanceStatus" NOT NULL DEFAULT 'DRAFT',
    "chargeDate" DATE NOT NULL,
    "concept" VARCHAR(140) NOT NULL,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "createdById" UUID NOT NULL,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_remittances_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_remittances_total_chk" CHECK ("totalAmount" > 0),
    CONSTRAINT "customer_remittances_line_count_chk" CHECK ("lineCount" > 0)
);

CREATE TABLE "customer_remittance_lines" (
    "id" UUID NOT NULL,
    "remittanceId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "dueDateId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "CustomerRemittanceLineStatus" NOT NULL DEFAULT 'ACTIVE',
    "mandateId" UUID NOT NULL,
    "mandateReference" VARCHAR(80) NOT NULL,
    "customerCodeSnapshot" VARCHAR(20) NOT NULL,
    "customerNameSnapshot" VARCHAR(200) NOT NULL,
    "invoiceNumberSnapshot" VARCHAR(20),
    "dueDateSnapshot" DATE NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "concept" VARCHAR(140) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_remittance_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_remittance_lines_amount_chk" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX "customer_remittances_number_key" ON "customer_remittances"("number");
CREATE UNIQUE INDEX "customer_remittances_year_sequence_key" ON "customer_remittances"("year", "sequence");
CREATE INDEX "customer_remittances_status_chargeDate_id_idx" ON "customer_remittances"("status", "chargeDate", "id");
CREATE INDEX "customer_remittances_createdById_createdAt_idx" ON "customer_remittances"("createdById", "createdAt");
CREATE UNIQUE INDEX "customer_remittance_lines_remittanceId_position_key" ON "customer_remittance_lines"("remittanceId", "position");
CREATE INDEX "customer_remittance_lines_dueDateId_status_idx" ON "customer_remittance_lines"("dueDateId", "status");
CREATE INDEX "customer_remittance_lines_customerId_dueDateSnapshot_idx" ON "customer_remittance_lines"("customerId", "dueDateSnapshot");
CREATE INDEX "customer_remittance_lines_invoiceId_idx" ON "customer_remittance_lines"("invoiceId");
CREATE UNIQUE INDEX "customer_remittance_lines_active_dueDateId_key"
    ON "customer_remittance_lines"("dueDateId")
    WHERE "status" = 'ACTIVE';

ALTER TABLE "customer_remittances"
    ADD CONSTRAINT "customer_remittances_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_remittances"
    ADD CONSTRAINT "customer_remittances_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_remittance_lines"
    ADD CONSTRAINT "customer_remittance_lines_remittanceId_fkey"
    FOREIGN KEY ("remittanceId") REFERENCES "customer_remittances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_remittance_lines"
    ADD CONSTRAINT "customer_remittance_lines_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_remittance_lines"
    ADD CONSTRAINT "customer_remittance_lines_dueDateId_fkey"
    FOREIGN KEY ("dueDateId") REFERENCES "invoice_due_dates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_remittance_lines"
    ADD CONSTRAINT "customer_remittance_lines_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_remittance_lines"
    ADD CONSTRAINT "customer_remittance_lines_mandateId_fkey"
    FOREIGN KEY ("mandateId") REFERENCES "customer_sepa_mandates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
