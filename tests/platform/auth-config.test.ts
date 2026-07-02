import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSessionCookieSameSite,
  isSessionCookieSecure
} from "@/modules/platform/application/auth";

describe("authentication cookie configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.AUTH_COOKIE_SECURE;
    delete process.env.AUTH_COOKIE_SAME_SITE;
  });

  it("forces secure session cookies in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.AUTH_COOKIE_SECURE = "false";

    expect(isSessionCookieSecure()).toBe(true);
  });

  it("allows insecure cookies only when explicitly configured outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    process.env.AUTH_COOKIE_SECURE = "false";

    expect(isSessionCookieSecure()).toBe(false);

    process.env.AUTH_COOKIE_SECURE = "true";

    expect(isSessionCookieSecure()).toBe(true);
  });

  it("keeps SameSite limited to lax or strict", () => {
    process.env.AUTH_COOKIE_SAME_SITE = "strict";
    expect(getSessionCookieSameSite()).toBe("strict");

    process.env.AUTH_COOKIE_SAME_SITE = "none";
    expect(getSessionCookieSameSite()).toBe("lax");
  });
});
