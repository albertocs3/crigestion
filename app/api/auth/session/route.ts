import { cookies } from "next/headers";
import {
  getSessionState,
  sessionCookieName
} from "@/modules/platform/application/auth";
import { jsonResponse } from "@/modules/platform/application/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;

  return jsonResponse(request, await getSessionState(token));
}
