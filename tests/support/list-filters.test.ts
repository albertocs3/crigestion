import { describe, expect, it } from "vitest";
import { madridDateRange, supportDateOnlySchema } from "@/modules/support/application/listFilters";
import { listSupportIncidentsSchema } from "@/modules/support/application/incidents";
import { listSupportCommunicationsSchema } from "@/modules/support/application/communications";

describe("support list date filters", () => {
  it("uses the 23-hour Madrid spring DST day as a half-open UTC range", () => {
    const range = madridDateRange("2026-03-29", "2026-03-29");
    expect(range.gte.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(range.lt.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(range.lt.getTime() - range.gte.getTime()).toBe(23 * 60 * 60 * 1_000);
  });

  it("uses the 25-hour Madrid autumn DST day as a half-open UTC range", () => {
    const range = madridDateRange("2026-10-25", "2026-10-25");
    expect(range.gte.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(range.lt.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(range.lt.getTime() - range.gte.getTime()).toBe(25 * 60 * 60 * 1_000);
  });

  it("accepts 366 inclusive days and rejects 367 or incomplete ranges", () => {
    expect(listSupportIncidentsSchema.safeParse({ createdFrom: "2025-01-01", createdTo: "2026-01-01" }).success).toBe(true);
    expect(listSupportIncidentsSchema.safeParse({ createdFrom: "2025-01-01", createdTo: "2026-01-02" }).success).toBe(false);
    expect(listSupportCommunicationsSchema.safeParse({ occurredFrom: "2026-01-01" }).success).toBe(false);
    expect(supportDateOnlySchema.safeParse("2026-02-30").success).toBe(false);
  });
});
