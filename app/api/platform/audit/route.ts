import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  requirePermission,
  sessionCookieName
} from "@/modules/platform/application/auth";
import {
  listAuditEvents,
  listAuditEventsSchema
} from "@/modules/platform/application/audit";
import { validationError } from "@/modules/platform/application/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const requiredPermission = "Platform.ViewAudit";

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(sessionCookieName)?.value;
  const authorization = await requirePermission(sessionToken, requiredPermission);

  if (!authorization.ok) {
    return NextResponse.json(authorization.error, { status: authorization.status });
  }

  const searchParams = new URL(request.url).searchParams;
  const payload = listAuditEventsSchema.safeParse({
    limit: searchParams.get("limit") ?? undefined,
    cursor: searchParams.get("cursor") ?? undefined,
    eventType: searchParams.get("eventType") ?? undefined
  });

  if (!payload.success) {
    return NextResponse.json(validationError(payload.error.flatten()), { status: 422 });
  }

  return NextResponse.json(await listAuditEvents(payload.data, authorization.user));
}
