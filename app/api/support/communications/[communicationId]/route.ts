import { cookies } from "next/headers";
import { requirePermission, sessionCookieName } from "@/modules/platform/application/auth";
import { getCorrelationId, jsonResponse, validationError } from "@/modules/platform/application/http";
import { getSupportCommunication, supportCommunicationParamsSchema } from "@/modules/support/application/communications";
export const dynamic = "force-dynamic"; export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ communicationId: string }> }) { const token = (await cookies()).get(sessionCookieName)?.value; const auth = await requirePermission(token, "Support.ViewCommunications", { correlationId: getCorrelationId(request) }); if (!auth.ok) return response(request, auth.error, auth.status); const params = supportCommunicationParamsSchema.safeParse(await context.params); if (!params.success) return response(request, validationError(params.error.flatten()), 422); const value = await getSupportCommunication(params.data.communicationId); return value ? response(request, value, 200) : response(request, { code: "SUPPORT_COMMUNICATION_NOT_FOUND", message: "La comunicación no existe." }, 404); }
function response(request: Request, body: unknown, status: number) { return jsonResponse(request, body, { status, headers: { "Cache-Control": "private, no-store, max-age=0" } }); }
