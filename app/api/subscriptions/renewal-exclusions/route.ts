import { cookies } from "next/headers";
import { requirePermission, sessionCookieName } from "@/modules/platform/application/auth";
import { getCorrelationId, jsonResponse, validationError } from "@/modules/platform/application/http";
import {
  listSubscriptionRenewalExclusions,
  listSubscriptionRenewalExclusionsSchema
} from "@/modules/subscriptions/application/renewalExclusions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const authorization = await requirePermission(token, "Subscriptions.RunRenewals", { correlationId });
  if (!authorization.ok) return jsonResponse(request, authorization.error, { status: authorization.status, headers: { "Cache-Control": "private, no-store" } });
  const query = new URL(request.url).searchParams;
  const allowedQueryKeys = new Set(["limit", "cursor", "reasonCode", "workState", "customerId", "search", "periodFrom", "periodTo"]);
  if ([...query.keys()].some((key) => !allowedQueryKeys.has(key) || query.getAll(key).length !== 1)) {
    return jsonResponse(request, { code: "VALIDATION_ERROR", message: "La consulta contiene parametros desconocidos o repetidos." }, { status: 422, headers: { "Cache-Control": "private, no-store" } });
  }
  const payload = listSubscriptionRenewalExclusionsSchema.safeParse({
    limit: query.get("limit") ?? undefined,
    cursor: query.get("cursor") ?? undefined,
    reasonCode: query.get("reasonCode") ?? undefined,
    workState: query.get("workState") ?? undefined,
    customerId: query.get("customerId") ?? undefined,
    search: query.get("search") ?? undefined,
    periodFrom: query.get("periodFrom") ?? undefined,
    periodTo: query.get("periodTo") ?? undefined
  });
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422, headers: { "Cache-Control": "private, no-store" } });
  const result = await listSubscriptionRenewalExclusions(payload.data, authorization.user, { correlationId });
  return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status, headers: { "Cache-Control": "private, no-store" } });
}
