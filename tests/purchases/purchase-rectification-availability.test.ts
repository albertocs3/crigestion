import { describe, expect, it } from "vitest";
import { getPurchaseRectificationAvailability } from "@/modules/purchases/presentation/rectificationAvailability";

const basePurchase = {
  documentType: "STANDARD",
  status: "REGISTERED",
  paymentStatus: "PENDING",
  rectificationInvoices: [],
  dueDates: [{
    amount: "36.30",
    allocatedAmount: "0.00",
    creditedAmount: "0.00",
    pendingAmount: "36.30",
    status: "PENDING"
  }]
};

describe("purchase rectification availability", () => {
  it("allows an unpaid purchase without settlement activity", () => {
    expect(getPurchaseRectificationAvailability(basePurchase)).toMatchObject({
      available: true,
      createsSupplierCredit: false
    });
  });

  it("allows a coherent fully paid purchase and exposes the supplier credit effect", () => {
    expect(getPurchaseRectificationAvailability({
      ...basePurchase,
      paymentStatus: "PAID",
      dueDates: [{
        ...basePurchase.dueDates[0],
        allocatedAmount: "36.30",
        pendingAmount: "0.00",
        status: "PAID"
      }]
    })).toMatchObject({
      available: true,
      createsSupplierCredit: true
    });
  });

  it("keeps partial and credit-settled purchases unavailable", () => {
    expect(getPurchaseRectificationAvailability({
      ...basePurchase,
      paymentStatus: "PARTIALLY_PAID",
      dueDates: [{ ...basePurchase.dueDates[0], allocatedAmount: "10.00", pendingAmount: "26.30" }]
    }).available).toBe(false);
    expect(getPurchaseRectificationAvailability({
      ...basePurchase,
      paymentStatus: "SETTLED",
      dueDates: [{ ...basePurchase.dueDates[0], creditedAmount: "36.30", pendingAmount: "0.00", status: "SETTLED" }]
    }).available).toBe(false);
  });
});
