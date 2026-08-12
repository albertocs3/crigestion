import { cookies } from "next/headers";
import { requirePermission, sessionCookieName } from "@/modules/platform/application/auth";
import { getCorrelationId, jsonResponse, validationError } from "@/modules/platform/application/http";
import { getSupportDashboard } from "@/modules/support/application/dashboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const authorization = await requirePermission(token, "Support.View", { correlationId });
  if (!authorization.ok) return response(request, authorization.error, authorization.status);
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    return response(request, validationError({ formErrors: ["El panel no admite parámetros."], fieldErrors: {} }), 422);
  }
  const result = await getSupportDashboard(authorization.user, { correlationId });
  return result.ok ? response(request, result.value, 200) : response(request, result.error, result.status, result.error.retryAfterSeconds);
}

function response(request: Request, body: unknown, status: number, retryAfterSeconds?: number) {
  return jsonResponse(request, body, { status, headers: {
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Vary: "Cookie",
    "X-Content-Type-Options": "nosniff",
    ...(retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : {}),
  } });
}
