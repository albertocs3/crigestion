import { cookies } from "next/headers";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import {
  getCorrelationId, idempotencyStorageKey, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse,
  originNotAllowed, readBoundedTextBody, unsupportedMediaType, validateIdempotencyKey, validationError
} from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import {
  createSubscriptionReactivationSchedule, createSubscriptionReactivationScheduleSchema,
  hashSubscriptionReactivationScheduleRequest
} from "@/modules/subscriptions/application/reactivationSchedules";
import { subscriptionParamsSchema } from "@/modules/subscriptions/application/subscriptions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ subscriptionId: string }> }) {
  if (!isAllowedOrigin(request)) return privateJsonResponse(request, originNotAllowed(), 403);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return privateJsonResponse(request, csrf.error, csrf.status);
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Subscriptions.ScheduleReactivations", { correlationId });
  if (!authorization.ok) return privateJsonResponse(request, authorization.error, authorization.status);
  const viewing = await requirePermission(token, "Subscriptions.View", { correlationId });
  if (!viewing.ok) return privateJsonResponse(request, viewing.error, viewing.status);
  const params = subscriptionParamsSchema.safeParse(await context.params);
  if (!params.success) return privateJsonResponse(request, validationError(params.error.flatten()), 422);
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) return privateJsonResponse(request, maintenance.error, maintenance.status);
  if (!isJsonRequest(request)) return privateJsonResponse(request, unsupportedMediaType(), 415);
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) return privateJsonResponse(request, idempotency.error, idempotency.status);
  const body = await readJsonBody(request);
  if (!body.ok) return privateJsonResponse(request, body.error, body.status);
  const payload = createSubscriptionReactivationScheduleSchema.safeParse(body.value);
  if (!payload.success) return privateJsonResponse(request, validationError(payload.error.flatten()), 422);
  const semanticPayload = { subscriptionId: params.data.subscriptionId, ...payload.data };
  const result = await createSubscriptionReactivationSchedule(params.data.subscriptionId, payload.data, authorization.user, {
    correlationId,
    idempotencyKey: idempotencyStorageKey(authorization.user.id, "subscription-reactivation-schedule-create", params.data.subscriptionId, idempotency.key),
    requestHash: hashSubscriptionReactivationScheduleRequest("create", semanticPayload)
  });
  return scheduleResponse(request, result);
}

async function readJsonBody(request: Request): Promise<
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: { code: string; message: string } }
> {
  const raw = await readBoundedTextBody(request, 2_048);
  if (raw === null) return { ok: false, status: 413, error: { code: "PAYLOAD_TOO_LARGE", message: "La peticion supera el tamano permitido." } };
  try { return { ok: true, value: JSON.parse(raw) as unknown }; }
  catch { return { ok: false, status: 400, error: invalidJson() }; }
}

function scheduleResponse(request: Request, result: Awaited<ReturnType<typeof createSubscriptionReactivationSchedule>>) {
  return privateJsonResponse(request, result.ok ? result.value : result.error, result.status);
}

function privateJsonResponse<TBody>(request: Request, body: TBody, status: number) {
  return jsonResponse(request, body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0", ...(status === 429 ? { "Retry-After": "900" } : {}) }
  });
}
