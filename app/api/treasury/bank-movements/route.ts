import { authorizeBankingMutation, authorizeBankingRead } from "@/app/api/treasury/_banking-http";
import { createBankMovement, createBankMovementSchema, listBankMovements, listBankMovementsSchema } from "@/modules/treasury/application/banking";
import { jsonResponse, validationError } from "@/modules/platform/application/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const authorization = await authorizeBankingRead(request);
  if (!authorization.ok) return authorization.response;
  const params = new URL(request.url).searchParams;
  const payload = listBankMovementsSchema.safeParse({ limit: params.get("limit") ?? undefined, cursor: params.get("cursor") ?? undefined, bankAccountId: params.get("bankAccountId") ?? undefined, status: params.get("status") ?? undefined, dateFrom: params.get("dateFrom") ?? undefined, dateTo: params.get("dateTo") ?? undefined, search: params.get("search") ?? undefined });
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  return jsonResponse(request, await listBankMovements(payload.data, authorization.user));
}

export async function POST(request: Request) {
  // authorizeBankingMutation ejecuta isAllowedOrigin(request) y validateCsrfToken(...).
  const authorization = await authorizeBankingMutation(request);
  if (!authorization.ok) return authorization.response;
  const payload = createBankMovementSchema.safeParse(authorization.body);
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  const result = await createBankMovement(payload.data, authorization.user, { correlationId: authorization.correlationId, idempotencyKey: authorization.idempotencyKey, requestHash: authorization.requestHash, operation: "create-movement" });
  return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status });
}
