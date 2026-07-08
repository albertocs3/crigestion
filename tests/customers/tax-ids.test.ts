import { describe, expect, it } from "vitest";
import {
  isValidSpanishTaxId,
  normalizeSpanishTaxId
} from "@/modules/customers/application/taxIds";

describe("Spanish tax id validation", () => {
  it("validates DNI identifiers", () => {
    expect(isValidSpanishTaxId("00000000T")).toBe(true);
    expect(isValidSpanishTaxId("00000001R")).toBe(true);
    expect(isValidSpanishTaxId("00000001T")).toBe(false);
  });

  it("validates NIE identifiers", () => {
    expect(isValidSpanishTaxId("X0000000T")).toBe(true);
    expect(isValidSpanishTaxId("Y0000000Z")).toBe(true);
    expect(isValidSpanishTaxId("Z0000000M")).toBe(true);
    expect(isValidSpanishTaxId("X0000000R")).toBe(false);
  });

  it("validates CIF identifiers", () => {
    expect(isValidSpanishTaxId("B12345674")).toBe(true);
    expect(isValidSpanishTaxId("P2345678C")).toBe(true);
    expect(isValidSpanishTaxId("B12345678")).toBe(false);
  });

  it("normalizes separators and casing", () => {
    expect(normalizeSpanishTaxId(" b-12345674 ")).toBe("B12345674");
    expect(isValidSpanishTaxId(" b 12345674 ")).toBe(true);
  });
});
