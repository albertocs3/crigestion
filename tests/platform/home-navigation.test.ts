import { describe, expect, it } from "vitest";
import { resolveTreasuryHomeHref } from "@/modules/platform/presentation/homeNavigation";

describe("home treasury navigation", () => {
  it("routes the general treasury role through the treasury overview", () => {
    expect(resolveTreasuryHomeHref(["Treasury.ManagePayments"])).toBe("/app/treasury");
  });

  it("routes minimal read roles directly to a page they can access", () => {
    expect(resolveTreasuryHomeHref(["Treasury.ViewSupplierPayments"])).toBe(
      "/app/treasury/supplier-payments"
    );
    expect(resolveTreasuryHomeHref(["Treasury.ViewCustomerCredits"])).toBe(
      "/app/treasury/credits"
    );
    expect(resolveTreasuryHomeHref(["Treasury.ViewSupplierCredits"])).toBe(
      "/app/treasury/supplier-credits"
    );
    expect(resolveTreasuryHomeHref(["Treasury.ViewBanking"])).toBe(
      "/app/treasury/banking"
    );
    expect(resolveTreasuryHomeHref(["Treasury.ImportBankStatements"])).toBe(
      "/app/treasury/banking/import"
    );
  });

  it("uses a stable priority for combined roles", () => {
    expect(
      resolveTreasuryHomeHref([
        "Treasury.ViewSupplierCredits",
        "Treasury.ManagePayments"
      ])
    ).toBe("/app/treasury");
    expect(
      resolveTreasuryHomeHref([
        "Treasury.ViewSupplierCredits",
        "Treasury.ViewSupplierPayments"
      ])
    ).toBe("/app/treasury/supplier-payments");
    expect(
      resolveTreasuryHomeHref([
        "Treasury.ViewSupplierPayments",
        "Treasury.ViewSupplierCredits"
      ])
    ).toBe("/app/treasury/supplier-payments");
  });

  it("does not expose treasury navigation for action-only permissions", () => {
    expect(resolveTreasuryHomeHref(["Treasury.ApproveSupplierRefunds"])).toBeNull();
    expect(resolveTreasuryHomeHref(["Treasury.ManageSupplierPayments"])).toBeNull();
  });
});
