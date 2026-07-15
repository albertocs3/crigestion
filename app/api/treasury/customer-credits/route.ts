import { listCustomerCredits, listCustomerCreditsSchema } from "@/modules/treasury/application/customerCredits";
import { jsonResponse, validationError } from "@/modules/platform/application/http";
import { authorizeCustomerCreditRead } from "@/app/api/treasury/_customer-credit-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const authorization = await authorizeCustomerCreditRead(request, "Treasury.ViewCustomerCredits");
  if (!authorization.ok) return authorization.response;

  const url = new URL(request.url);
  const query = listCustomerCreditsSchema.safeParse({
    limit: url.searchParams.get("limit") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    customerId: url.searchParams.get("customerId") ?? undefined,
    search: url.searchParams.get("search") ?? undefined
  });
  if (!query.success) return jsonResponse(request, validationError(query.error.flatten()), { status: 422 });

  return jsonResponse(request, await listCustomerCredits(query.data, authorization.user));
}
