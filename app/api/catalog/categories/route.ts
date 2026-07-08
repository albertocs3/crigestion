import { cookies } from "next/headers";
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
  createCatalogCategory,
  createCatalogCategorySchema,
  listCatalogCategories,
  listCatalogCategoriesSchema
} from "@/modules/catalog/application/categories";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const requiredPermission = "Catalog.Manage";

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(sessionCookieName)?.value;
  const authorization = await requirePermission(sessionToken, requiredPermission, {
    correlationId: getCorrelationId(request)
  });

  if (!authorization.ok) {
    return jsonResponse(request, authorization.error, { status: authorization.status });
  }

  const searchParams = new URL(request.url).searchParams;
  const payload = listCatalogCategoriesSchema.safeParse({
    includeInactive: searchParams.get("includeInactive") ?? undefined
  });

  if (!payload.success) {
    return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  }

  return jsonResponse(request, { items: await listCatalogCategories(payload.data) });
}

export async function POST(request: Request) {
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
  const authorization = await requirePermission(sessionToken, requiredPermission, {
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

  const payload = createCatalogCategorySchema.safeParse(body);

  if (!payload.success) {
    return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  }

  const result = await createCatalogCategory(payload.data, authorization.user, {
    correlationId
  });

  if (!result.ok) {
    return jsonResponse(request, result.error, { status: result.status });
  }

  return jsonResponse(request, result.value, { status: result.status });
}
