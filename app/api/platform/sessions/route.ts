import { cookies } from "next/headers";
import {
  requirePermission,
  sessionCookieName
} from "@/modules/platform/application/auth";
import {
  getCorrelationId,
  jsonResponse
} from "@/modules/platform/application/http";
import { listActiveSessions } from "@/modules/platform/application/sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const requiredPermission = "Platform.ManageSessions";

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(sessionCookieName)?.value;
  const authorization = await requirePermission(
    sessionToken,
    requiredPermission,
    { correlationId: getCorrelationId(request) }
  );

  if (!authorization.ok) {
    return jsonResponse(request, authorization.error, { status: authorization.status });
  }

  return jsonResponse(request, {
    sessions: await listActiveSessions(authorization.sessionId)
  });
}
