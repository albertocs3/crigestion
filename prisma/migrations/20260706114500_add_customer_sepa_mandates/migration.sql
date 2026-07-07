CREATE TYPE "CustomerSepaMandateStatus" AS ENUM ('ACTIVE', 'REVOKED', 'INVALIDATED');

CREATE TABLE "customer_sepa_mandates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "customerId" UUID NOT NULL,
  "reference" VARCHAR(80) NOT NULL,
  "referenceNormalized" VARCHAR(80) NOT NULL,
  "status" "CustomerSepaMandateStatus" NOT NULL DEFAULT 'ACTIVE',
  "signedAt" DATE NOT NULL,
  "revokedAt" TIMESTAMPTZ(3),
  "createdById" UUID NOT NULL,
  "revokedById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "customer_sepa_mandates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_sepa_mandates_one_active_per_customer_idx"
  ON "customer_sepa_mandates"("customerId")
  WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX "customer_sepa_mandates_referenceNormalized_key"
  ON "customer_sepa_mandates"("referenceNormalized");

CREATE INDEX "customer_sepa_mandates_customerId_status_idx"
  ON "customer_sepa_mandates"("customerId", "status");

CREATE INDEX "customer_sepa_mandates_createdById_createdAt_idx"
  ON "customer_sepa_mandates"("createdById", "createdAt");

ALTER TABLE "customer_sepa_mandates"
  ADD CONSTRAINT "customer_sepa_mandates_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_sepa_mandates"
  ADD CONSTRAINT "customer_sepa_mandates_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_sepa_mandates"
  ADD CONSTRAINT "customer_sepa_mandates_revokedById_fkey"
  FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
