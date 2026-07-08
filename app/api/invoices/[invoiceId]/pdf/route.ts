import { cookies } from "next/headers";
import { z } from "zod";
import { generateInvoicePdf } from "@/modules/billing/application/invoicePdf";
import {
  requirePermission,
  sessionCookieName
} from "@/modules/platform/application/auth";
import {
  getCorrelationId,
  jsonResponse,
  validationError
} from "@/modules/platform/application/http";

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

  const result = await generateInvoicePdf(params.data.invoiceId, authorization.user);

  if (!result.ok) {
    return jsonResponse(request, result.error, { status: result.status });
  }

  return new Response(arrayBuffer(result.value.bytes), {
    status: result.status,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": contentDisposition(result.value.filename),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

function contentDisposition(filename: string): string {
  const safeFilename = filename.replace(/[^A-Za-z0-9._-]/g, "_");

  return `inline; filename="${safeFilename}"`;
}
