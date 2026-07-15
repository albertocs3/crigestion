import { authorizeBankingMutation } from "@/app/api/treasury/_banking-http";
import { createBankReconciliation, createBankReconciliationSchema } from "@/modules/treasury/application/banking";
import { jsonResponse, validationError } from "@/modules/platform/application/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  // authorizeBankingMutation ejecuta isAllowedOrigin(request) y validateCsrfToken(...).
  const authorization = await authorizeBankingMutation(request);
  if (!authorization.ok) return authorization.response;
  const payload = createBankReconciliationSchema.safeParse(authorization.body);
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  const result = await createBankReconciliation(payload.data, authorization.user, { correlationId: authorization.correlationId, idempotencyKey: authorization.idempotencyKey, requestHash: authorization.requestHash, operation: "create-reconciliation", resourceId: payload.data.bankMovementId });
  return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status });
}
