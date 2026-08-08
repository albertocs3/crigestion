import { describe, expect, it } from "vitest";
import { getPurchaseCorrectionAvailability, getPurchaseRectificationAvailability } from "@/modules/purchases/presentation/rectificationAvailability";

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
      fullAvailable: true,
      partialAvailable: true,
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

  it("keeps full rectification unavailable but permits partial returns after settlement activity", () => {
    expect(getPurchaseRectificationAvailability({
      ...basePurchase,
      paymentStatus: "PARTIALLY_PAID",
      dueDates: [{ ...basePurchase.dueDates[0], allocatedAmount: "10.00", pendingAmount: "26.30" }]
    })).toMatchObject({ fullAvailable: false, partialAvailable: true });
    expect(getPurchaseRectificationAvailability({
      ...basePurchase,
      paymentStatus: "SETTLED",
      dueDates: [{ ...basePurchase.dueDates[0], creditedAmount: "36.30", pendingAmount: "0.00", status: "SETTLED" }]
    })).toMatchObject({ fullAvailable: false, partialAvailable: true });
  });

  it("blocks partial returns after a full rectification or when all quantities are exhausted", () => {
    expect(getPurchaseRectificationAvailability({ ...basePurchase, rectificationInvoices: [{ rectificationMode: "FULL" }] }).partialAvailable).toBe(false);
    expect(getPurchaseRectificationAvailability({ ...basePurchase, lines: [{ remainingRectifiableQuantity: "0.000" }] }).partialAvailable).toBe(false);
  });
});

describe("purchase internal correction availability", () => {
  it("allows only an unpaid registered standard purchase without settlement activity", () => {
    expect(getPurchaseCorrectionAvailability(basePurchase)).toEqual({ available: true });
    expect(getPurchaseCorrectionAvailability({ ...basePurchase, paymentStatus: "PAID", dueDates: [{ ...basePurchase.dueDates[0]!, status: "PAID", allocatedAmount: "36.30", pendingAmount: "0.00" }] })).toEqual({ available: false });
    expect(getPurchaseCorrectionAvailability({ ...basePurchase, dueDates: [{ ...basePurchase.dueDates[0]!, creditedAmount: "1.00", pendingAmount: "35.30" }] })).toEqual({ available: false });
    expect(getPurchaseCorrectionAvailability({ ...basePurchase, status: "RECTIFIED", rectificationInvoices: [{}] })).toEqual({ available: false });
    expect(getPurchaseCorrectionAvailability({ ...basePurchase, status: "VOIDED" })).toEqual({ available: false });
  });
});
