import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCorrelationId,
  getRequestContext,
  jsonResponse,
  isAllowedOrigin
} from "@/modules/platform/application/http";

const originalAppBaseUrl = process.env.APP_BASE_URL;

describe("platform HTTP security helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();

    if (originalAppBaseUrl === undefined) {
      delete process.env.APP_BASE_URL;
    } else {
      process.env.APP_BASE_URL = originalAppBaseUrl;
    }
  });

  it("allows local development requests when APP_BASE_URL is not configured", () => {
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.APP_BASE_URL;

    expect(
      isAllowedOrigin(new Request("http://localhost/api/platform/users"))
    ).toBe(true);
  });

  it("rejects production mutation origins when APP_BASE_URL is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.APP_BASE_URL;

    expect(
      isAllowedOrigin(new Request("https://app.example.test/api/auth/login"))
    ).toBe(false);
  });

  it("normalizes configured base URL before comparing Origin", () => {
    process.env.APP_BASE_URL = "https://app.example.test/app";

    const request = new Request("https://app.example.test/api/auth/login", {
      headers: {
        Origin: "https://app.example.test"
      }
    });

    expect(isAllowedOrigin(request)).toBe(true);
  });

  it("uses the request URL as a production fallback when Origin is absent", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.APP_BASE_URL = "https://app.example.test";

    expect(
      isAllowedOrigin(new Request("https://app.example.test/api/auth/logout"))
    ).toBe(true);
    expect(
      isAllowedOrigin(new Request("https://evil.example.test/api/auth/logout"))
    ).toBe(false);
  });

  it("ignores forwarded client IP headers in production unless explicitly trusted", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY_HEADERS", "false");
    const request = new Request("https://app.example.test/api/auth/login", {
      headers: {
        "X-Forwarded-For": "198.51.100.10"
      }
    });

    expect(getRequestContext(request).ipAddress).toBeUndefined();
  });

  it("uses forwarded client IP headers when proxy headers are trusted", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    const request = new Request("https://app.example.test/api/auth/login", {
      headers: {
        "X-Forwarded-For": "198.51.100.10, 10.0.0.1"
      }
    });

    expect(getRequestContext(request).ipAddress).toBe("198.51.100.10");
  });

  it("adds correlation id to error responses when the request carries one", async () => {
    const response = jsonResponse(
      new Request("http://localhost/api/platform/users", {
        headers: {
          "X-Correlation-ID": "test-correlation-001"
        }
      }),
      {
        code: "FORBIDDEN",
        message: "No tienes permiso para realizar esta accion."
      },
      { status: 403 }
    );
    const body = await response.json();

    expect(response.headers.get("X-Correlation-ID")).toBe("test-correlation-001");
    expect(body).toEqual({
      code: "FORBIDDEN",
      message: "No tienes permiso para realizar esta accion.",
      correlationId: "test-correlation-001"
    });
  });

  it("reuses generated correlation ids for the same request", () => {
    const request = new Request("http://localhost/api/platform/users");

    expect(getCorrelationId(request)).toBe(getCorrelationId(request));
  });
});
