CREATE TYPE "PlatformMaintenanceMode" AS ENUM ('RESTORE');

CREATE TABLE "platform_maintenance_state" (
    "id" UUID NOT NULL,
    "singletonKey" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" "PlatformMaintenanceMode",
    "reason" VARCHAR(500),
    "restoreOperationId" UUID,
    "enabledById" UUID,
    "disabledById" UUID,
    "enabledAt" TIMESTAMPTZ(3),
    "disabledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_maintenance_state_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_maintenance_state_singletonKey_key" ON "platform_maintenance_state"("singletonKey");
CREATE INDEX "platform_maintenance_state_enabled_mode_idx" ON "platform_maintenance_state"("enabled", "mode");
CREATE INDEX "platform_maintenance_state_restoreOperationId_idx" ON "platform_maintenance_state"("restoreOperationId");

ALTER TABLE "platform_maintenance_state" ADD CONSTRAINT "platform_maintenance_state_restoreOperationId_fkey" FOREIGN KEY ("restoreOperationId") REFERENCES "restore_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_maintenance_state" ADD CONSTRAINT "platform_maintenance_state_enabledById_fkey" FOREIGN KEY ("enabledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_maintenance_state" ADD CONSTRAINT "platform_maintenance_state_disabledById_fkey" FOREIGN KEY ("disabledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
