BEGIN;

CREATE TYPE "VerifactuMtlsTestOutcome" AS ENUM ('RUNNING', 'PASSED', 'FAILED', 'UNKNOWN');

ALTER TABLE "verifactu_mtls_credential_versions"
  ADD COLUMN "testedAttemptId" UUID;

CREATE TABLE "verifactu_mtls_credential_test_attempts" (
  "id" UUID NOT NULL,
  "versionId" UUID NOT NULL,
  "idempotencyKey" VARCHAR(160) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "outcome" "VerifactuMtlsTestOutcome" NOT NULL DEFAULT 'RUNNING',
  "pfxSha256" CHAR(64) NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3),
  "stableCode" VARCHAR(120),
  "responseSha256" CHAR(64),
  "actorUserId" UUID NOT NULL,
  "correlationId" VARCHAR(160),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "verifactu_mtls_credential_test_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "verifactu_mtls_test_attempt_hash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$' AND "pfxSha256" ~ '^[0-9a-f]{64}$' AND ("responseSha256" IS NULL OR "responseSha256" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "verifactu_mtls_test_attempt_lifecycle_check" CHECK (
    ("outcome" = 'RUNNING' AND "completedAt" IS NULL AND "stableCode" IS NULL)
    OR ("outcome" <> 'RUNNING' AND "completedAt" IS NOT NULL AND "stableCode" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "verifactu_mtls_credential_test_attempts_idempotency_key" ON "verifactu_mtls_credential_test_attempts"("idempotencyKey");
CREATE UNIQUE INDEX "verifactu_mtls_credential_test_attempts_id_version_key" ON "verifactu_mtls_credential_test_attempts"("id", "versionId");
CREATE INDEX "verifactu_mtls_credential_test_attempts_version_created_idx" ON "verifactu_mtls_credential_test_attempts"("versionId", "createdAt", "id");
CREATE INDEX "verifactu_mtls_credential_test_attempts_outcome_started_idx" ON "verifactu_mtls_credential_test_attempts"("outcome", "startedAt", "id");
CREATE UNIQUE INDEX "verifactu_mtls_credential_test_attempts_one_running_idx" ON "verifactu_mtls_credential_test_attempts"("versionId") WHERE "outcome" = 'RUNNING';
CREATE UNIQUE INDEX "verifactu_mtls_credential_versions_tested_attempt_key" ON "verifactu_mtls_credential_versions"("testedAttemptId");
CREATE UNIQUE INDEX "verifactu_mtls_credential_versions_tested_attempt_version_key" ON "verifactu_mtls_credential_versions"("testedAttemptId", "id");

ALTER TABLE "verifactu_mtls_credential_test_attempts"
  ADD CONSTRAINT "verifactu_mtls_credential_test_attempts_version_fkey" FOREIGN KEY ("versionId") REFERENCES "verifactu_mtls_credential_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "verifactu_mtls_credential_test_attempts_actor_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verifactu_mtls_credential_versions"
  DROP CONSTRAINT "verifactu_mtls_credential_versions_lifecycle_check",
  ADD CONSTRAINT "verifactu_mtls_credential_versions_lifecycle_check" CHECK (
    ("status" = 'STAGED' AND "testedAt" IS NULL AND "testedPfxSha256" IS NULL AND "testedAttemptId" IS NULL AND "activatedAt" IS NULL AND "retiredAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'TESTED' AND "testedAt" IS NOT NULL AND "testedPfxSha256" IS NOT NULL AND "testedAttemptId" IS NOT NULL AND "activatedAt" IS NULL AND "retiredAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'ACTIVE' AND "activatedAt" IS NOT NULL AND "testedAt" IS NOT NULL AND "retiredAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'RETIRED' AND "activatedAt" IS NOT NULL AND "retiredAt" IS NOT NULL AND "revokedAt" IS NULL)
    OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL)
  );

CREATE FUNCTION protect_verifactu_mtls_test_attempt() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'verifactu mtls test attempts cannot be deleted';
  END IF;
  IF OLD."outcome" <> 'RUNNING' THEN
    RAISE EXCEPTION 'completed verifactu mtls test attempt is immutable';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."versionId" IS DISTINCT FROM OLD."versionId"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR NEW."pfxSha256" IS DISTINCT FROM OLD."pfxSha256"
    OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt" OR NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId"
    OR NEW."correlationId" IS DISTINCT FROM OLD."correlationId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."outcome" = 'RUNNING' THEN
    RAISE EXCEPTION 'invalid verifactu mtls test attempt transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "verifactu_mtls_test_attempts_protect_trigger"
BEFORE UPDATE OR DELETE ON "verifactu_mtls_credential_test_attempts"
FOR EACH ROW EXECUTE FUNCTION protect_verifactu_mtls_test_attempt();

CREATE OR REPLACE FUNCTION protect_verifactu_mtls_credential_version() RETURNS trigger AS $$
DECLARE
  passed_attempt RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'verifactu mtls credential versions cannot be deleted';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."credentialId" IS DISTINCT FROM OLD."credentialId"
    OR NEW."version" IS DISTINCT FROM OLD."version" OR NEW."endpointKind" IS DISTINCT FROM OLD."endpointKind"
    OR NEW."allowTest" IS DISTINCT FROM OLD."allowTest" OR NEW."allowProduction" IS DISTINCT FROM OLD."allowProduction"
    OR NEW."validFrom" IS DISTINCT FROM OLD."validFrom" OR NEW."validUntil" IS DISTINCT FROM OLD."validUntil"
    OR NEW."materialCiphertext" IS DISTINCT FROM OLD."materialCiphertext" OR NEW."encryptionKeyId" IS DISTINCT FROM OLD."encryptionKeyId"
    OR NEW."envelopeVersion" IS DISTINCT FROM OLD."envelopeVersion" OR NEW."pfxSha256" IS DISTINCT FROM OLD."pfxSha256"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'verifactu mtls credential version material is immutable';
  END IF;
  IF OLD."status" = 'STAGED' AND NEW."status" NOT IN ('TESTED', 'REVOKED') THEN
    RAISE EXCEPTION 'invalid staged verifactu mtls credential transition';
  ELSIF OLD."status" = 'TESTED' AND NEW."status" NOT IN ('ACTIVE', 'REVOKED') THEN
    RAISE EXCEPTION 'invalid tested verifactu mtls credential transition';
  ELSIF OLD."status" = 'ACTIVE' AND NEW."status" NOT IN ('RETIRED', 'REVOKED') THEN
    RAISE EXCEPTION 'invalid active verifactu mtls credential transition';
  ELSIF OLD."status" IN ('RETIRED', 'REVOKED') THEN
    RAISE EXCEPTION 'terminal verifactu mtls credential version is immutable';
  END IF;
  IF NEW."status" = 'TESTED' THEN
    SELECT attempt."versionId", attempt."pfxSha256", attempt."outcome" INTO passed_attempt
    FROM "verifactu_mtls_credential_test_attempts" attempt WHERE attempt."id" = NEW."testedAttemptId";
    IF passed_attempt IS NULL OR passed_attempt."versionId" <> NEW."id" OR passed_attempt."pfxSha256" <> NEW."pfxSha256" OR passed_attempt."outcome" <> 'PASSED' THEN
      RAISE EXCEPTION 'verifactu mtls tested transition lacks matching passed attempt';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

UPDATE "verifactu_sif_installations" installation
SET "credentialRef" = NULL
WHERE "credentialRef" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "verifactu_mtls_credentials" credential
  WHERE credential."ref" = installation."credentialRef" AND credential."companyId" = installation."companyId"
);
ALTER TABLE "verifactu_sif_installations"
  ADD CONSTRAINT "verifactu_sif_installations_credential_company_fkey"
  FOREIGN KEY ("credentialRef", "companyId") REFERENCES "verifactu_mtls_credentials"("ref", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Billing.ManageVerifactuCredentials', 'Gestionar credenciales VeriFactu', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id" FROM "roles" role CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador' AND role."isProtected" = true AND permission."code" = 'Billing.ManageVerifactuCredentials'
ON CONFLICT DO NOTHING;

COMMIT;
