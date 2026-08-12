BEGIN;

CREATE TYPE "SupportIncidentMergeRole" AS ENUM ('PRIMARY', 'DUPLICATE');

CREATE TABLE "support_incident_merges" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "primaryIncidentId" UUID NOT NULL,
  "duplicateIncidentId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "primaryResponsibleUserId" UUID NOT NULL,
  "duplicateResponsibleUserId" UUID NOT NULL,
  "primaryStatusBefore" "SupportIncidentStatus" NOT NULL,
  "duplicateStatusBefore" "SupportIncidentStatus" NOT NULL,
  "primaryVersionBefore" INTEGER NOT NULL,
  "duplicateVersionBefore" INTEGER NOT NULL,
  "primaryResultingVersion" INTEGER NOT NULL,
  "duplicateResultingVersion" INTEGER NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "mergedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "support_incident_merges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_incident_merges_id_company_key" UNIQUE ("id", "companyId"),
  CONSTRAINT "support_incident_merges_duplicate_company_key" UNIQUE ("duplicateIncidentId", "companyId"),
  CONSTRAINT "support_incident_merges_values_check" CHECK (
    "primaryIncidentId" <> "duplicateIncidentId"
    AND "primaryVersionBefore" > 0
    AND "duplicateVersionBefore" > 0
    AND "primaryResultingVersion" = "primaryVersionBefore" + 1
    AND "duplicateResultingVersion" = "duplicateVersionBefore" + 1
    AND "primaryStatusBefore" NOT IN ('RESOLVED', 'CLOSED')
    AND "duplicateStatusBefore" NOT IN ('RESOLVED', 'CLOSED')
    AND length(btrim("reason")) BETWEEN 3 AND 500
  ),
  CONSTRAINT "support_incident_merges_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_merges_primary_fkey"
    FOREIGN KEY ("primaryIncidentId", "companyId") REFERENCES "support_incidents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_merges_duplicate_fkey"
    FOREIGN KEY ("duplicateIncidentId", "companyId") REFERENCES "support_incidents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_merges_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_merges_primary_responsible_fkey"
    FOREIGN KEY ("primaryResponsibleUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_merges_duplicate_responsible_fkey"
    FOREIGN KEY ("duplicateResponsibleUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "support_incident_merges_primary_time_idx"
  ON "support_incident_merges"("companyId", "primaryIncidentId", "mergedAt", "id");

ALTER TABLE "support_incidents"
  ADD COLUMN "mergedIntoIncidentId" UUID,
  ADD CONSTRAINT "support_incidents_merged_into_fkey"
    FOREIGN KEY ("mergedIntoIncidentId", "companyId") REFERENCES "support_incidents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "support_incidents_merged_into_idx"
  ON "support_incidents"("companyId", "mergedIntoIncidentId");

ALTER TABLE "support_incident_events"
  ADD COLUMN "mergeId" UUID,
  ADD COLUMN "mergeRole" "SupportIncidentMergeRole",
  ADD CONSTRAINT "support_event_merge_incident_key" UNIQUE ("mergeId", "companyId", "incidentId"),
  ADD CONSTRAINT "support_event_merge_role_key" UNIQUE ("mergeId", "mergeRole"),
  ADD CONSTRAINT "support_event_merge_fkey"
    FOREIGN KEY ("mergeId", "companyId") REFERENCES "support_incident_merges"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "support_incident_events"
  ADD CONSTRAINT "support_incident_events_kind_check_v3" CHECK (
    ("eventType" = 'CREATED' AND "actionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL AND "resultingVersion" = 1)
    OR ("eventType" = 'ACTION_ADDED' AND "actionId" IS NOT NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL)
    OR ("eventType" = 'STATUS_CHANGED' AND "actionId" IS NULL AND "transitionId" IS NOT NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL)
    OR ("eventType" IN ('COLLABORATOR_ADDED', 'COLLABORATOR_REMOVED', 'RESPONSIBLE_CHANGED') AND "actionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NOT NULL AND "priorityChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL)
    OR ("eventType" = 'PRIORITY_CHANGED' AND "actionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NOT NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL AND "fromStatus" IS NOT NULL AND "toStatus" = "fromStatus" AND "resultingVersion" > 1)
    OR ("eventType" = 'INCIDENT_MERGED' AND "actionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "mergeId" IS NOT NULL AND "mergeRole" IS NOT NULL AND "fromStatus" IS NOT NULL AND "toStatus" IS NOT NULL AND "resultingVersion" > 1 AND (("mergeRole" = 'PRIMARY' AND "toStatus" = "fromStatus") OR ("mergeRole" = 'DUPLICATE' AND "toStatus" = 'CLOSED')))
  ) NOT VALID;

ALTER TABLE "support_incident_events" VALIDATE CONSTRAINT "support_incident_events_kind_check_v3";
ALTER TABLE "support_incident_events" DROP CONSTRAINT "support_incident_events_kind_check";
ALTER TABLE "support_incident_events" RENAME CONSTRAINT "support_incident_events_kind_check_v3" TO "support_incident_events_kind_check";

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_kind_message_severity_check_v2" CHECK (
    ("kind" = 'SUPPORT_INCIDENT_ASSIGNED' AND "messageCode" = 'support.incident.assigned' AND "severity" = 'INFO') OR
    ("kind" = 'SUPPORT_INCIDENT_REASSIGNED' AND "messageCode" = 'support.incident.reassigned' AND "severity" = 'INFO') OR
    ("kind" = 'SUPPORT_INCIDENT_URGENT' AND "messageCode" = 'support.incident.urgent' AND "severity" = 'URGENT') OR
    ("kind" = 'SUPPORT_INCIDENT_COLLABORATOR_ADDED' AND "messageCode" = 'support.incident.collaborator-added' AND "severity" = 'INFO') OR
    ("kind" = 'SUPPORT_INCIDENT_COLLABORATOR_ACTION' AND "messageCode" = 'support.incident.collaborator-action' AND "severity" = 'INFO') OR
    ("kind" = 'SUPPORT_INCIDENT_REOPENED' AND "messageCode" = 'support.incident.reopened' AND "severity" = 'INFO') OR
    ("kind" = 'SUPPORT_INCIDENT_MERGED' AND "messageCode" = 'support.incident.merged' AND "severity" = 'INFO')
  ) NOT VALID;

ALTER TABLE "notifications" VALIDATE CONSTRAINT "notifications_kind_message_severity_check_v2";
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_message_severity_check";
ALTER TABLE "notifications" RENAME CONSTRAINT "notifications_kind_message_severity_check_v2" TO "notifications_kind_message_severity_check";

CREATE OR REPLACE FUNCTION "guard_support_incident_merge_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  locked_count INTEGER;
BEGIN
  PERFORM incident."id"
  FROM "support_incidents" incident
  WHERE incident."companyId" = NEW."companyId"
    AND incident."id" IN (NEW."primaryIncidentId", NEW."duplicateIncidentId")
  ORDER BY incident."id"
  FOR UPDATE;
  GET DIAGNOSTICS locked_count = ROW_COUNT;

  IF locked_count <> 2 OR NOT EXISTS (
    SELECT 1
    FROM "support_incidents" primary_incident
    JOIN "support_incidents" duplicate_incident
      ON duplicate_incident."id" = NEW."duplicateIncidentId"
     AND duplicate_incident."companyId" = NEW."companyId"
    WHERE primary_incident."id" = NEW."primaryIncidentId"
      AND primary_incident."companyId" = NEW."companyId"
      AND primary_incident."customerId" = duplicate_incident."customerId"
      AND primary_incident."mergedIntoIncidentId" IS NULL
      AND duplicate_incident."mergedIntoIncidentId" IS NULL
      AND primary_incident."status" NOT IN ('RESOLVED', 'CLOSED')
      AND duplicate_incident."status" NOT IN ('RESOLVED', 'CLOSED')
      AND primary_incident."responsibleUserId" = NEW."primaryResponsibleUserId"
      AND duplicate_incident."responsibleUserId" = NEW."duplicateResponsibleUserId"
      AND primary_incident."status" = NEW."primaryStatusBefore"
      AND duplicate_incident."status" = NEW."duplicateStatusBefore"
      AND primary_incident."version" = NEW."primaryVersionBefore"
      AND duplicate_incident."version" = NEW."duplicateVersionBefore"
      AND NOT EXISTS (
        SELECT 1 FROM "support_incident_merges" existing
        WHERE existing."companyId" = NEW."companyId"
          AND existing."duplicateIncidentId" = NEW."primaryIncidentId"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "support_incident_merges" existing
        WHERE existing."companyId" = NEW."companyId"
          AND existing."primaryIncidentId" = NEW."duplicateIncidentId"
      )
  ) THEN
    RAISE EXCEPTION 'Support incident merge identities or snapshots are invalid.' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "support_incident_merges_insert_guard"
BEFORE INSERT ON "support_incident_merges"
FOR EACH ROW EXECUTE FUNCTION "guard_support_incident_merge_insert"();

CREATE OR REPLACE FUNCTION "reject_support_incident_merge_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Support incident merges are append-only.' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "support_incident_merges_append_only"
BEFORE UPDATE OR DELETE ON "support_incident_merges"
FOR EACH ROW EXECUTE FUNCTION "reject_support_incident_merge_mutation"();

CREATE OR REPLACE FUNCTION "guard_merged_duplicate_incident_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."mergedIntoIncidentId" IS NOT NULL THEN
    RAISE EXCEPTION 'A merged duplicate incident is immutable.' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "support_incidents_merged_duplicate_guard"
BEFORE UPDATE OR DELETE ON "support_incidents"
FOR EACH ROW EXECUTE FUNCTION "guard_merged_duplicate_incident_mutation"();

CREATE OR REPLACE FUNCTION "guard_merged_duplicate_communication_link"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."incidentId" IS NULL
     OR (TG_OP = 'UPDATE' AND NEW."incidentId" IS NOT DISTINCT FROM OLD."incidentId") THEN
    RETURN NEW;
  END IF;

  PERFORM incident."id"
  FROM "support_incidents" incident
  WHERE incident."id" = NEW."incidentId"
    AND incident."companyId" = NEW."companyId"
  FOR SHARE;

  IF EXISTS (
    SELECT 1 FROM "support_incidents" incident
    WHERE incident."id" = NEW."incidentId"
      AND incident."companyId" = NEW."companyId"
      AND incident."mergedIntoIncidentId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A merged duplicate cannot receive communications.' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "support_communications_merged_duplicate_guard"
BEFORE INSERT OR UPDATE OF "incidentId" ON "support_communications"
FOR EACH ROW EXECUTE FUNCTION "guard_merged_duplicate_communication_link"();

CREATE OR REPLACE FUNCTION "guard_merged_duplicate_event_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "support_incidents" incident
    WHERE incident."id" = NEW."incidentId"
      AND incident."companyId" = NEW."companyId"
      AND incident."mergedIntoIncidentId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "support_incident_merges" merge
        WHERE merge."id" = NEW."mergeId"
          AND merge."companyId" = NEW."companyId"
          AND merge."duplicateIncidentId" = NEW."incidentId"
          AND merge."primaryIncidentId" = incident."mergedIntoIncidentId"
          AND NEW."eventType" = 'INCIDENT_MERGED'
          AND NEW."mergeRole" = 'DUPLICATE'
      )
  ) THEN
    RAISE EXCEPTION 'A merged duplicate cannot receive later events.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "support_events_merged_duplicate_guard"
BEFORE INSERT ON "support_incident_events"
FOR EACH ROW EXECUTE FUNCTION "guard_merged_duplicate_event_insert"();

CREATE OR REPLACE FUNCTION "guard_merged_duplicate_attachment_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "support_incidents" incident
    WHERE incident."id" = NEW."incidentId"
      AND incident."companyId" = NEW."companyId"
      AND incident."mergedIntoIncidentId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A merged duplicate cannot receive attachments.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "support_attachments_merged_duplicate_guard"
BEFORE INSERT ON "support_incident_attachments"
FOR EACH ROW EXECUTE FUNCTION "guard_merged_duplicate_attachment_insert"();

CREATE OR REPLACE FUNCTION "assert_no_attachment_on_merged_duplicate"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "support_incidents" incident
    WHERE incident."id" = NEW."incidentId"
      AND incident."companyId" = NEW."companyId"
      AND incident."mergedIntoIncidentId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A merged duplicate cannot receive attachments.' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "support_attachment_merged_duplicate_consistency"
AFTER INSERT ON "support_incident_attachments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_no_attachment_on_merged_duplicate"();

CREATE OR REPLACE FUNCTION "assert_support_incident_merge_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_merge_id UUID;
  target_company_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'support_incident_merges' THEN
    target_merge_id := NEW."id";
    target_company_id := NEW."companyId";
  ELSIF TG_TABLE_NAME = 'support_incident_events' THEN
    IF NEW."eventType" <> 'INCIDENT_MERGED' THEN RETURN NULL; END IF;
    target_merge_id := NEW."mergeId";
    target_company_id := NEW."companyId";
  ELSE
    IF NEW."mergedIntoIncidentId" IS NULL THEN RETURN NULL; END IF;
    SELECT merge."id" INTO target_merge_id
    FROM "support_incident_merges" merge
    WHERE merge."companyId" = NEW."companyId"
      AND merge."duplicateIncidentId" = NEW."id"
      AND merge."primaryIncidentId" = NEW."mergedIntoIncidentId";
    target_company_id := NEW."companyId";
  END IF;

  IF target_merge_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM "support_incident_merges" merge
    JOIN "support_incidents" primary_incident
      ON primary_incident."id" = merge."primaryIncidentId" AND primary_incident."companyId" = merge."companyId"
    JOIN "support_incidents" duplicate_incident
      ON duplicate_incident."id" = merge."duplicateIncidentId" AND duplicate_incident."companyId" = merge."companyId"
    WHERE merge."id" = target_merge_id
      AND merge."companyId" = target_company_id
      AND primary_incident."customerId" = duplicate_incident."customerId"
      AND primary_incident."mergedIntoIncidentId" IS NULL
      AND duplicate_incident."mergedIntoIncidentId" = primary_incident."id"
      AND primary_incident."version" = merge."primaryResultingVersion"
      AND duplicate_incident."version" = merge."duplicateResultingVersion"
      AND primary_incident."status" = merge."primaryStatusBefore"
      AND duplicate_incident."status" = 'CLOSED'
      AND duplicate_incident."closeReason" = 'DUPLICATE'
      AND duplicate_incident."closedAt" = merge."mergedAt"
      AND (SELECT count(*) FROM "support_incident_events" event WHERE event."mergeId" = merge."id" AND event."companyId" = merge."companyId") = 2
      AND EXISTS (
        SELECT 1 FROM "support_incident_events" event
        WHERE event."mergeId" = merge."id"
          AND event."companyId" = merge."companyId"
          AND event."incidentId" = merge."primaryIncidentId"
          AND event."mergeRole" = 'PRIMARY'
          AND event."eventType" = 'INCIDENT_MERGED'
          AND event."actorUserId" = merge."actorUserId"
          AND event."responsibleUserIdAtEvent" = merge."primaryResponsibleUserId"
          AND event."fromStatus" = merge."primaryStatusBefore"
          AND event."toStatus" = merge."primaryStatusBefore"
          AND event."resultingVersion" = merge."primaryResultingVersion"
          AND event."createdAt" = merge."mergedAt"
      )
      AND EXISTS (
        SELECT 1 FROM "support_incident_events" event
        WHERE event."mergeId" = merge."id"
          AND event."companyId" = merge."companyId"
          AND event."incidentId" = merge."duplicateIncidentId"
          AND event."mergeRole" = 'DUPLICATE'
          AND event."eventType" = 'INCIDENT_MERGED'
          AND event."actorUserId" = merge."actorUserId"
          AND event."responsibleUserIdAtEvent" = merge."duplicateResponsibleUserId"
          AND event."fromStatus" = merge."duplicateStatusBefore"
          AND event."toStatus" = 'CLOSED'
          AND event."resultingVersion" = merge."duplicateResultingVersion"
          AND event."createdAt" = merge."mergedAt"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "support_incident_merges" parent
        WHERE parent."companyId" = merge."companyId"
          AND parent."duplicateIncidentId" = merge."primaryIncidentId"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "support_incident_merges" child
        WHERE child."companyId" = merge."companyId"
          AND child."primaryIncidentId" = merge."duplicateIncidentId"
      )
  ) THEN
    RAISE EXCEPTION 'Support incident merge projection or evidence is incomplete.' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "support_merge_from_merge"
AFTER INSERT ON "support_incident_merges"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_support_incident_merge_consistency"();

CREATE CONSTRAINT TRIGGER "support_merge_from_event"
AFTER INSERT ON "support_incident_events"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."eventType" = 'INCIDENT_MERGED')
EXECUTE FUNCTION "assert_support_incident_merge_consistency"();

CREATE CONSTRAINT TRIGGER "support_merge_from_duplicate_projection"
AFTER UPDATE OF "mergedIntoIncidentId" ON "support_incidents"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."mergedIntoIncidentId" IS NOT NULL)
EXECUTE FUNCTION "assert_support_incident_merge_consistency"();

