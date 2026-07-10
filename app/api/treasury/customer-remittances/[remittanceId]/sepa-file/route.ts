import { cookies } from "next/headers";
import {
  requirePermission,
  sessionCookieName
} from "@/modules/platform/application/auth";
import {
  getCorrelationId,
  jsonResponse
} from "@/modules/platform/application/http";
import { getCustomerRemittanceSepaFile } from "@/modules/treasury/application/remittances";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const managePaymentsPermission = "Treasury.ManagePayments";

type RouteContext = {
  params: Promise<{
    remittanceId: string;
  }>;
};

export async function GET(request: Request, context: RouteContext) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(sessionCookieName)?.value;
  const authorization = await requirePermission(sessionToken, managePaymentsPermission, {
    correlationId: getCorrelationId(request)
  });

  if (!authorization.ok) {
    return jsonResponse(request, authorization.error, { status: authorization.status });
  }

  const params = await context.params;
  const result = await getCustomerRemittanceSepaFile(params.remittanceId, authorization.user);

  if (!result.ok) {
    return jsonResponse(request, result.error, { status: result.status });
  }

  return new Response(result.value.content, {
    status: result.status,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": contentDisposition(result.value.filename),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Remittance-SEPA-SHA256": result.value.sha256
    }
  });
}

function contentDisposition(filename: string): string {
  return `attachment; filename="${filename.replace(/"/g, "")}"`;
}
