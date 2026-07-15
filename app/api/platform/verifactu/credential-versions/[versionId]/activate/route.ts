import { createHash } from "node:crypto";
import { activateVerifactuCredentialSchema, testAndActivateVerifactuCredential } from "@/modules/billing/application/verifactuCredentials";
import { readConfiguredVerifactuCredentialCycle } from "@/modules/billing/infrastructure/verifactu/configuredCredentialCycle";
import { idempotencyStorageKey, jsonResponse, validationError } from "@/modules/platform/application/http";
import { authorizeCredentialMutation } from "../../../_credential-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ versionId: string }> }) {
  // authorizeCredentialMutation ejecuta isAllowedOrigin(request) y validateCsrfToken(...).
  const authorization = await authorizeCredentialMutation(request, "activate");
  if (!authorization.ok) return authorization.response;
  const { versionId } = await context.params;
  const version = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(versionId) ? versionId : null;
  const payload = activateVerifactuCredentialSchema.safeParse(authorization.body);
  if (!version || !payload.success) return jsonResponse(request, validationError(payload.success ? { versionId: ["UUID invalido."] } : payload.error.flatten()), { status: 422 });
  const requestHash = createHash("sha256").update(authorization.rawBody).digest("hex");
  const idempotencyKey = idempotencyStorageKey(authorization.user.id, "verifactu-credential-activate", version, authorization.clientIdempotencyKey);
  const result = await testAndActivateVerifactuCredential(version, payload.data, authorization.user, { correlationId: authorization.correlationId, idempotencyKey, requestHash }, readConfiguredVerifactuCredentialCycle());
  return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status });
}
