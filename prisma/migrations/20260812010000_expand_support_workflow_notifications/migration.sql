BEGIN;

ALTER TABLE "support_incident_events"
  ADD COLUMN "responsibleUserIdAtEvent" UUID;

ALTER TABLE "support_incident_events"
  ADD CONSTRAINT "support_incident_events_responsibleUserIdAtEvent_fkey"
  FOREIGN KEY ("responsibleUserIdAtEvent") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "support_incident_collaborators"
  ADD CONSTRAINT "support_collaborator_incident_key"
  UNIQUE ("id", "companyId", "incidentId");

ALTER TABLE "support_incident_participant_changes"
  ADD CONSTRAINT "support_participant_change_incident_key"
  UNIQUE ("id", "companyId", "incidentId"),
  DROP CONSTRAINT "support_incident_participant_changes_collaboratorId_companyId_fkey",
  ADD CONSTRAINT "support_participant_change_collaborator_incident_fkey"
  FOREIGN KEY ("collaboratorId", "companyId", "incidentId")
  REFERENCES "support_incident_collaborators"("id", "companyId", "incidentId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "support_incident_events"
  ADD CONSTRAINT "support_event_participant_incident_key"
  UNIQUE ("participantChangeId", "companyId", "incidentId"),
  DROP CONSTRAINT "support_incident_events_participantChangeId_companyId_fkey",
  ADD CONSTRAINT "support_event_participant_incident_fkey"
  FOREIGN KEY ("participantChangeId", "companyId", "incidentId")
  REFERENCES "support_incident_participant_changes"("id", "companyId", "incidentId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notifications"
  DROP CONSTRAINT "notifications_kind_message_severity_check";

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_kind_message_severity_check" CHECK (
    ("kind" = 'SUPPORT_INCIDENT_ASSIGNED' AND "messageCode" = 'support.incident.assigned' AND "severity" = 'INFO') OR
    ("kind" = 'SUPPORT_INCIDENT_REASSIGNED' AND "messageCode" = 'support.incident.reassigned' AND "severity" = 'INFO') OR
    ("kind" = 'SUPPORT_INCIDENT_URGENT' AND "messageCode" = 'support.incident.urgent' AND "severity" = 'URGENT') OR
    ("kind" = 'SUPPORT_INCIDENT_COLLABORATOR_ADDED' AND "messageCode" = 'support.incident.collaborator-added' AND "severity" = 'INFO') OR
    ("kind" = 'SUPPORT_INCIDENT_COLLABORATOR_ACTION' AND "messageCode" = 'support.incident.collaborator-action' AND "severity" = 'INFO') OR
    ("kind" = 'SUPPORT_INCIDENT_REOPENED' AND "messageCode" = 'support.incident.reopened' AND "severity" = 'INFO')
  );

CREATE OR REPLACE FUNCTION "require_support_event_responsible_snapshot"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "support_incidents" incident
    WHERE incident."id" = NEW."incidentId"
      AND incident."companyId" = NEW."companyId"
      AND incident."responsibleUserId" = NEW."responsibleUserIdAtEvent"
  ) THEN
    RAISE EXCEPTION 'Support incident event responsible snapshot is invalid.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "support_incident_events_responsible_snapshot"
BEFORE INSERT ON "support_incident_events"
FOR EACH ROW EXECUTE FUNCTION "require_support_event_responsible_snapshot"();

