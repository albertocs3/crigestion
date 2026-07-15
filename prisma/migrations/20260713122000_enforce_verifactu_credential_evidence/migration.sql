BEGIN;

ALTER TABLE "verifactu_mtls_credential_versions"
  DROP CONSTRAINT "verifactu_mtls_credential_versions_lifecycle_check",
  ADD CONSTRAINT "verifactu_mtls_credential_versions_lifecycle_check" CHECK (
    ("status" = 'STAGED' AND "testedAt" IS NULL AND "testedPfxSha256" IS NULL AND "testedAttemptId" IS NULL AND "activatedAt" IS NULL AND "retiredAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'TESTED' AND "testedAt" IS NOT NULL AND "testedPfxSha256" IS NOT NULL AND "testedAttemptId" IS NOT NULL AND "activatedAt" IS NULL AND "retiredAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'ACTIVE' AND "activatedAt" IS NOT NULL AND "testedAt" IS NOT NULL AND "testedPfxSha256" IS NOT NULL AND "testedAttemptId" IS NOT NULL AND "retiredAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'RETIRED' AND "activatedAt" IS NOT NULL AND "testedAt" IS NOT NULL AND "testedPfxSha256" IS NOT NULL AND "testedAttemptId" IS NOT NULL AND "retiredAt" IS NOT NULL AND "revokedAt" IS NULL)
    OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "verifactu_mtls_version_tested_attempt_version_fkey"
  FOREIGN KEY ("testedAttemptId", "id") REFERENCES "verifactu_mtls_credential_test_attempts"("id", "versionId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION validate_verifactu_mtls_version_insert() RETURNS trigger AS $$
BEGIN
  IF NEW."status" <> 'STAGED' THEN
    RAISE EXCEPTION 'verifactu mtls credential versions must be inserted as staged';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "verifactu_mtls_credential_versions_insert_trigger"
BEFORE INSERT ON "verifactu_mtls_credential_versions"
FOR EACH ROW EXECUTE FUNCTION validate_verifactu_mtls_version_insert();

COMMIT;
