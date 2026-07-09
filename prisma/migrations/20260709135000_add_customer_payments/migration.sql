CREATE TYPE "CustomerPaymentSource" AS ENUM ('MANUAL', 'SEPA_REMITTANCE');

CREATE TABLE "customer_payments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "invoiceId" UUID NOT NULL,
  "dueDateId" UUID NOT NULL,
  "source" "CustomerPaymentSource" NOT NULL DEFAULT 'MANUAL',
  "paymentDate" DATE NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "reference" VARCHAR(120),
  "notes" VARCHAR(500),
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "customer_payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_payments_amount_positive_chk" CHECK ("amount" > 0)
);

CREATE INDEX "customer_payments_invoiceId_paymentDate_id_idx"
  ON "customer_payments"("invoiceId", "paymentDate", "id");

CREATE INDEX "customer_payments_dueDateId_paymentDate_id_idx"
  ON "customer_payments"("dueDateId", "paymentDate", "id");

CREATE INDEX "customer_payments_createdById_createdAt_idx"
  ON "customer_payments"("createdById", "createdAt");

ALTER TABLE "customer_payments"
  ADD CONSTRAINT "customer_payments_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_payments"
  ADD CONSTRAINT "customer_payments_dueDateId_fkey"
  FOREIGN KEY ("dueDateId") REFERENCES "invoice_due_dates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_payments"
  ADD CONSTRAINT "customer_payments_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
