import { authorizeBankingRead } from "@/app/api/treasury/_banking-http";
import { listReconciliationCandidates, listReconciliationCandidatesSchema } from "@/modules/treasury/application/banking";
import { jsonResponse, validationError } from "@/modules/platform/application/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const authorization = await authorizeBankingRead(request);
  if (!authorization.ok) return authorization.response;
  const params = new URL(request.url).searchParams;
  const payload = listReconciliationCandidatesSchema.safeParse({ movementId: params.get("movementId"), limit: params.get("limit") ?? undefined, search: params.get("search") ?? undefined });
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  return jsonResponse(request, await listReconciliationCandidates(payload.data, authorization.user));
}
