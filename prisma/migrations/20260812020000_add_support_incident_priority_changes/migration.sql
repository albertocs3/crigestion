BEGIN;

CREATE TABLE "support_incident_priority_changes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "fromPriority" "SupportIncidentPriority" NOT NULL,
  "toPriority" "SupportIncidentPriority" NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "resultingVersion" INTEGER NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "support_priority_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_priority_change_incident_key" UNIQUE ("id", "companyId", "incidentId"),
  CONSTRAINT "support_priority_change_version_key" UNIQUE ("incidentId", "resultingVersion"),
  CONSTRAINT "support_priority_change_values_check" CHECK (
    "fromPriority" <> "toPriority"
    AND "resultingVersion" > 1
    AND length(btrim("reason")) BETWEEN 3 AND 500
  ),
  CONSTRAINT "support_priority_change_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_priority_change_incident_fkey"
    FOREIGN KEY ("incidentId", "companyId") REFERENCES "support_incidents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_priority_change_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "support_priority_change_incident_time_idx"
  ON "support_incident_priority_changes"("incidentId", "occurredAt", "id");
CREATE INDEX "support_priority_change_company_target_time_idx"
  ON "support_incident_priority_changes"("companyId", "toPriority", "occurredAt", "id");

CREATE OR REPLACE FUNCTION "reject_support_priority_change_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Support incident priority changes are append-only.' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "support_priority_changes_append_only"
BEFORE UPDATE OR DELETE ON "support_incident_priority_changes"
FOR EACH ROW EXECUTE FUNCTION "reject_support_priority_change_mutation"();

ALTER TABLE "support_incident_events"
  ADD COLUMN "priorityChangeId" UUID,
  ADD CONSTRAINT "support_event_priority_incident_key"
    UNIQUE ("priorityChangeId", "companyId", "incidentId"),
  ADD CONSTRAINT "support_event_priority_incident_fkey"
    FOREIGN KEY ("priorityChangeId", "companyId", "incidentId")
    REFERENCES "support_incident_priority_changes"("id", "companyId", "incidentId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "support_incident_events"
  ADD CONSTRAINT "support_incident_events_kind_check_v2" CHECK (
    ("eventType" = 'CREATED' AND "actionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "resultingVersion" = 1)
    OR ("eventType" = 'ACTION_ADDED' AND "actionId" IS NOT NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL)
    OR ("eventType" = 'STATUS_CHANGED' AND "actionId" IS NULL AND "transitionId" IS NOT NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL)
    OR ("eventType" IN ('COLLABORATOR_ADDED', 'COLLABORATOR_REMOVED', 'RESPONSIBLE_CHANGED') AND "actionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NOT NULL AND "priorityChangeId" IS NULL)
    OR ("eventType" = 'PRIORITY_CHANGED' AND "actionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NOT NULL AND "fromStatus" IS NOT NULL AND "toStatus" = "fromStatus" AND "resultingVersion" > 1)
  ) NOT VALID;

ALTER TABLE "support_incident_events"
  VALIDATE CONSTRAINT "support_incident_events_kind_check_v2";
ALTER TABLE "support_incident_events"
  DROP CONSTRAINT "support_incident_events_kind_check";
ALTER TABLE "support_incident_events"
  RENAME CONSTRAINT "support_incident_events_kind_check_v2" TO "support_incident_events_kind_check";

CREATE OR REPLACE FUNCTION "assert_support_priority_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_incident_id UUID;
  target_company_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'support_incidents' THEN
    target_incident_id := NEW."id";
    target_company_id := NEW."companyId";

    IF OLD."status" IN ('RESOLVED', 'CLOSED')
      OR NEW."version" <> OLD."version" + 1
      OR NEW."status" IS DISTINCT FROM OLD."status"
      OR NOT EXISTS (
        SELECT 1
        FROM "support_incident_priority_changes" change
        JOIN "support_incident_events" event
          ON event."priorityChangeId" = change."id"
         AND event."companyId" = change."companyId"
         AND event."incidentId" = change."incidentId"
        WHERE change."incidentId" = NEW."id"
          AND change."companyId" = NEW."companyId"
          AND change."fromPriority" = OLD."priority"
          AND change."toPriority" = NEW."priority"
          AND change."resultingVersion" = NEW."version"
          AND event."eventType" = 'PRIORITY_CHANGED'
          AND event."actorUserId" = change."actorUserId"
          AND event."resultingVersion" = change."resultingVersion"
          AND event."fromStatus" = OLD."status"
          AND event."toStatus" = NEW."status"
          AND event."createdAt" >= change."occurredAt"
          AND event."createdAt" <= change."occurredAt" + INTERVAL '5 minutes'
      )
    THEN
      RAISE EXCEPTION 'A priority projection change requires matching versioned evidence.' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    target_incident_id := NEW."incidentId";
    target_company_id := NEW."companyId";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "support_incident_priority_changes" change
    WHERE change."incidentId" = target_incident_id
      AND change."companyId" = target_company_id
      AND NOT EXISTS (
        SELECT 1
        FROM "support_incident_events" event
        WHERE event."priorityChangeId" = change."id"
          AND event."companyId" = change."companyId"
          AND event."incidentId" = change."incidentId"
          AND event."actorUserId" = change."actorUserId"
          AND event."eventType" = 'PRIORITY_CHANGED'
          AND event."resultingVersion" = change."resultingVersion"
          AND event."fromStatus" = event."toStatus"
          AND event."createdAt" >= change."occurredAt"
          AND event."createdAt" <= change."occurredAt" + INTERVAL '5 minutes'
      )
  ) THEN
    RAISE EXCEPTION 'A support priority change requires one matching event.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "support_incident_events" event
    WHERE event."incidentId" = target_incident_id
      AND event."companyId" = target_company_id
      AND event."eventType" = 'PRIORITY_CHANGED'
      AND NOT EXISTS (
        SELECT 1
        FROM "support_incident_priority_changes" change
        WHERE change."id" = event."priorityChangeId"
          AND change."companyId" = event."companyId"
          AND change."incidentId" = event."incidentId"
          AND change."actorUserId" = event."actorUserId"
          AND change."resultingVersion" = event."resultingVersion"
      )
  ) THEN
    RAISE EXCEPTION 'A priority event requires matching priority evidence.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "support_incidents" incident
    WHERE incident."id" = target_incident_id
      AND incident."companyId" = target_company_id
      AND (
        EXISTS (
          SELECT 1
          FROM "support_incident_priority_changes" change
          WHERE change."incidentId" = incident."id"
            AND change."companyId" = incident."companyId"
            AND change."resultingVersion" > incident."version"
        )
        OR EXISTS (
          SELECT 1
          FROM "support_incident_priority_changes" latest
          WHERE latest."incidentId" = incident."id"
            AND latest."companyId" = incident."companyId"
            AND latest."resultingVersion" = (
              SELECT max(candidate."resultingVersion")
              FROM "support_incident_priority_changes" candidate
              WHERE candidate."incidentId" = incident."id"
                AND candidate."companyId" = incident."companyId"
            )
            AND latest."toPriority" <> incident."priority"
        )
      )
  ) THEN
    RAISE EXCEPTION 'Support incident priority projection does not match its evidence.' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "support_priority_from_incident"
AFTER UPDATE OF "priority" ON "support_incidents"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."priority" IS DISTINCT FROM NEW."priority")
EXECUTE FUNCTION "assert_support_priority_consistency"();

