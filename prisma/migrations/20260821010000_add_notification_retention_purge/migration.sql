BEGIN;

CREATE INDEX "idempotency_records_notification_id_idx"
  ON "idempotency_records" (("responseBody" ->> 'id'))
  WHERE "key" LIKE 'v1:notif:%';
CREATE INDEX "idempotency_records_notification_bulk_body_idx"
  ON "idempotency_records" USING GIN ("responseBody" jsonb_path_ops)
  WHERE "key" LIKE 'v1:notif-bulk:%';

CREATE OR REPLACE FUNCTION "reject_notification_state_change_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Notification state changes are append-only.' USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "notifications" notification
    WHERE notification."id" = OLD."notificationId"
      AND notification."companyId" = OLD."companyId"
      AND notification."expiresAt" <= transaction_timestamp()
      AND (notification."createdAt" AT TIME ZONE 'UTC' + INTERVAL '1 year') AT TIME ZONE 'UTC' <= transaction_timestamp()
  ) THEN
    RAISE EXCEPTION 'Notification state evidence can only be purged after one year.' USING ERRCODE = 'check_violation';
  END IF;

  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION "guard_notification_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."expiresAt" > transaction_timestamp()
      OR (OLD."createdAt" AT TIME ZONE 'UTC' + INTERVAL '1 year') AT TIME ZONE 'UTC' > transaction_timestamp()
    THEN
      RAISE EXCEPTION 'A notification cannot be purged before one year.' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "notification_state_changes" change
      WHERE change."notificationId" = OLD."id" AND change."companyId" = OLD."companyId"
    ) THEN
      RAISE EXCEPTION 'Notification state evidence must be purged with its notification.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
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

CREATE OR REPLACE FUNCTION "purge_expired_notifications"(
  requested_batch_size INTEGER,
  requested_batch_number INTEGER,
  requested_worker_id TEXT
)
RETURNS TABLE (
  "asOf" TIMESTAMPTZ,
  "notificationCount" INTEGER,
  "stateChangeCount" INTEGER,
  "idempotencyRecordCount" INTEGER,
  "hasMore" BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET TimeZone = 'UTC'
AS $$
DECLARE
  selected_company_id UUID;
  selected_ids UUID[];
  deleted_notifications INTEGER := 0;
  deleted_state_changes INTEGER := 0;
  deleted_individual_replays INTEGER := 0;
  deleted_bulk_replays INTEGER := 0;
  cutoff TIMESTAMPTZ := transaction_timestamp();
  more_rows BOOLEAN := false;
BEGIN
  IF requested_batch_size IS NULL
    OR requested_batch_number IS NULL
    OR requested_worker_id IS NULL
    OR requested_batch_size < 1 OR requested_batch_size > 1000
    OR requested_batch_number < 1
    OR length(btrim(requested_worker_id)) < 1
    OR length(requested_worker_id) > 120
  THEN
    RAISE EXCEPTION 'Invalid notification purge command.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT installation."companyId"
  INTO selected_company_id
  FROM public."installations" installation
  WHERE installation."companyId" IS NOT NULL
  ORDER BY installation."createdAt", installation."id"
  LIMIT 1;

  IF selected_company_id IS NULL THEN
    RETURN QUERY SELECT cutoff, 0, 0, 0, false;
    RETURN;
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended(selected_company_id::TEXT, 2026082101)) THEN
    RAISE EXCEPTION 'Notification purge is already running.' USING ERRCODE = 'lock_not_available';
  END IF;

  SELECT array_agg(candidate."id" ORDER BY candidate."expiresAt", candidate."id")
  INTO selected_ids
  FROM (
    SELECT notification."id", notification."expiresAt"
    FROM public."notifications" notification
    WHERE notification."companyId" = selected_company_id
      AND notification."expiresAt" <= cutoff
      AND (notification."createdAt" AT TIME ZONE 'UTC' + INTERVAL '1 year') AT TIME ZONE 'UTC' <= cutoff
    ORDER BY notification."expiresAt", notification."id"
    LIMIT requested_batch_size
    FOR UPDATE SKIP LOCKED
  ) candidate;

  IF selected_ids IS NULL THEN
    RETURN QUERY SELECT cutoff, 0, 0, 0, false;
    RETURN;
  END IF;

  DELETE FROM public."idempotency_records" record
  WHERE record."key" LIKE 'v1:notif:%'
    AND record."responseBody" ->> 'id' IN (
      SELECT selected_id::TEXT FROM unnest(selected_ids) selected_id
    );
  GET DIAGNOSTICS deleted_individual_replays = ROW_COUNT;

  DELETE FROM public."idempotency_records" record
  USING unnest(selected_ids) selected("id")
  WHERE record."key" LIKE 'v1:notif-bulk:%'
    AND record."responseBody" @> jsonb_build_object(
      'items', jsonb_build_array(jsonb_build_object('id', selected."id"::TEXT))
    );
  GET DIAGNOSTICS deleted_bulk_replays = ROW_COUNT;

  DELETE FROM public."notification_state_changes" change
  WHERE change."companyId" = selected_company_id
    AND change."notificationId" = ANY(selected_ids);
  GET DIAGNOSTICS deleted_state_changes = ROW_COUNT;

  DELETE FROM public."notifications" notification
  WHERE notification."companyId" = selected_company_id
    AND notification."id" = ANY(selected_ids)
    AND notification."expiresAt" <= cutoff
    AND (notification."createdAt" AT TIME ZONE 'UTC' + INTERVAL '1 year') AT TIME ZONE 'UTC' <= cutoff;
  GET DIAGNOSTICS deleted_notifications = ROW_COUNT;

  IF deleted_notifications <> cardinality(selected_ids) THEN
    RAISE EXCEPTION 'Notification purge count mismatch.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public."notifications" notification
    WHERE notification."companyId" = selected_company_id
      AND notification."expiresAt" <= cutoff
      AND (notification."createdAt" AT TIME ZONE 'UTC' + INTERVAL '1 year') AT TIME ZONE 'UTC' <= cutoff
  ) INTO more_rows;

  INSERT INTO public."audit_events" ("id", "eventType", "actorType", "payload")
  VALUES (
    gen_random_uuid(),
    'NOTIFICATION_PURGE_BATCH_COMPLETED',
    'SYSTEM',
    jsonb_build_object(
      'companyId', selected_company_id,
      'asOf', cutoff,
      'batchNumber', requested_batch_number,
      'workerId', requested_worker_id,
      'notificationCount', deleted_notifications,
      'stateChangeCount', deleted_state_changes,
      'idempotencyRecordCount', deleted_individual_replays + deleted_bulk_replays,
      'hasMore', more_rows
    )
  );

  RETURN QUERY SELECT cutoff, deleted_notifications, deleted_state_changes,
    deleted_individual_replays + deleted_bulk_replays, more_rows;
END;
$$;

REVOKE ALL ON FUNCTION "purge_expired_notifications"(INTEGER, INTEGER, TEXT) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crigestion_staging_app') THEN
    REVOKE DELETE ON TABLE "notifications", "notification_state_changes"
      FROM "crigestion_staging_app";
    GRANT EXECUTE ON FUNCTION "purge_expired_notifications"(INTEGER, INTEGER, TEXT)
      TO "crigestion_staging_app";
  END IF;
END;
$$;

COMMIT;
