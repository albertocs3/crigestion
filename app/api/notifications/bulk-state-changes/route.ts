import { cookies } from "next/headers";
import { getSessionState, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { getCorrelationId, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse, originNotAllowed, readBoundedTextBody, unsupportedMediaType, validateIdempotencyKey, validationError } from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import { changeNotificationStatesBulk, hashNotificationBulkStateRequest, notificationBulkStateSchema } from "@/modules/platform/application/notifications";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) return response(request, originNotAllowed(), 403);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return response(request, csrf.error, csrf.status);
  const session = await getSessionState(token);
  if (!session.authenticated) return response(request, { code: "UNAUTHENTICATED", message: "No hay una sesión activa." }, 401);
  const correlationId = getCorrelationId(request);
  const maintenance = await requireMaintenanceModeInactive(session.user, request, { correlationId });
  if (!maintenance.ok) return response(request, maintenance.error, maintenance.status);
  if (!isJsonRequest(request)) return response(request, unsupportedMediaType(), 415);
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) return response(request, idempotency.error, idempotency.status);
  const raw = await readBoundedTextBody(request, 16_384);
  if (raw === null) return response(request, { code: "PAYLOAD_TOO_LARGE", message: "La petición supera el tamaño permitido." }, 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return response(request, invalidJson(), 400); }
  const parsed = notificationBulkStateSchema.safeParse(body);
  if (!parsed.success) return response(request, validationError(parsed.error.flatten()), 422);
  const result = await changeNotificationStatesBulk(parsed.data, session.user, { correlationId, idempotencyKey: idempotency.key, requestHash: hashNotificationBulkStateRequest(parsed.data) });
  return result.ok ? response(request, result.value, result.status) : response(request, result.error, result.status, result.error.retryAfterSeconds);
}

function response(request: Request, body: unknown, status: number, retryAfterSeconds?: number) {
  return jsonResponse(request, body, { status, headers: { "Cache-Control": "private, no-store, max-age=0", ...(retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : {}) } });
}
