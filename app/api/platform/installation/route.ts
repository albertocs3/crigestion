import { getInstallationState } from "@/modules/platform/application/installation";
import { jsonResponse } from "@/modules/platform/application/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return jsonResponse(request, await getInstallationState());
}
