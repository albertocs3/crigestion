import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { getCorrelationId, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse, originNotAllowed, unsupportedMediaType, validateIdempotencyKey } from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";

const requiredPermission = "Billing.ManageVerifactuCredentials";

export async function authorizeCredentialMutation(request: Request, scope: "stage" | "activate"): Promise<
  | { ok: true; user: SessionUser; correlationId: string; clientIdempotencyKey: string; rawBody: Buffer; body: unknown }
  | { ok: false; response: Response }
> {
  if (!isAllowedOrigin(request)) return { ok: false, response: jsonResponse(request, originNotAllowed(), { status: 403 }) };
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return { ok: false, response: jsonResponse(request, csrf.error, { status: csrf.status }) };
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, requiredPermission, { correlationId });
  if (!authorization.ok) return { ok: false, response: jsonResponse(request, authorization.error, { status: authorization.status }) };
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) return { ok: false, response: jsonResponse(request, maintenance.error, { status: maintenance.status }) };
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) return { ok: false, response: jsonResponse(request, idempotency.error, { status: idempotency.status }) };
  if (await consumeCredentialRateLimit(authorization.user.id, scope)) {
    await prisma.auditEvent.create({ data: { eventType: "VERIFACTU_MTLS_RATE_LIMITED", actorType: "USER", payload: { actorUserId: authorization.user.id, scope, correlationId } } });
    return { ok: false, response: jsonResponse(request, { code: "RATE_LIMITED", message: "Demasiados intentos de gestion de credenciales. Espere quince minutos." }, { status: 429, headers: { "Retry-After": "900" } }) };
  }
  const contentType = request.headers.get("Content-Type") ?? "";
  if (scope === "stage" ? !isMultipartFormData(contentType) : !isJsonRequest(request)) {
    return { ok: false, response: jsonResponse(request, unsupportedMediaType(), { status: 415 }) };
  }
  const maxBodyBytes = scope === "stage" ? 550_000 : 8_192;
  const declaredLengthHeader = request.headers.get("Content-Length");
  const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);
  if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBodyBytes)) return { ok: false, response: payloadTooLarge(request) };
  const rawBody = await readBoundedBody(request, maxBodyBytes);
  if (rawBody === null) return { ok: false, response: payloadTooLarge(request) };
  let body: unknown;
  if (scope === "stage") {
    body = rawBody;
  } else {
    try { body = JSON.parse(rawBody.toString("utf8")) as unknown; }
    catch {
      rawBody.fill(0);
      return { ok: false, response: jsonResponse(request, invalidJson(), { status: 400 }) };
    }
  }
  return { ok: true, user: authorization.user, correlationId, clientIdempotencyKey: idempotency.key, rawBody, body };
}

async function consumeCredentialRateLimit(userId: string, scope: "stage" | "activate"): Promise<boolean> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 15 * 60_000);
  const key = `verifactu-credential:${scope}:${userId}`;
  const [bucket] = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (${randomUUID()}::uuid, ${key}, ${now}, 1, ${now}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN 1 ELSE "rate_limit_buckets"."count" + 1 END,
      "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN ${now} ELSE "rate_limit_buckets"."windowStart" END,
      "updatedAt" = ${now}
    RETURNING "count"
  `;
  return Boolean(bucket && bucket.count > (scope === "stage" ? 5 : 3));
}

function payloadTooLarge(request: Request): Response {
  return jsonResponse(request, { code: "PAYLOAD_TOO_LARGE", message: "La peticion supera el tamano permitido." }, { status: 413 });
}

function isMultipartFormData(contentType: string): boolean {
  return /^multipart\/form-data\s*;\s*boundary=[^;\s]+/i.test(contentType);
}

async function readBoundedBody(request: Request, maxBodyBytes: number): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      chunks.push(Buffer.from(value));
      value.fill(0);
      if (size > maxBodyBytes) {
        await reader.cancel();
        return null;
      }
    }
    return Buffer.concat(chunks, size);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}
