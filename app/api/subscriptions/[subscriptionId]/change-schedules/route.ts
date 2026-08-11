import { cookies } from "next/headers";

import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import {
  getCorrelationId,
  idempotencyStorageKey,
  invalidJson,
  isAllowedOrigin,
  isJsonRequest,
  jsonResponse,
  originNotAllowed,
  readBoundedTextBody,
  unsupportedMediaType,
  validateIdempotencyKey,
  validationError
} from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import {
  createSubscriptionChangeSchedule,
  createSubscriptionChangeScheduleSchema,
  hashSubscriptionChangeScheduleRequest
} from "@/modules/subscriptions/application/subscriptionChanges";
import { subscriptionParamsSchema } from "@/modules/subscriptions/application/subscriptions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ subscriptionId: string }> }) {
  if (!isAllowedOrigin(request)) return privateJsonResponse(request, originNotAllowed(), 403);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return privateJsonResponse(request, csrf.error, csrf.status);
  const correlationId = getCorrelationId(request);
  const scheduling = await requirePermission(token, "Subscriptions.ScheduleChanges", { correlationId });
  if (!scheduling.ok) return privateJsonResponse(request, scheduling.error, scheduling.status);
  const economics = await requirePermission(token, "Subscriptions.ManageEconomics", { correlationId });
  if (!economics.ok) return privateJsonResponse(request, economics.error, economics.status);
  const viewing = await requirePermission(token, "Subscriptions.View", { correlationId });
  if (!viewing.ok) return privateJsonResponse(request, viewing.error, viewing.status);
  const params = subscriptionParamsSchema.safeParse(await context.params);
  if (!params.success) return privateJsonResponse(request, validationError(params.error.flatten()), 422);
  const maintenance = await requireMaintenanceModeInactive(scheduling.user, request, { correlationId });
  if (!maintenance.ok) return privateJsonResponse(request, maintenance.error, maintenance.status);
  if (!isJsonRequest(request)) return privateJsonResponse(request, unsupportedMediaType(), 415);
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) return privateJsonResponse(request, idempotency.error, idempotency.status);
  const body = await readJsonBody(request);
  if (!body.ok) return privateJsonResponse(request, body.error, body.status);
  const payload = createSubscriptionChangeScheduleSchema.safeParse(body.value);
  if (!payload.success) return privateJsonResponse(request, validationError(payload.error.flatten()), 422);
  const semanticPayload = { subscriptionId: params.data.subscriptionId, ...payload.data };
  const result = await createSubscriptionChangeSchedule(
    params.data.subscriptionId,
    payload.data,
    scheduling.user,
    {
      correlationId,
      idempotencyKey: idempotencyStorageKey(
        scheduling.user.id,
        "subscription-change-schedule-create",
        params.data.subscriptionId,
        idempotency.key
      ),
      requestHash: hashSubscriptionChangeScheduleRequest("create", semanticPayload)
    }
  );
  return privateJsonResponse(request, result.ok ? result.value : result.error, result.status);
}

async function readJsonBody(request: Request): Promise<
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: { code: string; message: string } }
> {
  const raw = await readBoundedTextBody(request, 16_384);
  if (raw === null) {
    return { ok: false, status: 413, error: { code: "PAYLOAD_TOO_LARGE", message: "La peticion supera el tamano permitido." } };
  }
  try { return { ok: true, value: JSON.parse(raw) as unknown }; }
  catch { return { ok: false, status: 400, error: invalidJson() }; }
}

function privateJsonResponse<TBody>(request: Request, body: TBody, status: number) {
  return jsonResponse(request, body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      ...(status === 429 ? { "Retry-After": "900" } : {})
    }
  });
}
