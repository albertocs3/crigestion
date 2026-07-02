import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSessionCookieSameSite,
  isSessionCookieSecure,
  readPlatformEnvironment,
  shouldTrustProxyHeaders
} from "@/modules/platform/application/environment";

const validSecret = "0123456789abcdef0123456789abcdef";

describe("platform environment validation", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.unstubAllEnvs();

    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }

    Object.assign(process.env, originalEnv);
  });

  it("accepts development defaults with a strong session secret", () => {
    const config = readPlatformEnvironment({
      NODE_ENV: "development",
      APP_ENV: "development",
      APP_SESSION_SECRET: validSecret
    });

    expect(config).toMatchObject({
      NODE_ENV: "development",
      AUTH_COOKIE_NAME: "crigestion_session",
      AUTH_COOKIE_SAME_SITE: "lax",
      TRUST_PROXY_HEADERS: "false"
    });
  });

  it("rejects missing or placeholder session secrets", () => {
    expect(() =>
      readPlatformEnvironment({
        NODE_ENV: "development"
      })
    ).toThrow("Invalid platform environment");

    expect(() =>
      readPlatformEnvironment({
        NODE_ENV: "development",
        APP_ENV: "development",
        APP_SESSION_SECRET: "change-me-in-local-env"
      })
    ).toThrow("APP_SESSION_SECRET is a placeholder");
  });

  it("requires HTTPS app base URL and secure cookies in production", () => {
    expect(() =>
      readPlatformEnvironment({
        NODE_ENV: "production",
        APP_ENV: "production",
        APP_SESSION_SECRET: validSecret,
        APP_BASE_URL: "http://app.example.test"
      })
    ).toThrow("APP_BASE_URL must use HTTPS");

    expect(() =>
      readPlatformEnvironment({
        NODE_ENV: "production",
        APP_ENV: "production",
        APP_SESSION_SECRET: validSecret,
        APP_BASE_URL: "https://app.example.test",
        AUTH_COOKIE_SECURE: "false"
      })
    ).toThrow("AUTH_COOKIE_SECURE cannot be false");
  });

  it("derives APP_ENV from NODE_ENV and rejects production downgrades", () => {
    const config = readPlatformEnvironment({
      NODE_ENV: "production",
      APP_SESSION_SECRET: validSecret,
      APP_BASE_URL: "https://app.example.test"
    });

    expect(config.APP_ENV).toBe("production");

    expect(() =>
      readPlatformEnvironment({
        NODE_ENV: "production",
        APP_ENV: "development",
        APP_SESSION_SECRET: validSecret,
        APP_BASE_URL: "https://app.example.test"
      })
    ).toThrow("APP_ENV must be production");
  });

  it("keeps cookie and proxy settings explicit", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("APP_SESSION_SECRET", validSecret);
    vi.stubEnv("AUTH_COOKIE_SECURE", "false");
    vi.stubEnv("AUTH_COOKIE_SAME_SITE", "strict");
    vi.stubEnv("TRUST_PROXY_HEADERS", "false");

    expect(isSessionCookieSecure()).toBe(false);
    expect(getSessionCookieSameSite()).toBe("strict");
    expect(shouldTrustProxyHeaders()).toBe(true);

    vi.stubEnv("AUTH_COOKIE_SECURE", "true");

    expect(isSessionCookieSecure()).toBe(true);
  });

  it("rejects unsupported SameSite values", () => {
    expect(() =>
      readPlatformEnvironment({
        NODE_ENV: "development",
        APP_ENV: "development",
        APP_SESSION_SECRET: validSecret,
        AUTH_COOKIE_SAME_SITE: "none"
      })
    ).toThrow("Invalid platform environment");
  });

  it("rejects invalid cookie names", () => {
    expect(() =>
      readPlatformEnvironment({
        NODE_ENV: "development",
        APP_ENV: "development",
        APP_SESSION_SECRET: validSecret,
        AUTH_COOKIE_NAME: "bad cookie=name"
      })
    ).toThrow("Invalid platform environment");
  });
});
