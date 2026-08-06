import { cookies } from "next/headers";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import {
  getCorrelationId, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse, originNotAllowed,
  readBoundedTextBody, unsupportedMediaType, validationError
} from "@/modules/platform/application/http";
import { exportSubscriptionRenewalWaiversCsv, exportSubscriptionRenewalWaiversSchema } from "@/modules/subscriptions/application/renewalWaiverReports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const responseHeaders = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" };

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) return jsonResponse(request, originNotAllowed(), { status: 403, headers: responseHeaders });
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return jsonResponse(request, csrf.error, { status: csrf.status, headers: responseHeaders });
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Subscriptions.ExportRenewalWaivers", { correlationId });
  if (!authorization.ok) return jsonResponse(request, authorization.error, { status: authorization.status, headers: responseHeaders });
  if (!isJsonRequest(request)) return jsonResponse(request, unsupportedMediaType(), { status: 415, headers: responseHeaders });
  const rawBody = await readBoundedTextBody(request, 4_096);
  if (rawBody === null) return jsonResponse(request, { code: "PAYLOAD_TOO_LARGE", message: "La peticion supera el tamano permitido." }, { status: 413, headers: responseHeaders });
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { return jsonResponse(request, invalidJson(), { status: 400, headers: responseHeaders }); }
  const payload = exportSubscriptionRenewalWaiversSchema.safeParse(body);
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422, headers: responseHeaders });
  const result = await exportSubscriptionRenewalWaiversCsv(payload.data, authorization.user, { correlationId });
  if (!result.ok) return jsonResponse(request, result.error, {
    status: result.status, headers: { ...responseHeaders, ...(result.status === 429 ? { "Retry-After": "900" } : {}) }
  });
  return new Response(`\uFEFF${result.value.content}`, { status: 200, headers: {
    ...responseHeaders,
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${result.value.filename.replace(/"/g, "")}"`,
    "Content-Length": result.value.byteCount.toString()
  } });
}
