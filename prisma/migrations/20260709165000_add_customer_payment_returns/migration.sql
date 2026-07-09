CREATE TABLE "customer_payment_returns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "paymentId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "dueDateId" UUID NOT NULL,
    "returnDate" DATE NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reasonCode" VARCHAR(80),
    "notes" VARCHAR(500),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_payment_returns_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_payment_returns_amount_positive" CHECK ("amount" > 0)
);

CREATE INDEX "customer_payment_returns_paymentId_returnDate_id_idx" ON "customer_payment_returns"("paymentId", "returnDate", "id");
CREATE INDEX "customer_payment_returns_invoiceId_returnDate_id_idx" ON "customer_payment_returns"("invoiceId", "returnDate", "id");
CREATE INDEX "customer_payment_returns_dueDateId_returnDate_id_idx" ON "customer_payment_returns"("dueDateId", "returnDate", "id");
CREATE INDEX "customer_payment_returns_createdById_createdAt_idx" ON "customer_payment_returns"("createdById", "createdAt");

ALTER TABLE "customer_payment_returns" ADD CONSTRAINT "customer_payment_returns_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "customer_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_payment_returns" ADD CONSTRAINT "customer_payment_returns_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_payment_returns" ADD CONSTRAINT "customer_payment_returns_dueDateId_fkey" FOREIGN KEY ("dueDateId") REFERENCES "invoice_due_dates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_payment_returns" ADD CONSTRAINT "customer_payment_returns_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
