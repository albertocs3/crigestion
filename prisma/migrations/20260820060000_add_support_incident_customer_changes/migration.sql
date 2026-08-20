BEGIN;

CREATE TABLE "support_incident_customer_changes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "previousCustomerId" UUID NOT NULL,
  "correctedCustomerId" UUID NOT NULL,
  "previousCustomerCode" VARCHAR(20) NOT NULL,
  "previousCustomerLegalName" VARCHAR(200) NOT NULL,
  "correctedCustomerCode" VARCHAR(20) NOT NULL,
  "correctedCustomerLegalName" VARCHAR(200) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "resultingVersion" INTEGER NOT NULL,
  "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_incident_customer_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_customer_change_incident_key" UNIQUE ("id", "companyId", "incidentId"),
  CONSTRAINT "support_customer_change_incident_version_key" UNIQUE ("incidentId", "resultingVersion"),
  CONSTRAINT "support_customer_change_values_check" CHECK (
    "previousCustomerId" <> "correctedCustomerId"
    AND length(btrim("previousCustomerCode")) BETWEEN 1 AND 20
    AND length(btrim("correctedCustomerCode")) BETWEEN 1 AND 20
    AND length(btrim("previousCustomerLegalName")) BETWEEN 1 AND 200
    AND length(btrim("correctedCustomerLegalName")) BETWEEN 1 AND 200
    AND length(btrim("reason")) BETWEEN 3 AND 500
    AND "resultingVersion" > 1
  ),
  CONSTRAINT "support_customer_change_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_customer_change_incident_fkey"
    FOREIGN KEY ("incidentId", "companyId") REFERENCES "support_incidents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_customer_change_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_customer_change_previous_customer_fkey"
    FOREIGN KEY ("previousCustomerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "support_customer_change_corrected_customer_fkey"
    FOREIGN KEY ("correctedCustomerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "support_incident_customer_changes_companyId_actorUserId_changedAt_id_idx"
  ON "support_incident_customer_changes"("companyId", "actorUserId", "changedAt", "id");

CREATE OR REPLACE FUNCTION "validate_support_customer_change_labels"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_customer "customers"%ROWTYPE;
  corrected_customer "customers"%ROWTYPE;
BEGIN
  SELECT * INTO STRICT previous_customer FROM "customers"
  WHERE "id" = NEW."previousCustomerId" FOR SHARE;
  SELECT * INTO STRICT corrected_customer FROM "customers"
  WHERE "id" = NEW."correctedCustomerId" FOR SHARE;

  IF NEW."previousCustomerCode" IS DISTINCT FROM previous_customer."code"
    OR NEW."previousCustomerLegalName" IS DISTINCT FROM previous_customer."legalName"
    OR NEW."correctedCustomerCode" IS DISTINCT FROM corrected_customer."code"
    OR NEW."correctedCustomerLegalName" IS DISTINCT FROM corrected_customer."legalName"
  THEN
    RAISE EXCEPTION 'Support customer change labels do not match their referenced customers.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "support_customer_changes_validate_labels"
BEFORE INSERT ON "support_incident_customer_changes"
FOR EACH ROW EXECUTE FUNCTION "validate_support_customer_change_labels"();

CREATE OR REPLACE FUNCTION "reject_support_customer_change_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Support incident customer changes are append-only.' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "support_incident_customer_changes_append_only"
BEFORE UPDATE OR DELETE ON "support_incident_customer_changes"
FOR EACH ROW EXECUTE FUNCTION "reject_support_customer_change_mutation"();

ALTER TABLE "support_incident_events"
  ADD COLUMN "customerChangeId" UUID,
  ADD CONSTRAINT "support_event_customer_change_incident_key" UNIQUE ("customerChangeId", "companyId", "incidentId"),
  ADD CONSTRAINT "support_event_customer_change_incident_fkey"
    FOREIGN KEY ("customerChangeId", "companyId", "incidentId")
    REFERENCES "support_incident_customer_changes"("id", "companyId", "incidentId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "support_incident_events"
  ADD CONSTRAINT "support_incident_events_kind_check_v6" CHECK (
    ("eventType" = 'CREATED' AND "actionId" IS NULL AND "actionCorrectionId" IS NULL AND "customerChangeId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL AND "resultingVersion" = 1)
    OR ("eventType" = 'ACTION_ADDED' AND "actionId" IS NOT NULL AND "actionCorrectionId" IS NULL AND "customerChangeId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL)
    OR ("eventType" = 'ACTION_CORRECTED' AND "actionId" IS NULL AND "actionCorrectionId" IS NOT NULL AND "customerChangeId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL AND "fromStatus" IS NOT NULL AND "toStatus" = "fromStatus" AND "resultingVersion" > 1)
    OR ("eventType" = 'CUSTOMER_CHANGED' AND "actionId" IS NULL AND "actionCorrectionId" IS NULL AND "customerChangeId" IS NOT NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL AND "fromStatus" IS NOT NULL AND "toStatus" = "fromStatus" AND "resultingVersion" > 1)
    OR ("eventType" = 'STATUS_CHANGED' AND "actionId" IS NULL AND "actionCorrectionId" IS NULL AND "customerChangeId" IS NULL AND "transitionId" IS NOT NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL)
    OR ("eventType" IN ('COLLABORATOR_ADDED', 'COLLABORATOR_REMOVED', 'RESPONSIBLE_CHANGED') AND "actionId" IS NULL AND "actionCorrectionId" IS NULL AND "customerChangeId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NOT NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL)
    OR ("eventType" = 'PRIORITY_CHANGED' AND "actionId" IS NULL AND "actionCorrectionId" IS NULL AND "customerChangeId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NOT NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL AND "fromStatus" IS NOT NULL AND "toStatus" = "fromStatus" AND "resultingVersion" > 1)
    OR ("eventType" = 'DETAILS_CHANGED' AND "actionId" IS NULL AND "actionCorrectionId" IS NULL AND "customerChangeId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NOT NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL AND "fromStatus" IS NOT NULL AND "toStatus" = "fromStatus" AND "resultingVersion" > 1)
    OR ("eventType" = 'INCIDENT_MERGED' AND "actionId" IS NULL AND "actionCorrectionId" IS NULL AND "customerChangeId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NOT NULL AND "mergeRole" IS NOT NULL AND "fromStatus" IS NOT NULL AND "toStatus" IS NOT NULL AND "resultingVersion" > 1 AND (("mergeRole" = 'PRIMARY' AND "toStatus" = "fromStatus") OR ("mergeRole" = 'DUPLICATE' AND "toStatus" = 'CLOSED')))
  ) NOT VALID;

ALTER TABLE "support_incident_events" VALIDATE CONSTRAINT "support_incident_events_kind_check_v6";
ALTER TABLE "support_incident_events" DROP CONSTRAINT "support_incident_events_kind_check";
ALTER TABLE "support_incident_events" RENAME CONSTRAINT "support_incident_events_kind_check_v6" TO "support_incident_events_kind_check";

ALTER TABLE "support_communications"
  DROP CONSTRAINT "support_communications_incidentId_companyId_customerId_fkey",
  ADD CONSTRAINT "support_communications_incidentId_companyId_fkey"
    FOREIGN KEY ("incidentId", "companyId") REFERENCES "support_incidents"("id", "companyId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "guard_merged_duplicate_communication_link"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  incident_customer_id UUID;
  merged_into_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."customerId" IS DISTINCT FROM OLD."customerId" THEN
    RAISE EXCEPTION 'A communication customer is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."incidentId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
    AND NEW."incidentId" IS NOT DISTINCT FROM OLD."incidentId"
    AND NEW."customerId" IS NOT DISTINCT FROM OLD."customerId"
  THEN
    RETURN NEW;
  END IF;

  SELECT incident."customerId", incident."mergedIntoIncidentId"
  INTO incident_customer_id, merged_into_id
  FROM "support_incidents" incident
  WHERE incident."id" = NEW."incidentId" AND incident."companyId" = NEW."companyId"
  FOR SHARE;

  IF incident_customer_id IS NULL
    OR incident_customer_id <> NEW."customerId"
    OR merged_into_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'A communication can only be linked to a canonical incident of the same customer.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER "support_communications_merged_duplicate_guard" ON "support_communications";
CREATE TRIGGER "support_communications_merged_duplicate_guard"
BEFORE INSERT OR UPDATE OF "incidentId", "customerId" ON "support_communications"
FOR EACH ROW EXECUTE FUNCTION "guard_merged_duplicate_communication_link"();

DROP TRIGGER "support_details_from_incident" ON "support_incidents";
CREATE CONSTRAINT TRIGGER "support_details_from_incident"
AFTER UPDATE OF "storeId", "categoryId", "title", "description" ON "support_incidents"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (
  OLD."customerId" IS NOT DISTINCT FROM NEW."customerId"
  AND (
    OLD."storeId" IS DISTINCT FROM NEW."storeId"
    OR OLD."categoryId" IS DISTINCT FROM NEW."categoryId"
    OR OLD."title" IS DISTINCT FROM NEW."title"
    OR OLD."description" IS DISTINCT FROM NEW."description"
  )
)
EXECUTE FUNCTION "assert_support_incident_details_consistency"();

CREATE OR REPLACE FUNCTION "assert_support_incident_customer_change_consistency"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_incident_id UUID;
  target_company_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'support_incidents' THEN
    target_incident_id := NEW."id";
    target_company_id := NEW."companyId";
    IF NEW."version" <> OLD."version" + 1
      OR OLD."customerId" IS NOT DISTINCT FROM NEW."customerId"
      OR OLD."storeId" IS NOT NULL OR NEW."storeId" IS NOT NULL
      OR OLD."mergedIntoIncidentId" IS NOT NULL OR NEW."mergedIntoIncidentId" IS NOT NULL
      OR EXISTS (SELECT 1 FROM "support_incidents" child WHERE child."companyId" = NEW."companyId" AND child."mergedIntoIncidentId" = NEW."id")
      OR NEW."companyId" IS DISTINCT FROM OLD."companyId"
      OR NEW."year" IS DISTINCT FROM OLD."year"
      OR NEW."sequenceNumber" IS DISTINCT FROM OLD."sequenceNumber"
      OR NEW."number" IS DISTINCT FROM OLD."number"
      OR NEW."categoryId" IS DISTINCT FROM OLD."categoryId"
      OR NEW."responsibleUserId" IS DISTINCT FROM OLD."responsibleUserId"
      OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
      OR NEW."title" IS DISTINCT FROM OLD."title"
      OR NEW."description" IS DISTINCT FROM OLD."description"
      OR NEW."priority" IS DISTINCT FROM OLD."priority"
      OR NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."firstActionAt" IS DISTINCT FROM OLD."firstActionAt"
      OR NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt"
      OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt"
      OR NEW."solution" IS DISTINCT FROM OLD."solution"
      OR NEW."closeReason" IS DISTINCT FROM OLD."closeReason"
      OR NEW."closeReasonDetail" IS DISTINCT FROM OLD."closeReasonDetail"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
      OR NOT EXISTS (
        SELECT 1 FROM "support_incident_customer_changes" change
        JOIN "support_incident_events" event
          ON event."customerChangeId" = change."id"
         AND event."companyId" = change."companyId"
         AND event."incidentId" = change."incidentId"
        WHERE change."incidentId" = NEW."id"
          AND change."companyId" = NEW."companyId"
          AND change."previousCustomerId" = OLD."customerId"
          AND change."correctedCustomerId" = NEW."customerId"
          AND change."resultingVersion" = NEW."version"
          AND change."changedAt" = NEW."updatedAt"
          AND change."changedAt" >= OLD."updatedAt"
          AND event."eventType" = 'CUSTOMER_CHANGED'
          AND event."actorUserId" = change."actorUserId"
          AND event."resultingVersion" = change."resultingVersion"
          AND event."fromStatus" = OLD."status"
          AND event."toStatus" = NEW."status"
          AND event."createdAt" = change."changedAt"
      )
    THEN
      RAISE EXCEPTION 'A customer projection change requires matching versioned evidence.' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    target_incident_id := NEW."incidentId";
    target_company_id := NEW."companyId";
  END IF;

  IF EXISTS (
    SELECT 1 FROM "support_incident_customer_changes" change
    WHERE change."incidentId" = target_incident_id AND change."companyId" = target_company_id
      AND NOT EXISTS (
        SELECT 1 FROM "support_incident_events" event
        WHERE event."customerChangeId" = change."id"
          AND event."companyId" = change."companyId"
          AND event."incidentId" = change."incidentId"
          AND event."actorUserId" = change."actorUserId"
          AND event."eventType" = 'CUSTOMER_CHANGED'
          AND event."resultingVersion" = change."resultingVersion"
          AND event."fromStatus" = event."toStatus"
          AND event."createdAt" = change."changedAt"
      )
  ) THEN
    RAISE EXCEPTION 'A support incident customer change requires one matching event.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "support_incident_events" event
    WHERE event."incidentId" = target_incident_id AND event."companyId" = target_company_id
      AND event."eventType" = 'CUSTOMER_CHANGED'
      AND NOT EXISTS (
        SELECT 1 FROM "support_incident_customer_changes" change
        WHERE change."id" = event."customerChangeId"
          AND change."companyId" = event."companyId"
          AND change."incidentId" = event."incidentId"
          AND change."actorUserId" = event."actorUserId"
          AND change."resultingVersion" = event."resultingVersion"
      )
  ) THEN
    RAISE EXCEPTION 'A customer change event requires matching evidence.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "support_incident_customer_changes" change
    JOIN "support_incidents" incident ON incident."id" = change."incidentId" AND incident."companyId" = change."companyId"
    WHERE change."incidentId" = target_incident_id AND change."companyId" = target_company_id
      AND change."resultingVersion" > incident."version"
  ) OR EXISTS (
    SELECT 1 FROM "support_incidents" incident
    JOIN "support_incident_customer_changes" latest
      ON latest."incidentId" = incident."id" AND latest."companyId" = incident."companyId"
    WHERE incident."id" = target_incident_id AND incident."companyId" = target_company_id
      AND latest."resultingVersion" = (
        SELECT max(candidate."resultingVersion") FROM "support_incident_customer_changes" candidate
        WHERE candidate."incidentId" = incident."id" AND candidate."companyId" = incident."companyId"
      )
      AND latest."correctedCustomerId" <> incident."customerId"
  ) THEN
    RAISE EXCEPTION 'Support incident customer projection does not match its evidence.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "support_customer_change_from_incident"
AFTER UPDATE OF "customerId" ON "support_incidents"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD."customerId" IS DISTINCT FROM NEW."customerId")
EXECUTE FUNCTION "assert_support_incident_customer_change_consistency"();

CREATE CONSTRAINT TRIGGER "support_customer_change_from_change"
AFTER INSERT ON "support_incident_customer_changes"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "assert_support_incident_customer_change_consistency"();

CREATE CONSTRAINT TRIGGER "support_customer_change_from_event"
AFTER INSERT ON "support_incident_events"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW."eventType" = 'CUSTOMER_CHANGED')
EXECUTE FUNCTION "assert_support_incident_customer_change_consistency"();

CREATE OR REPLACE FUNCTION "reject_spurious_support_customer_version"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."version" <> OLD."version"
    AND NEW."customerId" IS NOT DISTINCT FROM OLD."customerId"
    AND (
      EXISTS (SELECT 1 FROM "support_incident_customer_changes" change WHERE change."incidentId" = NEW."id" AND change."companyId" = NEW."companyId" AND change."resultingVersion" = NEW."version")
      OR EXISTS (SELECT 1 FROM "support_incident_events" event WHERE event."incidentId" = NEW."id" AND event."companyId" = NEW."companyId" AND event."resultingVersion" = NEW."version" AND event."eventType" = 'CUSTOMER_CHANGED')
    )
  THEN
    RAISE EXCEPTION 'A customer event cannot advance the version without changing customer.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "support_customer_change_from_version"
AFTER UPDATE OF "version" ON "support_incidents"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "reject_spurious_support_customer_version"();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Support.ChangeIncidentCustomer', 'Corregir administrativamente el cliente de una incidencia', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador' AND permission."code" = 'Support.ChangeIncidentCustomer'
ON CONFLICT DO NOTHING;

COMMIT;
