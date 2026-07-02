-- CreateEnum
CREATE TYPE "BackupOperationStatus" AS ENUM ('REQUESTED', 'RUNNING', 'VERIFIED', 'FAILED');

-- CreateTable
CREATE TABLE "backup_operations" (
    "id" UUID NOT NULL,
    "status" "BackupOperationStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedById" UUID NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "productVersion" VARCHAR(32) NOT NULL,
    "storageKey" VARCHAR(500),
    "sizeBytes" BIGINT,
    "sha256" CHAR(64),
    "errorCode" VARCHAR(120),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "backup_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backup_operations_status_requestedAt_idx" ON "backup_operations"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "backup_operations_requestedAt_id_idx" ON "backup_operations"("requestedAt", "id");

-- CreateIndex
CREATE INDEX "backup_operations_requestedById_requestedAt_idx" ON "backup_operations"("requestedById", "requestedAt");

-- AddForeignKey
ALTER TABLE "backup_operations" ADD CONSTRAINT "backup_operations_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
