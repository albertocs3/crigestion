import { cookies } from "next/headers";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { getCorrelationId, idempotencyStorageKey, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse, originNotAllowed, unsupportedMediaType, validateIdempotencyKey, validationError } from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import { hashSubscriptionRequest, scheduleSubscriptionCancellation, scheduleSubscriptionCancellationSchema, subscriptionParamsSchema } from "@/modules/subscriptions/application/subscriptions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ subscriptionId: string }> }) {
  if (!isAllowedOrigin(request)) return jsonResponse(request, originNotAllowed(), { status: 403 });
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return jsonResponse(request, csrf.error, { status: csrf.status });
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Subscriptions.Cancel", { correlationId });
  if (!authorization.ok) return jsonResponse(request, authorization.error, { status: authorization.status });
  const params = subscriptionParamsSchema.safeParse(await context.params);
  if (!params.success) return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) return jsonResponse(request, maintenance.error, { status: maintenance.status });
  if (!isJsonRequest(request)) return jsonResponse(request, unsupportedMediaType(), { status: 415 });
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) return jsonResponse(request, idempotency.error, { status: idempotency.status });
  let body: unknown;
  try { body = await request.json(); } catch { return jsonResponse(request, invalidJson(), { status: 400 }); }
  const payload = scheduleSubscriptionCancellationSchema.safeParse(body);
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  const result = await scheduleSubscriptionCancellation(params.data.subscriptionId, payload.data, authorization.user, {
    correlationId,
    idempotencyKey: idempotencyStorageKey(authorization.user.id, "subscription-cancellation-schedule-create", params.data.subscriptionId, idempotency.key),
    requestHash: hashSubscriptionRequest({ subscriptionId: params.data.subscriptionId, ...payload.data })
  });
  return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status });
}
