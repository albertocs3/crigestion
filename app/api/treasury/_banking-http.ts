import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { hashRequestBody } from "@/modules/platform/application/installation";
import { getCorrelationId, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse, originNotAllowed, unsupportedMediaType, validateIdempotencyKey } from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";

export async function authorizeBankingRead(request: Request): Promise<{ ok: true; user: SessionUser; correlationId: string | undefined } | { ok: false; response: Response }> {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Treasury.ViewBanking", { correlationId });
  if (!authorization.ok) return { ok: false, response: jsonResponse(request, authorization.error, { status: authorization.status }) };
  return { ok: true, user: authorization.user, correlationId };
}

async function consumeStatementImportRateLimit(userId: string): Promise<boolean> {
  const now = new Date(); const windowStart = new Date(now.getTime() - 60_000); const key = `n43-import:${userId}`;
  const [bucket] = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (${randomUUID()}::uuid, ${key}, ${now}, 1, ${now}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN 1 ELSE "rate_limit_buckets"."count" + 1 END,
      "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN ${now} ELSE "rate_limit_buckets"."windowStart" END,
      "updatedAt" = ${now}
    RETURNING "count"
  `;
  return Boolean(bucket && bucket.count > 10);
}

export async function authorizeBankingMutation(request: Request, permission = "Treasury.ReconcileBanking", maxBodyBytes = 1024 * 1024): Promise<
  | { ok: true; user: SessionUser; correlationId: string | undefined; idempotencyKey: string; requestHash: string; body: unknown }
  | { ok: false; response: Response }
> {
  if (!isAllowedOrigin(request)) return { ok: false, response: jsonResponse(request, originNotAllowed(), { status: 403 }) };
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return { ok: false, response: jsonResponse(request, csrf.error, { status: csrf.status }) };
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, permission, { correlationId });
  if (!authorization.ok) return { ok: false, response: jsonResponse(request, authorization.error, { status: authorization.status }) };
  if (permission === "Treasury.ImportBankStatements") {
    const limited = await consumeStatementImportRateLimit(authorization.user.id);
    if (limited) return { ok: false, response: jsonResponse(request, { code: "RATE_LIMITED", message: "Demasiados intentos de importacion. Espere un minuto." }, { status: 429, headers: { "Retry-After": "60" } }) };
  }
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) return { ok: false, response: jsonResponse(request, maintenance.error, { status: maintenance.status }) };
  if (!isJsonRequest(request)) return { ok: false, response: jsonResponse(request, unsupportedMediaType(), { status: 415 }) };
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) return { ok: false, response: jsonResponse(request, idempotency.error, { status: idempotency.status }) };
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) return { ok: false, response: jsonResponse(request, { code: "PAYLOAD_TOO_LARGE", message: "La peticion supera el tamano permitido." }, { status: 413 }) };
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > maxBodyBytes) return { ok: false, response: jsonResponse(request, { code: "PAYLOAD_TOO_LARGE", message: "La peticion supera el tamano permitido." }, { status: 413 }) };
  try {
    return { ok: true, user: authorization.user, correlationId, idempotencyKey: idempotency.key, requestHash: hashRequestBody(rawBody), body: JSON.parse(rawBody) as unknown };
  } catch {
    return { ok: false, response: jsonResponse(request, invalidJson(), { status: 400 }) };
  }
}
