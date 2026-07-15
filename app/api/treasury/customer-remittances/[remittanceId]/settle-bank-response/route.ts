import { cookies } from "next/headers";
import {
  requirePermission,
  sessionCookieName,
  validateCsrfToken
} from "@/modules/platform/application/auth";
import {
  getCorrelationId,
  hashIdempotencyPayload,
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
  settleCustomerRemittanceBankResponse,
  settleCustomerRemittanceBankResponseSchema
} from "@/modules/treasury/application/remittances";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const managePaymentsPermission = "Treasury.ManagePayments";

type RouteContext = {
  params: Promise<{
    remittanceId: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
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
  const authorization = await requirePermission(sessionToken, managePaymentsPermission, {
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

  const payload = settleCustomerRemittanceBankResponseSchema.safeParse(body);

  if (!payload.success) {
    return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  }

  const params = await context.params;
  const idempotencyScope = "treasury.remittances.settle-bank-response.v1";
  const result = await settleCustomerRemittanceBankResponse(
    params.remittanceId,
    payload.data,
    authorization.user,
    {
      correlationId,
      idempotencyKey: idempotencyStorageKey(
        authorization.user.id,
        idempotencyScope,
        params.remittanceId,
        idempotency.key
      ),
      requestHash: hashIdempotencyPayload(idempotencyScope, {
        remittanceId: params.remittanceId,
        command: {
          ...payload.data,
          paidLineIds: [...payload.data.paidLineIds].sort(),
          rejectedLineIds: [...payload.data.rejectedLineIds].sort()
        }
      })
    }
  );

  if (!result.ok) {
    return jsonResponse(request, result.error, { status: result.status });
  }

  return jsonResponse(request, result.value, { status: result.status });
}
