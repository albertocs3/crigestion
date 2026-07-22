import { runSupplierCreditRefundAction } from "@/app/api/treasury/_supplier-credit-refund-action";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ refundId: string }> }) { return runSupplierCreditRefundAction(request, context, "approve"); }
