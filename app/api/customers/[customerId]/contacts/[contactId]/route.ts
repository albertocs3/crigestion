import { cookies } from "next/headers";
import {
  requirePermission,
  sessionCookieName,
  validateCsrfToken,
} from "@/modules/platform/application/auth";
import {
  getCorrelationId,
  invalidJson,
  isAllowedOrigin,
  isJsonRequest,
  jsonResponse,
  originNotAllowed,
  readBoundedTextBody,
  unsupportedMediaType,
  validateIdempotencyKey,
  validationError,
} from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import {
  changeCustomerContact,
  customerContactActionSchema,
  customerContactParamsSchema,
  hashCustomerContactRequest,
} from "@/modules/customers/application/contacts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ customerId: string; contactId: string }> },
) {
  if (!isAllowedOrigin(request))
    return response(request, originNotAllowed(), 403);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return response(request, csrf.error, csrf.status);
  const correlationId = getCorrelationId(request);
  const auth = await requirePermission(token, "Customers.Manage", {
    correlationId,
  });
  if (!auth.ok) return response(request, auth.error, auth.status);
  const view = await requirePermission(token, "Customers.View", {
    correlationId,
  });
  if (!view.ok) return response(request, view.error, view.status);
  const maintenance = await requireMaintenanceModeInactive(auth.user, request, {
    correlationId,
  });
  if (!maintenance.ok)
    return response(request, maintenance.error, maintenance.status);
  const params = customerContactParamsSchema.safeParse(await context.params);
  if (!params.success || !params.data.contactId)
    return response(
      request,
      validationError(
        params.success
          ? {
              fieldErrors: { contactId: ["Identificador obligatorio."] },
              formErrors: [],
            }
          : params.error.flatten(),
      ),
      422,
    );
  if (!isJsonRequest(request))
    return response(request, unsupportedMediaType(), 415);
  const idem = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idem.ok) return response(request, idem.error, idem.status);
  const raw = await readBoundedTextBody(request, 4_096);
  if (raw === null)
    return response(
      request,
      {
        code: "PAYLOAD_TOO_LARGE",
        message: "La petición supera el tamaño máximo permitido.",
      },
      413,
    );
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return response(request, invalidJson(), 400);
  }
  const parsed = customerContactActionSchema.safeParse(body);
  if (!parsed.success)
    return response(request, validationError(parsed.error.flatten()), 422);
  const result = await changeCustomerContact(
    params.data.customerId,
    params.data.contactId,
    parsed.data,
    auth.user,
    {
      idempotencyKey: idem.key,
      requestHash: hashCustomerContactRequest({
        contactId: params.data.contactId,
        ...parsed.data,
      }),
      scope: `customer:${params.data.customerId}:contact:${params.data.contactId}:change`,
      correlationId,
    },
  );
  return result.ok
    ? response(request, result.value, result.status)
    : response(request, result.error, result.status);
}

function response(request: Request, body: unknown, status: number) {
  return jsonResponse(request, body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      ...(status === 503 ? { "Retry-After": "3" } : {}),
    },
  });
}
