const treasuryDestinations = [
  { permission: "Treasury.ManagePayments", href: "/app/treasury" },
  { permission: "Treasury.ViewSupplierPayments", href: "/app/treasury/supplier-payments" },
  { permission: "Treasury.ViewCustomerCredits", href: "/app/treasury/credits" },
  { permission: "Treasury.ViewSupplierCredits", href: "/app/treasury/supplier-credits" },
  { permission: "Treasury.ViewBanking", href: "/app/treasury/banking" },
  { permission: "Treasury.ImportBankStatements", href: "/app/treasury/banking/import" }
] as const;

export function resolveTreasuryHomeHref(permissions: readonly string[]): string | null {
  const grantedPermissions = new Set(permissions);
  return (
    treasuryDestinations.find(({ permission }) => grantedPermissions.has(permission))?.href ??
    null
  );
}
