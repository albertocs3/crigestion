import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  requirePermission,
  sessionCookieName
} from "@/modules/platform/application/auth";
import { listActiveSessions } from "@/modules/platform/application/sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const requiredPermission = "Platform.ManageSessions";

export async function GET() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(sessionCookieName)?.value;
  const authorization = await requirePermission(sessionToken, requiredPermission);

  if (!authorization.ok) {
    return NextResponse.json(authorization.error, { status: authorization.status });
  }

  return NextResponse.json({
    sessions: await listActiveSessions(authorization.sessionId)
  });
}
