BEGIN;

CREATE TYPE "VerifactuMtlsCredentialStatus" AS ENUM ('ACTIVE', 'DISABLED', 'REVOKED');
CREATE TYPE "VerifactuMtlsCredentialVersionStatus" AS ENUM ('STAGED', 'ACTIVE', 'RETIRED', 'REVOKED');
CREATE TYPE "VerifactuMtlsEndpointKind" AS ENUM ('STANDARD', 'SEAL');

CREATE TABLE "verifactu_mtls_credentials" (
  "id" UUID NOT NULL,
  "companyId" UUID NOT NULL,
  "ref" VARCHAR(160) NOT NULL,
  "alias" VARCHAR(120) NOT NULL,
  "status" "VerifactuMtlsCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
  "disabledAt" TIMESTAMPTZ(3),
  "revokedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "verifactu_mtls_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "verifactu_mtls_credentials_lifecycle_check" CHECK (
    ("status" = 'ACTIVE' AND "disabledAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'DISABLED' AND "disabledAt" IS NOT NULL AND "revokedAt" IS NULL)
    OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL)
  )
);

CREATE TABLE "verifactu_mtls_credential_versions" (
  "id" UUID NOT NULL,
  "credentialId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "VerifactuMtlsCredentialVersionStatus" NOT NULL DEFAULT 'STAGED',
  "endpointKind" "VerifactuMtlsEndpointKind" NOT NULL,
  "allowTest" BOOLEAN NOT NULL DEFAULT true,
  "allowProduction" BOOLEAN NOT NULL DEFAULT false,
  "validFrom" TIMESTAMPTZ(3) NOT NULL,
  "validUntil" TIMESTAMPTZ(3) NOT NULL,
  "materialCiphertext" BYTEA NOT NULL,
  "encryptionKeyId" VARCHAR(120) NOT NULL,
  "envelopeVersion" SMALLINT NOT NULL DEFAULT 1,
  "pfxSha256" CHAR(64) NOT NULL,
  "testedPfxSha256" CHAR(64),
  "testedAt" TIMESTAMPTZ(3),
  "activatedAt" TIMESTAMPTZ(3),
  "retiredAt" TIMESTAMPTZ(3),
  "revokedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "verifactu_mtls_credential_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "verifactu_mtls_credential_versions_version_check" CHECK ("version" > 0),
  CONSTRAINT "verifactu_mtls_credential_versions_dates_check" CHECK ("validFrom" < "validUntil"),
  CONSTRAINT "verifactu_mtls_credential_versions_environment_check" CHECK ("allowTest" OR "allowProduction"),
  CONSTRAINT "verifactu_mtls_credential_versions_material_check" CHECK (octet_length("materialCiphertext") BETWEEN 1 AND 614400),
  CONSTRAINT "verifactu_mtls_credential_versions_hash_check" CHECK (
    "pfxSha256" ~ '^[0-9a-f]{64}$' AND ("testedPfxSha256" IS NULL OR "testedPfxSha256" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "verifactu_mtls_credential_versions_test_check" CHECK (
    ("testedAt" IS NULL AND "testedPfxSha256" IS NULL) OR ("testedAt" IS NOT NULL AND "testedPfxSha256" IS NOT NULL)
  ),
  CONSTRAINT "verifactu_mtls_credential_versions_lifecycle_check" CHECK (
    ("status" = 'STAGED' AND "activatedAt" IS NULL AND "retiredAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'ACTIVE' AND "activatedAt" IS NOT NULL AND "testedAt" IS NOT NULL AND "retiredAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'RETIRED' AND "activatedAt" IS NOT NULL AND "retiredAt" IS NOT NULL AND "revokedAt" IS NULL)
    OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "verifactu_mtls_credentials_ref_key" ON "verifactu_mtls_credentials"("ref");
CREATE UNIQUE INDEX "verifactu_mtls_credentials_id_companyId_key" ON "verifactu_mtls_credentials"("id", "companyId");
CREATE INDEX "verifactu_mtls_credentials_company_status_created_idx" ON "verifactu_mtls_credentials"("companyId", "status", "createdAt", "id");
CREATE UNIQUE INDEX "verifactu_mtls_credential_versions_credential_version_key" ON "verifactu_mtls_credential_versions"("credentialId", "version");
CREATE UNIQUE INDEX "verifactu_mtls_credential_versions_id_credential_key" ON "verifactu_mtls_credential_versions"("id", "credentialId");
CREATE INDEX "verifactu_mtls_credential_versions_credential_status_version_idx" ON "verifactu_mtls_credential_versions"("credentialId", "status", "version");
CREATE UNIQUE INDEX "verifactu_mtls_credential_versions_one_active_idx" ON "verifactu_mtls_credential_versions"("credentialId") WHERE "status" = 'ACTIVE';

ALTER TABLE "verifactu_mtls_credentials"
  ADD CONSTRAINT "verifactu_mtls_credentials_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verifactu_mtls_credential_versions"
  ADD CONSTRAINT "verifactu_mtls_credential_versions_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "verifactu_mtls_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "verifactu_fiscal_records" ADD COLUMN "issuerName" VARCHAR(200);
UPDATE "verifactu_fiscal_records" record
SET "issuerName" = company."legalName"
FROM "companies" company
WHERE company."id" = record."companyId";
ALTER TABLE "verifactu_fiscal_records" ALTER COLUMN "issuerName" SET NOT NULL;

ALTER TABLE "verifactu_submission_attempts" ADD COLUMN "credentialVersionId" UUID;
CREATE INDEX "verifactu_submission_attempts_credential_version_created_idx" ON "verifactu_submission_attempts"("credentialVersionId", "createdAt", "id");
ALTER TABLE "verifactu_submission_attempts"
  ADD CONSTRAINT "verifactu_submission_attempts_credentialVersionId_fkey" FOREIGN KEY ("credentialVersionId") REFERENCES "verifactu_mtls_credential_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
