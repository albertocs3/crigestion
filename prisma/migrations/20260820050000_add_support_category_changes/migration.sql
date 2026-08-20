BEGIN;

CREATE EXTENSION IF NOT EXISTS unaccent;

ALTER TABLE "support_incident_categories"
  ALTER COLUMN "normalizedName" TYPE VARCHAR(480);

DO $$
BEGIN
  IF EXISTS (
    SELECT lower(unaccent(btrim("name")))
    FROM "support_incident_categories"
    GROUP BY "companyId", lower(unaccent(btrim("name")))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Support category names collide under the canonical normalization.' USING ERRCODE = 'unique_violation';
  END IF;
END;
$$;

UPDATE "support_incident_categories"
SET "normalizedName" = lower(unaccent(btrim("name")));

ALTER TABLE "support_incident_categories"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "support_incident_categories_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "support_incident_categories_values_check" CHECK (
    length(btrim("name")) BETWEEN 2 AND 120
    AND "normalizedName" = lower(unaccent(btrim("name")))
    AND ("description" IS NULL OR length(btrim("description")) BETWEEN 3 AND 500)
    AND "color" ~ '^#[0-9A-Fa-f]{6}$'
  );

CREATE TABLE "support_incident_category_changes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "categoryId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "previousName" VARCHAR(120) NOT NULL,
  "correctedName" VARCHAR(120) NOT NULL,
  "previousNormalizedName" VARCHAR(480) NOT NULL,
  "correctedNormalizedName" VARCHAR(480) NOT NULL,
  "previousDescription" VARCHAR(500),
  "correctedDescription" VARCHAR(500),
  "previousColor" VARCHAR(7) NOT NULL,
  "correctedColor" VARCHAR(7) NOT NULL,
  "previousIsActive" BOOLEAN NOT NULL,
  "correctedIsActive" BOOLEAN NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "resultingVersion" INTEGER NOT NULL,
  "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_incident_category_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_category_change_id_company_category_key" UNIQUE ("id", "companyId", "categoryId"),
  CONSTRAINT "support_category_change_category_version_key" UNIQUE ("categoryId", "resultingVersion"),
  CONSTRAINT "support_category_change_values_check" CHECK (
    "resultingVersion" > 1
    AND length(btrim("previousName")) BETWEEN 2 AND 120
    AND length(btrim("correctedName")) BETWEEN 2 AND 120
    AND length("previousNormalizedName") BETWEEN 1 AND 480
    AND length("correctedNormalizedName") BETWEEN 1 AND 480
    AND "previousNormalizedName" = lower(unaccent(btrim("previousName")))
    AND "correctedNormalizedName" = lower(unaccent(btrim("correctedName")))
    AND ("previousDescription" IS NULL OR length(btrim("previousDescription")) BETWEEN 3 AND 500)
    AND ("correctedDescription" IS NULL OR length(btrim("correctedDescription")) BETWEEN 3 AND 500)
    AND "previousColor" ~ '^#[0-9A-Fa-f]{6}$'
    AND "correctedColor" ~ '^#[0-9A-Fa-f]{6}$'
    AND length(btrim("reason")) BETWEEN 3 AND 500
    AND (
      "previousName" IS DISTINCT FROM "correctedName"
      OR "previousNormalizedName" IS DISTINCT FROM "correctedNormalizedName"
      OR "previousDescription" IS DISTINCT FROM "correctedDescription"
      OR "previousColor" IS DISTINCT FROM "correctedColor"
      OR "previousIsActive" IS DISTINCT FROM "correctedIsActive"
    )
  ),
  CONSTRAINT "support_category_change_company_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_category_change_category_fkey" FOREIGN KEY ("categoryId", "companyId") REFERENCES "support_incident_categories"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_category_change_actor_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "support_incident_category_changes_categoryId_changedAt_id_idx"
  ON "support_incident_category_changes"("categoryId", "changedAt", "id");
CREATE INDEX "support_incident_category_changes_companyId_actorUserId_changedAt_id_idx"
  ON "support_incident_category_changes"("companyId", "actorUserId", "changedAt", "id");

CREATE OR REPLACE FUNCTION "lock_support_category_company"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "companies" WHERE "id" = NEW."companyId" FOR UPDATE;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "support_incident_category_changes_company_lock"
BEFORE INSERT ON "support_incident_category_changes"
FOR EACH ROW EXECUTE FUNCTION "lock_support_category_company"();

CREATE OR REPLACE FUNCTION "reject_support_category_change_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Support incident category changes are append-only.' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "support_incident_category_changes_append_only"
BEFORE UPDATE OR DELETE ON "support_incident_category_changes"
FOR EACH ROW EXECUTE FUNCTION "reject_support_category_change_mutation"();

CREATE OR REPLACE FUNCTION "guard_support_incident_category"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Support incident categories cannot be deleted.' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM "companies" WHERE "id" = NEW."companyId" FOR UPDATE;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."companyId" IS DISTINCT FROM OLD."companyId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Support incident category identity is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "support_incident_categories_guard"
BEFORE UPDATE OR DELETE ON "support_incident_categories"
FOR EACH ROW EXECUTE FUNCTION "guard_support_incident_category"();

