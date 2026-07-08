CREATE TYPE "CustomerAddressType" AS ENUM ('BILLING', 'SHIPPING', 'OTHER');

CREATE TYPE "CustomerAddressStatus" AS ENUM ('ACTIVE', 'INACTIVE');

CREATE TABLE "customer_addresses" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "customerId" UUID NOT NULL,
  "type" "CustomerAddressType" NOT NULL,
  "status" "CustomerAddressStatus" NOT NULL DEFAULT 'ACTIVE',
  "label" VARCHAR(120) NOT NULL,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "addressLine" VARCHAR(240) NOT NULL,
  "postalCode" VARCHAR(20) NOT NULL,
  "city" VARCHAR(120) NOT NULL,
  "province" VARCHAR(120),
  "country" VARCHAR(2) NOT NULL,
  "contactName" VARCHAR(160),
  "phone" VARCHAR(40),
  "email" VARCHAR(254),
  "notes" VARCHAR(1000),
  "createdById" UUID NOT NULL,
  "updatedById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_addresses_one_active_primary_per_type_idx"
  ON "customer_addresses"("customerId", "type")
  WHERE "status" = 'ACTIVE' AND "isPrimary" = true;

CREATE INDEX "customer_addresses_customerId_type_status_isPrimary_idx"
  ON "customer_addresses"("customerId", "type", "status", "isPrimary");

CREATE INDEX "customer_addresses_customerId_status_label_id_idx"
  ON "customer_addresses"("customerId", "status", "label", "id");

CREATE INDEX "customer_addresses_createdById_createdAt_idx"
  ON "customer_addresses"("createdById", "createdAt");

ALTER TABLE "customer_addresses"
  ADD CONSTRAINT "customer_addresses_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_addresses"
  ADD CONSTRAINT "customer_addresses_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_addresses"
  ADD CONSTRAINT "customer_addresses_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
