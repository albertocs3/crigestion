import { z } from "zod";
import { jsonResponse, validationError } from "@/modules/platform/application/http";
import { createPurchaseRectification, createPurchaseRectificationSchema } from "@/modules/purchases/application/purchases";
import { authorizePurchaseMutation } from "../../_http";

const paramsSchema = z.object({ purchaseId: z.string().uuid() });
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ purchaseId: string }> }) {
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });
  const auth = await authorizePurchaseMutation(request, "Purchases.Rectify");
  if (!auth.ok) return auth.response;
  const parsed = createPurchaseRectificationSchema.safeParse(auth.body);
  if (!parsed.success) return jsonResponse(request, validationError(parsed.error.flatten()), { status: 422 });
  const result = await createPurchaseRectification(params.data.purchaseId, parsed.data, auth.user, {
    correlationId: auth.correlationId,
    idempotencyKey: auth.idempotencyKey,
    requestHash: auth.requestHash,
    scope: `rectify:${params.data.purchaseId}`
  });
  return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status });
}
