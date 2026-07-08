import { cookies } from "next/headers";
import { z } from "zod";
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
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import {
  issueInvoice,
  issueInvoiceSchema
} from "@/modules/billing/application/invoices";

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

  const maintenance = await requireMaintenanceModeInactive(
    authorization.user,
    request,
    { correlationId }
  );

  if (!maintenance.ok) {
    return jsonResponse(request, maintenance.error, { status: maintenance.status });
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

  const payload = issueInvoiceSchema.safeParse(normalizeIssueInvoiceBody(body));

  if (!payload.success) {
    return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  }

  const result = await issueInvoice(
    params.data.invoiceId,
    payload.data,
    authorization.user,
    { correlationId }
  );

  if (!result.ok) {
    return jsonResponse(request, result.error, { status: result.status });
  }

  return jsonResponse(request, result.value, { status: result.status });
}

function normalizeIssueInvoiceBody(body: unknown): unknown {
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

function normalizeDateOnlyInput(value: string): string {
  const text = value.trim().replace(/[\u200e\u200f]/g, "");

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    return text.slice(0, 10);
  }

  const localized = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(text);

  if (!localized) {
    return text;
  }

  const [, day, month, year] = localized;

  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}
