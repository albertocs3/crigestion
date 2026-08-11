BEGIN;

CREATE TYPE "SupportCommunicationChannel" AS ENUM ('PHONE', 'WHATSAPP');
CREATE TYPE "SupportCommunicationDirection" AS ENUM ('INBOUND', 'OUTBOUND');
CREATE TYPE "SupportCommunicationResult" AS ENUM ('RESOLVED_NO_FOLLOW_UP', 'REQUIRES_FOLLOW_UP', 'NO_ANSWER', 'INFORMATION_PROVIDED', 'REFERRED_TO_INCIDENT');

ALTER TABLE "support_incidents" ADD CONSTRAINT "support_incidents_id_companyId_customerId_key" UNIQUE ("id", "companyId", "customerId");

CREATE TABLE "support_communications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "companyId" UUID NOT NULL, "customerId" UUID NOT NULL, "incidentId" UUID,
  "registeredByUserId" UUID NOT NULL, "channel" "SupportCommunicationChannel" NOT NULL, "direction" "SupportCommunicationDirection" NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL, "contactNumber" VARCHAR(40) NOT NULL, "durationSeconds" INTEGER,
  "summary" VARCHAR(2000) NOT NULL, "result" "SupportCommunicationResult" NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_communications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_communications_id_companyId_key" UNIQUE ("id", "companyId"),
  CONSTRAINT "support_communications_content_check" CHECK (
    "version" > 0 AND length(btrim("contactNumber")) >= 3 AND length(btrim("summary")) >= 3
    AND "occurredAt" <= "recordedAt" + INTERVAL '5 minutes'
    AND (("channel" = 'PHONE' AND ("durationSeconds" IS NULL OR "durationSeconds" >= 0)) OR ("channel" = 'WHATSAPP' AND "durationSeconds" IS NULL))
    AND (("result" IN ('REQUIRES_FOLLOW_UP', 'REFERRED_TO_INCIDENT') AND "incidentId" IS NOT NULL) OR "result" NOT IN ('REQUIRES_FOLLOW_UP', 'REFERRED_TO_INCIDENT'))
  ),
  CONSTRAINT "support_communications_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_communications_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_communications_incidentId_companyId_customerId_fkey" FOREIGN KEY ("incidentId", "companyId", "customerId") REFERENCES "support_incidents"("id", "companyId", "customerId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_communications_registeredByUserId_fkey" FOREIGN KEY ("registeredByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "support_communications_companyId_occurredAt_id_idx" ON "support_communications"("companyId", "occurredAt", "id");
CREATE INDEX "support_communications_companyId_customerId_occurredAt_id_idx" ON "support_communications"("companyId", "customerId", "occurredAt", "id");
CREATE INDEX "support_communications_incidentId_occurredAt_id_idx" ON "support_communications"("incidentId", "occurredAt", "id");

CREATE TABLE "support_communication_corrections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "companyId" UUID NOT NULL, "communicationId" UUID NOT NULL, "correctedByUserId" UUID NOT NULL, "resultingVersion" INTEGER NOT NULL,
  "previousChannel" "SupportCommunicationChannel" NOT NULL, "correctedChannel" "SupportCommunicationChannel" NOT NULL,
  "previousDirection" "SupportCommunicationDirection" NOT NULL, "correctedDirection" "SupportCommunicationDirection" NOT NULL,
  "previousOccurredAt" TIMESTAMPTZ(3) NOT NULL, "correctedOccurredAt" TIMESTAMPTZ(3) NOT NULL,
  "previousContactNumber" VARCHAR(40) NOT NULL, "correctedContactNumber" VARCHAR(40) NOT NULL,
  "previousDurationSeconds" INTEGER, "correctedDurationSeconds" INTEGER,
  "previousSummary" VARCHAR(2000) NOT NULL, "correctedSummary" VARCHAR(2000) NOT NULL,
  "previousResult" "SupportCommunicationResult" NOT NULL, "correctedResult" "SupportCommunicationResult" NOT NULL,
  "previousIncidentId" UUID, "correctedIncidentId" UUID, "reason" VARCHAR(500) NOT NULL,
  "correctedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_communication_corrections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_communication_corrections_communicationId_resultingVersion_key" UNIQUE ("communicationId", "resultingVersion"),
  CONSTRAINT "support_communication_corrections_content_check" CHECK ("resultingVersion" > 1 AND length(btrim("reason")) >= 3),
  CONSTRAINT "support_communication_corrections_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_communication_corrections_communicationId_companyId_fkey" FOREIGN KEY ("communicationId", "companyId") REFERENCES "support_communications"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_communication_corrections_correctedByUserId_fkey" FOREIGN KEY ("correctedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "support_communication_corrections_communicationId_correctedAt_id_idx" ON "support_communication_corrections"("communicationId", "correctedAt", "id");

CREATE OR REPLACE FUNCTION "reject_support_communication_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Support communications cannot be deleted.' USING ERRCODE = 'check_violation'; END;
$$;
CREATE TRIGGER "support_communications_no_delete" BEFORE DELETE ON "support_communications" FOR EACH ROW EXECUTE FUNCTION "reject_support_communication_delete"();
CREATE TRIGGER "support_communication_corrections_append_only" BEFORE UPDATE OR DELETE ON "support_communication_corrections" FOR EACH ROW EXECUTE FUNCTION "reject_support_communication_delete"();

CREATE OR REPLACE FUNCTION "assert_support_communication_correction"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE correction_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'support_communications' THEN
    IF NEW."version" <> OLD."version" + 1 THEN RAISE EXCEPTION 'A communication correction must increment one version.' USING ERRCODE = 'check_violation'; END IF;
    SELECT count(*) INTO correction_count FROM "support_communication_corrections" correction
    WHERE correction."communicationId" = NEW."id" AND correction."companyId" = NEW."companyId" AND correction."resultingVersion" = NEW."version"
      AND correction."previousChannel" = OLD."channel" AND correction."correctedChannel" = NEW."channel"
      AND correction."previousDirection" = OLD."direction" AND correction."correctedDirection" = NEW."direction"
      AND correction."previousOccurredAt" = OLD."occurredAt" AND correction."correctedOccurredAt" = NEW."occurredAt"
      AND correction."previousContactNumber" = OLD."contactNumber" AND correction."correctedContactNumber" = NEW."contactNumber"
      AND correction."previousDurationSeconds" IS NOT DISTINCT FROM OLD."durationSeconds" AND correction."correctedDurationSeconds" IS NOT DISTINCT FROM NEW."durationSeconds"
      AND correction."previousSummary" = OLD."summary" AND correction."correctedSummary" = NEW."summary"
      AND correction."previousResult" = OLD."result" AND correction."correctedResult" = NEW."result"
      AND correction."previousIncidentId" IS NOT DISTINCT FROM OLD."incidentId" AND correction."correctedIncidentId" IS NOT DISTINCT FROM NEW."incidentId";
    IF correction_count <> 1 THEN RAISE EXCEPTION 'A communication update requires one exact correction.' USING ERRCODE = 'check_violation'; END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM "support_communications" communication WHERE communication."id" = NEW."communicationId" AND communication."companyId" = NEW."companyId" AND communication."version" = NEW."resultingVersion" AND communication."channel" = NEW."correctedChannel" AND communication."direction" = NEW."correctedDirection" AND communication."occurredAt" = NEW."correctedOccurredAt" AND communication."contactNumber" = NEW."correctedContactNumber" AND communication."durationSeconds" IS NOT DISTINCT FROM NEW."correctedDurationSeconds" AND communication."summary" = NEW."correctedSummary" AND communication."result" = NEW."correctedResult" AND communication."incidentId" IS NOT DISTINCT FROM NEW."correctedIncidentId")
    THEN RAISE EXCEPTION 'A correction must match the current communication projection.' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "support_communication_correction_from_communication" AFTER UPDATE OF "channel", "direction", "occurredAt", "contactNumber", "durationSeconds", "summary", "result", "incidentId", "version" ON "support_communications" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_support_communication_correction"();
CREATE CONSTRAINT TRIGGER "support_communication_correction_from_evidence" AFTER INSERT ON "support_communication_corrections" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_support_communication_correction"();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt") VALUES
  (gen_random_uuid(), 'Support.ViewCommunications', 'Consultar comunicaciones de clientes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Support.ManageCommunications', 'Registrar y corregir comunicaciones de clientes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;
INSERT INTO "role_permissions" ("roleId", "permissionId") SELECT role."id", permission."id" FROM "roles" role CROSS JOIN "permissions" permission WHERE role."code" = 'Administrador' AND permission."code" IN ('Support.ViewCommunications', 'Support.ManageCommunications') ON CONFLICT DO NOTHING;

COMMIT;
