ALTER TYPE "CustomerRemittanceStatus" ADD VALUE 'REJECTED';

ALTER TABLE "customer_remittances"
ADD COLUMN "rejectedAt" TIMESTAMPTZ(3),
ADD COLUMN "rejectionReason" VARCHAR(500);
