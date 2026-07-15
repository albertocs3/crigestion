import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { hashVerifactuInterventionBody, interveneVerifactuDeadMessage, interveneVerifactuMessageSchema } from "@/modules/billing/application/verifactuOperations";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { getCorrelationId, idempotencyStorageKey, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse, originNotAllowed, unsupportedMediaType, validateIdempotencyKey, validationError } from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ messageId: string }> }) {
  if (!isAllowedOrigin(request)) return jsonResponse(request, originNotAllowed(), { status: 403 });
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return jsonResponse(request, csrf.error, { status: csrf.status });
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Billing.ManageVerifactuOperations", { correlationId });
  if (!authorization.ok) return jsonResponse(request, authorization.error, { status: authorization.status });
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) return jsonResponse(request, maintenance.error, { status: maintenance.status });
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) return jsonResponse(request, idempotency.error, { status: idempotency.status });
  if (!isJsonRequest(request)) return jsonResponse(request, unsupportedMediaType(), { status: 415 });
  if (await consumeRateLimit(authorization.user.id)) {
    await prisma.auditEvent.create({ data: { eventType: "VERIFACTU_OUTBOX_INTERVENTION_RATE_LIMITED", actorType: "USER", payload: { actorUserId: authorization.user.id, correlationId } } });
    return jsonResponse(request, { code: "RATE_LIMITED", message: "Demasiadas intervenciones VeriFactu. Espere quince minutos." }, { status: 429, headers: { "Retry-After": "900" } });
  }
  const raw = await readBoundedBody(request, 4_096);
  if (raw === null) return jsonResponse(request, { code: "PAYLOAD_TOO_LARGE", message: "La peticion supera el tamano permitido." }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return jsonResponse(request, invalidJson(), { status: 400 }); }
  const payload = interveneVerifactuMessageSchema.safeParse(body);
  const { messageId } = await context.params;
  if (!payload.success || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId)) {
    return jsonResponse(request, validationError(payload.success ? { messageId: ["UUID invalido."] } : payload.error.flatten()), { status: 422 });
  }
  const requestHash = hashVerifactuInterventionBody(payload.data);
  const storageKey = idempotencyStorageKey(authorization.user.id, "verifactu-outbox-intervene", messageId, idempotency.key);
  const result = await interveneVerifactuDeadMessage({ messageId, ...payload.data, actor: authorization.user, correlationId, idempotencyKey: storageKey, requestHash });
  return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status });
}

async function consumeRateLimit(userId: string): Promise<boolean> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 15 * 60_000);
  const [bucket] = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (${randomUUID()}::uuid, ${`verifactu-operations:${userId}`}, ${now}, 1, ${now}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN 1 ELSE "rate_limit_buckets"."count" + 1 END,
      "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN ${now} ELSE "rate_limit_buckets"."windowStart" END,
      "updatedAt" = ${now}
    RETURNING "count"
  `;
  return Boolean(bucket && bucket.count > 10);
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString("utf8");
  } finally { reader.releaseLock(); }
}