CREATE OR REPLACE FUNCTION "assert_support_merge_notification_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_merge_id UUID;
  target_company_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'notifications' THEN
    IF NEW."kind" <> 'SUPPORT_INCIDENT_MERGED' THEN RETURN NULL; END IF;
    SELECT event."mergeId", event."companyId"
      INTO target_merge_id, target_company_id
    FROM "support_incident_events" event
    WHERE event."id" = NEW."sourceIncidentEventId"
      AND event."companyId" = NEW."companyId"
      AND event."incidentId" = NEW."incidentId";
  ELSIF TG_TABLE_NAME = 'support_incident_events' THEN
    IF NEW."eventType" <> 'INCIDENT_MERGED' OR NEW."mergeRole" <> 'PRIMARY' THEN RETURN NULL; END IF;
    target_merge_id := NEW."mergeId";
    target_company_id := NEW."companyId";
  ELSE
    target_merge_id := NEW."id";
    target_company_id := NEW."companyId";
  END IF;

  IF target_merge_id IS NULL OR EXISTS (
    SELECT 1
    FROM "notifications" notification
    LEFT JOIN "support_incident_events" event
      ON event."id" = notification."sourceIncidentEventId"
     AND event."companyId" = notification."companyId"
     AND event."incidentId" = notification."incidentId"
    LEFT JOIN "support_incident_merges" merge
      ON merge."id" = event."mergeId" AND merge."companyId" = event."companyId"
    LEFT JOIN "support_incidents" primary_incident
      ON primary_incident."id" = merge."primaryIncidentId" AND primary_incident."companyId" = merge."companyId"
    WHERE notification."kind" = 'SUPPORT_INCIDENT_MERGED'
      AND notification."sourceIncidentEventId" IN (
        SELECT source."id" FROM "support_incident_events" source
        WHERE source."mergeId" = target_merge_id AND source."companyId" = target_company_id AND source."mergeRole" = 'PRIMARY'
      )
      AND (
        event."eventType" IS DISTINCT FROM 'INCIDENT_MERGED'
        OR event."mergeRole" IS DISTINCT FROM 'PRIMARY'
        OR notification."incidentId" IS DISTINCT FROM merge."primaryIncidentId"
        OR notification."incidentNumber" IS DISTINCT FROM primary_incident."number"
        OR notification."createdAt" < event."createdAt"
        OR notification."createdAt" > event."createdAt" + INTERVAL '5 minutes'
        OR NOT EXISTS (
          SELECT 1
          FROM (
            SELECT merge."primaryResponsibleUserId" AS "userId"
            UNION SELECT merge."duplicateResponsibleUserId"
          ) expected
          WHERE expected."userId" = notification."recipientUserId"
        )
      )
  ) THEN
    RAISE EXCEPTION 'Support merge notification source or recipient is invalid.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "support_incident_merges" merge
    JOIN "support_incident_events" event
      ON event."mergeId" = merge."id" AND event."companyId" = merge."companyId" AND event."mergeRole" = 'PRIMARY'
    CROSS JOIN LATERAL (
      SELECT merge."primaryResponsibleUserId" AS "userId"
      UNION SELECT merge."duplicateResponsibleUserId"
    ) expected
    WHERE merge."id" = target_merge_id
      AND merge."companyId" = target_company_id
      AND NOT EXISTS (
        SELECT 1 FROM "notifications" notification
        WHERE notification."sourceIncidentEventId" = event."id"
          AND notification."companyId" = merge."companyId"
          AND notification."incidentId" = merge."primaryIncidentId"
          AND notification."recipientUserId" = expected."userId"
          AND notification."kind" = 'SUPPORT_INCIDENT_MERGED'
      )
  ) THEN
    RAISE EXCEPTION 'Support incident merge requires every participant notification.' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "support_merge_notification_from_notification"
AFTER INSERT ON "notifications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_support_merge_notification_consistency"();

CREATE CONSTRAINT TRIGGER "support_merge_notification_from_event"
AFTER INSERT ON "support_incident_events"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."eventType" = 'INCIDENT_MERGED' AND NEW."mergeRole" = 'PRIMARY')
EXECUTE FUNCTION "assert_support_merge_notification_consistency"();

CREATE CONSTRAINT TRIGGER "support_merge_notification_from_merge"
AFTER INSERT ON "support_incident_merges"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_support_merge_notification_consistency"();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Support.MergeIncidents', 'Fusionar incidencias duplicadas', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador'
  AND permission."code" = 'Support.MergeIncidents'
ON CONFLICT DO NOTHING;

COMMIT;
