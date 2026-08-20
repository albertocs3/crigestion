BEGIN;

CREATE TABLE "support_incident_action_corrections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "actionId" UUID NOT NULL,
  "originalAuthorUserId" UUID NOT NULL,
  "correctedByUserId" UUID NOT NULL,
  "previousText" VARCHAR(4000) NOT NULL,
  "correctedText" VARCHAR(4000) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "resultingActionVersion" INTEGER NOT NULL,
  "resultingIncidentVersion" INTEGER NOT NULL,
  "correctedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "support_incident_action_corrections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_action_correction_incident_key" UNIQUE ("id", "companyId", "incidentId"),
  CONSTRAINT "support_action_correction_action_version_key" UNIQUE ("actionId", "resultingActionVersion"),
  CONSTRAINT "support_action_correction_incident_version_key" UNIQUE ("incidentId", "resultingIncidentVersion"),
  CONSTRAINT "support_action_correction_values_check" CHECK (
    "resultingActionVersion" > 1
    AND "resultingIncidentVersion" > 1
    AND length(btrim("previousText")) BETWEEN 3 AND 4000
    AND length(btrim("correctedText")) BETWEEN 3 AND 4000
    AND length(btrim("reason")) BETWEEN 3 AND 500
    AND "previousText" IS DISTINCT FROM "correctedText"
  ),
  CONSTRAINT "support_action_correction_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_action_correction_incident_fkey"
    FOREIGN KEY ("incidentId", "companyId") REFERENCES "support_incidents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_action_correction_action_fkey"
    FOREIGN KEY ("actionId", "companyId", "incidentId") REFERENCES "support_incident_actions"("id", "companyId", "incidentId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_action_correction_original_author_fkey"
    FOREIGN KEY ("originalAuthorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_action_correction_corrected_by_fkey"
    FOREIGN KEY ("correctedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "support_action_correction_action_time_idx"
  ON "support_incident_action_corrections"("actionId", "correctedAt", "id");
CREATE INDEX "support_action_corrections_text_trgm_idx"
  ON "support_incident_action_corrections" USING GIN ("correctedText" gin_trgm_ops);

CREATE OR REPLACE FUNCTION "reject_support_action_correction_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Support action corrections are append-only.' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "support_action_corrections_append_only"
BEFORE UPDATE OR DELETE ON "support_incident_action_corrections"
FOR EACH ROW EXECUTE FUNCTION "reject_support_action_correction_mutation"();

ALTER TABLE "support_incident_events"
  ADD COLUMN "actionCorrectionId" UUID,
  ADD CONSTRAINT "support_event_action_correction_incident_key" UNIQUE ("actionCorrectionId", "companyId", "incidentId"),
  ADD CONSTRAINT "support_event_action_correction_incident_fkey"
    FOREIGN KEY ("actionCorrectionId", "companyId", "incidentId")
    REFERENCES "support_incident_action_corrections"("id", "companyId", "incidentId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "support_incident_events"
  ADD CONSTRAINT "support_incident_events_kind_check_v5" CHECK (
    ("eventType" = 'CREATED' AND "actionId" IS NULL AND "actionCorrectionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL AND "resultingVersion" = 1)
    OR ("eventType" = 'ACTION_ADDED' AND "actionId" IS NOT NULL AND "actionCorrectionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL)
    OR ("eventType" = 'ACTION_CORRECTED' AND "actionId" IS NULL AND "actionCorrectionId" IS NOT NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL AND "fromStatus" IS NOT NULL AND "toStatus" = "fromStatus" AND "resultingVersion" > 1)
    OR ("eventType" = 'STATUS_CHANGED' AND "actionId" IS NULL AND "actionCorrectionId" IS NULL AND "transitionId" IS NOT NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL)
    OR ("eventType" IN ('COLLABORATOR_ADDED', 'COLLABORATOR_REMOVED', 'RESPONSIBLE_CHANGED') AND "actionId" IS NULL AND "actionCorrectionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NOT NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL)
    OR ("eventType" = 'PRIORITY_CHANGED' AND "actionId" IS NULL AND "actionCorrectionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NOT NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL AND "fromStatus" IS NOT NULL AND "toStatus" = "fromStatus" AND "resultingVersion" > 1)
    OR ("eventType" = 'DETAILS_CHANGED' AND "actionId" IS NULL AND "actionCorrectionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NOT NULL AND "mergeId" IS NULL AND "mergeRole" IS NULL AND "fromStatus" IS NOT NULL AND "toStatus" = "fromStatus" AND "resultingVersion" > 1)
    OR ("eventType" = 'INCIDENT_MERGED' AND "actionId" IS NULL AND "actionCorrectionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "priorityChangeId" IS NULL AND "detailsChangeId" IS NULL AND "mergeId" IS NOT NULL AND "mergeRole" IS NOT NULL AND "fromStatus" IS NOT NULL AND "toStatus" IS NOT NULL AND "resultingVersion" > 1 AND (("mergeRole" = 'PRIMARY' AND "toStatus" = "fromStatus") OR ("mergeRole" = 'DUPLICATE' AND "toStatus" = 'CLOSED')))
  ) NOT VALID;

ALTER TABLE "support_incident_events" VALIDATE CONSTRAINT "support_incident_events_kind_check_v5";
ALTER TABLE "support_incident_events" DROP CONSTRAINT "support_incident_events_kind_check";
ALTER TABLE "support_incident_events" RENAME CONSTRAINT "support_incident_events_kind_check_v5" TO "support_incident_events_kind_check";

CREATE OR REPLACE FUNCTION "assert_support_action_correction_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_incident_id UUID;
  target_company_id UUID;
BEGIN
  target_incident_id := NEW."incidentId";
  target_company_id := NEW."companyId";

  IF EXISTS (
    SELECT 1
    FROM "support_incident_action_corrections" correction
    JOIN "support_incident_actions" action
      ON action."id" = correction."actionId"
     AND action."companyId" = correction."companyId"
     AND action."incidentId" = correction."incidentId"
    WHERE correction."incidentId" = target_incident_id
      AND correction."companyId" = target_company_id
      AND (
        correction."originalAuthorUserId" <> action."authorUserId"
        OR correction."correctedAt" < action."recordedAt"
        OR (
          correction."resultingActionVersion" = 2
          AND correction."previousText" <> action."text"
        )
        OR (
          correction."resultingActionVersion" > 2
          AND NOT EXISTS (
            SELECT 1
            FROM "support_incident_action_corrections" previous
            WHERE previous."actionId" = correction."actionId"
              AND previous."resultingActionVersion" = correction."resultingActionVersion" - 1
              AND previous."correctedText" = correction."previousText"
              AND previous."resultingIncidentVersion" < correction."resultingIncidentVersion"
              AND previous."correctedAt" <= correction."correctedAt"
          )
        )
        OR NOT EXISTS (
          SELECT 1
          FROM "support_incident_events" event
          WHERE event."actionCorrectionId" = correction."id"
            AND event."companyId" = correction."companyId"
            AND event."incidentId" = correction."incidentId"
            AND event."actorUserId" = correction."correctedByUserId"
            AND event."eventType" = 'ACTION_CORRECTED'
            AND event."resultingVersion" = correction."resultingIncidentVersion"
            AND event."fromStatus" = event."toStatus"
            AND event."createdAt" >= correction."correctedAt"
            AND event."createdAt" <= correction."correctedAt" + INTERVAL '5 minutes'
        )
      )
  ) THEN
    RAISE EXCEPTION 'A support action correction requires a continuous chain and matching event.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "support_incident_events" event
    WHERE event."incidentId" = target_incident_id
      AND event."companyId" = target_company_id
      AND event."eventType" = 'ACTION_CORRECTED'
      AND NOT EXISTS (
        SELECT 1
        FROM "support_incident_action_corrections" correction
        WHERE correction."id" = event."actionCorrectionId"
          AND correction."companyId" = event."companyId"
          AND correction."incidentId" = event."incidentId"
          AND correction."correctedByUserId" = event."actorUserId"
          AND correction."resultingIncidentVersion" = event."resultingVersion"
      )
  ) THEN
    RAISE EXCEPTION 'An action correction event requires matching evidence.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "support_incident_action_corrections" correction
    JOIN "support_incidents" incident
      ON incident."id" = correction."incidentId"
     AND incident."companyId" = correction."companyId"
    WHERE correction."incidentId" = target_incident_id
      AND correction."companyId" = target_company_id
      AND correction."resultingIncidentVersion" > incident."version"
  ) THEN
    RAISE EXCEPTION 'Action correction evidence cannot be ahead of the incident version.' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "support_action_correction_from_correction"
AFTER INSERT ON "support_incident_action_corrections"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_support_action_correction_consistency"();

CREATE CONSTRAINT TRIGGER "support_action_correction_from_event"
AFTER INSERT ON "support_incident_events"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."eventType" = 'ACTION_CORRECTED')
EXECUTE FUNCTION "assert_support_action_correction_consistency"();

CREATE OR REPLACE FUNCTION "assert_support_action_correction_version"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "support_incident_action_corrections" correction
    JOIN "support_incident_events" event
      ON event."actionCorrectionId" = correction."id"
     AND event."companyId" = correction."companyId"
     AND event."incidentId" = correction."incidentId"
    WHERE correction."incidentId" = NEW."id"
      AND correction."companyId" = NEW."companyId"
      AND correction."resultingIncidentVersion" = NEW."version"
  ) THEN
    IF NEW."version" <> OLD."version" + 1
      OR NEW."companyId" IS DISTINCT FROM OLD."companyId"
      OR NEW."year" IS DISTINCT FROM OLD."year"
      OR NEW."sequenceNumber" IS DISTINCT FROM OLD."sequenceNumber"
      OR NEW."number" IS DISTINCT FROM OLD."number"
      OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
      OR NEW."storeId" IS DISTINCT FROM OLD."storeId"
      OR NEW."categoryId" IS DISTINCT FROM OLD."categoryId"
      OR NEW."responsibleUserId" IS DISTINCT FROM OLD."responsibleUserId"
      OR NEW."mergedIntoIncidentId" IS DISTINCT FROM OLD."mergedIntoIncidentId"
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
    THEN
      RAISE EXCEPTION 'An action correction may only advance the incident version.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "support_action_correction_from_incident"
AFTER UPDATE OF "version" ON "support_incidents"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_support_action_correction_version"();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Support.CorrectActions', 'Corregir actuaciones propias conservando evidencia', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador' AND permission."code" = 'Support.CorrectActions'
ON CONFLICT DO NOTHING;

COMMIT;
