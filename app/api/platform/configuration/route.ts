import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  requirePermission,
  sessionCookieName
} from "@/modules/platform/application/auth";
import { getPlatformConfiguration } from "@/modules/platform/application/configuration";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const requiredPermission = "Platform.ManageConfiguration";

export async function GET() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(sessionCookieName)?.value;
  const authorization = await requirePermission(sessionToken, requiredPermission);

  if (!authorization.ok) {
    return NextResponse.json(authorization.error, { status: authorization.status });
  }

  const configuration = await getPlatformConfiguration();

  if (!configuration) {
    return NextResponse.json(
      {
        code: "CONFIGURATION_NOT_FOUND",
        message: "La configuracion de plataforma no existe."
      },
      { status: 404 }
    );
  }

  return NextResponse.json(configuration);
}
