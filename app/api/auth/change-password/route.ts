import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  changePassword,
  changePasswordSchema,
  sessionCookieName,
  validateCsrfToken
} from "@/modules/platform/application/auth";
import { isAllowedOrigin } from "@/modules/platform/application/http";

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

  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));

  if (!csrf.ok) {
    return NextResponse.json(csrf.error, { status: csrf.status });
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

  const payload = changePasswordSchema.safeParse(body);

  if (!payload.success) {
    return NextResponse.json(
      {
        code: "VALIDATION_ERROR",
        issues: payload.error.flatten()
      },
      { status: 422 }
    );
  }

  const result = await changePassword(token, payload.data);

  if (!result.ok) {
    return NextResponse.json(result.error, { status: result.status });
  }

  cookieStore.delete(sessionCookieName);

  return NextResponse.json({ passwordChanged: true }, { status: result.status });
}
