-- CreateEnum
CREATE TYPE "RestoreOperationStatus" AS ENUM ('REQUESTED', 'VALIDATING', 'PREPARING', 'RESTORING', 'VERIFYING', 'COMPLETED', 'FAILED', 'REQUIRES_RECOVERY');

-- CreateTable
CREATE TABLE "restore_operations" (
    "id" UUID NOT NULL,
    "status" "RestoreOperationStatus" NOT NULL DEFAULT 'REQUESTED',
    "backupOperationId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "preRestoreBackupOperationId" UUID,
    "errorCode" VARCHAR(120),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "restore_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "restore_operations_status_requestedAt_idx" ON "restore_operations"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "restore_operations_requestedAt_id_idx" ON "restore_operations"("requestedAt", "id");

-- CreateIndex
CREATE INDEX "restore_operations_backupOperationId_requestedAt_idx" ON "restore_operations"("backupOperationId", "requestedAt");

-- CreateIndex
CREATE INDEX "restore_operations_requestedById_requestedAt_idx" ON "restore_operations"("requestedById", "requestedAt");

-- Enforce BKP-RN-010 for restore operations. Cross-table exclusion with
-- backup_operations is also checked in application transactions.
CREATE UNIQUE INDEX "restore_operations_one_active_idx"
ON "restore_operations" ((1))
WHERE "status" IN ('REQUESTED', 'VALIDATING', 'PREPARING', 'RESTORING', 'VERIFYING');

-- AddForeignKey
ALTER TABLE "restore_operations" ADD CONSTRAINT "restore_operations_backupOperationId_fkey" FOREIGN KEY ("backupOperationId") REFERENCES "backup_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restore_operations" ADD CONSTRAINT "restore_operations_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restore_operations" ADD CONSTRAINT "restore_operations_preRestoreBackupOperationId_fkey" FOREIGN KEY ("preRestoreBackupOperationId") REFERENCES "backup_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
