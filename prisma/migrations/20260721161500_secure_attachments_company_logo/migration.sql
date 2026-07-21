CREATE TYPE "AttachmentPurpose" AS ENUM ('COMPANY_LOGO');

CREATE TYPE "AttachmentStatus" AS ENUM (
  'PENDING_VALIDATION',
  'SCANNING',
  'AVAILABLE',
  'REJECTED',
  'REPLACED',
  'RETENTION_LOCKED',
  'PHYSICALLY_DELETED'
);

CREATE TYPE "AttachmentScanResult" AS ENUM (
  'PENDING',
  'CLEAN',
  'INFECTED',
  'INCONCLUSIVE'
);

ALTER TABLE "companies"
  ADD COLUMN "logoAttachmentId" UUID;

CREATE TABLE "attachments" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "purpose" "AttachmentPurpose" NOT NULL,
  "originalFileName" VARCHAR(255) NOT NULL,
  "description" VARCHAR(500),
  "extension" VARCHAR(10) NOT NULL,
  "declaredMimeType" VARCHAR(100) NOT NULL,
  "detectedMimeType" VARCHAR(100),
  "sizeBytes" BIGINT NOT NULL,
  "sha256" CHAR(64),
  "storageKey" VARCHAR(500),
  "status" "AttachmentStatus" NOT NULL DEFAULT 'PENDING_VALIDATION',
  "scanResult" "AttachmentScanResult" NOT NULL DEFAULT 'PENDING',
  "scanEngine" VARCHAR(80),
  "scanEngineVersion" VARCHAR(80),
  "scanCompletedAt" TIMESTAMPTZ(3),
  "rejectionCode" VARCHAR(100),
  "availableAt" TIMESTAMPTZ(3),
  "replacedAt" TIMESTAMPTZ(3),
  "physicallyDeletedAt" TIMESTAMPTZ(3),
  "replacesAttachmentId" UUID,
  "uploadedById" UUID NOT NULL,
  "uploadedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attachments_size_positive_check" CHECK ("sizeBytes" > 0),
  CONSTRAINT "attachments_sha256_check" CHECK (
    "sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "attachments_storage_key_check" CHECK (
    "storageKey" IS NULL OR
    "storageKey" ~ '^company-logo/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg)$'
  ),
  CONSTRAINT "attachments_company_logo_policy_check" CHECK (
    "purpose" <> 'COMPANY_LOGO' OR (
      "sizeBytes" <= 5242880 AND
      "extension" IN ('png', 'jpg') AND
      (("extension" = 'png' AND "declaredMimeType" = 'image/png') OR
       ("extension" = 'jpg' AND "declaredMimeType" = 'image/jpeg')) AND
      (
        "detectedMimeType" IS NULL OR
        ("extension" = 'png' AND "detectedMimeType" = 'image/png') OR
        ("extension" = 'jpg' AND "detectedMimeType" = 'image/jpeg')
      )
    )
  ),
  CONSTRAINT "attachments_available_state_check" CHECK (
    "status" <> 'AVAILABLE' OR (
      "storageKey" IS NOT NULL AND
      "sha256" IS NOT NULL AND
      "detectedMimeType" IS NOT NULL AND
      "scanResult" = 'CLEAN' AND
      "scanCompletedAt" IS NOT NULL AND
      "availableAt" IS NOT NULL
    )
  ),
  CONSTRAINT "attachments_rejected_state_check" CHECK (
    "status" <> 'REJECTED' OR "rejectionCode" IS NOT NULL
  ),
  CONSTRAINT "attachments_replaced_state_check" CHECK (
    "status" <> 'REPLACED' OR "replacedAt" IS NOT NULL
  ),
  CONSTRAINT "attachments_deleted_state_check" CHECK (
    "status" <> 'PHYSICALLY_DELETED' OR (
      "physicallyDeletedAt" IS NOT NULL AND "storageKey" IS NULL
    )
  ),
  CONSTRAINT "attachments_scan_state_check" CHECK (
    ("scanResult" = 'PENDING' AND "scanCompletedAt" IS NULL) OR
    ("scanResult" <> 'PENDING' AND "scanCompletedAt" IS NOT NULL)
  ),
  CONSTRAINT "attachments_replacement_not_self_check" CHECK (
    "replacesAttachmentId" IS NULL OR "replacesAttachmentId" <> "id"
  )
);

CREATE UNIQUE INDEX "attachments_id_companyId_key"
  ON "attachments"("id", "companyId");

CREATE UNIQUE INDEX "attachments_replacesAttachmentId_companyId_key"
  ON "attachments"("replacesAttachmentId", "companyId");

CREATE UNIQUE INDEX "attachments_storageKey_key"
  ON "attachments"("storageKey");

CREATE INDEX "attachments_companyId_purpose_status_uploadedAt_id_idx"
  ON "attachments"("companyId", "purpose", "status", "uploadedAt", "id");

CREATE INDEX "attachments_uploadedById_uploadedAt_id_idx"
  ON "attachments"("uploadedById", "uploadedAt", "id");

CREATE INDEX "attachments_sha256_idx"
  ON "attachments"("sha256");

CREATE UNIQUE INDEX "attachments_one_available_company_logo_idx"
  ON "attachments"("companyId")
  WHERE "purpose" = 'COMPANY_LOGO' AND "status" = 'AVAILABLE';

CREATE UNIQUE INDEX "companies_logoAttachmentId_key"
  ON "companies"("logoAttachmentId");

ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_uploadedById_fkey"
  FOREIGN KEY ("uploadedById") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_replacesAttachmentId_companyId_fkey"
  FOREIGN KEY ("replacesAttachmentId", "companyId")
  REFERENCES "attachments"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "companies"
  ADD CONSTRAINT "companies_logoAttachmentId_fkey"
  FOREIGN KEY ("logoAttachmentId")
  REFERENCES "attachments"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION enforce_company_logo_attachment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."logoAttachmentId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "attachments" attachment
    WHERE attachment."id" = NEW."logoAttachmentId"
      AND attachment."companyId" = NEW."id"
      AND attachment."purpose" = 'COMPANY_LOGO'
      AND attachment."status" = 'AVAILABLE'
  ) THEN
    RAISE EXCEPTION 'COMPANY_LOGO_ATTACHMENT_INVALID'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "companies_logo_attachment_valid_trigger"
AFTER INSERT OR UPDATE ON "companies"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_company_logo_attachment();

CREATE FUNCTION enforce_active_company_logo_attachment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."purpose" = 'COMPANY_LOGO' AND NEW."status" = 'AVAILABLE' AND NOT EXISTS (
    SELECT 1
    FROM "companies" company
    WHERE company."id" = NEW."companyId"
      AND company."logoAttachmentId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'AVAILABLE_COMPANY_LOGO_NOT_REFERENCED'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "companies" company
    WHERE company."logoAttachmentId" = NEW."id"
      AND (
        company."id" <> NEW."companyId" OR
        NEW."purpose" <> 'COMPANY_LOGO' OR
        NEW."status" <> 'AVAILABLE'
      )
  ) THEN
    RAISE EXCEPTION 'ACTIVE_COMPANY_LOGO_ATTACHMENT_INVALID'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "attachments_active_company_logo_valid_trigger"
AFTER INSERT OR UPDATE ON "attachments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_active_company_logo_attachment();
