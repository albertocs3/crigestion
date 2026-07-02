-- Enforce BKP-RN-010 at database level: only one incompatible backup
-- operation can be active at the same time.
CREATE UNIQUE INDEX "backup_operations_one_active_idx"
ON "backup_operations" ((1))
WHERE "status" IN ('REQUESTED', 'RUNNING');
