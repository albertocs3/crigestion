import { cookies } from "next/headers";
import {
  login,
  loginSchema,
  sessionCookieName
} from "@/modules/platform/application/auth";
import {
  getSessionCookieSameSite,
  isSessionCookieSecure
} from "@/modules/platform/application/environment";
import {
  getRequestContext,
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

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) {
    return jsonResponse(request, originNotAllowed(), { status: 403 });
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

  const payload = loginSchema.safeParse(body);

  if (!payload.success) {
    return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  }

  const result = await login(payload.data, getRequestContext(request));

  if (!result.ok) {
    if (result.status === 429 && result.error.retryAfterSeconds) {
      return jsonResponse(request, result.error, {
        status: result.status,
        headers: {
          "Retry-After": String(result.error.retryAfterSeconds)
        }
      });
    }

    return jsonResponse(request, result.error, { status: result.status });
  }

  const cookieStore = await cookies();

  cookieStore.set(sessionCookieName, result.value.token, {
    httpOnly: true,
    secure: isSessionCookieSecure(),
    sameSite: getSessionCookieSameSite(),
    path: "/",
    expires: result.value.expiresAt
  });

  return jsonResponse(request, {
    authenticated: true,
    user: result.value.user,
    expiresAt: result.value.expiresAt.toISOString()
  });
}
