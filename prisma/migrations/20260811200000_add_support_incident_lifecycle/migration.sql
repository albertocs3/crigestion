BEGIN;

CREATE TYPE "SupportIncidentCloseReason" AS ENUM (
  'DUPLICATE', 'NOT_APPLICABLE', 'CUSTOMER_WITHDRAWS',
  'UNREACHABLE', 'RESOLVED_EXTERNALLY', 'OTHER'
);

ALTER TABLE "support_incidents"
  ADD COLUMN "solution" VARCHAR(4000),
  ADD COLUMN "closeReason" "SupportIncidentCloseReason",
  ADD COLUMN "closeReasonDetail" VARCHAR(500),
  ADD CONSTRAINT "support_incidents_lifecycle_projection_check" CHECK (
    ("status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL AND "closedAt" IS NULL AND "solution" IS NOT NULL AND "closeReason" IS NULL AND "closeReasonDetail" IS NULL)
    OR ("status" = 'CLOSED' AND "closedAt" IS NOT NULL AND "resolvedAt" IS NULL AND "solution" IS NULL AND "closeReason" IS NOT NULL AND (("closeReason" = 'OTHER') = ("closeReasonDetail" IS NOT NULL)))
    OR ("status" NOT IN ('RESOLVED', 'CLOSED') AND "resolvedAt" IS NULL AND "closedAt" IS NULL AND "solution" IS NULL AND "closeReason" IS NULL AND "closeReasonDetail" IS NULL)
  );

CREATE TABLE "support_incident_status_transitions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "fromStatus" "SupportIncidentStatus" NOT NULL,
  "toStatus" "SupportIncidentStatus" NOT NULL,
  "resultingVersion" INTEGER NOT NULL,
  "reasonText" VARCHAR(500),
  "solutionText" VARCHAR(4000),
  "closeReason" "SupportIncidentCloseReason",
  "closeReasonDetail" VARCHAR(500),
  "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_incident_status_transitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_incident_status_transitions_id_companyId_key" UNIQUE ("id", "companyId"),
  CONSTRAINT "support_incident_status_transitions_incidentId_resultingVersion_key" UNIQUE ("incidentId", "resultingVersion"),
  CONSTRAINT "support_incident_status_transitions_payload_check" CHECK (
    ("toStatus" IN ('PENDING_CUSTOMER', 'PENDING_THIRD_PARTY') AND "reasonText" IS NOT NULL AND "solutionText" IS NULL AND "closeReason" IS NULL AND "closeReasonDetail" IS NULL)
    OR ("toStatus" = 'IN_PROGRESS' AND "reasonText" IS NOT NULL AND "solutionText" IS NULL AND "closeReason" IS NULL AND "closeReasonDetail" IS NULL)
    OR ("toStatus" = 'RESOLVED' AND "reasonText" IS NULL AND "solutionText" IS NOT NULL AND "closeReason" IS NULL AND "closeReasonDetail" IS NULL)
    OR ("toStatus" = 'CLOSED' AND "reasonText" IS NULL AND "solutionText" IS NULL AND "closeReason" IS NOT NULL AND (("closeReason" = 'OTHER') = ("closeReasonDetail" IS NOT NULL)))
  ),
  CONSTRAINT "support_incident_status_transitions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_status_transitions_incidentId_companyId_fkey" FOREIGN KEY ("incidentId", "companyId") REFERENCES "support_incidents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_status_transitions_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "support_incident_status_transitions_incidentId_occurredAt_id_idx" ON "support_incident_status_transitions"("incidentId", "occurredAt", "id");
CREATE INDEX "support_incident_status_transitions_companyId_toStatus_occurredAt_id_idx" ON "support_incident_status_transitions"("companyId", "toStatus", "occurredAt", "id");

ALTER TABLE "support_incident_events" DISABLE TRIGGER "support_incident_events_append_only";
ALTER TABLE "support_incident_events" ADD COLUMN "transitionId" UUID, ADD COLUMN "resultingVersion" INTEGER;
UPDATE "support_incident_events" SET "resultingVersion" = 1 WHERE "eventType" = 'CREATED';
WITH ranked AS (
  SELECT event."id", row_number() OVER (PARTITION BY event."incidentId" ORDER BY action."recordedAt", action."id") + 1 AS resulting_version
  FROM "support_incident_events" event
  JOIN "support_incident_actions" action ON action."id" = event."actionId" AND action."companyId" = event."companyId"
  WHERE event."eventType" = 'ACTION_ADDED'
)
UPDATE "support_incident_events" event
SET "resultingVersion" = ranked.resulting_version,
    "fromStatus" = COALESCE(event."fromStatus", 'IN_PROGRESS'),
    "toStatus" = COALESCE(event."toStatus", 'IN_PROGRESS')
FROM ranked WHERE ranked."id" = event."id";
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "support_incident_events" WHERE "resultingVersion" IS NULL OR "toStatus" IS NULL) THEN
    RAISE EXCEPTION 'Support event version backfill is incomplete.';
  END IF;
