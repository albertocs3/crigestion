import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  requirePermission,
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
    return NextResponse.json(originNotAllowed(), { status: 403 });
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
    return NextResponse.json(validationError(params.error.flatten()), { status: 422 });
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

  const payload = updateRolePermissionsSchema.safeParse(body);

  if (!payload.success) {
    return NextResponse.json(validationError(payload.error.flatten()), { status: 422 });
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
