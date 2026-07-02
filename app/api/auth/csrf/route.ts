import { cookies } from "next/headers";
import {
  createCsrfToken,
  getSessionState,
  sessionCookieName
} from "@/modules/platform/application/auth";
import { jsonResponse } from "@/modules/platform/application/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  const session = await getSessionState(token);

  if (!session.authenticated || !token) {
    return jsonResponse(
      request,
      {
        code: "UNAUTHENTICATED",
        message: "No hay una sesion activa."
      },
      { status: 401 }
    );
  }

  return jsonResponse(request, {
    csrfToken: createCsrfToken(token)
  });
}