END $$;
ALTER TABLE "support_incident_events"
  ALTER COLUMN "resultingVersion" SET NOT NULL,
  ADD CONSTRAINT "support_incident_events_transitionId_companyId_key" UNIQUE ("transitionId", "companyId"),
  ADD CONSTRAINT "support_incident_events_incidentId_resultingVersion_key" UNIQUE ("incidentId", "resultingVersion"),
  ADD CONSTRAINT "support_incident_events_transitionId_companyId_fkey" FOREIGN KEY ("transitionId", "companyId") REFERENCES "support_incident_status_transitions"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "support_incident_events_kind_check" CHECK (
    ("eventType" = 'CREATED' AND "actionId" IS NULL AND "transitionId" IS NULL AND "resultingVersion" = 1)
    OR ("eventType" = 'ACTION_ADDED' AND "actionId" IS NOT NULL AND "transitionId" IS NULL)
    OR ("eventType" = 'STATUS_CHANGED' AND "actionId" IS NULL AND "transitionId" IS NOT NULL)
  );
ALTER TABLE "support_incident_events" ENABLE TRIGGER "support_incident_events_append_only";

CREATE OR REPLACE FUNCTION "reject_support_incident_status_transition_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Support incident status transitions are append-only.' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER "support_incident_status_transitions_append_only"
BEFORE UPDATE OR DELETE ON "support_incident_status_transitions"
FOR EACH ROW EXECUTE FUNCTION "reject_support_incident_status_transition_mutation"();

CREATE OR REPLACE FUNCTION "assert_support_incident_lifecycle_evidence"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_incident_id UUID; target_company_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'support_incidents' THEN
    target_incident_id := NEW."id"; target_company_id := NEW."companyId";
  ELSE
    target_incident_id := NEW."incidentId"; target_company_id := NEW."companyId";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "support_incidents" incident
    JOIN "support_incident_events" event ON event."incidentId" = incident."id" AND event."companyId" = incident."companyId"
      AND event."resultingVersion" = incident."version" AND event."toStatus" = incident."status"
    WHERE incident."id" = target_incident_id AND incident."companyId" = target_company_id
  ) THEN
    RAISE EXCEPTION 'Support incident lifecycle change requires versioned evidence.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "support_incident_status_transitions" transition
    WHERE transition."incidentId" = target_incident_id AND transition."companyId" = target_company_id
      AND NOT EXISTS (
        SELECT 1 FROM "support_incident_events" event
        WHERE event."transitionId" = transition."id" AND event."companyId" = transition."companyId"
          AND event."incidentId" = transition."incidentId" AND event."actorUserId" = transition."actorUserId"
          AND event."eventType" = 'STATUS_CHANGED' AND event."fromStatus" = transition."fromStatus"
          AND event."toStatus" = transition."toStatus" AND event."resultingVersion" = transition."resultingVersion"
      )
  ) THEN
    RAISE EXCEPTION 'A support status transition requires one matching event.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "support_incident_lifecycle_from_incident"
AFTER INSERT OR UPDATE OF "status", "version", "resolvedAt", "closedAt", "solution", "closeReason", "closeReasonDetail" ON "support_incidents"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_support_incident_lifecycle_evidence"();
CREATE CONSTRAINT TRIGGER "support_incident_lifecycle_from_transition"
AFTER INSERT ON "support_incident_status_transitions"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_support_incident_lifecycle_evidence"();
CREATE CONSTRAINT TRIGGER "support_incident_lifecycle_from_event"
AFTER INSERT ON "support_incident_events"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_support_incident_lifecycle_evidence"();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt") VALUES
  (gen_random_uuid(), 'Support.ManageAssigned', 'Gestionar el estado de incidencias asignadas', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Support.Reopen', 'Reabrir incidencias finalizadas', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id" FROM "roles" role CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador' AND permission."code" IN ('Support.ManageAssigned', 'Support.Reopen')
ON CONFLICT DO NOTHING;

COMMIT;
