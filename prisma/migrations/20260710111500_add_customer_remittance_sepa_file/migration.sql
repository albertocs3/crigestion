ALTER TABLE "customer_remittances"
ADD COLUMN "sepaFormat" VARCHAR(40),
ADD COLUMN "sepaMessageId" VARCHAR(80),
ADD COLUMN "sepaFileName" VARCHAR(160),
ADD COLUMN "sepaFileSha256" CHAR(64),
ADD COLUMN "sepaXml" TEXT,
ADD COLUMN "generatedAt" TIMESTAMPTZ(3);
