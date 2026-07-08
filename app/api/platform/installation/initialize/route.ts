import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  hashRequestBody,
  initializePlatform,
  initializeSchema
} from "@/modules/platform/application/installation";
import {
  getRequestContext,
  invalidJson,
  isAllowedOrigin,
  isJsonRequest,
  jsonResponse,
  originNotAllowed,
  unsupportedMediaType,
  validateIdempotencyKey,
  validationError
} from "@/modules/platform/application/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const initializeRateLimitWindowMs = 60_000;
const maxInitializeAttemptsByIp = 10;

export async function POST(request: Request) {
  const rateLimit = await consumeInitializeRateLimit(request);

  if (rateLimit.limited) {
    return jsonResponse(
      request,
      {
        code: "RATE_LIMITED",
        message: "Demasiados intentos de inicializacion. Espera antes de reintentar.",
        retryAfterSeconds: rateLimit.retryAfterSeconds
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimit.retryAfterSeconds)
        }
      }
    );
  }

  if (!isAllowedOrigin(request)) {
    return jsonResponse(request, originNotAllowed(), { status: 403 });
  }

  if (!isJsonRequest(request)) {
    return jsonResponse(request, unsupportedMediaType(), { status: 415 });
  }

  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));

  if (!idempotency.ok) {
    return jsonResponse(request, idempotency.error, { status: idempotency.status });
  }

  let rawBody: string;

  try {
    rawBody = await request.text();
  } catch {
    return jsonResponse(request, invalidJson(), { status: 400 });
  }

  let body: unknown;

  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse(request, invalidJson(), { status: 400 });
  }

  const payload = initializeSchema.safeParse(body);

  if (!payload.success) {
    return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  }

  const result = await initializePlatform(
    payload.data,
    idempotency.key,
    hashRequestBody(rawBody)
  );

  if (!result.ok) {
    return jsonResponse(
      request,
      result.error,
      { status: result.status }
    );
  }

  return jsonResponse(request, result.value, { status: result.status });
}

async function consumeInitializeRateLimit(
  request: Request
): Promise<{ limited: false } | { limited: true; retryAfterSeconds: number }> {
  const context = getRequestContext(request);

  if (!context.ipAddress) {
    return { limited: false };
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() - initializeRateLimitWindowMs);
  const key = `initialize:${context.ipAddress}`;
  const bucketId = randomUUID();
  const [bucket] = await prisma.$queryRaw<Array<{ count: number; windowStart: Date }>>`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (${bucketId}::uuid, ${key}, ${now}, 1, ${now}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN 1
        ELSE "rate_limit_buckets"."count" + 1
      END,
      "windowStart" = CASE
        WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN ${now}
        ELSE "rate_limit_buckets"."windowStart"
      END,
      "updatedAt" = ${now}
    RETURNING "count", "windowStart"
  `;

  if (!bucket || bucket.count <= maxInitializeAttemptsByIp) {
    return { limited: false };
  }

  const retryAfterMs = Math.max(
    1_000,
    bucket.windowStart.getTime() + initializeRateLimitWindowMs - now.getTime()
  );

  return {
    limited: true,
    retryAfterSeconds: Math.ceil(retryAfterMs / 1_000)
  };
}
