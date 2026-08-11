BEGIN;

CREATE TYPE "SupportIncidentPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
CREATE TYPE "SupportIncidentStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_THIRD_PARTY', 'RESOLVED', 'CLOSED');

ALTER TABLE "customer_stores"
  ADD CONSTRAINT "customer_stores_id_customerId_key" UNIQUE ("id", "customerId");

CREATE TABLE "support_incident_categories" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "normalizedName" VARCHAR(120) NOT NULL,
  "description" VARCHAR(500),
  "color" VARCHAR(7) NOT NULL DEFAULT '#475569',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_incident_categories_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_incident_categories_color_check" CHECK ("color" ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT "support_incident_categories_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_categories_companyId_normalizedName_key" UNIQUE ("companyId", "normalizedName"),
  CONSTRAINT "support_incident_categories_id_companyId_key" UNIQUE ("id", "companyId")
);

CREATE INDEX "support_incident_categories_companyId_isActive_name_id_idx"
  ON "support_incident_categories"("companyId", "isActive", "name", "id");

CREATE TABLE "support_incident_number_sequences" (
  "companyId" UUID NOT NULL,
  "year" INTEGER NOT NULL,
  "nextValue" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "support_incident_number_sequences_pkey" PRIMARY KEY ("companyId", "year"),
  CONSTRAINT "support_incident_number_sequences_year_check" CHECK ("year" BETWEEN 2000 AND 9999),
  CONSTRAINT "support_incident_number_sequences_next_value_check" CHECK ("nextValue" > 0),
  CONSTRAINT "support_incident_number_sequences_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "support_incidents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "year" INTEGER NOT NULL,
  "sequenceNumber" INTEGER NOT NULL,
  "number" VARCHAR(20) NOT NULL,
  "customerId" UUID NOT NULL,
  "storeId" UUID,
  "categoryId" UUID NOT NULL,
  "responsibleUserId" UUID NOT NULL,
  "createdById" UUID NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "description" VARCHAR(4000) NOT NULL,
  "priority" "SupportIncidentPriority" NOT NULL DEFAULT 'MEDIUM',
  "status" "SupportIncidentStatus" NOT NULL DEFAULT 'NEW',
  "version" INTEGER NOT NULL DEFAULT 1,
  "firstActionAt" TIMESTAMPTZ(3),
  "resolvedAt" TIMESTAMPTZ(3),
  "closedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_incidents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_incidents_sequence_check" CHECK ("year" BETWEEN 2000 AND 9999 AND "sequenceNumber" > 0),
  CONSTRAINT "support_incidents_version_check" CHECK ("version" > 0),
  CONSTRAINT "support_incidents_initial_timestamps_check" CHECK (
    ("status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL AND "closedAt" IS NULL)
    OR ("status" = 'CLOSED' AND "closedAt" IS NOT NULL)
    OR ("status" NOT IN ('RESOLVED', 'CLOSED') AND "resolvedAt" IS NULL AND "closedAt" IS NULL)
  ),
  CONSTRAINT "support_incidents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incidents_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incidents_storeId_customerId_fkey" FOREIGN KEY ("storeId", "customerId") REFERENCES "customer_stores"("id", "customerId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incidents_categoryId_companyId_fkey" FOREIGN KEY ("categoryId", "companyId") REFERENCES "support_incident_categories"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incidents_responsibleUserId_fkey" FOREIGN KEY ("responsibleUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incidents_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incidents_companyId_number_key" UNIQUE ("companyId", "number"),
  CONSTRAINT "support_incidents_companyId_year_sequenceNumber_key" UNIQUE ("companyId", "year", "sequenceNumber"),
  CONSTRAINT "support_incidents_id_companyId_key" UNIQUE ("id", "companyId")
);

CREATE INDEX "support_incidents_companyId_status_updatedAt_id_idx" ON "support_incidents"("companyId", "status", "updatedAt", "id");
CREATE INDEX "support_incidents_companyId_priority_status_updatedAt_id_idx" ON "support_incidents"("companyId", "priority", "status", "updatedAt", "id");
CREATE INDEX "support_incidents_companyId_responsibleUserId_status_updatedAt_id_idx" ON "support_incidents"("companyId", "responsibleUserId", "status", "updatedAt", "id");
CREATE INDEX "support_incidents_customerId_status_updatedAt_id_idx" ON "support_incidents"("customerId", "status", "updatedAt", "id");
CREATE INDEX "support_incidents_categoryId_status_updatedAt_id_idx" ON "support_incidents"("categoryId", "status", "updatedAt", "id");

CREATE TABLE "support_incident_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "eventType" VARCHAR(80) NOT NULL,
  "fromStatus" "SupportIncidentStatus",
  "toStatus" "SupportIncidentStatus",
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_incident_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_incident_events_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_events_incidentId_companyId_fkey" FOREIGN KEY ("incidentId", "companyId") REFERENCES "support_incidents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "support_incident_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "support_incident_events_incidentId_createdAt_id_idx" ON "support_incident_events"("incidentId", "createdAt", "id");
CREATE INDEX "support_incident_events_companyId_eventType_createdAt_id_idx" ON "support_incident_events"("companyId", "eventType", "createdAt", "id");

CREATE OR REPLACE FUNCTION "reject_support_incident_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Support incident events are append-only.' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "support_incident_events_append_only"
BEFORE UPDATE OR DELETE ON "support_incident_events"
FOR EACH ROW EXECUTE FUNCTION "reject_support_incident_event_mutation"();

CREATE OR REPLACE FUNCTION "assert_support_incident_created_event"()
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
  ELSE
    target_incident_id := NEW."incidentId";
    target_company_id := NEW."companyId";
  END IF;

  IF EXISTS (SELECT 1 FROM "support_incidents" WHERE "id" = target_incident_id AND "companyId" = target_company_id)
    AND NOT EXISTS (
      SELECT 1
      FROM "support_incidents" incident
      WHERE incident."id" = target_incident_id
        AND incident."companyId" = target_company_id
        AND (
          SELECT count(*)
          FROM "support_incident_events" event
          WHERE event."incidentId" = incident."id"
            AND event."companyId" = incident."companyId"
            AND event."eventType" = 'CREATED'
            AND event."fromStatus" IS NULL
            AND event."toStatus" = 'NEW'
            AND event."actorUserId" = incident."createdById"
        ) = 1
    )
  THEN
    RAISE EXCEPTION 'A support incident requires exactly one valid creation event.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "support_incident_requires_created_event"
AFTER INSERT ON "support_incidents"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_support_incident_created_event"();

CREATE CONSTRAINT TRIGGER "support_incident_event_consistency"
AFTER INSERT ON "support_incident_events"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_support_incident_created_event"();

INSERT INTO "permissions" ("id", "code", "name", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'Support.View', 'Consultar incidencias de atencion al cliente', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Support.Create', 'Crear incidencias de atencion al cliente', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Support.ManageCategories', 'Gestionar categorias de incidencias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
CROSS JOIN "permissions" permission
WHERE role."code" = 'Administrador'
  AND permission."code" IN ('Support.View', 'Support.Create', 'Support.ManageCategories')
ON CONFLICT DO NOTHING;

INSERT INTO "support_incident_categories" ("id", "companyId", "name", "normalizedName", "description", "color", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid(), company."id", 'General', 'general', 'Categoria inicial para incidencias sin clasificacion especifica.', '#475569', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "companies" company
ON CONFLICT ("companyId", "normalizedName") DO NOTHING;

COMMIT;
