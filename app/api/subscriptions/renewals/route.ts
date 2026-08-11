import { cookies } from "next/headers";
import { z } from "zod";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { getCorrelationId, idempotencyStorageKey, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse, originNotAllowed, readBoundedTextBody, unsupportedMediaType, validateIdempotencyKey, validationError } from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import { createSubscriptionRenewalDraft, currentSubscriptionRenewalCompanyId, hashSubscriptionRenewalDraftRequest, listSubscriptionRenewalPreview, listSubscriptionRenewalPreviewSchema, subscriptionRenewalBusinessDate, subscriptionRenewalDateOnlySchema } from "@/modules/subscriptions/application/renewals";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const prepareSchema = z.object({
  subscriptions: z.array(z.object({
    subscriptionId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    pendingExclusionId: z.string().uuid().optional(),
    lineDescriptionOverrides: z.array(z.object({
      subscriptionLineId: z.string().uuid(),
      description: z.string().trim().min(1).max(500)
    }).strict()).max(100).optional()
  }).strict()).min(1).max(100),
  issueDate: subscriptionRenewalDateOnlySchema
}).strict().superRefine((value, context) => {
  if (new Set(value.subscriptions.map((subscription) => subscription.subscriptionId)).size !== value.subscriptions.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["subscriptions"], message: "No se puede repetir una suscripcion." });
  }
  const overrideCount = value.subscriptions.reduce((count, subscription) => count + (subscription.lineDescriptionOverrides?.length ?? 0), 0);
  if (overrideCount > 100) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["subscriptions"], message: "No se pueden personalizar mas de 100 lineas por preparacion." });
  }
  value.subscriptions.forEach((subscription, index) => {
    const lineIds = subscription.lineDescriptionOverrides?.map((override) => override.subscriptionLineId) ?? [];
    if (new Set(lineIds).size !== lineIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["subscriptions", index, "lineDescriptionOverrides"], message: "No se puede repetir una linea personalizada." });
    }
  });
});

export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const authorization = await requirePermission(token, "Subscriptions.RunRenewals", { correlationId });
  if (!authorization.ok) return jsonResponse(request, authorization.error, { status: authorization.status });
  const query = new URL(request.url).searchParams;
  const allowedQueryKeys = new Set(["processDate", "includePending", "limit", "cursor"]);
  if ([...query.keys()].some((key) => !allowedQueryKeys.has(key) || query.getAll(key).length !== 1)) {
    return privateGetResponse(request, validationError({ formErrors: ["Los parametros de consulta no son validos."], fieldErrors: {} }), 422);
  }
  const includePending = query.get("includePending");
  if (includePending !== null && includePending !== "true" && includePending !== "false") {
    return privateGetResponse(request, validationError({ formErrors: [], fieldErrors: { includePending: ["Debe ser true o false."] } }), 422);
  }
  const payload = listSubscriptionRenewalPreviewSchema.safeParse({
    processDate: query.get("processDate") ?? await subscriptionRenewalBusinessDate(),
    includePending: includePending === "true",
    limit: query.get("limit") ?? undefined,
    cursor: query.get("cursor") ?? undefined
  });
  if (!payload.success) return privateGetResponse(request, validationError(payload.error.flatten()), 422);
  const result = await listSubscriptionRenewalPreview(payload.data, authorization.user, { correlationId });
  return privateGetResponse(request, result.ok ? result.value : result.error, result.status);
}

function privateGetResponse<TBody>(request: Request, body: TBody, status: number) {
  return jsonResponse(request, body, { status, headers: { "Cache-Control": "private, no-store, max-age=0" } });
}

export async function POST(request: Request) {
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
  const rawBody = await readBoundedTextBody(request, 65_536);
  if (rawBody === null) return jsonResponse(request, { code: "PAYLOAD_TOO_LARGE", message: "La peticion supera el tamano permitido." }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { return jsonResponse(request, invalidJson(), { status: 400 }); }
  const payload = prepareSchema.safeParse(body);
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  if (payload.data.issueDate > await subscriptionRenewalBusinessDate()) {
    return jsonResponse(request, { code: "SUBSCRIPTION_RENEWAL_PROCESS_DATE_IN_FUTURE", message: "La fecha de emision no puede ser futura." }, { status: 422 });
  }
  const companyId = await currentSubscriptionRenewalCompanyId();
  if (!companyId) return jsonResponse(request, { code: "PLATFORM_NOT_INITIALIZED", message: "La plataforma no esta inicializada." }, { status: 409 });
  const subscriptions = [...payload.data.subscriptions].sort((left, right) => left.subscriptionId.localeCompare(right.subscriptionId));
  const command = {
    companyId, subscriptionIds: subscriptions.map((subscription) => subscription.subscriptionId), issueDate: payload.data.issueDate,
    expectedVersions: Object.fromEntries(subscriptions.map((subscription) => [subscription.subscriptionId, subscription.expectedVersion])),
    pendingExclusionIds: Object.fromEntries(subscriptions.flatMap((subscription) => subscription.pendingExclusionId
      ? [[subscription.subscriptionId, subscription.pendingExclusionId]] : [])),
    lineDescriptionOverrides: subscriptions.flatMap((subscription) => subscription.lineDescriptionOverrides?.map((override) => ({
      subscriptionId: subscription.subscriptionId,
      subscriptionLineId: override.subscriptionLineId,
      description: override.description
    })) ?? [])
  };
  const result = await createSubscriptionRenewalDraft(command, authorization.user, {
    correlationId,
    idempotencyKey: idempotencyStorageKey(authorization.user.id, "subscription-renewal-prepare", companyId, idempotency.key),
    requestHash: hashSubscriptionRenewalDraftRequest(command)
  });
  return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status, ...(result.status === 429 ? { headers: { "Retry-After": "900" } } : {}) });
}
