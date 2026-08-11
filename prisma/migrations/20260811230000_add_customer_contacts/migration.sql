BEGIN;

CREATE TYPE "CustomerContactStatus" AS ENUM ('ACTIVE', 'INACTIVE');

CREATE TABLE "customer_contacts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "customerId" UUID NOT NULL,
  "storeId" UUID,
  "name" VARCHAR(160),
  "role" VARCHAR(120),
  "phone" VARCHAR(40),
  "mobile" VARCHAR(40),
  "whatsapp" VARCHAR(40),
  "email" VARCHAR(254),
  "status" "CustomerContactStatus" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdById" UUID NOT NULL,
  "updatedById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_contacts_storeId_key" UNIQUE ("storeId"),
  CONSTRAINT "customer_contacts_id_customerId_key" UNIQUE ("id", "customerId"),
  CONSTRAINT "customer_contacts_storeId_customerId_key" UNIQUE ("storeId", "customerId"),
  CONSTRAINT "customer_contacts_content_check" CHECK (
    "version" > 0
    AND ("name" IS NOT NULL OR "phone" IS NOT NULL OR "mobile" IS NOT NULL OR "whatsapp" IS NOT NULL OR "email" IS NOT NULL)
    AND ("name" IS NULL OR length(btrim("name")) >= 2)
    AND ("role" IS NULL OR length(btrim("role")) >= 2)
    AND ("phone" IS NULL OR length(btrim("phone")) >= 3)
    AND ("mobile" IS NULL OR length(btrim("mobile")) >= 3)
    AND ("whatsapp" IS NULL OR length(btrim("whatsapp")) >= 3)
  ),
  CONSTRAINT "customer_contacts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "customer_contacts_storeId_customerId_fkey" FOREIGN KEY ("storeId", "customerId") REFERENCES "customer_stores"("id", "customerId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "customer_contacts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "customer_contacts_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "customer_contacts_one_general_per_customer_idx"
  ON "customer_contacts" ("customerId") WHERE "storeId" IS NULL;
CREATE INDEX "customer_contacts_customerId_status_name_id_idx" ON "customer_contacts"("customerId", "status", "name", "id");
CREATE INDEX "customer_contacts_createdById_createdAt_idx" ON "customer_contacts"("createdById", "createdAt");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "customer_stores"
    WHERE "contactRole" IS NOT NULL
      AND "contactName" IS NULL AND "contactPhone" IS NULL AND "contactMobile" IS NULL
      AND "contactWhatsapp" IS NULL AND "contactEmail" IS NULL
  ) THEN
    RAISE EXCEPTION 'Customer store contactRole requires an identifying contact field before migration.'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

INSERT INTO "customer_contacts" ("customerId", "name", "phone", "email", "createdById")
SELECT customer."id", NULL, customer."phone", customer."email", customer."createdById"
FROM "customers" customer
WHERE customer."phone" IS NOT NULL OR customer."email" IS NOT NULL;

INSERT INTO "customer_contacts" (
  "customerId", "storeId", "name", "role", "phone", "mobile", "whatsapp", "email", "createdById"
)
SELECT store."customerId", store."id", store."contactName", store."contactRole", store."contactPhone",
  store."contactMobile", store."contactWhatsapp", store."contactEmail", store."createdById"
FROM "customer_stores" store
WHERE store."contactName" IS NOT NULL OR store."contactPhone" IS NOT NULL OR store."contactMobile" IS NOT NULL
  OR store."contactWhatsapp" IS NOT NULL OR store."contactEmail" IS NOT NULL;

CREATE OR REPLACE FUNCTION "guard_customer_contact"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Customer contacts cannot be deleted.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."customerId" <> OLD."customerId" OR NEW."storeId" IS DISTINCT FROM OLD."storeId"
    OR NEW."createdById" <> OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'Customer contact identity is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Customer contact updates must increment one version.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "customer_contacts_guard" BEFORE UPDATE OR DELETE ON "customer_contacts"
FOR EACH ROW EXECUTE FUNCTION "guard_customer_contact"();

