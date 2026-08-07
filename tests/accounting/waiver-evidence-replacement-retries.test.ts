import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requestWaiverEvidenceReplacement, runWaiverReplacementSerializable } from "@/modules/accounting/application/waiverEvidenceReplacements";

describe("waiver evidence replacement serializable retries", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries P2034 twice and returns the committed result", async () => {
    let attempts = 0;
    vi.spyOn(prisma, "$transaction").mockImplementation((async () => {
      attempts += 1;
      if (attempts < 3) throw prismaError("P2034");
      return { kind: "committed" as const };
    }) as never);

    await expect(runWaiverReplacementSerializable(async () => ({ kind: "unused" as const })))
      .resolves.toEqual({ kind: "committed" });
    expect(attempts).toBe(3);
  });

  it("returns a stable conflict after three serialization failures", async () => {
    const transaction = vi.spyOn(prisma, "$transaction").mockRejectedValue(prismaError("P2034"));

    await expect(runWaiverReplacementSerializable(async () => ({ kind: "unused" as const })))
      .resolves.toEqual({ kind: "transaction-busy" });
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("maps exhausted retries to the stable service contract without effects", async () => {
    const transaction = vi.spyOn(prisma, "$transaction").mockRejectedValue(prismaError("P2034"));
    const accountIds = [randomUUID(), randomUUID()];
    const result = await requestWaiverEvidenceReplacement(randomUUID(), {
      expectedReviewVersion: 4,
      reasonCode: "CORRECTED_AMOUNT",
      reasonDetail: "Corrección contable sometida a una carrera concurrente",
      accountingDate: "2026-08-07",
      concept: "Propuesta concurrente",
      lines: [
        { accountId: accountIds[0]!, concept: "Debe", debit: "1.00", credit: "0.00" },
        { accountId: accountIds[1]!, concept: "Haber", debit: "0.00", credit: "1.00" }
      ]
    }, {
      id: randomUUID(), displayName: "Revisor", userName: "reviewer",
      role: { code: "REVIEWER", name: "Revisor" }, permissions: ["Accounting.RequestWaiverEvidenceReplacements"]
    }, { idempotencyKey: randomUUID(), requestHash: "a".repeat(64), correlationId: "retry-exhausted" });

    expect(result).toEqual({ ok: false, status: 503, error: {
      code: "WAIVER_REPLACEMENT_BUSY", message: "La sustitución contable está ocupada; vuelva a intentarlo."
    } });
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("also retries PostgreSQL 40001 surfaced through raw SQL", async () => {
    let attempts = 0;
    vi.spyOn(prisma, "$transaction").mockImplementation((async () => {
      attempts += 1;
      if (attempts === 1) throw prismaError("P2010", { code: "40001" });
      return { kind: "committed" as const };
    }) as never);

    await expect(runWaiverReplacementSerializable(async () => ({ kind: "unused" as const })))
      .resolves.toEqual({ kind: "committed" });
    expect(attempts).toBe(2);
  });

  it("does not retry unrelated database failures", async () => {
    const error = prismaError("P2003");
    const transaction = vi.spyOn(prisma, "$transaction").mockRejectedValue(error);

    await expect(runWaiverReplacementSerializable(async () => ({ kind: "unused" as const }))).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("Database conflict", { code, clientVersion: "test", meta });
}
