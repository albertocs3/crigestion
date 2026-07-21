import { cookies } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  requirePermission,
  sessionCookieName,
  validateCsrfToken
} from "@/modules/platform/application/auth";
import {
  companyLogoRequestHash,
  consumeCompanyLogoRateLimit,
  downloadCompanyLogo,
  uploadCompanyLogo
} from "@/modules/platform/application/companyLogoAttachments";
import {
  getCorrelationId,
  isAllowedOrigin,
  jsonResponse,
  originNotAllowed,
  unsupportedMediaType,
  validateIdempotencyKey,
  validationError
} from "@/modules/platform/application/http";
import { requireMaintenanceModeInactive } from "@/modules/platform/application/maintenance";
import { companyLogoMaxBytes } from "@/modules/platform/infrastructure/companyLogoImage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const requiredPermission = "Platform.ManageConfiguration";
const maxMultipartBytes = companyLogoMaxBytes + 65_536;
const expectedLogoIdSchema = z.string().uuid().nullable();

export async function PUT(request: Request) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  if (await consumeCompanyLogoRateLimit(authorization.user.id, "upload")) {
    await auditRateLimited(authorization.user.id, "upload", authorization.correlationId);
    return jsonResponse(
      request,
      { code: "RATE_LIMITED", message: "Demasiados intentos de carga. Espera quince minutos." },
      { status: 429, headers: { "Retry-After": "900" } }
    );
  }

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^multipart\/form-data\s*;\s*boundary=[^;\s]{1,200}$/i.test(contentType)) {
    return jsonResponse(request, unsupportedMediaType(), { status: 415 });
  }
  const declaredLength = readContentLength(request.headers.get("Content-Length"));
  if (declaredLength === "invalid" || (declaredLength !== null && declaredLength > maxMultipartBytes)) {
    return payloadTooLarge(request);
  }

  const rawBody = await readBoundedBody(request, maxMultipartBytes);
  if (!rawBody) return payloadTooLarge(request);
  try {
    const form = await parseMultipart(request.url, contentType, rawBody);
    if (!form) return invalidMultipart(request);
    const keys = Array.from(form.keys());
    if (
      keys.some((key) => key !== "logo" && key !== "expectedLogoId") ||
      form.getAll("logo").length !== 1 ||
      form.getAll("expectedLogoId").length !== 1
    ) {
      return jsonResponse(
        request,
        validationError({ formErrors: ["Los campos del formulario no son validos."], fieldErrors: {} }),
        { status: 422 }
      );
    }

    const logo = form.get("logo");
    const expectedLogoIdValue = form.get("expectedLogoId");
    if (!isUploadedFile(logo) || typeof expectedLogoIdValue !== "string") {
      return invalidMultipart(request);
    }
    if (logo.size < 1 || logo.size > companyLogoMaxBytes) return payloadTooLarge(request);
    const parsedExpectedLogoId = expectedLogoIdSchema.safeParse(
      expectedLogoIdValue.trim() || null
    );
    if (!parsedExpectedLogoId.success) {
      return jsonResponse(request, validationError(parsedExpectedLogoId.error.flatten()), { status: 422 });
    }

    const bytes = Buffer.from(await logo.arrayBuffer());
    try {
      const requestHash = companyLogoRequestHash({
        bytes,
        fileName: logo.name,
        declaredMimeType: logo.type,
        expectedLogoId: parsedExpectedLogoId.data
      });
      const result = await uploadCompanyLogo(
        {
          bytes,
          fileName: logo.name,
          declaredMimeType: logo.type,
          expectedLogoId: parsedExpectedLogoId.data,
          clientIdempotencyKey: authorization.clientIdempotencyKey,
          requestHash
        },
        authorization.user,
        { correlationId: authorization.correlationId }
      );
      const headers = !result.ok && result.error.retryAfterSeconds
        ? { "Retry-After": String(result.error.retryAfterSeconds) }
        : undefined;
      return jsonResponse(request, result.ok ? result.value : result.error, {
        status: result.status,
        headers
      });
    } finally {
      bytes.fill(0);
    }
  } finally {
    rawBody.fill(0);
  }
}

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(sessionCookieName)?.value;
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(sessionToken, requiredPermission, { correlationId });
  if (!authorization.ok) {
    return jsonResponse(request, authorization.error, { status: authorization.status });
  }
  if (await consumeCompanyLogoRateLimit(authorization.user.id, "download")) {
    await auditRateLimited(authorization.user.id, "download", correlationId);
    return jsonResponse(
      request,
      { code: "RATE_LIMITED", message: "Demasiadas descargas. Espera un minuto." },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }

  const result = await downloadCompanyLogo(authorization.user, { correlationId });
  if (!result.ok) return jsonResponse(request, result.error, { status: result.status });

  return new Response(new Uint8Array(result.value.bytes), {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="company-logo.${result.value.extension}"`,
      "Content-Length": String(result.value.bytes.byteLength),
      "Content-Type": result.value.contentType,
      "Cross-Origin-Resource-Policy": "same-origin",
      ETag: result.value.etag,
      "X-Content-Type-Options": "nosniff",
      "X-Correlation-ID": correlationId
    }
  });
}

async function authorizeMutation(request: Request) {
  if (!isAllowedOrigin(request)) {
    return { ok: false as const, response: jsonResponse(request, originNotAllowed(), { status: 403 }) };
  }
  const sessionToken = (await cookies()).get(sessionCookieName)?.value;
  const csrf = validateCsrfToken(sessionToken, request.headers.get("X-CSRF-Token"));
  if (!csrf.ok) {
    return { ok: false as const, response: jsonResponse(request, csrf.error, { status: csrf.status }) };
  }
  const correlationId = getCorrelationId(request);
  const authorization = await requirePermission(sessionToken, requiredPermission, { correlationId });
  if (!authorization.ok) {
    return { ok: false as const, response: jsonResponse(request, authorization.error, { status: authorization.status }) };
  }
  const maintenance = await requireMaintenanceModeInactive(authorization.user, request, { correlationId });
  if (!maintenance.ok) {
    return { ok: false as const, response: jsonResponse(request, maintenance.error, { status: maintenance.status }) };
  }
  const idempotency = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
  if (!idempotency.ok) {
    return { ok: false as const, response: jsonResponse(request, idempotency.error, { status: idempotency.status }) };
  }
  return {
    ok: true as const,
    user: authorization.user,
    correlationId,
    clientIdempotencyKey: idempotency.key
  };
}

function readContentLength(value: string | null): number | null | "invalid" {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : "invalid";
}

async function readBoundedBody(request: Request, maximum: number): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        value.fill(0);
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
      value.fill(0);
    }
    return Buffer.concat(chunks, size);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}

async function parseMultipart(
  url: string,
  contentType: string,
  rawBody: Buffer
): Promise<FormData | null> {
  try {
    return await new Request(url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(rawBody)
    }).formData();
  } catch {
    return null;
  }
}

function isUploadedFile(value: FormDataEntryValue | null): value is File {
  return value !== null && typeof value !== "string" &&
    typeof value.name === "string" && typeof value.type === "string" &&
    typeof value.size === "number" && typeof value.arrayBuffer === "function";
}

function invalidMultipart(request: Request): Response {
  return jsonResponse(
    request,
    { code: "INVALID_MULTIPART", message: "El formulario multipart no es valido." },
    { status: 400 }
  );
}

function payloadTooLarge(request: Request): Response {
  return jsonResponse(
    request,
    { code: "PAYLOAD_TOO_LARGE", message: "La peticion supera el tamano permitido." },
    { status: 413 }
  );
}

async function auditRateLimited(
  actorUserId: string,
  scope: "upload" | "download",
  correlationId: string
): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      eventType: "COMPANY_LOGO_RATE_LIMITED",
      actorType: "USER",
      payload: { actorUserId, scope, correlationId }
    }
  });
}
