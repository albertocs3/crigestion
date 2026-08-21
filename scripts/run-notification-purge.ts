import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { purgeExpiredNotificationBatch } from "../modules/platform/application/notificationRetention";

function readInteger(name: string, fallback: number, maximum: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name}_INVALID`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const batchSize = readInteger("NOTIFICATION_PURGE_BATCH_SIZE", 500, 1_000);
  const maxBatches = readInteger("NOTIFICATION_PURGE_MAX_BATCHES", 10, 100);
  const host = (process.env.HOSTNAME ?? "host").slice(0, 60);
  const workerId = `notification-purge-${host}-${randomUUID()}`;
  const summary = { batches: 0, notifications: 0, stateChanges: 0, idempotencyRecords: 0 };
  let backlogRemains = false;

  for (let batchNumber = 1; batchNumber <= maxBatches; batchNumber += 1) {
    const result = await purgeExpiredNotificationBatch({ batchNumber, batchSize, workerId });
    if (result.outcome === "IDLE") break;
    summary.batches += 1;
    summary.notifications += result.notificationCount;
    summary.stateChanges += result.stateChangeCount;
    summary.idempotencyRecords += result.idempotencyRecordCount;
    backlogRemains = result.hasMore;
    if (!backlogRemains) break;
  }

  if (backlogRemains) throw new Error("NOTIFICATION_PURGE_BACKLOG_REMAINS");

  console.log(JSON.stringify({ event: "NOTIFICATION_PURGE_AUTOMATION_OK", ...summary }));
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error: unknown) => {
    const stableCode = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "NOTIFICATION_PURGE_AUTOMATION_FAILED";
    console.error(JSON.stringify({ event: "NOTIFICATION_PURGE_AUTOMATION_FAILED", stableCode }));
    process.exit(1);
  });