CREATE OR REPLACE FUNCTION "assert_expanded_support_notification_consistency"()
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
    LEFT JOIN "support_incident_participant_changes" participant_change
      ON participant_change."id" = event."participantChangeId"
     AND participant_change."companyId" = event."companyId"
    LEFT JOIN "support_incident_collaborators" collaborator
      ON collaborator."id" = participant_change."collaboratorId"
     AND collaborator."companyId" = event."companyId"
    LEFT JOIN "support_incident_actions" action
      ON action."id" = event."actionId"
     AND action."companyId" = event."companyId"
    LEFT JOIN "support_incident_status_transitions" transition
      ON transition."id" = event."transitionId"
     AND transition."companyId" = event."companyId"
    WHERE notification."sourceIncidentEventId" = target_event_id
      AND notification."companyId" = target_company_id
      AND notification."incidentId" = target_incident_id
      AND (
        (
          notification."kind" = 'SUPPORT_INCIDENT_COLLABORATOR_ADDED'
          AND (
            event."eventType" <> 'COLLABORATOR_ADDED'
            OR participant_change."changeType" <> 'COLLABORATOR_ADDED'
            OR notification."recipientUserId" IS DISTINCT FROM collaborator."userId"
          )
        )
        OR (
          notification."kind" = 'SUPPORT_INCIDENT_COLLABORATOR_ACTION'
          AND (
            event."eventType" <> 'ACTION_ADDED'
            OR action."authorUserId" IS DISTINCT FROM event."actorUserId"
            OR notification."recipientUserId" IS DISTINCT FROM event."responsibleUserIdAtEvent"
            OR NOT EXISTS (
              SELECT 1
              FROM "support_incident_collaborators" active_collaborator
              WHERE active_collaborator."incidentId" = event."incidentId"
                AND active_collaborator."companyId" = event."companyId"
                AND active_collaborator."userId" = action."authorUserId"
                AND active_collaborator."addedVersion" < event."resultingVersion"
                AND (active_collaborator."removedVersion" IS NULL OR event."resultingVersion" < active_collaborator."removedVersion")
            )
          )
        )
        OR (
          notification."kind" = 'SUPPORT_INCIDENT_REOPENED'
          AND (
            event."eventType" <> 'STATUS_CHANGED'
            OR event."fromStatus" NOT IN ('RESOLVED', 'CLOSED')
            OR event."toStatus" <> 'IN_PROGRESS'
            OR transition."fromStatus" IS DISTINCT FROM event."fromStatus"
            OR transition."toStatus" IS DISTINCT FROM event."toStatus"
            OR transition."resultingVersion" IS DISTINCT FROM event."resultingVersion"
            OR notification."recipientUserId" IS DISTINCT FROM event."responsibleUserIdAtEvent"
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Expanded support notification source or recipient is invalid.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "support_incident_events" event
    JOIN "support_incident_participant_changes" participant_change
      ON participant_change."id" = event."participantChangeId"
     AND participant_change."companyId" = event."companyId"
    JOIN "support_incident_collaborators" collaborator
      ON collaborator."id" = participant_change."collaboratorId"
     AND collaborator."companyId" = event."companyId"
    WHERE event."id" = target_event_id
      AND event."companyId" = target_company_id
      AND event."incidentId" = target_incident_id
      AND event."eventType" = 'COLLABORATOR_ADDED'
      AND participant_change."changeType" = 'COLLABORATOR_ADDED'
      AND NOT EXISTS (
        SELECT 1 FROM "notifications" notification
        WHERE notification."sourceIncidentEventId" = event."id"
          AND notification."companyId" = event."companyId"
          AND notification."incidentId" = event."incidentId"
          AND notification."recipientUserId" = collaborator."userId"
          AND notification."kind" = 'SUPPORT_INCIDENT_COLLABORATOR_ADDED'
      )
  ) THEN
    RAISE EXCEPTION 'Collaborator incorporation requires a notification.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "support_incident_events" event
    JOIN "support_incident_actions" action
      ON action."id" = event."actionId" AND action."companyId" = event."companyId"
    WHERE event."id" = target_event_id
      AND event."companyId" = target_company_id
      AND event."incidentId" = target_incident_id
      AND event."eventType" = 'ACTION_ADDED'
      AND EXISTS (
        SELECT 1 FROM "support_incident_collaborators" collaborator
        WHERE collaborator."incidentId" = event."incidentId"
          AND collaborator."companyId" = event."companyId"
          AND collaborator."userId" = action."authorUserId"
          AND collaborator."addedVersion" < event."resultingVersion"
          AND (collaborator."removedVersion" IS NULL OR event."resultingVersion" < collaborator."removedVersion")
      )
      AND NOT EXISTS (
        SELECT 1 FROM "notifications" notification
        WHERE notification."sourceIncidentEventId" = event."id"
          AND notification."companyId" = event."companyId"
          AND notification."incidentId" = event."incidentId"
          AND notification."recipientUserId" = event."responsibleUserIdAtEvent"
          AND notification."kind" = 'SUPPORT_INCIDENT_COLLABORATOR_ACTION'
      )
  ) THEN
    RAISE EXCEPTION 'Collaborator action requires a responsible notification.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "support_incident_events" event
    JOIN "support_incident_status_transitions" transition
      ON transition."id" = event."transitionId" AND transition."companyId" = event."companyId"
    WHERE event."id" = target_event_id
      AND event."companyId" = target_company_id
      AND event."incidentId" = target_incident_id
      AND event."eventType" = 'STATUS_CHANGED'
      AND event."fromStatus" IN ('RESOLVED', 'CLOSED')
      AND event."toStatus" = 'IN_PROGRESS'
      AND transition."fromStatus" = event."fromStatus"
      AND transition."toStatus" = event."toStatus"
      AND NOT EXISTS (
        SELECT 1 FROM "notifications" notification
        WHERE notification."sourceIncidentEventId" = event."id"
          AND notification."companyId" = event."companyId"
          AND notification."incidentId" = event."incidentId"
          AND notification."recipientUserId" = event."responsibleUserIdAtEvent"
          AND notification."kind" = 'SUPPORT_INCIDENT_REOPENED'
      )
  ) THEN
    RAISE EXCEPTION 'Incident reopening requires a responsible notification.' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "expanded_support_notification_from_notification"
AFTER INSERT ON "notifications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_expanded_support_notification_consistency"();

CREATE CONSTRAINT TRIGGER "expanded_support_notification_from_event"
AFTER INSERT ON "support_incident_events"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_expanded_support_notification_consistency"();

COMMIT;
