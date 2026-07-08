import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  calculateInvoiceLine,
  calculateInvoiceTaxSummaries,
  calculateInvoiceTotals
} from "@/modules/billing/application/calculations";

describe("billing calculations", () => {
  it("calculates line discounts, VAT and totals with money rounding per line", () => {
    const result = calculateInvoiceLine({
      quantity: "2.500",
      unitPrice: "19.99",
      discountPercent: "10.00",
      discountAmount: "1.00",
      taxRate: "21.00"
    });

    expect(result.lineSubtotal.toFixed(2)).toBe("49.98");
    expect(result.lineDiscountTotal.toFixed(2)).toBe("6.00");
    expect(result.lineTaxableBase.toFixed(2)).toBe("43.98");
    expect(result.lineTaxAmount.toFixed(2)).toBe("9.24");
    expect(result.lineTotal.toFixed(2)).toBe("53.22");
  });

  it("groups tax summaries and totals by tax rate", () => {
    const lines = [
      {
        taxRateCode: "IVA_21",
        taxRate: new Prisma.Decimal("21.00"),
        ...calculateInvoiceLine({
          quantity: "1.000",
          unitPrice: "100.00",
          taxRate: "21.00"
        })
      },
      {
        taxRateCode: "IVA_21",
        taxRate: new Prisma.Decimal("21.00"),
        ...calculateInvoiceLine({
          quantity: "1.000",
          unitPrice: "50.00",
          taxRate: "21.00"
        })
      },
      {
        taxRateCode: "IVA_0",
        taxRate: new Prisma.Decimal("0.00"),
        ...calculateInvoiceLine({
          quantity: "1.000",
          unitPrice: "10.00",
          taxRate: "0.00"
        })
      }
    ];
    const totals = calculateInvoiceTotals(lines);
    const summaries = calculateInvoiceTaxSummaries(lines);

    expect(totals.total.toFixed(2)).toBe("191.50");
    expect(summaries).toHaveLength(2);
    expect(summaries.map((summary) => ({
      code: summary.taxRateCode,
      base: summary.taxableBase.toFixed(2),
      tax: summary.taxAmount.toFixed(2),
      total: summary.total.toFixed(2)
    }))).toEqual([
      {
        code: "IVA_0",
        base: "10.00",
        tax: "0.00",
        total: "10.00"
      },
      {
        code: "IVA_21",
        base: "150.00",
        tax: "31.50",
        total: "181.50"
      }
    ]);
  });
});
