import "server-only";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  getConfiguredAppBaseUrl,
  isProductionEnvironment,
  shouldTrustProxyHeaders
} from "@/modules/platform/application/environment";

export const correlationIdHeaderName = "X-Correlation-ID";
const generatedCorrelationIds = new WeakMap<Request, string>();

export function getRequestContext(request: Request) {
  return {
    ipAddress: getClientIpAddress(request),
    userAgent: request.headers.get("user-agent") ?? undefined,
    correlationId: getCorrelationId(request)
  };
}

function getClientIpAddress(request: Request): string | undefined {
  if (!shouldTrustProxyHeaders()) {
    return undefined;
  }

  const forwardedFor = request.headers.get("x-forwarded-for");
  const forwardedIp = forwardedFor?.split(",")[0]?.trim();

  return forwardedIp || request.headers.get("x-real-ip")?.trim() || undefined;
}

export function getCorrelationId(request: Request): string {
  const headerValue = request.headers.get(correlationIdHeaderName);

  if (isValidCorrelationId(headerValue)) {
    return headerValue;
  }

  const existingCorrelationId = generatedCorrelationIds.get(request);

  if (existingCorrelationId) {
    return existingCorrelationId;
  }

  const correlationId = randomUUID();

  generatedCorrelationIds.set(request, correlationId);

  return correlationId;
}

export function jsonResponse<TBody>(
  request: Request,
  body: TBody,
  init: ResponseInit = {}
) {
  const correlationId = getCorrelationId(request);
  const shouldIncludeCorrelationId = isValidCorrelationId(
    request.headers.get(correlationIdHeaderName)
  );
  const responseBody = isErrorBody(body) && shouldIncludeCorrelationId
    ? {
        ...body,
        correlationId
      }
    : body;
  const response = NextResponse.json(responseBody, init);

  response.headers.set(correlationIdHeaderName, correlationId);

  return response;
}

export function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  const expectedOrigin = getConfiguredAppOrigin();

  if (!expectedOrigin) {
    return !isProductionEnvironment();
  }

  if (!origin) {
    return !isProductionEnvironment() || requestOrigin(request) === expectedOrigin;
  }

  return normalizeOrigin(origin) === expectedOrigin;
}

function getConfiguredAppOrigin(): string | null {
  const appBaseUrl = getConfiguredAppBaseUrl();

  if (!appBaseUrl) {
    return null;
  }

  return normalizeOrigin(appBaseUrl);
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function requestOrigin(request: Request): string | null {
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}

export function isJsonRequest(request: Request): boolean {
  const contentType = request.headers.get("Content-Type") ?? "";

  return contentType.toLocaleLowerCase("en-US").includes("application/json");
}

export function unsupportedMediaType() {
  return {
    code: "UNSUPPORTED_MEDIA_TYPE",
    message: "La peticion debe enviarse como JSON."
  } as const;
}

export function invalidJson() {
  return {
    code: "INVALID_JSON",
    message: "El cuerpo de la peticion no es JSON valido."
  } as const;
}

export function originNotAllowed() {
  return {
    code: "ORIGIN_NOT_ALLOWED",
    message: "Origen no permitido."
  } as const;
}

export function validationError(issues: unknown) {
  return {
    code: "VALIDATION_ERROR",
    issues
  } as const;
}

function isValidCorrelationId(value: string | null): value is string {
  return Boolean(value && /^[a-zA-Z0-9._:-]{8,100}$/.test(value));
}

function isErrorBody(body: unknown): body is { code: string; message?: string } {
  return (
    body !== null &&
    typeof body === "object" &&
    "code" in body &&
    typeof (body as { code?: unknown }).code === "string"
  );
}
