import { NextResponse, type NextRequest } from "next/server";

const correlationIdHeaderName = "X-Correlation-ID";

export function middleware(request: NextRequest) {
  const correlationId = getOrCreateCorrelationId(
    request.headers.get(correlationIdHeaderName)
  );
  const requestHeaders = new Headers(request.headers);

  requestHeaders.set(correlationIdHeaderName, correlationId);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders
    }
  });

  response.headers.set(correlationIdHeaderName, correlationId);

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};

function getOrCreateCorrelationId(value: string | null): string {
  return isValidCorrelationId(value) ? value : crypto.randomUUID();
}

function isValidCorrelationId(value: string | null): value is string {
  return Boolean(value && /^[a-zA-Z0-9._:-]{8,100}$/.test(value));
}
