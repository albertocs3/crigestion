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
  exportCustomerDueDatesCsv,
  exportCustomerDueDatesSchema
} from "@/modules/treasury/application/dueDates";

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
  const payload = exportCustomerDueDatesSchema.safeParse({
    limit: searchParams.get("limit") ?? undefined,
    scope: searchParams.get("scope") ?? undefined,
    customerId: searchParams.get("customerId") ?? undefined,
    dueFrom: searchParams.get("dueFrom") ?? undefined,
    dueTo: searchParams.get("dueTo") ?? undefined,
    search: searchParams.get("search") ?? undefined
  });

  if (!payload.success) {
    return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  }

  const result = await exportCustomerDueDatesCsv(payload.data, authorization.user);

  return new Response(`\uFEFF${result.content}`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": contentDisposition(result.filename),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function contentDisposition(filename: string): string {
  return `attachment; filename="${filename.replace(/"/g, "")}"`;
}
