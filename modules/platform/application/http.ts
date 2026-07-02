import "server-only";

export function getRequestContext(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for");

  return {
    ipAddress: forwardedFor?.split(",")[0]?.trim(),
    userAgent: request.headers.get("user-agent") ?? undefined
  };
}

export function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  const expectedOrigin = getConfiguredAppOrigin();

  if (!expectedOrigin) {
    return process.env.NODE_ENV !== "production";
  }

  if (!origin) {
    return process.env.NODE_ENV !== "production" || requestOrigin(request) === expectedOrigin;
  }

  return normalizeOrigin(origin) === expectedOrigin;
}

function getConfiguredAppOrigin(): string | null {
  const appBaseUrl = process.env.APP_BASE_URL?.trim();

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
