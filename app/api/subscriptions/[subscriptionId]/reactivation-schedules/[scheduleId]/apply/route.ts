import { cookies } from "next/headers";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import {
  getCorrelationId, idempotencyStorageKey, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse,
  originNotAllowed, readBoundedTextBody, unsupportedMediaType, validateIdempotencyKey, validationError
} from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import {
  applySubscriptionReactivationSchedule, applySubscriptionReactivationScheduleSchema,
  hashSubscriptionReactivationScheduleRequest, subscriptionReactivationScheduleParamsSchema
} from "@/modules/subscriptions/application/reactivationSchedules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ subscriptionId: string; scheduleId: string }> }) {
  if (!isAllowedOrigin(request)) return privateJsonResponse(request, originNotAllowed(), 403);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return privateJsonResponse(request, csrf.error, csrf.status);
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Subscriptions.ScheduleReactivations", { correlationId });
  if (!authorization.ok) return privateJsonResponse(request, authorization.error, authorization.status);
  const viewing = await requirePermission(token, "Subscriptions.View", { correlationId });
  if (!viewing.ok) return privateJsonResponse(request, viewing.error, viewing.status);
  const params = subscriptionReactivationScheduleParamsSchema.safeParse(await context.params);
  if (!params.success) return privateJsonResponse(request, validationError(params.error.flatten()), 422);
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) return privateJsonResponse(request, maintenance.error, maintenance.status);
  if (!isJsonRequest(request)) return privateJsonResponse(request, unsupportedMediaType(), 415);
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) return privateJsonResponse(request, idempotency.error, idempotency.status);
  const raw = await readBoundedTextBody(request, 2_048);
  if (raw === null) return privateJsonResponse(request, { code: "PAYLOAD_TOO_LARGE", message: "La peticion supera el tamano permitido." }, 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return privateJsonResponse(request, invalidJson(), 400); }
  const payload = applySubscriptionReactivationScheduleSchema.safeParse(body);
  if (!payload.success) return privateJsonResponse(request, validationError(payload.error.flatten()), 422);
  const semanticPayload = { ...params.data, ...payload.data };
  const result = await applySubscriptionReactivationSchedule(params.data.subscriptionId, params.data.scheduleId, payload.data, authorization.user, {
    correlationId,
    idempotencyKey: idempotencyStorageKey(authorization.user.id, "subscription-reactivation-schedule-apply", params.data.scheduleId, idempotency.key),
    requestHash: hashSubscriptionReactivationScheduleRequest("apply", semanticPayload)
  });
  return privateJsonResponse(request, result.ok ? result.value : result.error, result.status);
}

function privateJsonResponse<TBody>(request: Request, body: TBody, status: number) {
  return jsonResponse(request, body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0", ...(status === 429 ? { "Retry-After": "900" } : {}) }
  });
}
