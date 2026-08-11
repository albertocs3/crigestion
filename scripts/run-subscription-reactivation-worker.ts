import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { processNextDueSubscriptionReactivationSchedule } from "../modules/subscriptions/application/reactivationSchedules";

function readBatchSize(): number {
  const raw = process.env.SUBSCRIPTION_REACTIVATION_AUTOMATION_BATCH_SIZE ?? "25";
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("SUBSCRIPTION_REACTIVATION_AUTOMATION_BATCH_SIZE_INVALID");
  }
  return parsed;
}

async function main(): Promise<void> {
  const host = (process.env.HOSTNAME ?? "host").slice(0, 80);
  const workerId = `subscription-reactivation-${host}-${randomUUID()}`;
  const batchSize = readBatchSize();
  const summary = { applied: 0, blocked: 0, skipped: 0 };

  for (let index = 0; index < batchSize; index += 1) {
    const result = await processNextDueSubscriptionReactivationSchedule(workerId);
    if (result.outcome === "IDLE") break;
    if (result.outcome === "APPLIED") summary.applied += 1;
    else if (result.outcome === "BLOCKED") summary.blocked += 1;
    else summary.skipped += 1;
  }

  console.log(JSON.stringify({ event: "SUBSCRIPTION_REACTIVATION_AUTOMATION_OK", ...summary }));
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error: unknown) => {
    const stableCode = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "SUBSCRIPTION_REACTIVATION_AUTOMATION_FAILED";
    console.error(JSON.stringify({ event: "SUBSCRIPTION_REACTIVATION_AUTOMATION_FAILED", stableCode }));
    process.exit(1);
  });
