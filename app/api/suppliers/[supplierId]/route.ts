import { cookies } from "next/headers";
import { z } from "zod";
import { requirePermission, sessionCookieName, validateCsrfToken } from "@/modules/platform/application/auth";
import { getCorrelationId, invalidJson, isAllowedOrigin, isJsonRequest, jsonResponse, originNotAllowed, unsupportedMediaType, validateIdempotencyKey, validationError } from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import { getSupplier, supplierRequestHash, updateSupplier, updateSupplierSchema, updateSupplierStatus, updateSupplierStatusSchema } from "@/modules/suppliers/application/suppliers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const paramsSchema = z.object({ supplierId: z.string().uuid() });
const bodySchema = z.discriminatedUnion("action", [z.object({ action: z.literal("update"), supplier: updateSupplierSchema }).strict(), ...updateSupplierStatusSchema.options]);

export async function GET(request: Request, context: { params: Promise<{ supplierId: string }> }) {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const authorization = await requirePermission(token, "Suppliers.View", { correlationId: getCorrelationId(request) });
  if (!authorization.ok) return jsonResponse(request, authorization.error, { status: authorization.status });
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });
  const result = await getSupplier(params.data.supplierId, authorization.user);
  return result.ok ? jsonResponse(request, result.value, { status: result.status }) : jsonResponse(request, result.error, { status: result.status });
}

export async function PATCH(request: Request, context: { params: Promise<{ supplierId: string }> }) {
  if (!isAllowedOrigin(request)) return jsonResponse(request, originNotAllowed(), { status: 403 });
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return jsonResponse(request, csrf.error, { status: csrf.status });
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(token, "Suppliers.Manage", { correlationId });
  if (!authorization.ok) return jsonResponse(request, authorization.error, { status: authorization.status });
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) return jsonResponse(request, maintenance.error, { status: maintenance.status });
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });
  if (!isJsonRequest(request)) return jsonResponse(request, unsupportedMediaType(), { status: 415 });
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) return jsonResponse(request, idempotency.error, { status: idempotency.status });
  let body: unknown; try { body = await request.json(); } catch { return jsonResponse(request, invalidJson(), { status: 400 }); }
  const payload = bodySchema.safeParse(body);
  if (!payload.success) return jsonResponse(request, validationError(payload.error.flatten()), { status: 422 });
  const mutationContext = { correlationId, idempotencyKey: idempotency.key, requestHash: supplierRequestHash(payload.data), scope: `${payload.data.action}:${params.data.supplierId}` };
  const result = payload.data.action === "update" ? await updateSupplier(params.data.supplierId, payload.data.supplier, authorization.user, mutationContext) : await updateSupplierStatus(params.data.supplierId, payload.data, authorization.user, mutationContext);
  return result.ok ? jsonResponse(request, result.value, { status: result.status }) : jsonResponse(request, result.error, { status: result.status });
}
