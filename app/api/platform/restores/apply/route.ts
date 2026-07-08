import { cookies } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  requirePermission,
  sessionCookieName,
  validateCsrfToken
} from "@/modules/platform/application/auth";
import {
  getCorrelationId,
  invalidJson,
  isAllowedOrigin,
  isJsonRequest,
  jsonResponse,
  originNotAllowed,
  unsupportedMediaType,
  validateIdempotencyKey,
  validationError
} from "@/modules/platform/application/http";
import {
  createPgRestoreApplyPort,
  processNextValidatedRestoreApply
} from "@/modules/platform/infrastructure/restoreExecutor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const requiredPermission = "Platform.ManageMaintenance";
const applyRestoreSchema = z.object({}).strict();

export async function POST(request: Request) {
  const correlationId = getCorrelationId(request);

  if (!isAllowedOrigin(request)) {
    return jsonResponse(request, originNotAllowed(), { status: 403 });
  }

  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(sessionToken, request.headers.get("X-CSRF-Token"));

  if (!csrf.ok) {
    return jsonResponse(request, csrf.error, { status: csrf.status });
  }

  const authorization = await requirePermission(
    sessionToken,
    requiredPermission,
    { correlationId }
  );

  if (!authorization.ok) {
    return jsonResponse(request, authorization.error, { status: authorization.status });
  }

  if (!isJsonRequest(request)) {
    return jsonResponse(request, unsupportedMediaType(), { status: 415 });
  }

  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));

  if (!idempotency.ok) {
    return jsonResponse(request, idempotency.error, { status: idempotency.status });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, invalidJson(), { status: 400 });
  }

  const payload = applyRestoreSchema.safeParse(body);

  if (!payload.success) {
    return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  }

  const result = await processNextValidatedRestoreApply({
    prisma,
    actor: {
      userId: authorization.user.id,
      correlationId
    },
    applyRestore: createPgRestoreApplyPort({
      targetDatabaseUrl: restoreTargetDatabaseUrl()
    })
  });

  if (!result.processed) {
    return jsonResponse(
      request,
      {
        code: "NO_VALIDATED_RESTORE_IN_MAINTENANCE",
        message: "No hay una restauracion validada con mantenimiento activo."
      },
      { status: 409 }
    );
  }

  if (result.status !== "COMPLETED") {
    return jsonResponse(
      request,
      {
        code: result.errorCode,
        message: "No se pudo aplicar la restauracion.",
        restore: result
      },
      { status: 500 }
    );
  }

  return jsonResponse(request, result, { status: 200 });
}

function restoreTargetDatabaseUrl(): string | undefined {
  if (process.env.RESTORE_TARGET_DATABASE_URL) {
    return process.env.RESTORE_TARGET_DATABASE_URL;
  }

  if (process.env.NODE_ENV !== "production") {
    return process.env.DATABASE_URL;
  }

  return undefined;
}
