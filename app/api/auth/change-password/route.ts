import { cookies } from "next/headers";
import {
  changePassword,
  changePasswordSchema,
  getSessionState,
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

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) {
    return jsonResponse(request, originNotAllowed(), { status: 403 });
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));

  if (!csrf.ok) {
    return jsonResponse(request, csrf.error, { status: csrf.status });
  }

  const sessionState = await getSessionState(token);

  if (sessionState.authenticated) {
    const correlationId = getCorrelationId(request);
    const maintenance = await requireMaintenanceModeInactive(
      sessionState.user,
      request,
      { correlationId }
    );

    if (!maintenance.ok) {
      return jsonResponse(request, maintenance.error, { status: maintenance.status });
    }
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

  const payload = changePasswordSchema.safeParse(body);

  if (!payload.success) {
    return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  }

  const result = await changePassword(token, payload.data);

  if (!result.ok) {
    return jsonResponse(request, result.error, { status: result.status });
  }

  cookieStore.delete(sessionCookieName);

  return jsonResponse(request, { passwordChanged: true }, { status: result.status });
}
