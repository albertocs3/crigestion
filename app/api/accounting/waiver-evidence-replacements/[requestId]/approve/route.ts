import { cookies } from "next/headers";
import { z } from "zod";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { getCorrelationId, idempotencyStorageKey, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse, originNotAllowed, readBoundedTextBody, unsupportedMediaType, validateIdempotencyKey, validationError } from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import { approveWaiverEvidenceReplacement, approveWaiverEvidenceReplacementSchema, hashWaiverEvidenceReplacementApproval } from "@/modules/accounting/application/waiverEvidenceReplacements";

export const dynamic = "force-dynamic"; export const runtime = "nodejs";
const paramsSchema = z.object({ requestId: z.string().uuid() }).strict();
export async function POST(request: Request, context: { params: Promise<{ requestId: string }> }) {
  if (!isAllowedOrigin(request)) return jsonResponse(request, originNotAllowed(), { status: 403 });
  const token = (await cookies()).get(sessionCookieName)?.value; const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return jsonResponse(request, csrf.error, { status: csrf.status }); const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Accounting.ApproveWaiverEvidenceReplacements", { correlationId });
  if (!authorization.ok) return jsonResponse(request, authorization.error, { status: authorization.status });
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId }); if (!maintenance.ok) return jsonResponse(request, maintenance.error, { status: maintenance.status });
  if (!isJsonRequest(request)) return jsonResponse(request, unsupportedMediaType(), { status: 415 });
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key")); if (!idempotency.ok) return jsonResponse(request, idempotency.error, { status: idempotency.status });
  const params = paramsSchema.safeParse(await context.params); if (!params.success) return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });
  const raw = await readBoundedTextBody(request, 1_024); if (raw === null) return jsonResponse(request, { code: "PAYLOAD_TOO_LARGE", message: "La petición supera el tamaño permitido." }, { status: 413 });
  let body: unknown; try { body = JSON.parse(raw); } catch { return jsonResponse(request, invalidJson(), { status: 400 }); }
  const payload = approveWaiverEvidenceReplacementSchema.safeParse(body); if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  const result = await approveWaiverEvidenceReplacement(params.data.requestId, payload.data, authorization.user, { correlationId,
    idempotencyKey: idempotencyStorageKey(authorization.user.id, "accounting-waiver-evidence-replacement-approve", params.data.requestId, idempotency.key),
    requestHash: hashWaiverEvidenceReplacementApproval(params.data.requestId, payload.data) });
  return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status,
    ...([429, 503].includes(result.status) ? { headers: { "Retry-After": result.status === 429 ? "900" : "1" } } : {}) });
}
