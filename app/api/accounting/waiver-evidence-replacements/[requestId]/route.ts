import { cookies } from "next/headers";
import { z } from "zod";
import { getWaiverEvidenceReplacementDetail } from "@/modules/accounting/application/waiverEvidenceReplacements";
import { requirePermission, sessionCookieName } from "@/modules/platform/application/auth";
import { getCorrelationId, jsonResponse, validationError } from "@/modules/platform/application/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const paramsSchema = z.object({ requestId: z.string().uuid() }).strict();
const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff"
};

export async function GET(request: Request, context: { params: Promise<{ requestId: string }> }) {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Accounting.ApproveWaiverEvidenceReplacements", { correlationId });
  if (!authorization.ok) return jsonResponse(request, authorization.error, { status: authorization.status, headers: privateHeaders });
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return jsonResponse(request, validationError(params.error.flatten()), { status: 422, headers: privateHeaders });
  const detail = await getWaiverEvidenceReplacementDetail(params.data.requestId, authorization.user, { correlationId });
  if (!detail) return jsonResponse(request, { code: "WAIVER_REPLACEMENT_REQUEST_NOT_FOUND", message: "No se encontró la solicitud." }, { status: 404, headers: privateHeaders });
  return jsonResponse(request, detail, { status: 200, headers: privateHeaders });
}
