-- Add a non-destructive validation checkpoint for restore requests.
ALTER TYPE "RestoreOperationStatus" ADD VALUE 'VALIDATED';

ALTER TABLE "restore_operations"
ADD COLUMN "validatedAt" TIMESTAMPTZ(3);

DROP INDEX "restore_operations_one_active_idx";

CREATE UNIQUE INDEX "restore_operations_one_active_idx"
ON "restore_operations" ((1))
WHERE "status" IN ('REQUESTED', 'VALIDATING', 'PREPARING', 'RESTORING', 'VERIFYING');
