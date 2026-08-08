import { describe, expect, it } from "vitest";
import { normalizeOptionalCreditSearch } from "@/modules/treasury/presentation/creditFilters";

describe("credit filters", () => {
  it.each([undefined, "", "   "])("omits an empty search value (%s)", (value) => {
    expect(normalizeOptionalCreditSearch(value)).toBeUndefined();
  });

  it("trims a populated search value", () => {
    expect(normalizeOptionalCreditSearch("  UAT-PARTIAL  ")).toBe("UAT-PARTIAL");
  });
});
