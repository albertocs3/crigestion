import { cookies } from "next/headers";
import { z } from "zod";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { getCorrelationId, idempotencyStorageKey, isAllowedOrigin, jsonResponse, originNotAllowed, validateIdempotencyKey, validationError } from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import { hashFiscalYearCloseRequest, requestFiscalYearClose } from "@/modules/accounting/application/fiscalYearCloseRequests";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type RouteContext = { params: Promise<{ fiscalYearId: string }> };
const paramsSchema = z.object({ fiscalYearId: z.string().uuid() }).strict();

export async function POST(request: Request, context: RouteContext) {
  if (!isAllowedOrigin(request)) return jsonResponse(request, originNotAllowed(), { status: 403 });
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return jsonResponse(request, csrf.error, { status: csrf.status });
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Accounting.RequestExerciseClosures", { correlationId });
  if (!authorization.ok) return jsonResponse(request, authorization.error, { status: authorization.status });
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) return jsonResponse(request, maintenance.error, { status: maintenance.status });
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) return jsonResponse(request, idempotency.error, { status: idempotency.status });
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });
  const result = await requestFiscalYearClose(params.data.fiscalYearId, authorization.user, {
    correlationId,
    idempotencyKey: idempotencyStorageKey(authorization.user.id, "accounting-fiscal-year-close-request", params.data.fiscalYearId, idempotency.key),
    requestHash: hashFiscalYearCloseRequest(params.data.fiscalYearId)
  });
  if (!result.ok) return jsonResponse(request, result.error, { status: result.status });
  return jsonResponse(request, result.value, { status: result.status });
}
