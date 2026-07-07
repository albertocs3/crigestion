import { describe, expect, it } from "vitest";
import { normalizeDateInputValue } from "@/modules/billing/presentation/dateInput";

describe("normalizeDateInputValue", () => {
  it("keeps API date format untouched", () => {
    expect(normalizeDateInputValue("2026-07-07")).toBe("2026-07-07");
  });

  it("normalizes Spanish date format for API payloads", () => {
    expect(normalizeDateInputValue("07/07/2026")).toBe("2026-07-07");
  });
});
