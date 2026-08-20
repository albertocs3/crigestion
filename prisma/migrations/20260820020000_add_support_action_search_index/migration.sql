CREATE INDEX "support_incident_actions_text_trgm_idx"
ON "support_incident_actions" USING GIN ("text" gin_trgm_ops);
