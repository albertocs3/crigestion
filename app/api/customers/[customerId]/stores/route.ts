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
  validationError
} from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import {
  createCustomerStore,
  createCustomerStoreSchema,
  listCustomerStores,
  listCustomerStoresSchema
} from "@/modules/customers/application/stores";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const viewPermission = "Customers.View";
const managePermission = "Customers.Manage";
const paramsSchema = z.object({
  customerId: z.string().uuid()
});

export async function GET(
  request: Request,
  context: { params: Promise<{ customerId: string }> }
) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(sessionCookieName)?.value;
  const authorization = await requirePermission(sessionToken, viewPermission, {
    correlationId: getCorrelationId(request)
  });

  if (!authorization.ok) {
    return jsonResponse(request, authorization.error, { status: authorization.status });
  }

  const params = paramsSchema.safeParse(await context.params);

  if (!params.success) {
    return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });
  }

  const searchParams = new URL(request.url).searchParams;
  const payload = listCustomerStoresSchema.safeParse({
    status: searchParams.get("status") ?? undefined
  });

  if (!payload.success) {
    return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  }

  const result = await listCustomerStores(
    params.data.customerId,
    payload.data,
    authorization.user
  );

  if (!result) {
    return jsonResponse(
      request,
      { code: "CUSTOMER_NOT_FOUND", message: "El cliente no existe." },
      { status: 404 }
    );
  }

  return jsonResponse(request, result);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ customerId: string }> }
) {
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
  const authorization = await requirePermission(sessionToken, managePermission, {
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

  const params = paramsSchema.safeParse(await context.params);

  if (!params.success) {
    return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });
  }

  if (!isJsonRequest(request)) {
    return jsonResponse(request, unsupportedMediaType(), { status: 415 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, invalidJson(), { status: 400 });
  }

  const payload = createCustomerStoreSchema.safeParse(body);

  if (!payload.success) {
    return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  }

  const result = await createCustomerStore(
    params.data.customerId,
    payload.data,
    authorization.user,
    { correlationId }
  );

  if (!result.ok) {
    return jsonResponse(request, result.error, { status: result.status });
  }

  return jsonResponse(request, result.value, { status: result.status });
}
