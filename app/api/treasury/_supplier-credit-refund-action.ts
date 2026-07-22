import { z } from "zod";
import { authorizeCustomerCreditMutation } from "@/app/api/treasury/_customer-credit-http";
import { idempotencyStorageKey, jsonResponse, validationError } from "@/modules/platform/application/http";
import { approveSupplierCreditRefund, cancelSupplierCreditRefund, hashSupplierCreditRefundAction, hashSupplierCreditRefundPost, postSupplierCreditRefund, postSupplierCreditRefundSchema } from "@/modules/treasury/application/supplierCredits";

const paramsSchema = z.object({ refundId: z.string().uuid() });
const emptyBodySchema = z.object({}).strict();
type RefundAction = "approve" | "post" | "cancel";

export async function runSupplierCreditRefundAction(request: Request, context: { params: Promise<{ refundId: string }> }, action: RefundAction): Promise<Response> {
  const permission = action === "approve" ? "Treasury.ApproveSupplierRefunds" : action === "post" ? "Treasury.PostSupplierRefunds" : "Treasury.RequestSupplierRefunds";
  const authorization = await authorizeCustomerCreditMutation(request, permission);
  if (!authorization.ok) return authorization.response;
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });
  if (action === "post") {
    const payload = postSupplierCreditRefundSchema.safeParse(authorization.body);
    if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
    const result = await postSupplierCreditRefund(params.data.refundId, payload.data, authorization.user, { correlationId: authorization.correlationId, idempotencyKey: idempotencyStorageKey(authorization.user.id, "supplier-credit-refund-post", params.data.refundId, authorization.clientIdempotencyKey), requestHash: hashSupplierCreditRefundPost(params.data.refundId, payload.data) });
    return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status });
  }
  const payload = emptyBodySchema.safeParse(authorization.body);
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  const service = action === "approve" ? approveSupplierCreditRefund : cancelSupplierCreditRefund;
  const result = await service(params.data.refundId, authorization.user, { correlationId: authorization.correlationId, idempotencyKey: idempotencyStorageKey(authorization.user.id, `supplier-credit-refund-${action}`, params.data.refundId, authorization.clientIdempotencyKey), requestHash: hashSupplierCreditRefundAction(params.data.refundId, action) });
  return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status });
}
