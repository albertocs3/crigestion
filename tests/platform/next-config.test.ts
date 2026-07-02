import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const nextConfigPath = pathToFileURL(`${process.cwd()}/next.config.mjs`).href;

describe("Next.js security configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("disables the powered-by header and configures base security headers", async () => {
    const config = await importConfig("test");
    const headers = await readConfiguredHeaders(config);

    expect(config.poweredByHeader).toBe(false);
    expect(headers).toMatchObject({
      "Content-Security-Policy": expect.stringContaining("default-src 'self'"),
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()"
    });
    expect(headers["Strict-Transport-Security"]).toBeUndefined();
  });

  it("enables HSTS only for production builds", async () => {
    const config = await importConfig("production");
    const headers = await readConfiguredHeaders(config);

    expect(headers["Strict-Transport-Security"]).toBe(
      "max-age=31536000; includeSubDomains"
    );
  });
});

async function importConfig(nodeEnv: string) {
  vi.stubEnv("NODE_ENV", nodeEnv);

  return (await import(`${nextConfigPath}?env=${nodeEnv}-${Date.now()}`)).default;
}

async function readConfiguredHeaders(config: {
  headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>>;
}) {
  const [routeHeaders] = await config.headers();

  expect(routeHeaders?.source).toBe("/(.*)");

  return Object.fromEntries(
    (routeHeaders?.headers ?? []).map((header) => [header.key, header.value])
  );
}