CREATE OR REPLACE FUNCTION "assert_support_category_change_consistency"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_category_id UUID;
  target_company_id UUID;
  category_row "support_incident_categories"%ROWTYPE;
  evidence_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'support_incident_categories' THEN
    target_category_id := NEW."id";
    target_company_id := NEW."companyId";
    IF NEW."version" <> OLD."version" + 1
      OR NOT EXISTS (
        SELECT 1 FROM "support_incident_category_changes" change
        WHERE change."categoryId" = NEW."id"
          AND change."companyId" = NEW."companyId"
          AND change."actorUserId" IS NOT NULL
          AND change."previousName" = OLD."name"
          AND change."correctedName" = NEW."name"
          AND change."previousNormalizedName" = OLD."normalizedName"
          AND change."correctedNormalizedName" = NEW."normalizedName"
          AND change."previousDescription" IS NOT DISTINCT FROM OLD."description"
          AND change."correctedDescription" IS NOT DISTINCT FROM NEW."description"
          AND change."previousColor" = OLD."color"
          AND change."correctedColor" = NEW."color"
          AND change."previousIsActive" = OLD."isActive"
          AND change."correctedIsActive" = NEW."isActive"
          AND change."resultingVersion" = NEW."version"
          AND change."changedAt" = NEW."updatedAt"
          AND change."changedAt" >= OLD."updatedAt"
      )
    THEN
      RAISE EXCEPTION 'A support category projection change requires matching versioned evidence.' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    target_category_id := NEW."categoryId";
    target_company_id := NEW."companyId";
  END IF;

  SELECT * INTO STRICT category_row
  FROM "support_incident_categories"
  WHERE "id" = target_category_id AND "companyId" = target_company_id;

  SELECT count(*)::integer INTO evidence_count
  FROM "support_incident_category_changes"
  WHERE "categoryId" = target_category_id AND "companyId" = target_company_id;

  IF NOT EXISTS (
    SELECT 1 FROM "support_incident_categories" active_category
    WHERE active_category."companyId" = target_company_id
      AND active_category."isActive" = true
  ) THEN
    RAISE EXCEPTION 'At least one support incident category must remain active.' USING ERRCODE = 'check_violation';
  END IF;

  IF evidence_count <> category_row."version" - 1
    OR EXISTS (
      SELECT 1 FROM "support_incident_category_changes" change
      WHERE change."categoryId" = target_category_id
        AND change."companyId" = target_company_id
        AND (
          (change."resultingVersion" = 2 AND EXISTS (
            SELECT 1 FROM "support_incident_category_changes" predecessor
            WHERE predecessor."categoryId" = change."categoryId"
              AND predecessor."resultingVersion" < change."resultingVersion"
          ))
          OR (change."resultingVersion" > 2 AND NOT EXISTS (
            SELECT 1 FROM "support_incident_category_changes" predecessor
            WHERE predecessor."categoryId" = change."categoryId"
              AND predecessor."companyId" = change."companyId"
              AND predecessor."resultingVersion" = change."resultingVersion" - 1
              AND predecessor."correctedName" = change."previousName"
              AND predecessor."correctedNormalizedName" = change."previousNormalizedName"
              AND predecessor."correctedDescription" IS NOT DISTINCT FROM change."previousDescription"
              AND predecessor."correctedColor" = change."previousColor"
              AND predecessor."correctedIsActive" = change."previousIsActive"
              AND predecessor."changedAt" <= change."changedAt"
          ))
        )
    )
    OR NOT EXISTS (
      SELECT 1 FROM "support_incident_category_changes" latest
      WHERE latest."categoryId" = category_row."id"
        AND latest."companyId" = category_row."companyId"
        AND latest."resultingVersion" = category_row."version"
        AND latest."correctedName" = category_row."name"
        AND latest."correctedNormalizedName" = category_row."normalizedName"
        AND latest."correctedDescription" IS NOT DISTINCT FROM category_row."description"
        AND latest."correctedColor" = category_row."color"
        AND latest."correctedIsActive" = category_row."isActive"
    )
  THEN
    RAISE EXCEPTION 'Support category projection does not match its append-only evidence.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "support_category_change_from_category"
AFTER UPDATE OF "name", "normalizedName", "description", "color", "isActive", "version", "updatedAt" ON "support_incident_categories"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (
  OLD."name" IS DISTINCT FROM NEW."name"
  OR OLD."normalizedName" IS DISTINCT FROM NEW."normalizedName"
  OR OLD."description" IS DISTINCT FROM NEW."description"
  OR OLD."color" IS DISTINCT FROM NEW."color"
  OR OLD."isActive" IS DISTINCT FROM NEW."isActive"
  OR OLD."version" IS DISTINCT FROM NEW."version"
  OR OLD."updatedAt" IS DISTINCT FROM NEW."updatedAt"
)
EXECUTE FUNCTION "assert_support_category_change_consistency"();

CREATE CONSTRAINT TRIGGER "support_category_change_from_evidence"
AFTER INSERT ON "support_incident_category_changes"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "assert_support_category_change_consistency"();

COMMIT;
