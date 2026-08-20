import { cookies } from "next/headers";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { getCorrelationId, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse, originNotAllowed, readBoundedTextBody, unsupportedMediaType, validateIdempotencyKey, validationError } from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import { createSupportIncident, createSupportIncidentSchema, hashSupportRequest, listSupportIncidents, listSupportIncidentsSchema } from "@/modules/support/application/incidents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Support.View", { correlationId });
  if (!authorization.ok) return response(request, authorization.error, authorization.status);
  const parsed = listSupportIncidentsSchema.safeParse(strictQuery(new URL(request.url).searchParams));
  if (!parsed.success) return response(request, validationError(parsed.error.flatten()), 422);
  const result = await listSupportIncidents(parsed.data, authorization.user, { correlationId });
  if (result.rateLimited) return response(request, { code: "SUPPORT_INCIDENT_SEARCH_RATE_LIMITED", message: "Se ha superado el límite temporal de búsquedas." }, 429);
  if (result.searchTooBroad) return response(request, { code: "SUPPORT_INCIDENT_SEARCH_TOO_BROAD", message: "La búsqueda coincide con demasiadas incidencias. Usa un término más específico." }, 422);
  if (result.searchBusy) return response(request, { code: "SUPPORT_INCIDENT_SEARCH_BUSY", message: "La búsqueda no pudo completarse a tiempo. Reinténtala en unos segundos." }, 503);
  return response(request, { incidents: result.incidents, nextCursor: result.nextCursor }, 200);
}

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) return response(request, originNotAllowed(), 403);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return response(request, csrf.error, csrf.status);
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Support.Create", { correlationId });
  if (!authorization.ok) return response(request, authorization.error, authorization.status);
  const viewAuthorization = await requirePermission(token, "Support.View", { correlationId });
  if (!viewAuthorization.ok) return response(request, viewAuthorization.error, viewAuthorization.status);
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) return response(request, maintenance.error, maintenance.status);
  if (!isJsonRequest(request)) return response(request, unsupportedMediaType(), 415);
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) return response(request, idempotency.error, idempotency.status);
  const rawBody = await readBoundedTextBody(request, 8_192);
  if (rawBody === null) return response(request, { code: "PAYLOAD_TOO_LARGE", message: "La peticion supera el tamano maximo permitido." }, 413);
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { return response(request, invalidJson(), 400); }
  const parsed = createSupportIncidentSchema.safeParse(body);
  if (!parsed.success) return response(request, validationError(parsed.error.flatten()), 422);
  const result = await createSupportIncident(parsed.data, authorization.user, { idempotencyKey: idempotency.key, requestHash: hashSupportRequest(parsed.data), scope: "incident:create", correlationId });
  return result.ok ? response(request, result.value, result.status) : response(request, result.error, result.status);
}

function response(request: Request, body: unknown, status: number) { return jsonResponse(request, body, { status, headers: { "Cache-Control": "private, no-store, max-age=0", ...(status === 429 ? { "Retry-After": "900" } : {}), ...(status === 503 ? { "Retry-After": "3" } : {}) } }); }
function strictQuery(search: URLSearchParams): Record<string, string | string[]> {
  const result = Object.create(null) as Record<string, string | string[]>;
  for (const [key, value] of search) result[key] = Object.hasOwn(result, key) ? [...(Array.isArray(result[key]) ? result[key] : [result[key] as string]), value] : value;
  return result;
}
