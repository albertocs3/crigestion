import { createHash, createHmac } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { stageVerifactuCredential, stageVerifactuCredentialSchema } from "@/modules/billing/application/verifactuCredentials";
import { readConfiguredVerifactuCredentialCycle } from "@/modules/billing/infrastructure/verifactu/configuredCredentialCycle";
import { idempotencyStorageKey, jsonResponse, validationError } from "@/modules/platform/application/http";
import { getVerifactuCredentialIdempotencySecret } from "@/modules/platform/application/environment";
import { isStagingProductionCapabilityForbidden } from "@/modules/platform/application/stagingEnvironment";
import { authorizeCredentialMutation } from "../_credential-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  // authorizeCredentialMutation ejecuta isAllowedOrigin(request) y validateCsrfToken(...).
  const authorization = await authorizeCredentialMutation(request, "stage");
  if (!authorization.ok) return authorization.response;
  let pfx: Buffer | null = null;
  try {
    if (!Buffer.isBuffer(authorization.body)) return jsonResponse(request, { code: "INVALID_MULTIPART", message: "El formulario multipart no es valido." }, { status: 400 });
    let dependencies: ReturnType<typeof readConfiguredVerifactuCredentialCycle>;
    try { dependencies = readConfiguredVerifactuCredentialCycle(); }
    catch {
      await prisma.auditEvent.create({ data: { eventType: "VERIFACTU_MTLS_CONFIGURATION_INVALID", actorType: "USER", payload: { actorUserId: authorization.user.id, correlationId: authorization.correlationId } } });
      return jsonResponse(request, { code: "VERIFACTU_CREDENTIAL_STORE_NOT_CONFIGURED", message: "El almacen cifrado de certificados no esta configurado. Contacta con administracion." }, { status: 503 });
    }
    const parts = parseMultipartForm(authorization.body, request.headers.get("Content-Type") ?? "");
    if (!parts) return jsonResponse(request, { code: "INVALID_MULTIPART", message: "El formulario multipart no es valido." }, { status: 400 });
    const allowedFields = new Set(["sifInstallationId", "alias", "passphrase", "endpointKind", "allowProduction", "certificate"]);
    if (parts.some((part) => !allowedFields.has(part.name)) || Array.from(allowedFields).some((key) => parts.filter((part) => part.name === key).length !== 1)) {
      return jsonResponse(request, validationError({ formErrors: ["Los campos del formulario no son validos."], fieldErrors: {} }), { status: 422 });
    }
    const certificate = parts.find((part) => part.name === "certificate")!;
    if (!certificate.filename || certificate.value.byteLength < 1 || certificate.value.byteLength > 512 * 1024 || !isAcceptedPkcs12Type(certificate.contentType ?? "")) {
      return jsonResponse(request, { code: "VERIFACTU_CREDENTIAL_MATERIAL_INVALID", message: "El certificado PFX no es valido." }, { status: 422 });
    }
    const payload = stageVerifactuCredentialSchema.safeParse({
      sifInstallationId: readText(parts, "sifInstallationId", 64),
      alias: readText(parts, "alias", 480),
      passphrase: readText(parts, "passphrase", 16_384),
      endpointKind: readText(parts, "endpointKind", 16),
      allowTest: true,
      allowProduction: readText(parts, "allowProduction", 5) === "true"
    });
    if (!payload.success || !["true", "false"].includes(readText(parts, "allowProduction", 5))) {
      return jsonResponse(request, validationError(payload.success ? { formErrors: ["allowProduction no es valido."], fieldErrors: {} } : payload.error.flatten()), { status: 422 });
    }
    if (payload.data.allowProduction && isStagingProductionCapabilityForbidden()) {
      await prisma.auditEvent.create({ data: {
        eventType: "VERIFACTU_PRODUCTION_CONFIGURATION_DENIED",
        actorType: "USER",
        payload: { actorUserId: authorization.user.id, operation: "CREDENTIAL_STAGE", correlationId: authorization.correlationId }
      } });
      return jsonResponse(request, {
        code: "VERIFACTU_PRODUCTION_FORBIDDEN_IN_STAGING",
        message: "Este entorno solo admite credenciales AEAT TEST."
      }, { status: 409 });
    }
    pfx = Buffer.from(certificate.value);
    const requestHash = credentialStageRequestHash(payload.data, pfx);
    const idempotencyKey = idempotencyStorageKey(authorization.user.id, "verifactu-credential-stage", payload.data.sifInstallationId, authorization.clientIdempotencyKey);
    const result = await stageVerifactuCredential({ ...payload.data, pfx }, authorization.user, { correlationId: authorization.correlationId, idempotencyKey, requestHash }, dependencies);
    return jsonResponse(request, result.ok ? result.value : result.error, { status: result.status });
  } finally {
    pfx?.fill(0);
    authorization.rawBody.fill(0);
  }
}

