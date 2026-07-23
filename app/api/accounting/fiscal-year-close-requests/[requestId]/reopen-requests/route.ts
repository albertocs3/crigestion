import { cookies } from "next/headers";
import { z } from "zod";
import {
  hashFiscalYearReopenRequest,
  requestFiscalYearReopening,
  requestFiscalYearReopeningSchema
} from "@/modules/accounting/application/fiscalYearReopenRequests";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import {
  getCorrelationId,
  idempotencyStorageKey,
  invalidJson,
  isAllowedOrigin,
  isJsonRequest,
  jsonResponse,
  originNotAllowed,
  unsupportedMediaType,
  validateIdempotencyKey,
  validationError
} from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type RouteContext = { params: Promise<{ requestId: string }> };
const paramsSchema = z.object({ requestId: z.string().uuid() }).strict();
const maxBodyBytes = 16 * 1024;

export async function POST(request: Request, context: RouteContext) {
  if (!isAllowedOrigin(request)) return jsonResponse(request, originNotAllowed(), { status: 403 });
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return jsonResponse(request, csrf.error, { status: csrf.status });
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Accounting.RequestExerciseReopenings", { correlationId });
  if (!authorization.ok) return jsonResponse(request, authorization.error, { status: authorization.status });
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) return jsonResponse(request, maintenance.error, { status: maintenance.status });
  if (!isJsonRequest(request)) return jsonResponse(request, unsupportedMediaType(), { status: 415 });
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) return jsonResponse(request, idempotency.error, { status: idempotency.status });
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });

  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) return payloadTooLarge(request);
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > maxBodyBytes) return payloadTooLarge(request);
  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return jsonResponse(request, invalidJson(), { status: 400 });
  }
  const command = requestFiscalYearReopeningSchema.safeParse(body);
  if (!command.success) return jsonResponse(request, validationError(command.error.flatten()), { status: 422 });
  const result = await requestFiscalYearReopening(params.data.requestId, command.data, authorization.user, {
    correlationId,
    idempotencyKey: idempotencyStorageKey(authorization.user.id, "accounting-fiscal-year-reopen-request", params.data.requestId, idempotency.key),
    requestHash: hashFiscalYearReopenRequest(params.data.requestId, command.data)
  });
  return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status });
}

function payloadTooLarge(request: Request): Response {
  return jsonResponse(request, { code: "PAYLOAD_TOO_LARGE", message: "La peticion supera el tamano permitido." }, { status: 413 });
}
