import { cookies } from "next/headers";
import { z } from "zod";
import {
  requirePermission,
  sessionCookieName,
  validateCsrfToken
} from "@/modules/platform/application/auth";
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
import {
  createInvoiceRectification,
  createInvoiceRectificationSchema,
  hashInvoiceRectificationBody,
  readInvoiceRectificationReplay,
  normalizeDateOnlyInput
} from "@/modules/billing/application/invoices";
import { readConfiguredVerifactuAltaPreparer } from "@/modules/billing/infrastructure/verifactu/configuredPreparer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const issuePermission = "Billing.Issue";
const paramsSchema = z.object({
  invoiceId: z.string().uuid()
});

export async function POST(
  request: Request,
  context: { params: Promise<{ invoiceId: string }> }
) {
  const params = paramsSchema.safeParse(await context.params);

  if (!params.success) {
    return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });
  }

  if (!isAllowedOrigin(request)) {
    return jsonResponse(request, originNotAllowed(), { status: 403 });
  }

  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(sessionToken, request.headers.get("X-CSRF-Token"));

  if (!csrf.ok) {
    return jsonResponse(request, csrf.error, { status: csrf.status });
  }

  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(sessionToken, issuePermission, {
    correlationId
  });

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

  const payload = createInvoiceRectificationSchema.safeParse(
    normalizeRectificationBody(body)
  );

  if (!payload.success) {
    return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  }

  const storageKey = idempotencyStorageKey(authorization.user.id, "invoice-rectification", params.data.invoiceId, idempotency.key);
  const requestHash = hashInvoiceRectificationBody(payload.data);
  const replay = await readInvoiceRectificationReplay(storageKey, requestHash);
  if (replay) return jsonResponse(request, replay.ok ? replay.value : replay.error, { status: replay.status });

  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) return jsonResponse(request, maintenance.error, { status: maintenance.status });

  const result = await createInvoiceRectification(
    params.data.invoiceId,
    payload.data,
    authorization.user,
    {
      correlationId,
      idempotencyKey: storageKey,
      requestHash
    },
    { prepareVerifactuAlta: readConfiguredVerifactuAltaPreparer() }
  );

  if (!result.ok) {
    return jsonResponse(request, result.error, { status: result.status });
  }

  return jsonResponse(request, result.value, { status: result.status });
}

function normalizeRectificationBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }

  const candidate = body as { issueDate?: unknown };

  if (typeof candidate.issueDate !== "string") {
    return body;
  }

  return {
    ...body,
    issueDate: normalizeDateOnlyInput(candidate.issueDate)
  };
}