ALTER TABLE "support_communications" ADD COLUMN "contactId" UUID;
ALTER TABLE "support_communications" ADD CONSTRAINT "support_communications_contactId_customerId_fkey"
  FOREIGN KEY ("contactId", "customerId") REFERENCES "customer_contacts"("id", "customerId") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "support_communications_contactId_occurredAt_id_idx" ON "support_communications"("contactId", "occurredAt", "id");

ALTER TABLE "support_communication_corrections" ADD COLUMN "previousContactId" UUID;
ALTER TABLE "support_communication_corrections" ADD COLUMN "correctedContactId" UUID;

DROP TRIGGER "support_communication_correction_from_communication" ON "support_communications";
DROP TRIGGER "support_communication_correction_from_evidence" ON "support_communication_corrections";

CREATE OR REPLACE FUNCTION "assert_support_communication_correction"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE correction_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'support_communications' THEN
    IF NEW."version" <> OLD."version" + 1 THEN RAISE EXCEPTION 'A communication correction must increment one version.' USING ERRCODE = 'check_violation'; END IF;
    SELECT count(*) INTO correction_count FROM "support_communication_corrections" correction
    WHERE correction."communicationId" = NEW."id" AND correction."companyId" = NEW."companyId" AND correction."resultingVersion" = NEW."version"
      AND correction."previousChannel" = OLD."channel" AND correction."correctedChannel" = NEW."channel"
      AND correction."previousDirection" = OLD."direction" AND correction."correctedDirection" = NEW."direction"
      AND correction."previousOccurredAt" = OLD."occurredAt" AND correction."correctedOccurredAt" = NEW."occurredAt"
      AND correction."previousContactNumber" = OLD."contactNumber" AND correction."correctedContactNumber" = NEW."contactNumber"
      AND correction."previousDurationSeconds" IS NOT DISTINCT FROM OLD."durationSeconds" AND correction."correctedDurationSeconds" IS NOT DISTINCT FROM NEW."durationSeconds"
      AND correction."previousSummary" = OLD."summary" AND correction."correctedSummary" = NEW."summary"
      AND correction."previousResult" = OLD."result" AND correction."correctedResult" = NEW."result"
      AND correction."previousIncidentId" IS NOT DISTINCT FROM OLD."incidentId" AND correction."correctedIncidentId" IS NOT DISTINCT FROM NEW."incidentId"
      AND correction."previousContactId" IS NOT DISTINCT FROM OLD."contactId" AND correction."correctedContactId" IS NOT DISTINCT FROM NEW."contactId";
    IF correction_count <> 1 THEN RAISE EXCEPTION 'A communication update requires one exact correction.' USING ERRCODE = 'check_violation'; END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM "support_communications" communication WHERE communication."id" = NEW."communicationId" AND communication."companyId" = NEW."companyId" AND communication."version" = NEW."resultingVersion" AND communication."channel" = NEW."correctedChannel" AND communication."direction" = NEW."correctedDirection" AND communication."occurredAt" = NEW."correctedOccurredAt" AND communication."contactNumber" = NEW."correctedContactNumber" AND communication."durationSeconds" IS NOT DISTINCT FROM NEW."correctedDurationSeconds" AND communication."summary" = NEW."correctedSummary" AND communication."result" = NEW."correctedResult" AND communication."incidentId" IS NOT DISTINCT FROM NEW."correctedIncidentId" AND communication."contactId" IS NOT DISTINCT FROM NEW."correctedContactId")
    THEN RAISE EXCEPTION 'A correction must match the current communication projection.' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "support_communication_correction_from_communication"
AFTER UPDATE OF "channel", "direction", "occurredAt", "contactNumber", "durationSeconds", "summary", "result", "incidentId", "contactId", "version"
ON "support_communications" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_support_communication_correction"();
CREATE CONSTRAINT TRIGGER "support_communication_correction_from_evidence"
AFTER INSERT ON "support_communication_corrections" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assert_support_communication_correction"();

COMMIT;
