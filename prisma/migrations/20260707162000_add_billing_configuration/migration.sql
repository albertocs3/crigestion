CREATE TABLE "billing_configurations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "singletonKey" INTEGER NOT NULL DEFAULT 1,
  "invoiceLegalFooter" TEXT NOT NULL DEFAULT '',
  "invoiceAccentColor" VARCHAR(7) NOT NULL DEFAULT '#0f766e',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_configurations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_configurations_singletonKey_key"
  ON "billing_configurations"("singletonKey");

ALTER TABLE "billing_configurations"
  ADD CONSTRAINT "billing_configurations_accent_color_chk"
  CHECK ("invoiceAccentColor" ~ '^#[0-9A-Fa-f]{6}$');
