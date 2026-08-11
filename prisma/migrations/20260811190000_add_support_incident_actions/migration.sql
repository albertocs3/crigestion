BEGIN;

CREATE TABLE "support_incident_actions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "authorUserId" UUID NOT NULL,
  "text" VARCHAR(4000) NOT NULL,
  "performedAt" TIMESTAMPTZ(3) NOT NULL,
  "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_incident_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_incident_actions_id_companyId_key" UNIQUE ("id", "companyId"),
  CONSTRAINT "support_incident_actions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_actions_incidentId_companyId_fkey" FOREIGN KEY ("incidentId", "companyId") REFERENCES "support_incidents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_actions_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "support_incident_actions_incidentId_performedAt_id_idx" ON "support_incident_actions"("incidentId", "performedAt", "id");
CREATE INDEX "support_incident_actions_companyId_authorUserId_recordedAt_id_idx" ON "support_incident_actions"("companyId", "authorUserId", "recordedAt", "id");

ALTER TABLE "support_incident_events"
  ADD COLUMN "actionId" UUID,
  ADD CONSTRAINT "support_incident_events_actionId_companyId_key" UNIQUE ("actionId", "companyId"),
  ADD CONSTRAINT "support_incident_events_actionId_companyId_fkey" FOREIGN KEY ("actionId", "companyId") REFERENCES "support_incident_actions"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "reject_support_incident_action_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Support incident actions are append-only.' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "support_incident_actions_append_only"
BEFORE UPDATE OR DELETE ON "support_incident_actions"
FOR EACH ROW EXECUTE FUNCTION "reject_support_incident_action_mutation"();

CREATE OR REPLACE FUNCTION "assert_support_incident_action_consistency"()
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
  ELSIF TG_TABLE_NAME = 'support_incident_actions' THEN
    target_incident_id := NEW."incidentId";
    target_company_id := NEW."companyId";
  ELSE
    SELECT action."incidentId", action."companyId"
      INTO target_incident_id, target_company_id
    FROM "support_incident_actions" action
    WHERE action."id" = NEW."actionId" AND action."companyId" = NEW."companyId";
    IF target_incident_id IS NULL THEN RETURN NULL; END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "support_incident_actions" action
    JOIN "support_incidents" incident ON incident."id" = action."incidentId" AND incident."companyId" = action."companyId"
    WHERE action."incidentId" = target_incident_id
      AND action."companyId" = target_company_id
      AND (
        action."performedAt" < incident."createdAt"
        OR action."performedAt" > action."recordedAt" + INTERVAL '5 minutes'
        OR NOT EXISTS (
          SELECT 1 FROM "support_incident_events" event
          WHERE event."actionId" = action."id"
            AND event."companyId" = action."companyId"
            AND event."incidentId" = action."incidentId"
            AND event."actorUserId" = action."authorUserId"
            AND event."eventType" = 'ACTION_ADDED'
        )
      )
  ) THEN
    RAISE EXCEPTION 'A support action requires valid timing and one matching event.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (SELECT 1 FROM "support_incident_actions" WHERE "incidentId" = target_incident_id AND "companyId" = target_company_id)
    AND EXISTS (
      SELECT 1
      FROM "support_incidents" incident
      WHERE incident."id" = target_incident_id
        AND incident."companyId" = target_company_id
        AND (
          incident."status" = 'NEW'
          OR incident."firstActionAt" IS DISTINCT FROM (
            SELECT min(action."performedAt") FROM "support_incident_actions" action
            WHERE action."incidentId" = incident."id" AND action."companyId" = incident."companyId"
          )
        )
    )
  THEN
    RAISE EXCEPTION 'A support incident with actions requires the first action timestamp and a progressed status.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "support_incident_action_consistency_from_action"
AFTER INSERT ON "support_incident_actions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_support_incident_action_consistency"();

CREATE CONSTRAINT TRIGGER "support_incident_action_consistency_from_event"
AFTER INSERT ON "support_incident_events"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_support_incident_action_consistency"();

CREATE CONSTRAINT TRIGGER "support_incident_action_consistency_from_incident"
AFTER UPDATE OF "status", "firstActionAt" ON "support_incidents"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_support_incident_action_consistency"();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Support.AddActions', 'Registrar actuaciones en incidencias asignadas', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador' AND permission."code" = 'Support.AddActions'
ON CONFLICT DO NOTHING;

COMMIT;
