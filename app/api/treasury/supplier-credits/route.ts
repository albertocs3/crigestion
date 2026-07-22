import { authorizeCustomerCreditRead } from "@/app/api/treasury/_customer-credit-http";
import { jsonResponse, validationError } from "@/modules/platform/application/http";
import { listSupplierCredits, listSupplierCreditsSchema } from "@/modules/treasury/application/supplierCredits";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const authorization = await authorizeCustomerCreditRead(request, "Treasury.ViewSupplierCredits");
  if (!authorization.ok) return authorization.response;
  const url = new URL(request.url);
  const query = listSupplierCreditsSchema.safeParse({ limit: url.searchParams.get("limit") ?? undefined, cursor: url.searchParams.get("cursor") ?? undefined, status: url.searchParams.get("status") ?? undefined, supplierId: url.searchParams.get("supplierId") ?? undefined, search: url.searchParams.get("search") ?? undefined });
  if (!query.success) return jsonResponse(request, validationError(query.error.flatten()), { status: 422 });
  return jsonResponse(request, await listSupplierCredits(query.data, authorization.user));
}
