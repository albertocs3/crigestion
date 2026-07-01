import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  createCsrfToken,
  getSessionState,
  sessionCookieName
} from "@/modules/platform/application/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  const session = await getSessionState(token);

  if (!session.authenticated || !token) {
    return NextResponse.json(
      {
        code: "UNAUTHENTICATED",
        message: "No hay una sesion activa."
      },
      { status: 401 }
    );
  }

  return NextResponse.json({
    csrfToken: createCsrfToken(token)
  });
}
