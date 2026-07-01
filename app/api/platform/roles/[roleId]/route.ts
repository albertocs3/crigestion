import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  requirePermission,
  sessionCookieName,
  validateCsrfToken
} from "@/modules/platform/application/auth";
import { isAllowedOrigin } from "@/modules/platform/application/http";
import {
  updateRolePermissions,
  updateRolePermissionsSchema
} from "@/modules/platform/application/roles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const requiredPermission = "Platform.ManageRoles";
const paramsSchema = z.object({
  roleId: z.string().uuid()
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ roleId: string }> }
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

  const payload = updateRolePermissionsSchema.safeParse(body);

  if (!payload.success) {
    return NextResponse.json(
      {
        code: "VALIDATION_ERROR",
        issues: payload.error.flatten()
      },
      { status: 422 }
    );
  }

  const result = await updateRolePermissions(
    params.data.roleId,
    payload.data,
    authorization.user
  );

  if (!result.ok) {
    return NextResponse.json(result.error, { status: result.status });
  }

  return NextResponse.json(result.value, { status: result.status });
}