type MultipartPart = { name: string; filename?: string; contentType?: string; value: Buffer };

function readText(parts: MultipartPart[], name: string, maxBytes: number): string {
  const part = parts.find((candidate) => candidate.name === name);
  if (!part || part.filename || part.contentType || part.value.byteLength > maxBytes) return "";
  const value = part.value.toString("utf8");
  return Buffer.byteLength(value, "utf8") === part.value.byteLength ? value : "";
}

function isAcceptedPkcs12Type(value: string): boolean {
  return value === "" || value === "application/x-pkcs12" || value === "application/pkcs12" || value === "application/octet-stream";
}

function parseMultipartForm(body: Buffer, contentType: string): MultipartPart[] | null {
  const boundaryMatch = /^multipart\/form-data\s*;\s*boundary=([^;\s]{1,200})$/i.exec(contentType);
  if (!boundaryMatch) return null;
  const delimiter = Buffer.from(`--${boundaryMatch[1]}`, "ascii");
  const nextDelimiter = Buffer.concat([Buffer.from("\r\n", "ascii"), delimiter]);
  const headerSeparator = Buffer.from("\r\n\r\n", "ascii");
  if (!body.subarray(0, delimiter.byteLength).equals(delimiter) || body.subarray(delimiter.byteLength, delimiter.byteLength + 2).toString("ascii") !== "\r\n") return null;
  let cursor = delimiter.byteLength + 2;
  const parts: MultipartPart[] = [];
  while (parts.length < 7) {
    const headerEnd = body.indexOf(headerSeparator, cursor);
    if (headerEnd < cursor || headerEnd - cursor > 4096) return null;
    const headers = parsePartHeaders(body.subarray(cursor, headerEnd));
    if (!headers) return null;
    const valueStart = headerEnd + headerSeparator.byteLength;
    const boundaryStart = body.indexOf(nextDelimiter, valueStart);
    if (boundaryStart < valueStart) return null;
    parts.push({ ...headers, value: body.subarray(valueStart, boundaryStart) });
    const suffixStart = boundaryStart + nextDelimiter.byteLength;
    const suffix = body.subarray(suffixStart, suffixStart + 2).toString("ascii");
    if (suffix === "--") {
      const trailing = body.subarray(suffixStart + 2);
      return trailing.byteLength === 0 || trailing.toString("ascii") === "\r\n" ? parts : null;
    }
    if (suffix !== "\r\n") return null;
    cursor = suffixStart + 2;
  }
  return null;
}

function parsePartHeaders(bytes: Buffer): Omit<MultipartPart, "value"> | null {
  const text = bytes.toString("utf8");
  if (Buffer.byteLength(text, "utf8") !== bytes.byteLength) return null;
  const headers = new Map<string, string>();
  for (const line of text.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) return null;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (headers.has(name) || !["content-disposition", "content-type"].includes(name)) return null;
    headers.set(name, value);
  }
  const disposition = headers.get("content-disposition") ?? "";
  const match = /^form-data;\s*name="([A-Za-z][A-Za-z0-9]{0,63})"(?:;\s*filename="([^"\r\n]{1,255})")?$/.exec(disposition);
  if (!match) return null;
  const contentType = headers.get("content-type");
  if (contentType && !/^[A-Za-z0-9!#$&^_.+/-]{1,100}$/.test(contentType)) return null;
  return { name: match[1]!, ...(match[2] ? { filename: match[2] } : {}), ...(contentType ? { contentType: contentType.toLowerCase() } : {}) };
}

function credentialStageRequestHash(payload: ReturnType<typeof stageVerifactuCredentialSchema.parse>, pfx: Buffer): string {
  const canonicalMetadata = JSON.stringify({
    sifInstallationId: payload.sifInstallationId,
    alias: payload.alias,
    endpointKind: payload.endpointKind,
    allowTest: payload.allowTest,
    allowProduction: payload.allowProduction,
    pfxSha256: createHash("sha256").update(pfx).digest("hex")
  });
  return createHmac("sha256", getVerifactuCredentialIdempotencySecret())
    .update("VERIFACTU-CREDENTIAL-STAGE\0", "utf8")
    .update(canonicalMetadata, "utf8")
    .update("\0", "utf8")
    .update(payload.passphrase, "utf8")
    .digest("hex");
}
