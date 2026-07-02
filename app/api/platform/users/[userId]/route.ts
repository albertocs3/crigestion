import { cookies } from "next/headers";
import { z } from "zod";
import {
  requirePermission,
  type SessionUser,
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
import {
  changeUserRole,
  deactivateUser,
  reactivateUser
} from "@/modules/platform/application/users";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const requiredPermission = "Platform.ManageUsers";
const paramsSchema = z.object({
  userId: z.string().uuid()
});
const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("deactivate")
  }),
  z.object({
    action: z.literal("reactivate")
  }),
  z.object({
    action: z.literal("changeRole"),
    roleCode: z.string().trim().min(1).max(80)
  })
]);

export async function PATCH(
  request: Request,
  context: { params: Promise<{ userId: string }> }
) {
  if (!isAllowedOrigin(request)) {
    return jsonResponse(request, originNotAllowed(), { status: 403 });
  }

  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(sessionToken, request.headers.get("X-CSRF-Token"));

  if (!csrf.ok) {
    return jsonResponse(request, csrf.error, { status: csrf.status });
  }

  const authorization = await requirePermission(
    sessionToken,
    requiredPermission,
    { correlationId: getCorrelationId(request) }
  );

  if (!authorization.ok) {
    return jsonResponse(request, authorization.error, { status: authorization.status });
  }

  const params = paramsSchema.safeParse(await context.params);

  if (!params.success) {
    return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });
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

  const payload = bodySchema.safeParse(body);

  if (!payload.success) {
    return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  }

  const result = await applyUserPatch(
    params.data.userId,
    payload.data,
    authorization.user
  );

  if (!result.ok) {
    return jsonResponse(request, result.error, { status: result.status });
  }

  return jsonResponse(request, result.value, { status: result.status });
}

async function applyUserPatch(
  userId: string,
  payload: z.infer<typeof bodySchema>,
  actor: SessionUser
) {
  if (payload.action === "deactivate") {
    return deactivateUser(userId, actor);
  }

  if (payload.action === "reactivate") {
    return reactivateUser(userId, actor);
  }

  return changeUserRole(userId, payload.roleCode, actor);
}
