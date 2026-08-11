BEGIN;

CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'URGENT', 'CRITICAL');
CREATE TYPE "NotificationStatus" AS ENUM ('UNREAD', 'READ', 'ARCHIVED');

ALTER TABLE "support_incident_events"
  ADD CONSTRAINT "support_incident_events_id_companyId_incidentId_key"
  UNIQUE ("id", "companyId", "incidentId");

CREATE TABLE "notifications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "recipientUserId" UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "sourceIncidentEventId" UUID NOT NULL,
  "kind" VARCHAR(80) NOT NULL,
  "messageCode" VARCHAR(100) NOT NULL,
  "incidentNumber" VARCHAR(20) NOT NULL,
  "severity" "NotificationSeverity" NOT NULL,
  "status" "NotificationStatus" NOT NULL DEFAULT 'UNREAD',
  "version" INTEGER NOT NULL DEFAULT 1,
  "readAt" TIMESTAMPTZ(3),
  "archivedAt" TIMESTAMPTZ(3),
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notifications_id_companyId_key" UNIQUE ("id", "companyId"),
  CONSTRAINT "notifications_companyId_recipientUserId_sourceIncidentEventId_key"
    UNIQUE ("companyId", "recipientUserId", "sourceIncidentEventId"),
  CONSTRAINT "notifications_version_check" CHECK ("version" > 0),
  CONSTRAINT "notifications_kind_message_severity_check" CHECK (
    ("kind" = 'SUPPORT_INCIDENT_ASSIGNED' AND "messageCode" = 'support.incident.assigned' AND "severity" = 'INFO') OR
    ("kind" = 'SUPPORT_INCIDENT_REASSIGNED' AND "messageCode" = 'support.incident.reassigned' AND "severity" = 'INFO') OR
    ("kind" = 'SUPPORT_INCIDENT_URGENT' AND "messageCode" = 'support.incident.urgent' AND "severity" = 'URGENT')
  ),
  CONSTRAINT "notifications_state_check" CHECK (
    ("status" = 'UNREAD' AND "readAt" IS NULL AND "archivedAt" IS NULL) OR
    ("status" = 'READ' AND "readAt" IS NOT NULL AND "archivedAt" IS NULL) OR
    ("status" = 'ARCHIVED' AND "archivedAt" IS NOT NULL)
  ),
  CONSTRAINT "notifications_retention_check" CHECK (
    "expiresAt" > "createdAt" + INTERVAL '364 days'
    AND "expiresAt" <= "createdAt" + INTERVAL '367 days'
  ),
  CONSTRAINT "notifications_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "notifications_recipientUserId_fkey"
    FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "notifications_incidentId_companyId_fkey"
    FOREIGN KEY ("incidentId", "companyId") REFERENCES "support_incidents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "notifications_sourceIncidentEventId_companyId_incidentId_fkey"
    FOREIGN KEY ("sourceIncidentEventId", "companyId", "incidentId")
    REFERENCES "support_incident_events"("id", "companyId", "incidentId") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "notifications_companyId_recipientUserId_status_createdAt_id_idx"
  ON "notifications"("companyId", "recipientUserId", "status", "createdAt", "id");
CREATE INDEX "notifications_companyId_recipientUserId_createdAt_id_idx"
  ON "notifications"("companyId", "recipientUserId", "createdAt" DESC, "id" DESC);
CREATE INDEX "notifications_companyId_incidentId_createdAt_id_idx"
  ON "notifications"("companyId", "incidentId", "createdAt", "id");
CREATE INDEX "notifications_companyId_expiresAt_id_idx"
  ON "notifications"("companyId", "expiresAt", "id");
CREATE INDEX "notifications_recipient_unread_cursor_idx"
  ON "notifications"("companyId", "recipientUserId", "createdAt" DESC, "id" DESC)
  WHERE "status" = 'UNREAD';

CREATE TABLE "notification_state_changes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "notificationId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "fromStatus" "NotificationStatus" NOT NULL,
  "toStatus" "NotificationStatus" NOT NULL,
  "resultingVersion" INTEGER NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notification_state_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_state_changes_notificationId_resultingVersion_key"
    UNIQUE ("notificationId", "resultingVersion"),
  CONSTRAINT "notification_state_changes_transition_check" CHECK (
    "resultingVersion" > 1 AND (
      ("fromStatus" = 'UNREAD' AND "toStatus" IN ('READ', 'ARCHIVED')) OR
      ("fromStatus" = 'READ' AND "toStatus" IN ('UNREAD', 'ARCHIVED'))
    )
  ),
  CONSTRAINT "notification_state_changes_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "notification_state_changes_notificationId_companyId_fkey"
    FOREIGN KEY ("notificationId", "companyId") REFERENCES "notifications"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "notification_state_changes_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "notification_state_changes_notificationId_occurredAt_id_idx"
  ON "notification_state_changes"("notificationId", "occurredAt", "id");
CREATE INDEX "notification_state_changes_companyId_actorUserId_occurredAt_id_idx"
  ON "notification_state_changes"("companyId", "actorUserId", "occurredAt", "id");

