import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { processNextDueSubscriptionReactivationSchedule } from "@/modules/subscriptions/application/reactivationSchedules";

describe("subscription reactivation automation retries", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries PostgreSQL 40001 surfaced through P2010", async () => {
    const fixture = mockDueCandidate();
    let attempts = 0;
    const transaction = vi.spyOn(prisma, "$transaction").mockImplementation((async () => {
      attempts += 1;
      if (attempts === 1) throw prismaError("P2010", { code: "40001" });
      return { outcome: "SKIPPED" as const, scheduleId: fixture.scheduleId };
    }) as never);

    await expect(processNextDueSubscriptionReactivationSchedule("retry-worker"))
      .resolves.toEqual({ outcome: "SKIPPED", scheduleId: fixture.scheduleId });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(fixture.candidates).toHaveBeenCalledTimes(2);
  });

  it("stops after three serialization conflicts", async () => {
    const fixture = mockDueCandidate();
    const error = prismaError("P2034");
    const transaction = vi.spyOn(prisma, "$transaction").mockRejectedValue(error);

    await expect(processNextDueSubscriptionReactivationSchedule("retry-worker-exhausted"))
      .rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(fixture.candidates).toHaveBeenCalledTimes(3);
  });

  it("does not retry unrelated database failures", async () => {
    const fixture = mockDueCandidate();
    const error = prismaError("P2003");
    const transaction = vi.spyOn(prisma, "$transaction").mockRejectedValue(error);

    await expect(processNextDueSubscriptionReactivationSchedule("retry-worker-fatal"))
      .rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(fixture.candidates).toHaveBeenCalledTimes(1);
  });
});

function mockDueCandidate() {
  const companyId = randomUUID();
  const scheduleId = randomUUID();
  const subscriptionId = randomUUID();
  vi.spyOn(prisma.installation, "findFirst").mockResolvedValue({ companyId } as never);
  const candidates = vi.spyOn(prisma, "$queryRaw")
    .mockResolvedValue([{ id: scheduleId, subscriptionId }] as never);
  return { candidates, scheduleId };
}

function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("Database conflict", {
    code,
    clientVersion: "test",
    meta
  });
}
