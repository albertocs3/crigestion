import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  login,
  loginSchema,
  sessionCookieName
} from "@/modules/platform/application/auth";
import {
  getRequestContext,
  isAllowedOrigin
} from "@/modules/platform/application/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json(
      {
        code: "ORIGIN_NOT_ALLOWED",
        message: "Origen no permitido."
      },
      { status: 403 }
    );
  }

  const contentType = request.headers.get("Content-Type") ?? "";

  if (!contentType.toLocaleLowerCase("en-US").includes("application/json")) {
    return NextResponse.json(
      {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "La peticion debe enviarse como JSON."
      },
      { status: 415 }
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        code: "INVALID_JSON",
        message: "El cuerpo de la peticion no es JSON valido."
      },
      { status: 400 }
    );
  }

  const payload = loginSchema.safeParse(body);

  if (!payload.success) {
    return NextResponse.json(
      {
        code: "VALIDATION_ERROR",
        issues: payload.error.flatten()
      },
      { status: 422 }
    );
  }

  const result = await login(payload.data, getRequestContext(request));

  if (!result.ok) {
    return NextResponse.json(result.error, { status: result.status });
  }

  const cookieStore = await cookies();

  cookieStore.set(sessionCookieName, result.value.token, {
    httpOnly: true,
    secure: process.env.AUTH_COOKIE_SECURE === "true",
    sameSite: "lax",
    path: "/",
    expires: result.value.expiresAt
  });

  return NextResponse.json({
    authenticated: true,
    user: result.value.user,
    expiresAt: result.value.expiresAt.toISOString()
  });
}
