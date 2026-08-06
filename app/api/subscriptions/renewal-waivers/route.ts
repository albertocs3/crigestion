import { cookies } from "next/headers";
import { requirePermission, sessionCookieName } from "@/modules/platform/application/auth";
import { getCorrelationId, jsonResponse, validationError } from "@/modules/platform/application/http";
import { listSubscriptionRenewalWaivers, listSubscriptionRenewalWaiversSchema } from "@/modules/subscriptions/application/renewalWaiverReports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const responseHeaders = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" };

export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const authorization = await requirePermission(token, "Subscriptions.ViewRenewalWaivers", { correlationId });
  if (!authorization.ok) return jsonResponse(request, authorization.error, { status: authorization.status, headers: responseHeaders });
  const query = new URL(request.url).searchParams;
  const allowedKeys = new Set(["limit", "cursor", "reasonCode", "customerId", "search", "periodFrom", "periodTo", "waivedFrom", "waivedTo"]);
  if ([...query.keys()].some((key) => !allowedKeys.has(key) || query.getAll(key).length !== 1)) {
    return jsonResponse(request, { code: "VALIDATION_ERROR", message: "La consulta contiene parametros desconocidos o repetidos." }, { status: 422, headers: responseHeaders });
  }
  const payload = listSubscriptionRenewalWaiversSchema.safeParse({
    limit: query.get("limit") ?? undefined, cursor: query.get("cursor") ?? undefined,
    reasonCode: query.get("reasonCode") ?? undefined, customerId: query.get("customerId") ?? undefined,
    search: query.get("search") ?? undefined, periodFrom: query.get("periodFrom") ?? undefined,
    periodTo: query.get("periodTo") ?? undefined, waivedFrom: query.get("waivedFrom") ?? undefined,
    waivedTo: query.get("waivedTo") ?? undefined
  });
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422, headers: responseHeaders });
  const result = await listSubscriptionRenewalWaivers(payload.data, authorization.user, { correlationId });
  return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status, headers: responseHeaders });
}
