import { cookies } from "next/headers";
import { z } from "zod";
import {
  requirePermission,
  sessionCookieName,
} from "@/modules/platform/application/auth";
import {
  getCorrelationId,
  jsonResponse,
  validationError,
} from "@/modules/platform/application/http";
import { getCustomerSupportContext } from "@/modules/support/application/customerContext";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const paramsSchema = z
  .object({ customerId: z.string().uuid() })
  .strict();

export async function GET(
  request: Request,
  context: { params: Promise<{ customerId: string }> },
) {
  const correlationId = getCorrelationId(request);
  const token = (await cookies()).get(sessionCookieName)?.value;
  const customerAuthorization = await requirePermission(
    token,
    "Customers.View",
    { correlationId },
  );
  if (!customerAuthorization.ok) {
    return response(
      request,
      customerAuthorization.error,
      customerAuthorization.status,
    );
  }
  const supportAuthorization = await requirePermission(token, "Support.View", {
    correlationId,
  });
  if (!supportAuthorization.ok) {
    return response(
      request,
      supportAuthorization.error,
      supportAuthorization.status,
    );
  }
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    return response(
      request,
      validationError({
        formErrors: ["El contexto de soporte no admite parámetros."],
        fieldErrors: {},
      }),
      422,
    );
  }
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) {
    return response(request, validationError(parsed.error.flatten()), 422);
  }
  const result = await getCustomerSupportContext(
    parsed.data.customerId,
    supportAuthorization.user,
    { correlationId },
  );
  return result.ok
    ? response(request, result.value, 200)
    : response(
        request,
        result.error,
        result.status,
        result.error.retryAfterSeconds,
      );
}

function response(
  request: Request,
  body: unknown,
  status: number,
  retryAfterSeconds?: number,
) {
  return jsonResponse(request, body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
      ...(retryAfterSeconds
        ? { "Retry-After": String(retryAfterSeconds) }
        : {}),
    },
  });
}
