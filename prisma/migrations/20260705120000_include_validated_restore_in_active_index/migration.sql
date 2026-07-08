DROP INDEX "restore_operations_one_active_idx";

CREATE UNIQUE INDEX "restore_operations_one_active_idx"
ON "restore_operations" ((1))
WHERE "status" IN ('REQUESTED', 'VALIDATING', 'VALIDATED', 'PREPARING', 'RESTORING', 'VERIFYING');
