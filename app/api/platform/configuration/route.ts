import { cookies } from "next/headers";
import {
  requirePermission,
  sessionCookieName
} from "@/modules/platform/application/auth";
import { getPlatformConfiguration } from "@/modules/platform/application/configuration";
import {
  getCorrelationId,
  jsonResponse
} from "@/modules/platform/application/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const requiredPermission = "Platform.ManageConfiguration";

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

  const configuration = await getPlatformConfiguration();

  if (!configuration) {
    return jsonResponse(
      request,
      {
        code: "CONFIGURATION_NOT_FOUND",
        message: "La configuracion de plataforma no existe."
      },
      { status: 404 }
    );
  }

  return jsonResponse(request, configuration);
}
