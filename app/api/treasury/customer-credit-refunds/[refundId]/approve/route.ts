import { runCustomerCreditRefundAction } from "@/app/api/treasury/_customer-credit-refund-action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ refundId: string }> }) {
  return runCustomerCreditRefundAction(request, context, "approve");
}
