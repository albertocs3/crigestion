import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  getSessionCookieSameSite,
  isSessionCookieSecure,
  login,
  loginSchema,
  sessionCookieName
} from "@/modules/platform/application/auth";
import {
  getRequestContext,
  invalidJson,
  isAllowedOrigin,
  isJsonRequest,
  originNotAllowed,
  unsupportedMediaType,
  validationError
} from "@/modules/platform/application/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json(originNotAllowed(), { status: 403 });
  }

  if (!isJsonRequest(request)) {
    return NextResponse.json(unsupportedMediaType(), { status: 415 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(invalidJson(), { status: 400 });
  }

  const payload = loginSchema.safeParse(body);

  if (!payload.success) {
    return NextResponse.json(validationError(payload.error.flatten()), { status: 422 });
  }

  const result = await login(payload.data, getRequestContext(request));

  if (!result.ok) {
    return NextResponse.json(result.error, { status: result.status });
  }

  const cookieStore = await cookies();

  cookieStore.set(sessionCookieName, result.value.token, {
    httpOnly: true,
    secure: isSessionCookieSecure(),
    sameSite: getSessionCookieSameSite(),
    path: "/",
    expires: result.value.expiresAt
  });

  return NextResponse.json({
    authenticated: true,
    user: result.value.user,
    expiresAt: result.value.expiresAt.toISOString()
  });
}
