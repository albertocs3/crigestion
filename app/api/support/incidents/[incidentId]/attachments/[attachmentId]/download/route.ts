import { cookies } from "next/headers";
import { z } from "zod";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { getCorrelationId, isAllowedOrigin, jsonResponse, originNotAllowed } from "@/modules/platform/application/http";
import { acquireSupportAttachmentDownloadSlot, auditSupportAttachmentRateLimited, consumeSupportAttachmentRateLimit, downloadSupportIncidentAttachment, releaseSupportAttachmentDownloadSlot } from "@/modules/support/application/incidentAttachments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const paramsSchema = z.object({ incidentId: z.string().uuid(), attachmentId: z.string().uuid() }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ incidentId: string; attachmentId: string }> }) {
  if (!isAllowedOrigin(request)) return jsonResponse(request, originNotAllowed(), { status: 403, headers: noStoreHeaders() });
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return jsonResponse(request, csrf.error, { status: csrf.status, headers: noStoreHeaders() });
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Support.DownloadAttachments", { correlationId });
  if (!authorization.ok) return jsonResponse(request, authorization.error, { status: authorization.status, headers: noStoreHeaders() });
  const view = await requirePermission(token, "Support.View", { correlationId });
  if (!view.ok) return jsonResponse(request, view.error, { status: view.status, headers: noStoreHeaders() });
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) return jsonResponse(request, { code: "VALIDATION_ERROR", message: "Los identificadores no son validos." }, { status: 422, headers: noStoreHeaders() });
  if (await consumeSupportAttachmentRateLimit(authorization.user.id, "download")) { await auditSupportAttachmentRateLimited(authorization.user.id, "download", correlationId); return jsonResponse(request, { code: "SUPPORT_ATTACHMENT_RATE_LIMITED", message: "Demasiadas descargas. Espera un minuto." }, { status: 429, headers: { ...noStoreHeaders(), "Retry-After": "60" } }); }
  if (!acquireSupportAttachmentDownloadSlot()) return jsonResponse(request, { code: "SUPPORT_ATTACHMENT_DOWNLOAD_BUSY", message: "Hay demasiadas descargas activas. Reintenta en unos segundos." }, { status: 503, headers: { ...noStoreHeaders(), "Retry-After": "5" } });
  try {
    const result = await downloadSupportIncidentAttachment(parsed.data.incidentId, parsed.data.attachmentId, authorization.user, { correlationId });
    if (!result.ok) return jsonResponse(request, result.error, { status: result.status, headers: noStoreHeaders() });
    const fileName = result.value.attachment.originalFileName;
    const fallback = fileName.normalize("NFKD").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || `attachment.${result.value.attachment.mediaType === "application/pdf" ? "pdf" : "jpg"}`;
    return new Response(result.value.bytes as unknown as BodyInit, { status: 200, headers: { ...noStoreHeaders(), "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`, "Content-Length": String(result.value.bytes.byteLength), "Content-Security-Policy": "sandbox", "Content-Type": result.value.attachment.mediaType, "Cross-Origin-Resource-Policy": "same-origin", ETag: result.value.etag, "X-Content-Type-Options": "nosniff", "X-Correlation-ID": correlationId } });
  } finally { releaseSupportAttachmentDownloadSlot(); }
}
function noStoreHeaders() { return { "Cache-Control": "private, no-store, max-age=0" }; }
