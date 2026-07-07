import { cookies } from "next/headers";
import { z } from "zod";
import {
  requirePermission,
  sessionCookieName
} from "@/modules/platform/application/auth";
import {
  getCorrelationId,
  jsonResponse,
  validationError
} from "@/modules/platform/application/http";
import { getInvoiceDetail } from "@/modules/billing/application/invoices";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const viewPermission = "Billing.View";
const paramsSchema = z.object({
  invoiceId: z.string().uuid()
});

export async function GET(
  request: Request,
  context: { params: Promise<{ invoiceId: string }> }
) {
  const params = paramsSchema.safeParse(await context.params);

  if (!params.success) {
    return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });
  }

  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(sessionCookieName)?.value;
  const authorization = await requirePermission(sessionToken, viewPermission, {
    correlationId: getCorrelationId(request)
  });

  if (!authorization.ok) {
    return jsonResponse(request, authorization.error, { status: authorization.status });
  }

  const invoice = await getInvoiceDetail(params.data.invoiceId, authorization.user);

  if (!invoice) {
    return jsonResponse(
      request,
      {
        code: "INVOICE_NOT_FOUND",
        message: "La factura no existe."
      },
      { status: 404 }
    );
  }

  return jsonResponse(request, invoice);
}
