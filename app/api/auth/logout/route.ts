import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  logout,
  sessionCookieName,
  validateCsrfToken
} from "@/modules/platform/application/auth";
import {
  isAllowedOrigin,
  originNotAllowed
} from "@/modules/platform/application/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json(originNotAllowed(), { status: 403 });
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));

  if (!csrf.ok) {
    return NextResponse.json(csrf.error, { status: csrf.status });
  }

  const result = await logout(token);

  cookieStore.delete(sessionCookieName);

  if (!result.ok) {
    return NextResponse.json(result.error, { status: result.status });
  }

  return NextResponse.json({ authenticated: false });
}
