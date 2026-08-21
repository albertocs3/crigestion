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
        AND NEW."updatedAt" = change."occurredAt"
        AND change."occurredAt" >= OLD."updatedAt"
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
              AND notification."updatedAt" = change."occurredAt"
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
