import { cookies } from "next/headers";
import {
  requirePermission,
  sessionCookieName,
  validateCsrfToken
} from "@/modules/platform/application/auth";
import {
  getCorrelationId,
  isAllowedOrigin,
  jsonResponse,
  originNotAllowed,
  validateIdempotencyKey
} from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import { generateCustomerRemittanceSepa } from "@/modules/treasury/application/remittances";

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

  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));

  if (!idempotency.ok) {
    return jsonResponse(request, idempotency.error, { status: idempotency.status });
  }

  const params = await context.params;
  const result = await generateCustomerRemittanceSepa(
    params.remittanceId,
    authorization.user,
    { correlationId }
  );

  if (!result.ok) {
    return jsonResponse(request, result.error, { status: result.status });
  }

  return jsonResponse(request, result.value, { status: result.status });
}
