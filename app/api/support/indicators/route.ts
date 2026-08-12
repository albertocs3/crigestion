import { cookies } from "next/headers";
import { getCorrelationId, jsonResponse, validationError } from "@/modules/platform/application/http";
import { requirePermission, sessionCookieName } from "@/modules/platform/application/auth";
import { getSupportIndicators, supportIndicatorsQuerySchema } from "@/modules/support/application/indicators";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const view = await requirePermission(token, "Support.View", { correlationId });
  if (!view.ok) return response(request, view.error, view.status);
  const indicators = await requirePermission(token, "Support.ViewIndicators", { correlationId });
  if (!indicators.ok) return response(request, indicators.error, indicators.status);

  const search = new URL(request.url).searchParams;
  const allowed = new Set(["from", "to", "scope", "technicianId"]);
  const invalidShape = [...search.keys()].some((key) => !allowed.has(key)) || [...allowed].some((key) => search.getAll(key).length > 1);
  if (invalidShape) return response(request, validationError({ formErrors: ["Los parametros no son validos."], fieldErrors: {} }), 422);
  const parsed = supportIndicatorsQuerySchema.safeParse({
    from: search.get("from") ?? undefined,
    to: search.get("to") ?? undefined,
    scope: search.get("scope") ?? undefined,
    technicianId: search.get("technicianId") || undefined,
  });
  if (!parsed.success) return response(request, validationError(parsed.error.flatten()), 422);
  if (parsed.data.scope === "global") {
    const global = await requirePermission(token, "Support.ViewGlobalIndicators", { correlationId });
    if (!global.ok) return response(request, global.error, global.status);
  }
  const result = await getSupportIndicators(parsed.data, indicators.user, { correlationId });
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
