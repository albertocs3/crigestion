import { cookies } from "next/headers";
import {
  requirePermission,
  sessionCookieName,
  validateCsrfToken,
} from "@/modules/platform/application/auth";
import {
  getCorrelationId,
  invalidJson,
  isAllowedOrigin,
  isJsonRequest,
  jsonResponse,
  originNotAllowed,
  readBoundedTextBody,
  unsupportedMediaType,
  validateIdempotencyKey,
  validationError,
} from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import {
  createSupportCommunication,
  createSupportCommunicationSchema,
  hashSupportCommunicationRequest,
  listSupportCommunications,
  listSupportCommunicationsSchema,
} from "@/modules/support/application/communications";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const correlationId = getCorrelationId(request);
  const auth = await requirePermission(token, "Support.ViewCommunications", {
    correlationId,
  });
  if (!auth.ok) return response(request, auth.error, auth.status);
  const url = new URL(request.url);
  const parsed = listSupportCommunicationsSchema.safeParse(
    strictQuery(url.searchParams),
  );
  return parsed.success
    ? response(
        request,
        await listSupportCommunications(parsed.data, auth.user, {
          correlationId,
        }),
        200,
      )
    : response(request, validationError(parsed.error.flatten()), 422);
}
export async function POST(request: Request) {
  if (!isAllowedOrigin(request))
    return response(request, originNotAllowed(), 403);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(token, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) return response(request, csrf.error, csrf.status);
  const correlationId = getCorrelationId(request);
  const auth = await requirePermission(token, "Support.ManageCommunications", {
    correlationId,
  });
  if (!auth.ok) return response(request, auth.error, auth.status);
  const view = await requirePermission(token, "Support.ViewCommunications", {
    correlationId,
  });
  if (!view.ok) return response(request, view.error, view.status);
  const maintenance = await requireMaintenanceModeInactive(auth.user, request, {
    correlationId,
  });
  if (!maintenance.ok)
    return response(request, maintenance.error, maintenance.status);
  if (!isJsonRequest(request))
    return response(request, unsupportedMediaType(), 415);
  const idem = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idem.ok) return response(request, idem.error, idem.status);
  const raw = await readBoundedTextBody(request, 8_192);
  if (raw === null)
    return response(
      request,
      {
        code: "PAYLOAD_TOO_LARGE",
        message: "La petición supera el tamaño máximo permitido.",
      },
      413,
    );
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return response(request, invalidJson(), 400);
  }
  const parsed = createSupportCommunicationSchema.safeParse(body);
  if (!parsed.success)
    return response(request, validationError(parsed.error.flatten()), 422);
  const result = await createSupportCommunication(parsed.data, auth.user, {
    idempotencyKey: idem.key,
    requestHash: hashSupportCommunicationRequest(parsed.data),
    scope: "communication:create",
    correlationId,
  });
  return result.ok
    ? response(request, result.value, result.status)
    : response(request, result.error, result.status);
}
function response(request: Request, body: unknown, status: number) {
  return jsonResponse(request, body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      ...(status === 429 ? { "Retry-After": "900" } : {}),
      ...(status === 503 ? { "Retry-After": "3" } : {}),
    },
  });
}
function strictQuery(search: URLSearchParams): Record<string, string | string[]> {
  const result = Object.create(null) as Record<string, string | string[]>;
  for (const [key, value] of search) result[key] = Object.hasOwn(result, key) ? [...(Array.isArray(result[key]) ? result[key] : [result[key] as string]), value] : value;
  return result;
}
