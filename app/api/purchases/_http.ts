import { cookies } from "next/headers";
import type { SessionUser } from "@/modules/platform/application/auth";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { getCorrelationId, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse, originNotAllowed, unsupportedMediaType, validateIdempotencyKey } from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import { purchaseRequestHash } from "@/modules/purchases/application/purchases";

export async function authorizePurchaseRead(request: Request, permission = "Purchases.View"): Promise<{ ok: true; user: SessionUser; correlationId: string } | { ok: false; response: Response }> {
  const correlationId = getCorrelationId(request); const token = (await cookies()).get(sessionCookieName)?.value; const auth = await requirePermission(token, permission, { correlationId });
  return auth.ok ? { ok: true, user: auth.user, correlationId } : { ok: false, response: jsonResponse(request, auth.error, { status: auth.status }) };
}

export async function authorizePurchaseMutation(request: Request, permission: string, maxBytes = 256 * 1024): Promise<{ ok: true; user: SessionUser; correlationId: string; idempotencyKey: string; requestHash: string; body: unknown } | { ok: false; response: Response }> {
  if (!isAllowedOrigin(request)) return { ok: false, response: jsonResponse(request, originNotAllowed(), { status: 403 }) };
  const token = (await cookies()).get(sessionCookieName)?.value; const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token")); if (!csrf.ok) return { ok: false, response: jsonResponse(request, csrf.error, { status: csrf.status }) };
  const correlationId = getCorrelationId(request); const auth = await requirePermission(token, permission, { correlationId }); if (!auth.ok) return { ok: false, response: jsonResponse(request, auth.error, { status: auth.status }) };
  const maintenance = await requireMaintenanceModeInactive(auth.user, request, { correlationId }); if (!maintenance.ok) return { ok: false, response: jsonResponse(request, maintenance.error, { status: maintenance.status }) };
  if (!isJsonRequest(request)) return { ok: false, response: jsonResponse(request, unsupportedMediaType(), { status: 415 }) };
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key")); if (!idempotency.ok) return { ok: false, response: jsonResponse(request, idempotency.error, { status: idempotency.status }) };
  const declared = Number(request.headers.get("Content-Length") ?? "0"); if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, response: jsonResponse(request, { code: "PAYLOAD_TOO_LARGE", message: "La petición supera el tamaño permitido." }, { status: 413 }) };
  const raw = await request.text(); if (Buffer.byteLength(raw, "utf8") > maxBytes) return { ok: false, response: jsonResponse(request, { code: "PAYLOAD_TOO_LARGE", message: "La petición supera el tamaño permitido." }, { status: 413 }) };
  try { return { ok: true, user: auth.user, correlationId, idempotencyKey: idempotency.key, requestHash: purchaseRequestHash(JSON.parse(raw)), body: JSON.parse(raw) as unknown }; }
  catch { return { ok: false, response: jsonResponse(request, invalidJson(), { status: 400 }) }; }
}
