import { cookies } from "next/headers";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { getCorrelationId, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse, originNotAllowed, readBoundedTextBody, unsupportedMediaType, validateIdempotencyKey, validationError } from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import { createSupportCategory, createSupportCategorySchema, hashSupportRequest, listSupportCategories } from "@/modules/support/application/incidents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const authorization = await requirePermission(token, "Support.View", { correlationId: getCorrelationId(request) });
  if (!authorization.ok) return response(request, authorization.error, authorization.status);
  return response(request, { categories: await listSupportCategories() }, 200);
}

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) return response(request, originNotAllowed(), 403);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return response(request, csrf.error, csrf.status);
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Support.ManageCategories", { correlationId });
  if (!authorization.ok) return response(request, authorization.error, authorization.status);
  const viewAuthorization = await requirePermission(token, "Support.View", { correlationId });
  if (!viewAuthorization.ok) return response(request, viewAuthorization.error, viewAuthorization.status);
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) return response(request, maintenance.error, maintenance.status);
  if (!isJsonRequest(request)) return response(request, unsupportedMediaType(), 415);
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) return response(request, idempotency.error, idempotency.status);
  const rawBody = await readBoundedTextBody(request, 2_048);
  if (rawBody === null) return response(request, { code: "PAYLOAD_TOO_LARGE", message: "La peticion supera el tamano maximo permitido." }, 413);
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { return response(request, invalidJson(), 400); }
  const parsed = createSupportCategorySchema.safeParse(body);
  if (!parsed.success) return response(request, validationError(parsed.error.flatten()), 422);
  const result = await createSupportCategory(parsed.data, authorization.user, { idempotencyKey: idempotency.key, requestHash: hashSupportRequest(parsed.data), scope: "category:create", correlationId });
  return result.ok ? response(request, result.value, result.status) : response(request, result.error, result.status);
}

function response(request: Request, body: unknown, status: number) { return jsonResponse(request, body, { status, headers: { "Cache-Control": "private, no-store, max-age=0" } }); }
