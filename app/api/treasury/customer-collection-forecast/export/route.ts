import { cookies } from "next/headers";
import {
  requirePermission,
  sessionCookieName
} from "@/modules/platform/application/auth";
import {
  getCorrelationId,
  jsonResponse,
  validationError
} from "@/modules/platform/application/http";
import {
  exportCustomerCollectionForecastCsv,
  getCustomerCollectionForecastSchema
} from "@/modules/treasury/application/forecast";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const managePaymentsPermission = "Treasury.ManagePayments";

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(sessionCookieName)?.value;
  const authorization = await requirePermission(sessionToken, managePaymentsPermission, {
    correlationId: getCorrelationId(request)
  });

  if (!authorization.ok) {
    return jsonResponse(request, authorization.error, { status: authorization.status });
  }

  const searchParams = new URL(request.url).searchParams;
  const payload = getCustomerCollectionForecastSchema.safeParse({
    year: searchParams.get("year") ?? undefined,
    customerId: searchParams.get("customerId") ?? undefined,
    search: searchParams.get("search") ?? undefined,
    asOf: searchParams.get("asOf") ?? undefined,
    limit: searchParams.get("limit") ?? undefined
  });

  if (!payload.success) {
    return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  }

  const exportFile = await exportCustomerCollectionForecastCsv(
    payload.data,
    authorization.user
  );

  return new Response(exportFile.content, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFile.filename}"`,
      "Cache-Control": "private, no-store"
    }
  });
}
