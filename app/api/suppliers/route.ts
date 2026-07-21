import { cookies } from "next/headers";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { getCorrelationId, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse, originNotAllowed, unsupportedMediaType, validateIdempotencyKey, validationError } from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import { createSupplier, createSupplierSchema, listSuppliers, listSuppliersSchema, supplierRequestHash } from "@/modules/suppliers/application/suppliers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const authorization = await requirePermission(token, "Suppliers.View", { correlationId: getCorrelationId(request) });
  if (!authorization.ok) return jsonResponse(request, authorization.error, { status: authorization.status });
  const query = new URL(request.url).searchParams;
  const payload = listSuppliersSchema.safeParse({ limit: query.get("limit") ?? undefined, cursor: query.get("cursor") ?? undefined, status: query.get("status") ?? undefined, search: query.get("search") ?? undefined });
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  return jsonResponse(request, await listSuppliers(payload.data, authorization.user));
}

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) return jsonResponse(request, originNotAllowed(), { status: 403 });
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return jsonResponse(request, csrf.error, { status: csrf.status });
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Suppliers.Manage", { correlationId });
  if (!authorization.ok) return jsonResponse(request, authorization.error, { status: authorization.status });
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) return jsonResponse(request, maintenance.error, { status: maintenance.status });
  if (!isJsonRequest(request)) return jsonResponse(request, unsupportedMediaType(), { status: 415 });
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) return jsonResponse(request, idempotency.error, { status: idempotency.status });
  let body: unknown; try { body = await request.json(); } catch { return jsonResponse(request, invalidJson(), { status: 400 }); }
  const payload = createSupplierSchema.safeParse(body);
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  const result = await createSupplier(payload.data, authorization.user, { correlationId, idempotencyKey: idempotency.key, requestHash: supplierRequestHash(payload.data), scope: "create" });
  return result.ok ? jsonResponse(request, result.value, { status: result.status }) : jsonResponse(request, result.error, { status: result.status });
}
