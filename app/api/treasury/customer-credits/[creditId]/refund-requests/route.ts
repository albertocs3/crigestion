import { z } from "zod";
import { authorizeCustomerCreditMutation } from "@/app/api/treasury/_customer-credit-http";
import { idempotencyStorageKey, jsonResponse, validationError } from "@/modules/platform/application/http";
import { hashCustomerCreditRefundRequest, requestCustomerCreditRefund, requestCustomerCreditRefundSchema } from "@/modules/treasury/application/customerCredits";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const paramsSchema = z.object({ creditId: z.string().uuid() });

export async function POST(request: Request, context: { params: Promise<{ creditId: string }> }) {
  const authorization = await authorizeCustomerCreditMutation(request, "Treasury.RequestCustomerRefunds");
  if (!authorization.ok) return authorization.response;
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });
  const payload = requestCustomerCreditRefundSchema.safeParse(authorization.body);
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });

  const result = await requestCustomerCreditRefund(params.data.creditId, payload.data, authorization.user, {
    correlationId: authorization.correlationId,
    idempotencyKey: idempotencyStorageKey(authorization.user.id, "customer-credit-refund-request", params.data.creditId, authorization.clientIdempotencyKey),
    requestHash: hashCustomerCreditRefundRequest(params.data.creditId, payload.data)
  });
  return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status });
}
