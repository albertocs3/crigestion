import { cookies } from "next/headers";
import { requirePermission, sessionCookieName } from "@/modules/platform/application/auth";
import { getCorrelationId, jsonResponse, validationError } from "@/modules/platform/application/http";
import { getSupportIncident, supportIncidentParamsSchema } from "@/modules/support/application/incidents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ incidentId: string }> }) {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const authorization = await requirePermission(token, "Support.View", { correlationId: getCorrelationId(request) });
  if (!authorization.ok) return response(request, authorization.error, authorization.status);
  const params = supportIncidentParamsSchema.safeParse(await context.params);
  if (!params.success) return response(request, validationError(params.error.flatten()), 422);
  const incident = await getSupportIncident(params.data.incidentId, authorization.user);
  if (!incident) return response(request, { code: "SUPPORT_INCIDENT_NOT_FOUND", message: "La incidencia no existe." }, 404);
  return response(request, incident, 200);
}

function response(request: Request, body: unknown, status: number) { return jsonResponse(request, body, { status, headers: { "Cache-Control": "private, no-store, max-age=0" } }); }
