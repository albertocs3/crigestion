import { jsonResponse, validationError } from "@/modules/platform/application/http";
import { listSupplierDueDates, listSupplierDueDatesSchema } from "@/modules/purchases/application/purchases";
import { authorizePurchaseRead } from "../../purchases/_http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authorization = await authorizePurchaseRead(request, "Treasury.ViewSupplierPayments");
  if (!authorization.ok) return authorization.response;
  const query = new URL(request.url).searchParams;
  const payload = listSupplierDueDatesSchema.safeParse(
    Object.fromEntries([...query].filter(([, value]) => value !== ""))
  );
  if (!payload.success) {
    return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  }
  return jsonResponse(request, await listSupplierDueDates(payload.data, authorization.user));
}
