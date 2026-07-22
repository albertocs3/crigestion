import { z } from "zod";
import { authorizeCustomerCreditMutation } from "@/app/api/treasury/_customer-credit-http";
import { idempotencyStorageKey, jsonResponse, validationError } from "@/modules/platform/application/http";
import { applySupplierCredit, applySupplierCreditSchema, hashSupplierCreditApplication } from "@/modules/treasury/application/supplierCredits";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const paramsSchema = z.object({ creditId: z.string().uuid() });

export async function POST(request: Request, context: { params: Promise<{ creditId: string }> }) {
  const authorization = await authorizeCustomerCreditMutation(request, "Treasury.ApplySupplierCredits");
  if (!authorization.ok) return authorization.response;
  const params = paramsSchema.safeParse(await context.params); const payload = applySupplierCreditSchema.safeParse(authorization.body);
  if (!params.success) return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  const result = await applySupplierCredit(params.data.creditId, payload.data, authorization.user, { correlationId: authorization.correlationId, idempotencyKey: idempotencyStorageKey(authorization.user.id, "supplier-credit-application", params.data.creditId, authorization.clientIdempotencyKey), requestHash: hashSupplierCreditApplication(params.data.creditId, payload.data) });
  return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status });
}
