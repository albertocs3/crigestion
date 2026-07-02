CREATE INDEX "audit_events_createdAt_id_idx" ON "audit_events"("createdAt", "id");

CREATE INDEX "audit_events_eventType_createdAt_idx" ON "audit_events"("eventType", "createdAt");
