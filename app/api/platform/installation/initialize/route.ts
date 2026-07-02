import {
  hashRequestBody,
  initializePlatform,
  initializeSchema
} from "@/modules/platform/application/installation";
import {
  invalidJson,
  isAllowedOrigin,
  isJsonRequest,
  jsonResponse,
  originNotAllowed,
  unsupportedMediaType,
  validationError
} from "@/modules/platform/application/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const globalForRateLimit = globalThis as unknown as {
  initializeRateLimit?: Map<string, { count: number; resetAt: number }>;
};

const initializeRateLimit =
  globalForRateLimit.initializeRateLimit ?? new Map<string, { count: number; resetAt: number }>();

if (!globalForRateLimit.initializeRateLimit) {
  globalForRateLimit.initializeRateLimit = initializeRateLimit;
}

function isRateLimited(request: Request): boolean {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const ipAddress = forwardedFor?.split(",")[0]?.trim() ?? "local";
  const now = Date.now();
  const windowMs = 60_000;
  const maxAttempts = 10;
  const current = initializeRateLimit.get(ipAddress);

  if (!current || current.resetAt <= now) {
    initializeRateLimit.set(ipAddress, { count: 1, resetAt: now + windowMs });
    return false;
  }

  current.count += 1;
  return current.count > maxAttempts;
}

export async function POST(request: Request) {
  if (isRateLimited(request)) {
    return jsonResponse(
      request,
      {
        code: "RATE_LIMITED",
        message: "Demasiados intentos de inicializacion. Espera antes de reintentar."
      },
      { status: 429 }
    );
  }

  if (!isAllowedOrigin(request)) {
    return jsonResponse(request, originNotAllowed(), { status: 403 });
  }

  if (!isJsonRequest(request)) {
    return jsonResponse(request, unsupportedMediaType(), { status: 415 });
  }

  const idempotencyKey = request.headers.get("Idempotency-Key");

  if (!idempotencyKey) {
    return jsonResponse(
      request,
      {
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "La cabecera Idempotency-Key es obligatoria."
      },
      { status: 400 }
    );
  }

  if (idempotencyKey.length > 160) {
    return jsonResponse(
      request,
      {
        code: "IDEMPOTENCY_KEY_INVALID",
        message: "La cabecera Idempotency-Key no puede superar 160 caracteres."
      },
      { status: 400 }
    );
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
    idempotencyKey,
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
