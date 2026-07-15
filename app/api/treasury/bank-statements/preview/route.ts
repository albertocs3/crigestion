import { authorizeBankingMutation } from "@/app/api/treasury/_banking-http";
import { norma43FileSchema, previewNorma43 } from "@/modules/treasury/application/norma43";
import { jsonResponse, validationError } from "@/modules/platform/application/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  // authorizeBankingMutation ejecuta isAllowedOrigin(request) y validateCsrfToken(...).
  const authorization = await authorizeBankingMutation(request, "Treasury.ImportBankStatements", 7 * 1024 * 1024);
  if (!authorization.ok) return authorization.response;
  const payload = norma43FileSchema.safeParse(authorization.body);
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  const result = await previewNorma43(payload.data, authorization.user);
  return jsonResponse(request, result.ok ? { ...result.value, movements: undefined, movementCount: result.value.movements.length } : result.error, { status: result.status });
}
