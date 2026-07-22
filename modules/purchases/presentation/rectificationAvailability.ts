type PurchaseRectificationState = {
  documentType: string;
  status: string;
  paymentStatus: string;
  rectificationInvoices: unknown[];
  dueDates: Array<{
    amount: string;
    allocatedAmount: string;
    creditedAmount: string;
    pendingAmount: string;
    status: string;
  }>;
};

export function getPurchaseRectificationAvailability(purchase: PurchaseRectificationState) {
  const hasSettlementActivity = purchase.dueDates.some(
    (dueDate) => Number(dueDate.allocatedAmount) > 0 || Number(dueDate.creditedAmount) > 0
  );
  const isFullyPaid = purchase.paymentStatus === "PAID"
    && purchase.dueDates.length > 0
    && purchase.dueDates.every(
      (dueDate) => dueDate.status === "PAID"
        && dueDate.pendingAmount === "0.00"
        && dueDate.creditedAmount === "0.00"
        && dueDate.allocatedAmount === dueDate.amount
    );
  const isStructurallyRectifiable = purchase.documentType === "STANDARD"
    && purchase.status === "REGISTERED"
    && purchase.rectificationInvoices.length === 0;
  const isUnpaid = purchase.paymentStatus === "PENDING" && !hasSettlementActivity;

  return {
    available: isStructurallyRectifiable && (isUnpaid || isFullyPaid),
    createsSupplierCredit: isStructurallyRectifiable && isFullyPaid,
    hasSettlementActivity
  };
}
