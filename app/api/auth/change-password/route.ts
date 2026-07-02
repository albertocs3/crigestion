import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  changePassword,
  changePasswordSchema,
  sessionCookieName,
  validateCsrfToken
} from "@/modules/platform/application/auth";
import {
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

  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));

  if (!csrf.ok) {
    return NextResponse.json(csrf.error, { status: csrf.status });
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

  const payload = changePasswordSchema.safeParse(body);

  if (!payload.success) {
    return NextResponse.json(validationError(payload.error.flatten()), { status: 422 });
  }

  const result = await changePassword(token, payload.data);

  if (!result.ok) {
    return NextResponse.json(result.error, { status: result.status });
  }

  cookieStore.delete(sessionCookieName);

  return NextResponse.json({ passwordChanged: true }, { status: result.status });
}
