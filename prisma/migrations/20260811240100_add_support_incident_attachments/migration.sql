BEGIN;

ALTER TABLE "attachments"
  DROP CONSTRAINT "attachments_storage_key_check";

ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_storage_key_check" CHECK (
    "storageKey" IS NULL OR
    (
      "purpose" = 'COMPANY_LOGO' AND
      "storageKey" ~ '^company-logo/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg)$'
    ) OR
    (
      "purpose" = 'SUPPORT_INCIDENT' AND
      "storageKey" ~ '^support-incident/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|pdf)$'
    )
  );

ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_support_incident_policy_check" CHECK (
    "purpose" <> 'SUPPORT_INCIDENT' OR (
      "sizeBytes" <= 16777216 AND
      "extension" IN ('jpg', 'pdf') AND
      (("extension" = 'jpg' AND "declaredMimeType" = 'image/jpeg') OR
       ("extension" = 'pdf' AND "declaredMimeType" = 'application/pdf')) AND
      (
        "detectedMimeType" IS NULL OR
        ("extension" = 'jpg' AND "detectedMimeType" = 'image/jpeg') OR
        ("extension" = 'pdf' AND "detectedMimeType" = 'application/pdf')
      )
    )
  );

ALTER TABLE "support_incident_actions"
  ADD CONSTRAINT "support_incident_actions_id_companyId_incidentId_key"
  UNIQUE ("id", "companyId", "incidentId");

CREATE TABLE "support_incident_attachments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "actionId" UUID,
  "attachmentId" UUID NOT NULL,
  "attachedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "support_incident_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_incident_attachments_id_companyId_key" UNIQUE ("id", "companyId"),
  CONSTRAINT "support_incident_attachments_attachmentId_key" UNIQUE ("attachmentId"),
  CONSTRAINT "support_incident_attachments_attachmentId_companyId_key" UNIQUE ("attachmentId", "companyId"),
  CONSTRAINT "support_incident_attachments_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_attachments_incidentId_companyId_fkey"
    FOREIGN KEY ("incidentId", "companyId") REFERENCES "support_incidents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_attachments_actionId_companyId_incidentId_fkey"
    FOREIGN KEY ("actionId", "companyId", "incidentId") REFERENCES "support_incident_actions"("id", "companyId", "incidentId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_attachments_attachmentId_companyId_fkey"
    FOREIGN KEY ("attachmentId", "companyId") REFERENCES "attachments"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "support_incident_attachments_incidentId_attachedAt_id_idx"
  ON "support_incident_attachments"("incidentId", "attachedAt", "id");

CREATE INDEX "support_incident_attachments_actionId_attachedAt_id_idx"
  ON "support_incident_attachments"("actionId", "attachedAt", "id");

CREATE INDEX "support_incident_attachments_companyId_attachedAt_id_idx"
  ON "support_incident_attachments"("companyId", "attachedAt", "id");

CREATE OR REPLACE FUNCTION "reject_support_incident_attachment_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Support incident attachment links are append-only.' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "support_incident_attachments_append_only"
BEFORE UPDATE OR DELETE ON "support_incident_attachments"
FOR EACH ROW EXECUTE FUNCTION "reject_support_incident_attachment_mutation"();

CREATE OR REPLACE FUNCTION "assert_support_incident_attachment_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_attachment_id UUID;
  target_company_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'attachments' THEN
    target_attachment_id := NEW."id";
    target_company_id := NEW."companyId";
  ELSE
    target_attachment_id := NEW."attachmentId";
    target_company_id := NEW."companyId";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "attachments" replacement
    JOIN "attachments" original
      ON original."id" = replacement."replacesAttachmentId"
     AND original."companyId" = replacement."companyId"
    WHERE replacement."id" = target_attachment_id
      AND replacement."companyId" = target_company_id
      AND replacement."purpose" IS DISTINCT FROM original."purpose"
  ) THEN
    RAISE EXCEPTION 'ATTACHMENT_REPLACEMENT_PURPOSE_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "support_incident_attachments" link
    JOIN "attachments" attachment
      ON attachment."id" = link."attachmentId"
     AND attachment."companyId" = link."companyId"
    WHERE link."attachmentId" = target_attachment_id
      AND link."companyId" = target_company_id
      AND attachment."purpose" <> 'SUPPORT_INCIDENT'
  ) THEN
    RAISE EXCEPTION 'SUPPORT_INCIDENT_ATTACHMENT_PURPOSE_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "attachments" attachment
    WHERE attachment."id" = target_attachment_id
      AND attachment."companyId" = target_company_id
      AND attachment."purpose" = 'SUPPORT_INCIDENT'
      AND (
        SELECT count(*)
        FROM "support_incident_attachments" link
        WHERE link."attachmentId" = attachment."id"
          AND link."companyId" = attachment."companyId"
      ) <> 1
  ) THEN
    RAISE EXCEPTION 'SUPPORT_INCIDENT_ATTACHMENT_LINK_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "attachments" replacement
    JOIN "support_incident_attachments" replacement_link
      ON replacement_link."attachmentId" = replacement."id"
     AND replacement_link."companyId" = replacement."companyId"
    LEFT JOIN "attachments" original
      ON original."id" = replacement."replacesAttachmentId"
     AND original."companyId" = replacement."companyId"
    LEFT JOIN "support_incident_attachments" original_link
      ON original_link."attachmentId" = original."id"
     AND original_link."companyId" = original."companyId"
    WHERE replacement."id" = target_attachment_id
      AND replacement."companyId" = target_company_id
      AND replacement."purpose" = 'SUPPORT_INCIDENT'
      AND replacement."replacesAttachmentId" IS NOT NULL
      AND (
        original."purpose" IS DISTINCT FROM 'SUPPORT_INCIDENT'::"AttachmentPurpose"
        OR original_link."incidentId" IS DISTINCT FROM replacement_link."incidentId"
      )
  ) THEN
    RAISE EXCEPTION 'SUPPORT_INCIDENT_ATTACHMENT_REPLACEMENT_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "support_incident_attachment_consistency_from_attachment"
AFTER INSERT OR UPDATE ON "attachments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_support_incident_attachment_consistency"();

CREATE CONSTRAINT TRIGGER "support_incident_attachment_consistency_from_link"
AFTER INSERT ON "support_incident_attachments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_support_incident_attachment_consistency"();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'Support.ManageAttachments', 'Adjuntar archivos a incidencias autorizadas', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Support.DownloadAttachments', 'Descargar adjuntos de incidencias autorizadas', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador'
  AND permission."code" IN ('Support.ManageAttachments', 'Support.DownloadAttachments')
ON CONFLICT DO NOTHING;

COMMIT;
