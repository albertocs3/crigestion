import { cookies } from "next/headers";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { getCorrelationId, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse, originNotAllowed, readBoundedTextBody, unsupportedMediaType, validateIdempotencyKey, validationError } from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import { supportIncidentParamsSchema } from "@/modules/support/application/incidents";
import { changeSupportParticipants, hashSupportParticipantRequest, supportParticipantChangeSchema } from "@/modules/support/application/participants";

export const dynamic = "force-dynamic"; export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ incidentId: string }> }) {
  if (!isAllowedOrigin(request)) return response(request, originNotAllowed(), 403);
  const token = (await cookies()).get(sessionCookieName)?.value; const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token")); if (!csrf.ok) return response(request, csrf.error, csrf.status);
  const correlationId = getCorrelationId(request); const authorization = await requirePermission(token, "Support.ManageParticipants", { correlationId }); if (!authorization.ok) return response(request, authorization.error, authorization.status); const view = await requirePermission(token, "Support.View", { correlationId }); if (!view.ok) return response(request, view.error, view.status);
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId }); if (!maintenance.ok) return response(request, maintenance.error, maintenance.status);
  const params = supportIncidentParamsSchema.safeParse(await context.params); if (!params.success) return response(request, validationError(params.error.flatten()), 422); if (!isJsonRequest(request)) return response(request, unsupportedMediaType(), 415);
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key")); if (!idempotency.ok) return response(request, idempotency.error, idempotency.status);
  const raw = await readBoundedTextBody(request, 4_096); if (raw === null) return response(request, { code: "PAYLOAD_TOO_LARGE", message: "La petición supera el tamaño máximo permitido." }, 413); let body: unknown; try { body = JSON.parse(raw); } catch { return response(request, invalidJson(), 400); }
  const parsed = supportParticipantChangeSchema.safeParse(body); if (!parsed.success) return response(request, validationError(parsed.error.flatten()), 422);
  const result = await changeSupportParticipants(params.data.incidentId, parsed.data, authorization.user, { idempotencyKey: idempotency.key, requestHash: hashSupportParticipantRequest({ incidentId: params.data.incidentId, ...parsed.data }), scope: `incident:${params.data.incidentId}:participant-change`, correlationId });
  return result.ok ? response(request, result.value, result.status) : response(request, result.error, result.status);
}
function response(request: Request, body: unknown, status: number) { return jsonResponse(request, body, { status, headers: { "Cache-Control": "private, no-store, max-age=0" } }); }
