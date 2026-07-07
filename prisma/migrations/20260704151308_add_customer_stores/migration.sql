-- CreateEnum
CREATE TYPE "CustomerStoreStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "customer_stores" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "status" "CustomerStoreStatus" NOT NULL DEFAULT 'ACTIVE',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "addressLine" VARCHAR(240) NOT NULL,
    "postalCode" VARCHAR(20) NOT NULL,
    "city" VARCHAR(120) NOT NULL,
    "province" VARCHAR(120),
    "country" VARCHAR(2) NOT NULL,
    "email" VARCHAR(254),
    "phone" VARCHAR(40),
    "whatsapp" VARCHAR(40),
    "contactName" VARCHAR(160),
    "contactRole" VARCHAR(120),
    "contactPhone" VARCHAR(40),
    "contactMobile" VARCHAR(40),
    "contactWhatsapp" VARCHAR(40),
    "contactEmail" VARCHAR(254),
    "notes" VARCHAR(1000),
    "createdById" UUID NOT NULL,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_stores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_stores_code_key" ON "customer_stores"("code");

-- CreateIndex
CREATE INDEX "customer_stores_customerId_status_name_id_idx" ON "customer_stores"("customerId", "status", "name", "id");

-- CreateIndex
CREATE INDEX "customer_stores_customerId_isPrimary_idx" ON "customer_stores"("customerId", "isPrimary");

-- CreateIndex
CREATE INDEX "customer_stores_createdById_createdAt_idx" ON "customer_stores"("createdById", "createdAt");

-- AddForeignKey
ALTER TABLE "customer_stores" ADD CONSTRAINT "customer_stores_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_stores" ADD CONSTRAINT "customer_stores_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_stores" ADD CONSTRAINT "customer_stores_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