CREATE CONSTRAINT TRIGGER "support_priority_from_change"
AFTER INSERT ON "support_incident_priority_changes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_support_priority_consistency"();

CREATE CONSTRAINT TRIGGER "support_priority_from_event"
AFTER INSERT ON "support_incident_events"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_support_priority_consistency"();

CREATE OR REPLACE FUNCTION "assert_support_notification_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_event_id UUID;
  target_company_id UUID;
  target_incident_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'notifications' THEN
    target_event_id := NEW."sourceIncidentEventId";
    target_company_id := NEW."companyId";
    target_incident_id := NEW."incidentId";
  ELSE
    target_event_id := NEW."id";
    target_company_id := NEW."companyId";
    target_incident_id := NEW."incidentId";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "notifications" notification
    JOIN "support_incident_events" event
      ON event."id" = notification."sourceIncidentEventId"
     AND event."companyId" = notification."companyId"
     AND event."incidentId" = notification."incidentId"
    JOIN "support_incidents" incident
      ON incident."id" = notification."incidentId"
     AND incident."companyId" = notification."companyId"
    LEFT JOIN "support_incident_participant_changes" participant_change
      ON participant_change."id" = event."participantChangeId"
     AND participant_change."companyId" = event."companyId"
     AND participant_change."incidentId" = event."incidentId"
    LEFT JOIN "support_incident_priority_changes" priority_change
      ON priority_change."id" = event."priorityChangeId"
     AND priority_change."companyId" = event."companyId"
     AND priority_change."incidentId" = event."incidentId"
    WHERE notification."sourceIncidentEventId" = target_event_id
      AND notification."companyId" = target_company_id
      AND notification."incidentId" = target_incident_id
      AND (
        notification."incidentNumber" <> incident."number"
        OR notification."createdAt" < event."createdAt"
        OR notification."createdAt" > event."createdAt" + INTERVAL '5 minutes'
        OR (
          notification."kind" = 'SUPPORT_INCIDENT_ASSIGNED'
          AND (event."eventType" <> 'CREATED' OR notification."recipientUserId" <> incident."responsibleUserId")
        )
        OR (
          notification."kind" = 'SUPPORT_INCIDENT_REASSIGNED'
          AND (
            event."eventType" <> 'RESPONSIBLE_CHANGED'
            OR notification."recipientUserId" <> participant_change."toResponsibleId"
          )
        )
        OR (
          notification."kind" = 'SUPPORT_INCIDENT_URGENT'
          AND (
            (
              (event."eventType" = 'CREATED' AND incident."priority" = 'URGENT')
              OR (
                event."eventType" = 'PRIORITY_CHANGED'
                AND priority_change."fromPriority" <> 'URGENT'
                AND priority_change."toPriority" = 'URGENT'
                AND priority_change."resultingVersion" = event."resultingVersion"
              )
            ) IS NOT TRUE
            OR NOT EXISTS (
              SELECT 1
              FROM "users" recipient
              JOIN "role_permissions" role_permission ON role_permission."roleId" = recipient."roleId"
              JOIN "permissions" permission ON permission."id" = role_permission."permissionId"
              WHERE recipient."id" = notification."recipientUserId"
                AND recipient."status" = 'ACTIVE'
                AND permission."code" = 'Support.ReceiveUrgentNotifications'
            )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Support notification source or recipient is invalid.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "support_incident_events" event
    JOIN "support_incidents" incident
      ON incident."id" = event."incidentId" AND incident."companyId" = event."companyId"
    WHERE event."id" = target_event_id
      AND event."companyId" = target_company_id
      AND event."incidentId" = target_incident_id
      AND event."eventType" = 'CREATED'
      AND NOT EXISTS (
        SELECT 1 FROM "notifications" notification
        WHERE notification."sourceIncidentEventId" = event."id"
          AND notification."companyId" = event."companyId"
          AND notification."incidentId" = event."incidentId"
          AND notification."recipientUserId" = incident."responsibleUserId"
          AND (
            notification."kind" = 'SUPPORT_INCIDENT_ASSIGNED'
            OR (incident."priority" = 'URGENT' AND notification."kind" = 'SUPPORT_INCIDENT_URGENT')
          )
      )
  ) THEN
    RAISE EXCEPTION 'Incident creation requires an assignment notification.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "support_incident_events" event
    JOIN "support_incidents" incident
      ON incident."id" = event."incidentId" AND incident."companyId" = event."companyId"
    JOIN "users" recipient ON recipient."status" = 'ACTIVE'
    JOIN "role_permissions" role_permission ON role_permission."roleId" = recipient."roleId"
    JOIN "permissions" permission ON permission."id" = role_permission."permissionId"
      AND permission."code" = 'Support.ReceiveUrgentNotifications'
    WHERE event."id" = target_event_id
      AND event."companyId" = target_company_id
      AND event."incidentId" = target_incident_id
      AND event."eventType" = 'CREATED'
      AND incident."priority" = 'URGENT'
      AND NOT EXISTS (
        SELECT 1 FROM "notifications" notification
        WHERE notification."sourceIncidentEventId" = event."id"
          AND notification."companyId" = event."companyId"
          AND notification."incidentId" = event."incidentId"
          AND notification."recipientUserId" = recipient."id"
          AND notification."kind" = 'SUPPORT_INCIDENT_URGENT'
      )
  ) THEN
    RAISE EXCEPTION 'Urgent incident creation requires every configured recipient.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "support_incident_events" event
    JOIN "support_incident_priority_changes" priority_change
      ON priority_change."id" = event."priorityChangeId"
     AND priority_change."companyId" = event."companyId"
     AND priority_change."incidentId" = event."incidentId"
    JOIN "users" recipient ON recipient."status" = 'ACTIVE'
    JOIN "role_permissions" role_permission ON role_permission."roleId" = recipient."roleId"
    JOIN "permissions" permission ON permission."id" = role_permission."permissionId"
      AND permission."code" = 'Support.ReceiveUrgentNotifications'
    WHERE event."id" = target_event_id
      AND event."companyId" = target_company_id
      AND event."incidentId" = target_incident_id
      AND event."eventType" = 'PRIORITY_CHANGED'
      AND priority_change."fromPriority" <> 'URGENT'
      AND priority_change."toPriority" = 'URGENT'
      AND NOT EXISTS (
        SELECT 1 FROM "notifications" notification
        WHERE notification."sourceIncidentEventId" = event."id"
          AND notification."companyId" = event."companyId"
          AND notification."incidentId" = event."incidentId"
          AND notification."recipientUserId" = recipient."id"
          AND notification."kind" = 'SUPPORT_INCIDENT_URGENT'
      )
  ) THEN
    RAISE EXCEPTION 'Urgent priority escalation requires every configured recipient.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "support_incident_events" event
    JOIN "support_incident_participant_changes" participant_change
      ON participant_change."id" = event."participantChangeId"
     AND participant_change."companyId" = event."companyId"
     AND participant_change."incidentId" = event."incidentId"
    WHERE event."id" = target_event_id
      AND event."companyId" = target_company_id
      AND event."incidentId" = target_incident_id
      AND event."eventType" = 'RESPONSIBLE_CHANGED'
      AND NOT EXISTS (
        SELECT 1 FROM "notifications" notification
        WHERE notification."sourceIncidentEventId" = event."id"
          AND notification."companyId" = event."companyId"
          AND notification."incidentId" = event."incidentId"
          AND notification."recipientUserId" = participant_change."toResponsibleId"
          AND notification."kind" = 'SUPPORT_INCIDENT_REASSIGNED'
      )
  ) THEN
    RAISE EXCEPTION 'Responsible change requires a notification for the new responsible user.' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

COMMIT;
