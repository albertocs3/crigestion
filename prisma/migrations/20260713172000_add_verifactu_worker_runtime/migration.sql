BEGIN;

CREATE TYPE "VerifactuWorkerStatus" AS ENUM ('RUNNING', 'STOPPING', 'STOPPED', 'FAILED');

CREATE TABLE "verifactu_worker_runs" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "workerId" VARCHAR(160) NOT NULL,
    "environment" "VerifactuEnvironment" NOT NULL,
    "status" "VerifactuWorkerStatus" NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "heartbeatAt" TIMESTAMPTZ(3) NOT NULL,
    "lastPollAt" TIMESTAMPTZ(3),
    "lastProcessedAt" TIMESTAMPTZ(3),
    "stoppedAt" TIMESTAMPTZ(3),
    "lastOutcome" "VerifactuAttemptOutcome",
    "lastErrorCode" VARCHAR(120),
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "idleCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "leaseLostCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verifactu_worker_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "verifactu_worker_runs_worker_id_check" CHECK (length("workerId") BETWEEN 1 AND 160),
    CONSTRAINT "verifactu_worker_runs_counter_check" CHECK ("processedCount" >= 0 AND "idleCount" >= 0 AND "errorCount" >= 0 AND "leaseLostCount" >= 0),
    CONSTRAINT "verifactu_worker_runs_heartbeat_check" CHECK ("heartbeatAt" >= "startedAt"),
    CONSTRAINT "verifactu_worker_runs_stop_check" CHECK (
      ("status" IN ('STOPPED', 'FAILED') AND "stoppedAt" IS NOT NULL)
      OR ("status" IN ('RUNNING', 'STOPPING') AND "stoppedAt" IS NULL)
    ),
    CONSTRAINT "verifactu_worker_runs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "verifactu_worker_runs_workerId_key" ON "verifactu_worker_runs"("workerId");

CREATE INDEX "verifactu_worker_runs_companyId_environment_status_heartbeatAt_idx"
  ON "verifactu_worker_runs"("companyId", "environment", "status", "heartbeatAt");

CREATE INDEX "verifactu_worker_runs_heartbeatAt_idx" ON "verifactu_worker_runs"("heartbeatAt");

COMMIT;
