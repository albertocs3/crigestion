import { cookies } from "next/headers";
import {
  requirePermission,
  sessionCookieName,
} from "@/modules/platform/application/auth";
import {
  getCorrelationId,
  jsonResponse,
  validationError,
} from "@/modules/platform/application/http";
import {
  getSupportCommunication,
  isSupportCommunicationCorrectionsCursor,
  supportCommunicationDetailQuerySchema,
  supportCommunicationParamsSchema,
} from "@/modules/support/application/communications";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ communicationId: string }> },
) {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const correlationId = getCorrelationId(request);
  const auth = await requirePermission(token, "Support.ViewCommunications", {
    correlationId,
  });
  if (!auth.ok) return response(request, auth.error, auth.status);
  const params = supportCommunicationParamsSchema.safeParse(
    await context.params,
  );
  if (!params.success)
    return response(request, validationError(params.error.flatten()), 422);
  const queryValues = [...new URL(request.url).searchParams.entries()];
  const query = supportCommunicationDetailQuerySchema.safeParse(
    queryValues.length === 0
      ? {}
      : queryValues.length === 1 && queryValues[0]![0] === "correctionsCursor"
        ? { correctionsCursor: queryValues[0]![1] }
        : { invalid: true },
  );
  if (
    !query.success ||
    (query.data.correctionsCursor &&
      !isSupportCommunicationCorrectionsCursor(
        query.data.correctionsCursor,
        params.data.communicationId,
      ))
  )
    return response(
      request,
      validationError({
        fieldErrors: { correctionsCursor: ["El cursor no es válido."] },
        formErrors: [],
      }),
      422,
    );
  const value = await getSupportCommunication(
    params.data.communicationId,
    auth.user,
    { correlationId },
    query.data.correctionsCursor,
  );
  return value
    ? response(request, value, 200)
    : response(
        request,
        {
          code: "SUPPORT_COMMUNICATION_NOT_FOUND",
          message: "La comunicación no existe.",
        },
        404,
      );
}
function response(request: Request, body: unknown, status: number) {
  return jsonResponse(request, body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}
