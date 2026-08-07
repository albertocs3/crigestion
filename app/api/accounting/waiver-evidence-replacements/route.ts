import { cookies } from "next/headers";
import {
  listWaiverEvidenceReplacementProposals,
  listWaiverEvidenceReplacementProposalsSchema
} from "@/modules/accounting/application/waiverEvidenceReplacements";
import { requirePermission, sessionCookieName } from "@/modules/platform/application/auth";
import { getCorrelationId, jsonResponse, validationError } from "@/modules/platform/application/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff"
};

export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const authorization = await requirePermission(token, "Accounting.ApproveWaiverEvidenceReplacements", { correlationId });
  if (!authorization.ok) return jsonResponse(request, authorization.error, { status: authorization.status, headers: privateHeaders });
  const query = new URL(request.url).searchParams;
  const allowedQueryKeys = new Set(["limit", "cursor"]);
  if ([...query.keys()].some((key) => !allowedQueryKeys.has(key) || query.getAll(key).length !== 1)) {
    return jsonResponse(request, { code: "VALIDATION_ERROR", message: "La consulta contiene parámetros desconocidos o repetidos." },
      { status: 422, headers: privateHeaders });
  }
  const payload = listWaiverEvidenceReplacementProposalsSchema.safeParse({
    limit: query.get("limit") ?? undefined,
    cursor: query.get("cursor") ?? undefined
  });
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422, headers: privateHeaders });
  const result = await listWaiverEvidenceReplacementProposals(payload.data, authorization.user, { correlationId });
  return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status,
    headers: { ...privateHeaders, ...(result.status === 429 ? { "Retry-After": String(result.retryAfterSeconds) } : {}) } });
}
