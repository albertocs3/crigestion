import { cookies } from "next/headers";
import { z } from "zod";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { getCorrelationId, isAllowedOrigin, jsonResponse, originNotAllowed, validateIdempotencyKey, validationError } from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import { auditSupportAttachmentRateLimited, consumeSupportAttachmentRateLimit, isSupportIncidentAttachmentCursor, listSupportIncidentAttachmentPage, supportIncidentAttachmentRequestHash, uploadSupportIncidentAttachment } from "@/modules/support/application/incidentAttachments";
import { incidentAttachmentMaxBytes } from "@/modules/support/infrastructure/incidentAttachmentFile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const paramsSchema = z.object({ incidentId: z.string().uuid() }).strict();
const actionIdSchema = z.string().uuid().nullable();
const maximumMultipartBytes = incidentAttachmentMaxBytes + 65_536;

export async function GET(request: Request, { params }: { params: Promise<{ incidentId: string }> }) {
  const authorization = await authorize(request, "Support.View");
  if (!authorization.ok) return authorization.response;
  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) return jsonResponse(request, validationError(parsedParams.error.flatten()), { status: 422, headers: noStoreHeaders() });
  const cursor = new URL(request.url).searchParams.get("cursor");
  if (cursor && (cursor.length > 512 || !isSupportIncidentAttachmentCursor(cursor))) return jsonResponse(request, validationError({ fieldErrors: { cursor: ["El cursor no es valido."] }, formErrors: [] }), { status: 422, headers: noStoreHeaders() });
  const page = await listSupportIncidentAttachmentPage(parsedParams.data.incidentId, authorization.user, cursor);
  if (!page) return jsonResponse(request, { code: "SUPPORT_INCIDENT_NOT_FOUND", message: "La incidencia no existe." }, { status: 404, headers: noStoreHeaders() });
  return jsonResponse(request, page, { headers: noStoreHeaders() });
}

export async function POST(request: Request, { params }: { params: Promise<{ incidentId: string }> }) {
  if (!isAllowedOrigin(request)) return jsonResponse(request, originNotAllowed(), { status: 403, headers: noStoreHeaders() });
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return jsonResponse(request, csrf.error, { status: csrf.status, headers: noStoreHeaders() });
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Support.ManageAttachments", { correlationId });
  if (!authorization.ok) return jsonResponse(request, authorization.error, { status: authorization.status, headers: noStoreHeaders() });
  const view = await requirePermission(token, "Support.View", { correlationId });
  if (!view.ok) return jsonResponse(request, view.error, { status: view.status, headers: noStoreHeaders() });
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) return jsonResponse(request, maintenance.error, { status: maintenance.status, headers: noStoreHeaders() });
  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) return jsonResponse(request, validationError(parsedParams.error.flatten()), { status: 422, headers: noStoreHeaders() });
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) return jsonResponse(request, idempotency.error, { status: idempotency.status, headers: noStoreHeaders() });
  if (await consumeSupportAttachmentRateLimit(authorization.user.id, "upload")) {
    await auditSupportAttachmentRateLimited(authorization.user.id, "upload", correlationId);
    return jsonResponse(request, { code: "SUPPORT_ATTACHMENT_RATE_LIMITED", message: "Demasiados intentos de carga. Espera quince minutos." }, { status: 429, headers: { ...noStoreHeaders(), "Retry-After": "900" } });
  }
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^multipart\/form-data\s*;\s*boundary=[^;\s]{1,200}$/i.test(contentType)) return jsonResponse(request, { code: "UNSUPPORTED_MEDIA_TYPE", message: "La peticion debe enviarse como multipart/form-data." }, { status: 415, headers: noStoreHeaders() });
  const declaredLength = readContentLength(request.headers.get("Content-Length"));
  if (declaredLength === "invalid" || (declaredLength !== null && declaredLength > maximumMultipartBytes)) return payloadTooLarge(request);
  const raw = await readBoundedBody(request, maximumMultipartBytes);
  if (!raw) return payloadTooLarge(request);
  try {
    const form = await parseMultipart(request.url, contentType, raw);
    if (!form) return invalidMultipart(request);
    const keys = Array.from(form.keys());
    if (keys.some((key) => key !== "file" && key !== "actionId") || form.getAll("file").length !== 1 || form.getAll("actionId").length > 1) return invalidMultipart(request);
    const file = form.get("file");
    const actionValue = form.get("actionId");
    if (!isUploadedFile(file) || (actionValue !== null && typeof actionValue !== "string")) return invalidMultipart(request);
    if (file.size < 1 || file.size > incidentAttachmentMaxBytes) return payloadTooLarge(request);
    const actionId = actionIdSchema.safeParse(typeof actionValue === "string" && actionValue.trim() ? actionValue.trim() : null);
    if (!actionId.success) return jsonResponse(request, validationError(actionId.error.flatten()), { status: 422, headers: noStoreHeaders() });
    const bytes = Buffer.from(await file.arrayBuffer());
    try {
      const requestHash = supportIncidentAttachmentRequestHash({ incidentId: parsedParams.data.incidentId, actionId: actionId.data, bytes, fileName: file.name, declaredMimeType: file.type });
      const result = await uploadSupportIncidentAttachment({ incidentId: parsedParams.data.incidentId, actionId: actionId.data, bytes, fileName: file.name, declaredMimeType: file.type, clientIdempotencyKey: idempotency.key, requestHash }, authorization.user, { correlationId });
      return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status, headers: { ...noStoreHeaders(), ...(result.ok || !result.error.retryAfterSeconds ? {} : { "Retry-After": String(result.error.retryAfterSeconds) }) } });
    } finally { bytes.fill(0); }
  } finally { raw.fill(0); }
}

async function authorize(request: Request, permission: string) { const token = (await cookies()).get(sessionCookieName)?.value; const authorization = await requirePermission(token, permission, { correlationId: getCorrelationId(request) }); return authorization.ok ? { ok: true as const, user: authorization.user } : { ok: false as const, response: jsonResponse(request, authorization.error, { status: authorization.status, headers: noStoreHeaders() }) }; }
function noStoreHeaders() { return { "Cache-Control": "private, no-store, max-age=0" }; }
function readContentLength(value: string | null): number | null | "invalid" { if (value === null) return null; const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : "invalid"; }
async function readBoundedBody(request: Request, maximum: number): Promise<Buffer | null> { if (!request.body) return Buffer.alloc(0); const reader = request.body.getReader(); const chunks: Buffer[] = []; let size = 0; try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maximum) { value.fill(0); await reader.cancel(); return null; } chunks.push(Buffer.from(value)); value.fill(0); } return Buffer.concat(chunks, size); } finally { for (const chunk of chunks) chunk.fill(0); reader.releaseLock(); } }
async function parseMultipart(url: string, contentType: string, raw: Buffer): Promise<FormData | null> { try { return await new Request(url, { method: "POST", headers: { "Content-Type": contentType }, body: new Uint8Array(raw) }).formData(); } catch { return null; } }
function isUploadedFile(value: FormDataEntryValue | null): value is File { return value !== null && typeof value !== "string" && typeof value.name === "string" && typeof value.type === "string" && typeof value.size === "number" && typeof value.arrayBuffer === "function"; }
function invalidMultipart(request: Request) { return jsonResponse(request, { code: "INVALID_MULTIPART", message: "El formulario multipart no es valido." }, { status: 400, headers: noStoreHeaders() }); }
function payloadTooLarge(request: Request) { return jsonResponse(request, { code: "PAYLOAD_TOO_LARGE", message: "La peticion supera el tamano permitido." }, { status: 413, headers: noStoreHeaders() }); }
