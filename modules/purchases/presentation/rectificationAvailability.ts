type PurchaseRectificationState = {
  documentType: string;
  status: string;
  paymentStatus: string;
  rectificationInvoices: Array<{ rectificationMode?: string | null }>;
  lines?: Array<{ remainingRectifiableQuantity?: string }>;
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
  const hasFullRectification = purchase.rectificationInvoices.some((invoice) => invoice.rectificationMode === "FULL");
  const hasRemainingQuantity = purchase.lines?.some((line) => Number(line.remainingRectifiableQuantity ?? 0) > 0) ?? true;
  const isUnpaid = purchase.paymentStatus === "PENDING" && !hasSettlementActivity;
  const fullAvailable = isStructurallyRectifiable && (isUnpaid || isFullyPaid);
  const partialAvailable = purchase.documentType === "STANDARD"
    && purchase.status === "REGISTERED"
    && !hasFullRectification
    && hasRemainingQuantity;

  return {
    available: fullAvailable,
    fullAvailable,
    partialAvailable,
    createsSupplierCredit: isStructurallyRectifiable && isFullyPaid,
    hasSettlementActivity
  };
}

export function getPurchaseCorrectionAvailability(purchase: PurchaseRectificationState) {
  const rectification = getPurchaseRectificationAvailability(purchase);
  return {
    available: rectification.available && purchase.paymentStatus === "PENDING" && !rectification.hasSettlementActivity
  };
}
