import { z } from "zod";
import { authorizeBankingMutation } from "@/app/api/treasury/_banking-http";
import { undoBankReconciliation } from "@/modules/treasury/application/banking";
import { jsonResponse, validationError } from "@/modules/platform/application/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ reconciliationId: string }> }) {
  // authorizeBankingMutation ejecuta isAllowedOrigin(request) y validateCsrfToken(...).
  const authorization = await authorizeBankingMutation(request);
  if (!authorization.ok) return authorization.response;
  const params = z.object({ reconciliationId: z.string().uuid() }).safeParse(await context.params);
  if (!params.success) return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });
  const result = await undoBankReconciliation(params.data.reconciliationId, authorization.user, { correlationId: authorization.correlationId, idempotencyKey: authorization.idempotencyKey, requestHash: authorization.requestHash, operation: "undo-reconciliation", resourceId: params.data.reconciliationId });
  return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status });
}