CREATE OR REPLACE FUNCTION "reject_notification_state_change_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Notification state changes are append-only.' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "notification_state_changes_append_only"
BEFORE UPDATE OR DELETE ON "notification_state_changes"
FOR EACH ROW EXECUTE FUNCTION "reject_notification_state_change_mutation"();

CREATE OR REPLACE FUNCTION "guard_notification_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Notifications are retained records.' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."id" <> NEW."id"
    OR OLD."companyId" <> NEW."companyId"
    OR OLD."recipientUserId" <> NEW."recipientUserId"
    OR OLD."incidentId" <> NEW."incidentId"
    OR OLD."sourceIncidentEventId" <> NEW."sourceIncidentEventId"
    OR OLD."kind" <> NEW."kind"
    OR OLD."messageCode" <> NEW."messageCode"
    OR OLD."incidentNumber" <> NEW."incidentNumber"
    OR OLD."severity" <> NEW."severity"
    OR OLD."expiresAt" <> NEW."expiresAt"
    OR OLD."createdAt" <> NEW."createdAt"
    OR NEW."version" <> OLD."version" + 1
    OR NEW."status" = OLD."status"
    OR NEW."updatedAt" < OLD."updatedAt"
    OR (NEW."status" = 'ARCHIVED' AND NEW."readAt" IS DISTINCT FROM OLD."readAt")
  THEN
    RAISE EXCEPTION 'Invalid notification mutation.' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "notifications_guard"
BEFORE UPDATE OR DELETE ON "notifications"
FOR EACH ROW EXECUTE FUNCTION "guard_notification_mutation"();

CREATE OR REPLACE FUNCTION "assert_notification_state_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_notification_id UUID;
  target_company_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'notifications' THEN
    target_notification_id := NEW."id";
    target_company_id := NEW."companyId";

    IF TG_OP = 'INSERT' THEN
      IF NEW."version" <> 1 OR NEW."status" <> 'UNREAD'
        OR EXISTS (
          SELECT 1 FROM "notification_state_changes" change
          WHERE change."notificationId" = NEW."id" AND change."companyId" = NEW."companyId"
        )
      THEN
        RAISE EXCEPTION 'A notification must start unread at version one.' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NOT EXISTS (
      SELECT 1
      FROM "notification_state_changes" change
      WHERE change."notificationId" = NEW."id"
        AND change."companyId" = NEW."companyId"
        AND change."actorUserId" = NEW."recipientUserId"
        AND change."fromStatus" = OLD."status"
        AND change."toStatus" = NEW."status"
        AND change."resultingVersion" = NEW."version"
        AND (
          (NEW."status" = 'READ' AND NEW."readAt" = change."occurredAt")
          OR (NEW."status" = 'UNREAD' AND NEW."readAt" IS NULL)
          OR (NEW."status" = 'ARCHIVED' AND NEW."archivedAt" = change."occurredAt")
        )
    ) THEN
      RAISE EXCEPTION 'A notification state mutation requires matching evidence.' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    target_notification_id := NEW."notificationId";
    target_company_id := NEW."companyId";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "notifications" notification
    WHERE notification."id" = target_notification_id
      AND notification."companyId" = target_company_id
      AND (
        (SELECT count(*) FROM "notification_state_changes" change
         WHERE change."notificationId" = notification."id" AND change."companyId" = notification."companyId") <> notification."version" - 1
        OR (
          notification."version" > 1 AND NOT EXISTS (
            SELECT 1 FROM "notification_state_changes" change
            WHERE change."notificationId" = notification."id"
              AND change."companyId" = notification."companyId"
              AND change."actorUserId" = notification."recipientUserId"
              AND change."toStatus" = notification."status"
              AND change."resultingVersion" = notification."version"
              AND (
                (notification."status" = 'READ' AND notification."readAt" = change."occurredAt")
                OR (notification."status" = 'UNREAD' AND notification."readAt" IS NULL)
                OR (notification."status" = 'ARCHIVED' AND notification."archivedAt" = change."occurredAt")
              )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Notification state projection does not match its evidence.' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "notification_state_consistency_from_notification"
AFTER INSERT OR UPDATE ON "notifications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_notification_state_consistency"();

CREATE CONSTRAINT TRIGGER "notification_state_consistency_from_change"
AFTER INSERT ON "notification_state_changes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_notification_state_consistency"();

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
            event."eventType" <> 'CREATED'
            OR incident."priority" <> 'URGENT'
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
    JOIN "support_incident_participant_changes" participant_change
      ON participant_change."id" = event."participantChangeId"
     AND participant_change."companyId" = event."companyId"
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

CREATE CONSTRAINT TRIGGER "support_notification_consistency_from_notification"
AFTER INSERT ON "notifications"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_support_notification_consistency"();

CREATE CONSTRAINT TRIGGER "support_notification_consistency_from_event"
AFTER INSERT ON "support_incident_events"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_support_notification_consistency"();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES (
  gen_random_uuid(),
  'Support.ReceiveUrgentNotifications',
  'Recibir notificaciones internas de incidencias urgentes',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador'
  AND permission."code" = 'Support.ReceiveUrgentNotifications'
ON CONFLICT DO NOTHING;

COMMIT;
