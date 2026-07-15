import { cookies } from "next/headers";
import type { SessionUser } from "@/modules/platform/application/auth";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import {
  getCorrelationId,
  invalidJson,
  isAllowedOrigin,
  isJsonRequest,
  jsonResponse,
  originNotAllowed,
  unsupportedMediaType,
  validateIdempotencyKey
} from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";

const maxBodyBytes = 16 * 1024;

export async function authorizeCustomerCreditRead(
  request: Request,
  permission: string
): Promise<
  | { ok: true; user: SessionUser; correlationId: string }
  | { ok: false; response: Response }
> {
  const correlationId = getCorrelationId(request);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const authorization = await requirePermission(token, permission, { correlationId });

  if (!authorization.ok) {
    return { ok: false, response: jsonResponse(request, authorization.error, { status: authorization.status }) };
  }

  return { ok: true, user: authorization.user, correlationId };
}

export async function authorizeCustomerCreditMutation(
  request: Request,
  permission: string
): Promise<
  | { ok: true; user: SessionUser; correlationId: string; clientIdempotencyKey: string; body: unknown }
  | { ok: false; response: Response }
> {
  if (!isAllowedOrigin(request)) {
    return { ok: false, response: jsonResponse(request, originNotAllowed(), { status: 403 }) };
  }

  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return { ok: false, response: jsonResponse(request, csrf.error, { status: csrf.status }) };

  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, permission, { correlationId });
  if (!authorization.ok) {
    return { ok: false, response: jsonResponse(request, authorization.error, { status: authorization.status }) };
  }

  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) {
    return { ok: false, response: jsonResponse(request, maintenance.error, { status: maintenance.status }) };
  }

  if (!isJsonRequest(request)) {
    return { ok: false, response: jsonResponse(request, unsupportedMediaType(), { status: 415 }) };
  }

  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) {
    return { ok: false, response: jsonResponse(request, idempotency.error, { status: idempotency.status }) };
  }

  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    return { ok: false, response: payloadTooLarge(request) };
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > maxBodyBytes) {
    return { ok: false, response: payloadTooLarge(request) };
  }

  try {
    return {
      ok: true,
      user: authorization.user,
      correlationId,
      clientIdempotencyKey: idempotency.key,
      body: JSON.parse(rawBody) as unknown
    };
  } catch {
    return { ok: false, response: jsonResponse(request, invalidJson(), { status: 400 }) };
  }
}

function payloadTooLarge(request: Request): Response {
  return jsonResponse(request, {
    code: "PAYLOAD_TOO_LARGE",
    message: "La peticion supera el tamano permitido."
  }, { status: 413 });
}
