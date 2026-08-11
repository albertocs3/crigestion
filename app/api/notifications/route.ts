import { cookies } from "next/headers";
import { getSessionState, sessionCookieName } from "@/modules/platform/application/auth";
import { jsonResponse, validationError } from "@/modules/platform/application/http";
import { listNotifications, notificationListSchema } from "@/modules/platform/application/notifications";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const session = await getSessionState(token);
  if (!session.authenticated) return response(request, { code: "UNAUTHENTICATED", message: "No hay una sesión activa." }, 401);
  const url = new URL(request.url);
  const parsed = notificationListSchema.safeParse({ state: url.searchParams.get("state") ?? undefined, limit: url.searchParams.get("limit") ?? undefined, cursor: url.searchParams.get("cursor") ?? undefined });
  if (!parsed.success) return response(request, validationError(parsed.error.flatten()), 422);
  const result = await listNotifications(session.user, parsed.data);
  if (!result) return response(request, { code: "NOTIFICATION_CURSOR_INVALID", message: "El cursor no es válido." }, 422);
  return response(request, result, 200);
}

function response(request: Request, body: unknown, status: number) {
  return jsonResponse(request, body, { status, headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
