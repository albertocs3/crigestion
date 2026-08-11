BEGIN;

CREATE TYPE "SupportIncidentParticipantChangeType" AS ENUM ('COLLABORATOR_ADDED', 'COLLABORATOR_REMOVED', 'RESPONSIBLE_CHANGED');

CREATE TABLE "support_incident_collaborators" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "companyId" UUID NOT NULL, "incidentId" UUID NOT NULL,
  "userId" UUID NOT NULL, "addedByUserId" UUID NOT NULL, "removedByUserId" UUID,
  "addedVersion" INTEGER NOT NULL, "removedVersion" INTEGER,
  "addedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "removedAt" TIMESTAMPTZ(3),
  CONSTRAINT "support_incident_collaborators_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_incident_collaborators_id_companyId_key" UNIQUE ("id", "companyId"),
  CONSTRAINT "support_incident_collaborators_state_check" CHECK (
    "addedVersion" > 1 AND (("removedAt" IS NULL AND "removedByUserId" IS NULL AND "removedVersion" IS NULL)
      OR ("removedAt" IS NOT NULL AND "removedAt" >= "addedAt" AND "removedByUserId" IS NOT NULL AND "removedVersion" > "addedVersion"))
  ),
  CONSTRAINT "support_incident_collaborators_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_collaborators_incidentId_companyId_fkey" FOREIGN KEY ("incidentId", "companyId") REFERENCES "support_incidents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_collaborators_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_collaborators_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_collaborators_removedByUserId_fkey" FOREIGN KEY ("removedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "support_incident_collaborators_one_active_per_user" ON "support_incident_collaborators"("incidentId", "userId") WHERE "removedAt" IS NULL;
CREATE INDEX "support_incident_collaborators_incidentId_removedAt_addedAt_id_idx" ON "support_incident_collaborators"("incidentId", "removedAt", "addedAt", "id");
CREATE INDEX "support_incident_collaborators_companyId_userId_removedAt_id_idx" ON "support_incident_collaborators"("companyId", "userId", "removedAt", "id");

CREATE TABLE "support_incident_participant_changes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "companyId" UUID NOT NULL, "incidentId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL, "changeType" "SupportIncidentParticipantChangeType" NOT NULL,
  "collaboratorId" UUID, "fromResponsibleId" UUID, "toResponsibleId" UUID, "reason" VARCHAR(500),
  "resultingVersion" INTEGER NOT NULL, "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_incident_participant_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_incident_participant_changes_id_companyId_key" UNIQUE ("id", "companyId"),
  CONSTRAINT "support_incident_participant_changes_incidentId_resultingVersion_key" UNIQUE ("incidentId", "resultingVersion"),
  CONSTRAINT "support_incident_participant_changes_payload_check" CHECK ((
    ("changeType" = 'COLLABORATOR_ADDED' AND "collaboratorId" IS NOT NULL AND "fromResponsibleId" IS NULL AND "toResponsibleId" IS NULL AND "reason" IS NULL)
    OR ("changeType" = 'COLLABORATOR_REMOVED' AND "collaboratorId" IS NOT NULL AND "fromResponsibleId" IS NULL AND "toResponsibleId" IS NULL AND length(btrim("reason")) >= 3)
    OR ("changeType" = 'RESPONSIBLE_CHANGED' AND "collaboratorId" IS NULL AND "fromResponsibleId" IS NOT NULL AND "toResponsibleId" IS NOT NULL AND "fromResponsibleId" <> "toResponsibleId" AND length(btrim("reason")) >= 3)
  ) AND "resultingVersion" > 1),
  CONSTRAINT "support_incident_participant_changes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_participant_changes_incidentId_companyId_fkey" FOREIGN KEY ("incidentId", "companyId") REFERENCES "support_incidents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_participant_changes_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_participant_changes_collaboratorId_companyId_fkey" FOREIGN KEY ("collaboratorId", "companyId") REFERENCES "support_incident_collaborators"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_participant_changes_fromResponsibleId_fkey" FOREIGN KEY ("fromResponsibleId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_participant_changes_toResponsibleId_fkey" FOREIGN KEY ("toResponsibleId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "support_incident_participant_changes_incidentId_occurredAt_id_idx" ON "support_incident_participant_changes"("incidentId", "occurredAt", "id");

ALTER TABLE "support_incident_events" DROP CONSTRAINT "support_incident_events_kind_check";
ALTER TABLE "support_incident_events"
  ADD COLUMN "participantChangeId" UUID,
  ADD CONSTRAINT "support_incident_events_participantChangeId_companyId_key" UNIQUE ("participantChangeId", "companyId"),
  ADD CONSTRAINT "support_incident_events_participantChangeId_companyId_fkey" FOREIGN KEY ("participantChangeId", "companyId") REFERENCES "support_incident_participant_changes"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "support_incident_events_kind_check" CHECK (
    ("eventType" = 'CREATED' AND "actionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL AND "resultingVersion" = 1)
    OR ("eventType" = 'ACTION_ADDED' AND "actionId" IS NOT NULL AND "transitionId" IS NULL AND "participantChangeId" IS NULL)
    OR ("eventType" = 'STATUS_CHANGED' AND "actionId" IS NULL AND "transitionId" IS NOT NULL AND "participantChangeId" IS NULL)
    OR ("eventType" IN ('COLLABORATOR_ADDED', 'COLLABORATOR_REMOVED', 'RESPONSIBLE_CHANGED') AND "actionId" IS NULL AND "transitionId" IS NULL AND "participantChangeId" IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION "guard_support_incident_collaborator_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Support incident collaborators are historical.' USING ERRCODE = 'check_violation'; END IF;
  IF OLD."id" <> NEW."id" OR OLD."companyId" <> NEW."companyId" OR OLD."incidentId" <> NEW."incidentId" OR OLD."userId" <> NEW."userId"
    OR OLD."addedByUserId" <> NEW."addedByUserId" OR OLD."addedVersion" <> NEW."addedVersion" OR OLD."addedAt" <> NEW."addedAt"
    OR OLD."removedAt" IS NOT NULL OR NEW."removedAt" IS NULL OR NEW."removedByUserId" IS NULL OR NEW."removedVersion" IS NULL
  THEN RAISE EXCEPTION 'Invalid support collaborator mutation.' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "support_incident_collaborators_guard" BEFORE UPDATE OR DELETE ON "support_incident_collaborators" FOR EACH ROW EXECUTE FUNCTION "guard_support_incident_collaborator_mutation"();

CREATE OR REPLACE FUNCTION "reject_support_incident_participant_change_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Support incident participant changes are append-only.' USING ERRCODE = 'check_violation'; END;
$$;
CREATE TRIGGER "support_incident_participant_changes_append_only" BEFORE UPDATE OR DELETE ON "support_incident_participant_changes" FOR EACH ROW EXECUTE FUNCTION "reject_support_incident_participant_change_mutation"();

CREATE OR REPLACE FUNCTION "assert_support_incident_participant_consistency"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_incident_id UUID; target_company_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'support_incidents' THEN
    target_incident_id := NEW."id"; target_company_id := NEW."companyId";
    IF OLD."responsibleUserId" IS DISTINCT FROM NEW."responsibleUserId"
      AND (NEW."version" <> OLD."version" + 1 OR NOT EXISTS (
        SELECT 1 FROM "support_incident_participant_changes" change
        WHERE change."incidentId" = NEW."id" AND change."companyId" = NEW."companyId"
          AND change."changeType" = 'RESPONSIBLE_CHANGED' AND change."fromResponsibleId" = OLD."responsibleUserId"
          AND change."toResponsibleId" = NEW."responsibleUserId" AND change."resultingVersion" = NEW."version"
      ))
    THEN RAISE EXCEPTION 'A responsible change requires matching versioned evidence.' USING ERRCODE = 'check_violation'; END IF;
  ELSE
    target_incident_id := NEW."incidentId"; target_company_id := NEW."companyId";
  END IF;
  IF EXISTS (
    SELECT 1 FROM "support_incident_participant_changes" change
    WHERE change."incidentId" = target_incident_id AND change."companyId" = target_company_id
      AND NOT EXISTS (SELECT 1 FROM "support_incident_events" event WHERE event."participantChangeId" = change."id" AND event."companyId" = change."companyId" AND event."incidentId" = change."incidentId" AND event."actorUserId" = change."actorUserId" AND event."eventType" = change."changeType"::text AND event."resultingVersion" = change."resultingVersion")
  ) THEN RAISE EXCEPTION 'A support participant change requires one matching event.' USING ERRCODE = 'check_violation'; END IF;
  IF EXISTS (
    SELECT 1 FROM "support_incident_collaborators" collaborator
    WHERE collaborator."incidentId" = target_incident_id AND collaborator."companyId" = target_company_id
      AND (NOT EXISTS (SELECT 1 FROM "support_incident_participant_changes" change WHERE change."collaboratorId" = collaborator."id" AND change."changeType" = 'COLLABORATOR_ADDED' AND change."resultingVersion" = collaborator."addedVersion")
        OR (collaborator."removedAt" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "support_incident_participant_changes" change WHERE change."collaboratorId" = collaborator."id" AND change."changeType" = 'COLLABORATOR_REMOVED' AND change."resultingVersion" = collaborator."removedVersion")))
  ) THEN RAISE EXCEPTION 'Support collaborator state requires matching participant evidence.' USING ERRCODE = 'check_violation'; END IF;
  IF EXISTS (SELECT 1 FROM "support_incidents" incident JOIN "support_incident_collaborators" collaborator ON collaborator."incidentId" = incident."id" AND collaborator."companyId" = incident."companyId" AND collaborator."removedAt" IS NULL AND collaborator."userId" = incident."responsibleUserId" WHERE incident."id" = target_incident_id AND incident."companyId" = target_company_id)
  THEN RAISE EXCEPTION 'The responsible user cannot also be an active collaborator.' USING ERRCODE = 'check_violation'; END IF;
  IF EXISTS (SELECT 1 FROM "support_incident_participant_changes" change JOIN "support_incidents" incident ON incident."id" = change."incidentId" AND incident."companyId" = change."companyId" WHERE change."incidentId" = target_incident_id AND change."companyId" = target_company_id AND change."changeType" = 'RESPONSIBLE_CHANGED' AND change."resultingVersion" = incident."version" AND incident."responsibleUserId" <> change."toResponsibleId")
  THEN RAISE EXCEPTION 'The responsible projection does not match its evidence.' USING ERRCODE = 'check_violation'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "support_incident_participants_from_collaborator" AFTER INSERT OR UPDATE ON "support_incident_collaborators" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_support_incident_participant_consistency"();
CREATE CONSTRAINT TRIGGER "support_incident_participants_from_change" AFTER INSERT ON "support_incident_participant_changes" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_support_incident_participant_consistency"();
CREATE CONSTRAINT TRIGGER "support_incident_participants_from_event" AFTER INSERT ON "support_incident_events" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_support_incident_participant_consistency"();
CREATE CONSTRAINT TRIGGER "support_incident_participants_from_incident" AFTER UPDATE OF "responsibleUserId" ON "support_incidents" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_support_incident_participant_consistency"();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt") VALUES (gen_random_uuid(), 'Support.ManageParticipants', 'Gestionar colaboradores y responsable de incidencias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;
INSERT INTO "role_permissions" ("roleId", "permissionId") SELECT role."id", permission."id" FROM "roles" role CROSS JOIN "permissions" permission WHERE role."code" = 'Administrador' AND permission."code" = 'Support.ManageParticipants' ON CONFLICT DO NOTHING;

COMMIT;
