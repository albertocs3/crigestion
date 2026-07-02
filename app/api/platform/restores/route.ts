import { cookies } from "next/headers";
import {
  requirePermission,
  sessionCookieName,
  validateCsrfToken
} from "@/modules/platform/application/auth";
import {
  listRestoreOperations,
  listRestoreOperationsSchema,
  requestRestore,
  requestRestoreSchema
} from "@/modules/platform/application/restores";
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

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const requiredPermission = "Platform.ManageBackups";

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(sessionCookieName)?.value;
  const authorization = await requirePermission(
    sessionToken,
    requiredPermission,
    { correlationId: getCorrelationId(request) }
  );

  if (!authorization.ok) {
    return jsonResponse(request, authorization.error, { status: authorization.status });
  }

  const searchParams = new URL(request.url).searchParams;
  const payload = listRestoreOperationsSchema.safeParse({
    limit: searchParams.get("limit") ?? undefined,
    cursor: searchParams.get("cursor") ?? undefined,
    status: searchParams.get("status") ?? undefined
  });

  if (!payload.success) {
    return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  }

  return jsonResponse(
    request,
    await listRestoreOperations(payload.data, authorization.user)
  );
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
  const authorization = await requirePermission(
    sessionToken,
    requiredPermission,
    { correlationId }
  );

  if (!authorization.ok) {
    return jsonResponse(request, authorization.error, { status: authorization.status });
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

  const payload = requestRestoreSchema.safeParse(body);

  if (!payload.success) {
    return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  }

  const result = await requestRestore(
    payload.data,
    authorization.user,
    { correlationId }
  );

  if (!result.ok) {
    return jsonResponse(request, result.error, { status: result.status });
  }

  return jsonResponse(request, result.value, { status: result.status });
}
