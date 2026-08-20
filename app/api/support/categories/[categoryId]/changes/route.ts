import { cookies } from "next/headers";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { getCorrelationId, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse, originNotAllowed, readBoundedTextBody, unsupportedMediaType, validateIdempotencyKey, validationError } from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import { changeSupportCategory, hashSupportCategoryChangeRequest, supportCategoryChangeSchema, supportCategoryParamsSchema } from "@/modules/support/application/categoryChanges";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ categoryId: string }> }) {
  if (!isAllowedOrigin(request)) return response(request, originNotAllowed(), 403);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return response(request, csrf.error, csrf.status);
  const correlationId = getCorrelationId(request);
  const viewAuthorization = await requirePermission(token, "Support.View", { correlationId });
  if (!viewAuthorization.ok) return response(request, viewAuthorization.error, viewAuthorization.status);
  const authorization = await requirePermission(token, "Support.ManageCategories", { correlationId });
  if (!authorization.ok) return response(request, authorization.error, authorization.status);
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) return response(request, maintenance.error, maintenance.status);
  const params = supportCategoryParamsSchema.safeParse(await context.params);
  if (!params.success) return response(request, validationError(params.error.flatten()), 422);
  if (!isJsonRequest(request)) return response(request, unsupportedMediaType(), 415);
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) return response(request, idempotency.error, idempotency.status);
  const rawBody = await readBoundedTextBody(request, 4_096);
  if (rawBody === null) return response(request, { code: "PAYLOAD_TOO_LARGE", message: "La petición supera el tamaño máximo permitido." }, 413);
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { return response(request, invalidJson(), 400); }
  const parsed = supportCategoryChangeSchema.safeParse(body);
  if (!parsed.success) return response(request, validationError(parsed.error.flatten()), 422);
  const result = await changeSupportCategory(params.data.categoryId, parsed.data, authorization.user, {
    idempotencyKey: idempotency.key,
    requestHash: hashSupportCategoryChangeRequest({ categoryId: params.data.categoryId, ...parsed.data }),
    scope: `category:${params.data.categoryId}:change`,
    correlationId,
  });
  const retryAfter: Record<string, string> = !result.ok && result.error.retryAfterSeconds ? { "Retry-After": String(result.error.retryAfterSeconds) } : {};
  return result.ok ? response(request, result.value, result.status) : response(request, result.error, result.status, retryAfter);
}

function response(request: Request, body: unknown, status: number, extraHeaders: Record<string, string> = {}) {
  return jsonResponse(request, body, { status, headers: { "Cache-Control": "private, no-store, max-age=0", ...extraHeaders } });
}
