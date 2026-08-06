import { cookies } from "next/headers";
import { z } from "zod";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { getCorrelationId, idempotencyStorageKey, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse, originNotAllowed, readBoundedTextBody, unsupportedMediaType, validateIdempotencyKey, validationError } from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import { currentSubscriptionRenewalCompanyId, hashSubscriptionRenewalReleaseRequest, releaseSubscriptionRenewal } from "@/modules/subscriptions/application/renewals";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const paramsSchema = z.object({ invoiceId: z.string().uuid() });
const bodySchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export async function POST(request: Request, context: { params: Promise<{ invoiceId: string }> }) {
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });
  if (!isAllowedOrigin(request)) return jsonResponse(request, originNotAllowed(), { status: 403 });
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return jsonResponse(request, csrf.error, { status: csrf.status });
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Subscriptions.RunRenewals", { correlationId });
  if (!authorization.ok) return jsonResponse(request, authorization.error, { status: authorization.status });
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) return jsonResponse(request, maintenance.error, { status: maintenance.status });
  if (!isJsonRequest(request)) return jsonResponse(request, unsupportedMediaType(), { status: 415 });
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) return jsonResponse(request, idempotency.error, { status: idempotency.status });
  const rawBody = await readBoundedTextBody(request, 2_048);
  if (rawBody === null) return jsonResponse(request, { code: "PAYLOAD_TOO_LARGE", message: "La peticion supera el tamano permitido." }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { return jsonResponse(request, invalidJson(), { status: 400 }); }
  const payload = bodySchema.safeParse(body);
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  const companyId = await currentSubscriptionRenewalCompanyId();
  if (!companyId) return jsonResponse(request, { code: "PLATFORM_NOT_INITIALIZED", message: "La plataforma no esta inicializada." }, { status: 409 });
  const command = { companyId, invoiceId: params.data.invoiceId, reason: payload.data.reason };
  const result = await releaseSubscriptionRenewal(command, authorization.user, {
    correlationId,
    idempotencyKey: idempotencyStorageKey(authorization.user.id, "subscription-renewal-release", params.data.invoiceId, idempotency.key),
    requestHash: hashSubscriptionRenewalReleaseRequest(command)
  });
  return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status, ...(result.status === 429 ? { headers: { "Retry-After": "900" } } : {}) });
}
