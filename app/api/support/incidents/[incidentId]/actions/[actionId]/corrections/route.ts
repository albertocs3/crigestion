import { cookies } from "next/headers";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { getCorrelationId, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse, originNotAllowed, readBoundedTextBody, unsupportedMediaType, validateIdempotencyKey, validationError } from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import { correctSupportAction, hashSupportActionCorrectionRequest, isSupportActionCorrectionHistoryCursor, listSupportActionCorrections, supportActionCorrectionHistoryQuerySchema, supportActionCorrectionParamsSchema, supportActionCorrectionSchema } from "@/modules/support/application/actionCorrections";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ incidentId: string; actionId: string }> }) {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Support.View", { correlationId });
  if (!authorization.ok) return response(request, authorization.error, authorization.status);
  const params = supportActionCorrectionParamsSchema.safeParse(await context.params);
  if (!params.success) return response(request, validationError(params.error.flatten()), 422);
  const rawQuery = strictQuery(new URL(request.url).searchParams);
  const query = rawQuery ? supportActionCorrectionHistoryQuerySchema.safeParse(rawQuery) : null;
  if (!query?.success
    || (query.data.cursor && !isSupportActionCorrectionHistoryCursor(query.data.cursor, params.data.incidentId, params.data.actionId, query.data.limit))) {
    return response(request, validationError({ fieldErrors: { cursor: ["El cursor no es válido."] }, formErrors: [] }), 422);
  }
  const result = await listSupportActionCorrections(params.data.incidentId, params.data.actionId, query.data, authorization.user, { correlationId });
  const headers: Record<string, string> = !result.ok && "retryAfterSeconds" in result.error
    ? { "Retry-After": String(result.error.retryAfterSeconds) }
    : {};
  return result.ok ? response(request, result.value, 200) : response(request, result.error, result.status, headers);
}

export async function POST(request: Request, context: { params: Promise<{ incidentId: string; actionId: string }> }) {
  if (!isAllowedOrigin(request)) return response(request, originNotAllowed(), 403);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return response(request, csrf.error, csrf.status);
  const correlationId = getCorrelationId(request);
  const viewAuthorization = await requirePermission(token, "Support.View", { correlationId });
  if (!viewAuthorization.ok) return response(request, viewAuthorization.error, viewAuthorization.status);
  const authorization = await requirePermission(token, "Support.CorrectActions", { correlationId });
  if (!authorization.ok) return response(request, authorization.error, authorization.status);
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) return response(request, maintenance.error, maintenance.status);
  const params = supportActionCorrectionParamsSchema.safeParse(await context.params);
  if (!params.success) return response(request, validationError(params.error.flatten()), 422);
  if (!isJsonRequest(request)) return response(request, unsupportedMediaType(), 415);
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) return response(request, idempotency.error, idempotency.status);
  const rawBody = await readBoundedTextBody(request, 8_192);
  if (rawBody === null) return response(request, { code: "PAYLOAD_TOO_LARGE", message: "La petición supera el tamaño máximo permitido." }, 413);
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { return response(request, invalidJson(), 400); }
  const parsed = supportActionCorrectionSchema.safeParse(body);
  if (!parsed.success) return response(request, validationError(parsed.error.flatten()), 422);
  const result = await correctSupportAction(params.data.incidentId, params.data.actionId, parsed.data, authorization.user, {
    idempotencyKey: idempotency.key,
    requestHash: hashSupportActionCorrectionRequest({ ...params.data, ...parsed.data }),
    scope: `incident:${params.data.incidentId}:action:${params.data.actionId}:correction`,
    correlationId,
  });
  const headers: Record<string, string> = !result.ok && result.error.retryAfterSeconds ? { "Retry-After": String(result.error.retryAfterSeconds) } : {};
  return result.ok ? response(request, result.value, result.status) : response(request, result.error, result.status, headers);
}

function response(request: Request, body: unknown, status: number, extraHeaders: Record<string, string> = {}) {
  return jsonResponse(request, body, { status, headers: { "Cache-Control": "private, no-store, max-age=0", ...extraHeaders } });
}

function strictQuery(searchParams: URLSearchParams): Record<string, string> | null {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of searchParams.entries()) {
    if ((key !== "limit" && key !== "cursor") || Object.hasOwn(result, key)) return null;
    result[key] = value;
  }
  return result;
}
