import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  requirePermission,
  sessionCookieName,
  validateCsrfToken
} from "@/modules/platform/application/auth";
import { isAllowedOrigin } from "@/modules/platform/application/http";
import { revokeActiveSession } from "@/modules/platform/application/sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const requiredPermission = "Platform.ManageSessions";
const paramsSchema = z.object({
  sessionId: z.string().uuid()
});
const bodySchema = z.object({
  action: z.literal("revoke")
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
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
  const sessionToken = cookieStore.get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(sessionToken, request.headers.get("X-CSRF-Token"));

  if (!csrf.ok) {
    return NextResponse.json(csrf.error, { status: csrf.status });
  }

  const authorization = await requirePermission(sessionToken, requiredPermission);

  if (!authorization.ok) {
    return NextResponse.json(authorization.error, { status: authorization.status });
  }

  const params = paramsSchema.safeParse(await context.params);

  if (!params.success) {
    return NextResponse.json(
      {
        code: "VALIDATION_ERROR",
        issues: params.error.flatten()
      },
      { status: 422 }
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

  const payload = bodySchema.safeParse(body);

  if (!payload.success) {
    return NextResponse.json(
      {
        code: "VALIDATION_ERROR",
        issues: payload.error.flatten()
      },
      { status: 422 }
    );
  }

  const result = await revokeActiveSession(
    params.data.sessionId,
    authorization.user,
    authorization.sessionId
  );

  if (!result.ok) {
    return NextResponse.json(result.error, { status: result.status });
  }

  return NextResponse.json(result.value, { status: result.status });
}
