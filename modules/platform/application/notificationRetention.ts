import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const purgeCommandSchema = z.object({
  batchNumber: z.number().int().positive(),
  batchSize: z.number().int().min(1).max(1_000),
  workerId: z.string().trim().min(1).max(120),
}).strict();

export type NotificationPurgeResult = {
  outcome: "IDLE" | "PURGED";
  asOf: string;
  notificationCount: number;
  stateChangeCount: number;
  idempotencyRecordCount: number;
  hasMore: boolean;
};

type PurgeRow = {
  asOf: Date;
  notificationCount: number;
  stateChangeCount: number;
  idempotencyRecordCount: number;
  hasMore: boolean;
};

export async function purgeExpiredNotificationBatch(
  input: z.input<typeof purgeCommandSchema>,
): Promise<NotificationPurgeResult> {
  const command = purgeCommandSchema.parse(input);
  const [row] = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT set_config('lock_timeout', ${"2s"}, true)`);
    await tx.$queryRaw(Prisma.sql`SELECT set_config('statement_timeout', ${"30s"}, true)`);
    return tx.$queryRaw<PurgeRow[]>(Prisma.sql`
      SELECT
        "asOf",
        "notificationCount",
        "stateChangeCount",
        "idempotencyRecordCount",
        "hasMore"
      FROM "purge_expired_notifications"(
        ${command.batchSize}::integer,
        ${command.batchNumber}::integer,
        ${command.workerId}
      )
    `);
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 5_000,
    timeout: 45_000,
  });
  if (!row) throw new Error("NOTIFICATION_PURGE_RESULT_MISSING");
  return {
    outcome: row.notificationCount === 0 ? "IDLE" : "PURGED",
    asOf: row.asOf.toISOString(),
    notificationCount: row.notificationCount,
    stateChangeCount: row.stateChangeCount,
    idempotencyRecordCount: row.idempotencyRecordCount,
    hasMore: row.hasMore,
  };
}
