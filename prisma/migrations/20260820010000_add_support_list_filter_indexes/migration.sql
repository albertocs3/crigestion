CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "support_incidents_number_trgm_idx"
ON "support_incidents" USING GIN ("number" gin_trgm_ops);

CREATE INDEX "support_incidents_title_trgm_idx"
ON "support_incidents" USING GIN ("title" gin_trgm_ops);

CREATE INDEX "support_incidents_description_trgm_idx"
ON "support_incidents" USING GIN ("description" gin_trgm_ops);

CREATE INDEX "support_incidents_companyId_responsibleUserId_updatedAt_id_idx"
ON "support_incidents"("companyId", "responsibleUserId", "updatedAt", "id");

CREATE INDEX "support_incidents_companyId_categoryId_updatedAt_id_idx"
ON "support_incidents"("companyId", "categoryId", "updatedAt", "id");

CREATE INDEX "support_incidents_companyId_createdAt_id_idx"
ON "support_incidents"("companyId", "createdAt", "id");

CREATE INDEX "support_communications_companyId_contactId_occurredAt_id_idx"
ON "support_communications"("companyId", "contactId", "occurredAt", "id");

CREATE INDEX "support_communications_companyId_channel_occurredAt_id_idx"
ON "support_communications"("companyId", "channel", "occurredAt", "id");
