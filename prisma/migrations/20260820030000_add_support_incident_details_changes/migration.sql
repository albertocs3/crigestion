BEGIN;

CREATE TABLE "support_incident_details_changes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "previousStoreId" UUID,
  "correctedStoreId" UUID,
  "previousCategoryId" UUID NOT NULL,
  "correctedCategoryId" UUID NOT NULL,
  "previousCategoryName" VARCHAR(120) NOT NULL,
  "correctedCategoryName" VARCHAR(120) NOT NULL,
  "previousStoreCode" VARCHAR(20),
  "previousStoreName" VARCHAR(160),
  "correctedStoreCode" VARCHAR(20),
  "correctedStoreName" VARCHAR(160),
  "previousTitle" VARCHAR(200) NOT NULL,
  "correctedTitle" VARCHAR(200) NOT NULL,
  "previousDescription" VARCHAR(4000) NOT NULL,
  "correctedDescription" VARCHAR(4000) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "resultingVersion" INTEGER NOT NULL,
  "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "support_incident_details_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_details_change_incident_key" UNIQUE ("id", "companyId", "incidentId"),
  CONSTRAINT "support_details_change_version_key" UNIQUE ("incidentId", "resultingVersion"),
  CONSTRAINT "support_details_change_values_check" CHECK (
    "resultingVersion" > 1
    AND length(btrim("previousTitle")) BETWEEN 3 AND 200
    AND length(btrim("correctedTitle")) BETWEEN 3 AND 200
    AND length(btrim("previousDescription")) BETWEEN 3 AND 4000
    AND length(btrim("correctedDescription")) BETWEEN 3 AND 4000
    AND length(btrim("reason")) BETWEEN 3 AND 500
    AND length(btrim("previousCategoryName")) BETWEEN 1 AND 120
    AND length(btrim("correctedCategoryName")) BETWEEN 1 AND 120
    AND (("previousStoreId" IS NULL AND "previousStoreCode" IS NULL AND "previousStoreName" IS NULL) OR ("previousStoreId" IS NOT NULL AND "previousStoreCode" IS NOT NULL AND "previousStoreName" IS NOT NULL AND length(btrim("previousStoreCode")) BETWEEN 1 AND 20 AND length(btrim("previousStoreName")) BETWEEN 1 AND 160))
    AND (("correctedStoreId" IS NULL AND "correctedStoreCode" IS NULL AND "correctedStoreName" IS NULL) OR ("correctedStoreId" IS NOT NULL AND "correctedStoreCode" IS NOT NULL AND "correctedStoreName" IS NOT NULL AND length(btrim("correctedStoreCode")) BETWEEN 1 AND 20 AND length(btrim("correctedStoreName")) BETWEEN 1 AND 160))
    AND (
      "previousStoreId" IS DISTINCT FROM "correctedStoreId"
      OR "previousCategoryId" IS DISTINCT FROM "correctedCategoryId"
      OR "previousTitle" IS DISTINCT FROM "correctedTitle"
      OR "previousDescription" IS DISTINCT FROM "correctedDescription"
    )
  ),
  CONSTRAINT "support_details_change_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_details_change_incident_fkey"
    FOREIGN KEY ("incidentId", "companyId") REFERENCES "support_incidents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_details_change_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_details_change_customer_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "support_details_change_previous_store_fkey"
    FOREIGN KEY ("previousStoreId", "customerId") REFERENCES "customer_stores"("id", "customerId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "support_details_change_corrected_store_fkey"
    FOREIGN KEY ("correctedStoreId", "customerId") REFERENCES "customer_stores"("id", "customerId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "support_details_change_previous_category_fkey"
    FOREIGN KEY ("previousCategoryId", "companyId") REFERENCES "support_incident_categories"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "support_details_change_corrected_category_fkey"
    FOREIGN KEY ("correctedCategoryId", "companyId") REFERENCES "support_incident_categories"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "support_details_change_incident_time_idx"
  ON "support_incident_details_changes"("incidentId", "changedAt", "id");

CREATE OR REPLACE FUNCTION "validate_support_details_change_labels"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_category_name TEXT;
  corrected_category_name TEXT;
  previous_store_code TEXT;
  previous_store_name TEXT;
  corrected_store_code TEXT;
  corrected_store_name TEXT;
BEGIN
  SELECT "name" INTO STRICT previous_category_name
  FROM "support_incident_categories"
  WHERE "id" = NEW."previousCategoryId" AND "companyId" = NEW."companyId"
  FOR SHARE;
  SELECT "name" INTO STRICT corrected_category_name
  FROM "support_incident_categories"
  WHERE "id" = NEW."correctedCategoryId" AND "companyId" = NEW."companyId"
  FOR SHARE;
  IF NEW."previousCategoryName" <> previous_category_name
    OR NEW."correctedCategoryName" <> corrected_category_name
  THEN
    RAISE EXCEPTION 'Support incident category snapshots must match their referenced rows.' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."previousStoreId" IS NOT NULL THEN
    SELECT "code", "name" INTO STRICT previous_store_code, previous_store_name
    FROM "customer_stores"
    WHERE "id" = NEW."previousStoreId" AND "customerId" = NEW."customerId"
    FOR SHARE;
    IF NEW."previousStoreCode" IS DISTINCT FROM previous_store_code OR NEW."previousStoreName" IS DISTINCT FROM previous_store_name THEN
      RAISE EXCEPTION 'Support incident previous store snapshot must match its referenced row.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."correctedStoreId" IS NOT NULL THEN
    SELECT "code", "name" INTO STRICT corrected_store_code, corrected_store_name
    FROM "customer_stores"
    WHERE "id" = NEW."correctedStoreId" AND "customerId" = NEW."customerId"
    FOR SHARE;
    IF NEW."correctedStoreCode" IS DISTINCT FROM corrected_store_code OR NEW."correctedStoreName" IS DISTINCT FROM corrected_store_name THEN
      RAISE EXCEPTION 'Support incident corrected store snapshot must match its referenced row.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "support_incident_details_changes_validate_labels"
BEFORE INSERT ON "support_incident_details_changes"
FOR EACH ROW EXECUTE FUNCTION "validate_support_details_change_labels"();

CREATE OR REPLACE FUNCTION "reject_support_details_change_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Support incident details changes are append-only.' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "support_incident_details_changes_append_only"
BEFORE UPDATE OR DELETE ON "support_incident_details_changes"
FOR EACH ROW EXECUTE FUNCTION "reject_support_details_change_mutation"();

ALTER TABLE "support_incident_events"
  ADD COLUMN "detailsChangeId" UUID,
  ADD CONSTRAINT "support_event_details_incident_key" UNIQUE ("detailsChangeId", "companyId", "incidentId"),
  ADD CONSTRAINT "support_event_details_incident_fkey"
    FOREIGN KEY ("detailsChangeId", "companyId", "incidentId")
    REFERENCES "support_incident_details_changes"("id", "companyId", "incidentId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "support_incident_events"
  ADD CONSTRAINT "support_incident_events_kind_check_v4" CHECK (
    ("eventType" = 'CREATED' AND "actionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL AND "resultingVersion" = 1)
    OR ("eventType" = 'ACTION_ADDED' AND "actionId" IS NOT NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL)
    OR ("eventType" = 'STATUS_CHANGED' AND "actionId" IS NULL AND "transitionId" IS NOT NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL)
    OR ("eventType" IN ('COLLABORATOR_ADDED', 'COLLABORATOR_REMOVED', 'RESPONSIBLE_CHANGED') AND "actionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NOT NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL)
    OR ("eventType" = 'PRIORITY_CHANGED' AND "actionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NOT NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL AND "fromStatus" IS NOT NULL AND "toStatus" = "fromStatus" AND "resultingVersion" > 1)
    OR ("eventType" = 'DETAILS_CHANGED' AND "actionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NOT NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL AND "fromStatus" IS NOT NULL AND "toStatus" = "fromStatus" AND "resultingVersion" > 1)
    OR ("eventType" = 'INCIDENT_MERGED' AND "actionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NOT NULL AND "mergeRole" IS NOT NULL AND "fromStatus" IS NOT NULL AND "toStatus" IS NOT NULL AND "resultingVersion" > 1 AND (("mergeRole" = 'PRIMARY' AND "toStatus" = "fromStatus") OR ("mergeRole" = 'DUPLICATE' AND "toStatus" = 'CLOSED')))
  ) NOT VALID;

ALTER TABLE "support_incident_events" VALIDATE CONSTRAINT "support_incident_events_kind_check_v4";
ALTER TABLE "support_incident_events" DROP CONSTRAINT "support_incident_events_kind_check";
ALTER TABLE "support_incident_events" RENAME CONSTRAINT "support_incident_events_kind_check_v4" TO "support_incident_events_kind_check";

CREATE OR REPLACE FUNCTION "assert_support_incident_details_consistency"()
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

    IF NEW."version" <> OLD."version" + 1
      OR NEW."companyId" IS DISTINCT FROM OLD."companyId"
      OR NEW."year" IS DISTINCT FROM OLD."year"
      OR NEW."sequenceNumber" IS DISTINCT FROM OLD."sequenceNumber"
      OR NEW."number" IS DISTINCT FROM OLD."number"
      OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
      OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
      OR NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."priority" IS DISTINCT FROM OLD."priority"
      OR NEW."responsibleUserId" IS DISTINCT FROM OLD."responsibleUserId"
      OR NEW."mergedIntoIncidentId" IS DISTINCT FROM OLD."mergedIntoIncidentId"
      OR NEW."firstActionAt" IS DISTINCT FROM OLD."firstActionAt"
      OR NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt"
      OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt"
      OR NEW."solution" IS DISTINCT FROM OLD."solution"
      OR NEW."closeReason" IS DISTINCT FROM OLD."closeReason"
      OR NEW."closeReasonDetail" IS DISTINCT FROM OLD."closeReasonDetail"
      OR NOT EXISTS (
        SELECT 1
        FROM "support_incident_details_changes" change
        JOIN "support_incident_events" event
          ON event."detailsChangeId" = change."id"
         AND event."companyId" = change."companyId"
         AND event."incidentId" = change."incidentId"
        WHERE change."incidentId" = NEW."id"
          AND change."companyId" = NEW."companyId"
          AND change."customerId" = OLD."customerId"
          AND change."previousStoreId" IS NOT DISTINCT FROM OLD."storeId"
          AND change."correctedStoreId" IS NOT DISTINCT FROM NEW."storeId"
          AND change."previousCategoryId" = OLD."categoryId"
          AND change."correctedCategoryId" = NEW."categoryId"
          AND change."previousTitle" = OLD."title"
          AND change."correctedTitle" = NEW."title"
          AND change."previousDescription" = OLD."description"
          AND change."correctedDescription" = NEW."description"
          AND change."resultingVersion" = NEW."version"
          AND event."eventType" = 'DETAILS_CHANGED'
          AND event."actorUserId" = change."actorUserId"
          AND event."resultingVersion" = change."resultingVersion"
          AND event."fromStatus" = OLD."status"
          AND event."toStatus" = NEW."status"
          AND event."createdAt" >= change."changedAt"
          AND event."createdAt" <= change."changedAt" + INTERVAL '5 minutes'
      )
    THEN
      RAISE EXCEPTION 'A details projection change requires matching versioned evidence.' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    target_incident_id := NEW."incidentId";
    target_company_id := NEW."companyId";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "support_incident_details_changes" change
    WHERE change."incidentId" = target_incident_id
      AND change."companyId" = target_company_id
      AND NOT EXISTS (
        SELECT 1 FROM "support_incident_events" event
        WHERE event."detailsChangeId" = change."id"
          AND event."companyId" = change."companyId"
          AND event."incidentId" = change."incidentId"
          AND event."actorUserId" = change."actorUserId"
          AND event."eventType" = 'DETAILS_CHANGED'
          AND event."resultingVersion" = change."resultingVersion"
          AND event."fromStatus" = event."toStatus"
          AND event."createdAt" >= change."changedAt"
          AND event."createdAt" <= change."changedAt" + INTERVAL '5 minutes'
      )
  ) THEN
    RAISE EXCEPTION 'A support incident details change requires one matching event.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "support_incident_events" event
    WHERE event."incidentId" = target_incident_id
      AND event."companyId" = target_company_id
      AND event."eventType" = 'DETAILS_CHANGED'
      AND NOT EXISTS (
        SELECT 1 FROM "support_incident_details_changes" change
        WHERE change."id" = event."detailsChangeId"
          AND change."companyId" = event."companyId"
          AND change."incidentId" = event."incidentId"
          AND change."actorUserId" = event."actorUserId"
          AND change."resultingVersion" = event."resultingVersion"
      )
  ) THEN
    RAISE EXCEPTION 'A details event requires matching details evidence.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "support_incidents" incident
    WHERE incident."id" = target_incident_id
      AND incident."companyId" = target_company_id
      AND (
        EXISTS (
          SELECT 1 FROM "support_incident_details_changes" change
          WHERE change."incidentId" = incident."id"
            AND change."companyId" = incident."companyId"
            AND change."resultingVersion" > incident."version"
        )
        OR EXISTS (
          SELECT 1
          FROM "support_incident_details_changes" latest
          WHERE latest."incidentId" = incident."id"
            AND latest."companyId" = incident."companyId"
            AND latest."resultingVersion" = (
              SELECT max(candidate."resultingVersion")
              FROM "support_incident_details_changes" candidate
              WHERE candidate."incidentId" = incident."id"
                AND candidate."companyId" = incident."companyId"
            )
            AND (
              latest."customerId" <> incident."customerId"
              OR latest."correctedStoreId" IS DISTINCT FROM incident."storeId"
              OR latest."correctedCategoryId" <> incident."categoryId"
              OR latest."correctedTitle" <> incident."title"
              OR latest."correctedDescription" <> incident."description"
            )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Support incident details projection does not match its evidence.' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "support_details_from_incident"
AFTER UPDATE OF "customerId", "storeId", "categoryId", "title", "description" ON "support_incidents"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  OLD."customerId" IS DISTINCT FROM NEW."customerId"
  OR OLD."storeId" IS DISTINCT FROM NEW."storeId"
  OR OLD."categoryId" IS DISTINCT FROM NEW."categoryId"
  OR OLD."title" IS DISTINCT FROM NEW."title"
  OR OLD."description" IS DISTINCT FROM NEW."description"
)
EXECUTE FUNCTION "assert_support_incident_details_consistency"();

CREATE OR REPLACE FUNCTION "reject_spurious_support_details_version"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."version" <> OLD."version"
    AND NEW."storeId" IS NOT DISTINCT FROM OLD."storeId"
    AND NEW."categoryId" IS NOT DISTINCT FROM OLD."categoryId"
    AND NEW."title" IS NOT DISTINCT FROM OLD."title"
    AND NEW."description" IS NOT DISTINCT FROM OLD."description"
    AND (
      EXISTS (
        SELECT 1 FROM "support_incident_details_changes" change
        WHERE change."incidentId" = NEW."id"
          AND change."companyId" = NEW."companyId"
          AND change."resultingVersion" = NEW."version"
      )
      OR EXISTS (
        SELECT 1 FROM "support_incident_events" event
        WHERE event."incidentId" = NEW."id"
          AND event."companyId" = NEW."companyId"
          AND event."resultingVersion" = NEW."version"
          AND event."eventType" = 'DETAILS_CHANGED'
      )
    )
  THEN
    RAISE EXCEPTION 'A details event cannot advance the version without changing details.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "support_details_from_version"
AFTER UPDATE OF "version" ON "support_incidents"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "reject_spurious_support_details_version"();

CREATE CONSTRAINT TRIGGER "support_details_from_change"
AFTER INSERT ON "support_incident_details_changes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_support_incident_details_consistency"();

CREATE CONSTRAINT TRIGGER "support_details_from_event"
AFTER INSERT ON "support_incident_events"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."eventType" = 'DETAILS_CHANGED')
EXECUTE FUNCTION "assert_support_incident_details_consistency"();

COMMIT;
