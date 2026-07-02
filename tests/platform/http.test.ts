import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedOrigin } from "@/modules/platform/application/http";

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
});
