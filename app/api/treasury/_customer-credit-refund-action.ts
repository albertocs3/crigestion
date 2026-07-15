import { z } from "zod";
import { authorizeCustomerCreditMutation } from "@/app/api/treasury/_customer-credit-http";
import { idempotencyStorageKey, jsonResponse, validationError } from "@/modules/platform/application/http";
import {
  approveCustomerCreditRefund,
  cancelCustomerCreditRefund,
  hashCustomerCreditRefundAction,
  postCustomerCreditRefund
} from "@/modules/treasury/application/customerCredits";

const paramsSchema = z.object({ refundId: z.string().uuid() });
const emptyBodySchema = z.object({}).strict();
type RefundAction = "approve" | "post" | "cancel";

const configuration = {
  approve: { permission: "Treasury.ApproveCustomerRefunds", service: approveCustomerCreditRefund },
  post: { permission: "Treasury.PostCustomerRefunds", service: postCustomerCreditRefund },
  cancel: { permission: "Treasury.RequestCustomerRefunds", service: cancelCustomerCreditRefund }
} as const;

export async function runCustomerCreditRefundAction(
  request: Request,
  context: { params: Promise<{ refundId: string }> },
  action: RefundAction
): Promise<Response> {
  const selected = configuration[action];
  const authorization = await authorizeCustomerCreditMutation(request, selected.permission);
  if (!authorization.ok) return authorization.response;
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });
  const payload = emptyBodySchema.safeParse(authorization.body);
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });

  const result = await selected.service(params.data.refundId, authorization.user, {
    correlationId: authorization.correlationId,
    idempotencyKey: idempotencyStorageKey(authorization.user.id, `customer-credit-refund-${action}`, params.data.refundId, authorization.clientIdempotencyKey),
    requestHash: hashCustomerCreditRefundAction(params.data.refundId, action)
  });
  return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status });
}
