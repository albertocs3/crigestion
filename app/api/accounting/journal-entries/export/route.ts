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
  exportJournalEntriesCsv,
  exportJournalEntriesSchema
} from "@/modules/accounting/application/journal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const viewPermission = "Accounting.View";

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(sessionCookieName)?.value;
  const authorization = await requirePermission(sessionToken, viewPermission, {
    correlationId: getCorrelationId(request)
  });

  if (!authorization.ok) {
    return jsonResponse(request, authorization.error, { status: authorization.status });
  }

  const searchParams = new URL(request.url).searchParams;
  const payload = exportJournalEntriesSchema.safeParse({
    limit: searchParams.get("limit") ?? undefined,
    year: searchParams.get("year") ?? undefined
  });

  if (!payload.success) {
    return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  }

  const result = await exportJournalEntriesCsv(payload.data, authorization.user);

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
