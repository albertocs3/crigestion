BEGIN;

CREATE UNIQUE INDEX "verifactu_mtls_credentials_ref_company_key"
ON "verifactu_mtls_credentials"("ref", "companyId");

ALTER TABLE "verifactu_mtls_credential_versions"
  DROP CONSTRAINT "verifactu_mtls_credential_versions_material_check";
ALTER TABLE "verifactu_mtls_credential_versions"
  ADD CONSTRAINT "verifactu_mtls_credential_versions_material_check"
  CHECK (octet_length("materialCiphertext") BETWEEN 1 AND 921600),
  ADD CONSTRAINT "verifactu_mtls_credential_versions_active_test_check"
  CHECK ("status" <> 'ACTIVE' OR ("testedPfxSha256" = "pfxSha256" AND "testedAt" <= "activatedAt")),
  ADD CONSTRAINT "verifactu_mtls_credential_versions_envelope_check"
  CHECK ("envelopeVersion" = 1 AND "encryptionKeyId" ~ '^[A-Za-z0-9_-]{1,120}$');

CREATE FUNCTION protect_verifactu_mtls_credential() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'verifactu mtls credentials cannot be deleted';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."companyId" IS DISTINCT FROM OLD."companyId" OR NEW."ref" IS DISTINCT FROM OLD."ref" THEN
    RAISE EXCEPTION 'verifactu mtls credential identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "verifactu_mtls_credentials_protect_trigger"
BEFORE UPDATE OR DELETE ON "verifactu_mtls_credentials"
FOR EACH ROW EXECUTE FUNCTION protect_verifactu_mtls_credential();

CREATE FUNCTION protect_verifactu_mtls_credential_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'verifactu mtls credential versions cannot be deleted';
  END IF;
  IF OLD."status" <> 'STAGED' AND (
    NEW."id" IS DISTINCT FROM OLD."id" OR NEW."credentialId" IS DISTINCT FROM OLD."credentialId"
    OR NEW."version" IS DISTINCT FROM OLD."version" OR NEW."endpointKind" IS DISTINCT FROM OLD."endpointKind"
    OR NEW."allowTest" IS DISTINCT FROM OLD."allowTest" OR NEW."allowProduction" IS DISTINCT FROM OLD."allowProduction"
    OR NEW."validFrom" IS DISTINCT FROM OLD."validFrom" OR NEW."validUntil" IS DISTINCT FROM OLD."validUntil"
    OR NEW."materialCiphertext" IS DISTINCT FROM OLD."materialCiphertext" OR NEW."encryptionKeyId" IS DISTINCT FROM OLD."encryptionKeyId"
    OR NEW."envelopeVersion" IS DISTINCT FROM OLD."envelopeVersion" OR NEW."pfxSha256" IS DISTINCT FROM OLD."pfxSha256"
    OR NEW."testedPfxSha256" IS DISTINCT FROM OLD."testedPfxSha256" OR NEW."testedAt" IS DISTINCT FROM OLD."testedAt"
    OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'activated verifactu mtls credential version is immutable';
  END IF;
  IF OLD."status" = 'ACTIVE' AND NEW."status" NOT IN ('ACTIVE', 'RETIRED', 'REVOKED') THEN
    RAISE EXCEPTION 'invalid verifactu mtls credential transition';
  END IF;
  IF OLD."status" IN ('RETIRED', 'REVOKED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal verifactu mtls credential version is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "verifactu_mtls_credential_versions_protect_trigger"
BEFORE UPDATE OR DELETE ON "verifactu_mtls_credential_versions"
FOR EACH ROW EXECUTE FUNCTION protect_verifactu_mtls_credential_version();

CREATE FUNCTION validate_verifactu_attempt_credential_company() RETURNS trigger AS $$
DECLARE
  record_company UUID;
  version_company UUID;
BEGIN
  IF NEW."credentialVersionId" IS NULL THEN RETURN NEW; END IF;
  SELECT "companyId" INTO record_company FROM "verifactu_fiscal_records" WHERE "id" = NEW."fiscalRecordId";
  SELECT credential."companyId" INTO version_company
  FROM "verifactu_mtls_credential_versions" version
  JOIN "verifactu_mtls_credentials" credential ON credential."id" = version."credentialId"
  WHERE version."id" = NEW."credentialVersionId";
  IF record_company IS NULL OR version_company IS NULL OR record_company <> version_company THEN
    RAISE EXCEPTION 'verifactu attempt credential belongs to another company';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "verifactu_attempt_credential_company_trigger"
BEFORE INSERT ON "verifactu_submission_attempts"
FOR EACH ROW EXECUTE FUNCTION validate_verifactu_attempt_credential_company();

COMMIT;
