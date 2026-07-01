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
  const appBaseUrl = process.env.APP_BASE_URL;

  if (!origin || !appBaseUrl) {
    return true;
  }

  return origin === appBaseUrl;
}
