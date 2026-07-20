import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSessionCookieSameSite,
  isSessionCookieSecure,
  readPlatformEnvironment,
  shouldTrustProxyHeaders
} from "@/modules/platform/application/environment";
import {
  isVerifactuPreparationAllowed,
  readOperationalEnvironment
} from "@/modules/platform/application/operationalEnvironment";
import { isStagingProductionCapabilityForbidden } from "@/modules/platform/application/stagingEnvironment";
import {
  isTfmDemoRuntimeEnvironment,
  tfmDemoConfirmation
} from "@/modules/platform/application/tfmDemoEnvironment";

const validSecret = "0123456789abcdef0123456789abcdef";
const validCredentialSecret = "verifactu-idempotency-secret-32-bytes";

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

  it("normalizes an empty VeriFactu idempotency secret in development and requires it in production", () => {
    expect(readPlatformEnvironment({
      NODE_ENV: "development", APP_ENV: "development", APP_SESSION_SECRET: validSecret,
      VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET: ""
    }).VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET).toBeUndefined();

    expect(() => readPlatformEnvironment({
      NODE_ENV: "production", APP_ENV: "production", APP_SESSION_SECRET: validSecret,
      APP_BASE_URL: "https://app.example.test"
    })).toThrow("VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET is required in deployed environments");
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
        VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET: validCredentialSecret,
        APP_BASE_URL: "http://app.example.test"
      })
    ).toThrow("APP_BASE_URL must use HTTPS");

    expect(() =>
      readPlatformEnvironment({
        NODE_ENV: "production",
        APP_ENV: "production",
        APP_SESSION_SECRET: validSecret,
        VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET: validCredentialSecret,
        APP_BASE_URL: "https://app.example.test",
        AUTH_COOKIE_SECURE: "false"
      })
    ).toThrow("AUTH_COOKIE_SECURE cannot be false");
  });

  it("derives APP_ENV from NODE_ENV and rejects production downgrades", () => {
    const config = readPlatformEnvironment({
      NODE_ENV: "production",
      APP_SESSION_SECRET: validSecret,
      VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET: validCredentialSecret,
      APP_BASE_URL: "https://app.example.test"
    });

    expect(config.APP_ENV).toBe("production");

    expect(() =>
      readPlatformEnvironment({
        NODE_ENV: "production",
        APP_ENV: "development",
        APP_SESSION_SECRET: validSecret,
        VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET: validCredentialSecret,
        APP_BASE_URL: "https://app.example.test"
      })
    ).toThrow("APP_ENV must be staging or production");
  });

  it("treats staging as a production-grade HTTPS deployment", () => {
    const config = readPlatformEnvironment({
      NODE_ENV: "production",
      APP_ENV: "staging",
      APP_BASE_URL: "https://gestion-test.crisoft.es",
      APP_SESSION_SECRET: validSecret,
      VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET: validCredentialSecret,
      AUTH_COOKIE_SECURE: "true",
      TRUST_PROXY_HEADERS: "true"
    });

    expect(config.APP_ENV).toBe("staging");

    expect(() => readPlatformEnvironment({
      ...config,
      APP_BASE_URL: "http://gestion-test.crisoft.es"
    })).toThrow("APP_BASE_URL must use HTTPS in deployed environments");

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("APP_BASE_URL", "https://gestion-test.crisoft.es");
    vi.stubEnv("APP_SESSION_SECRET", validSecret);
    vi.stubEnv("VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET", validCredentialSecret);
    vi.stubEnv("AUTH_COOKIE_SECURE", "true");
    vi.stubEnv("TRUST_PROXY_HEADERS", "false");
    expect(isSessionCookieSecure()).toBe(true);
    expect(shouldTrustProxyHeaders()).toBe(false);
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

  it("recognizes only the exact isolated TEST database and VeriFactu configuration", () => {
    const summary = readOperationalEnvironment({
      NODE_ENV: "test", APP_ENV: "test",
      DATABASE_URL: "postgresql://secret-user:secret-password@localhost:5432/crigestion_test?schema=public",
      VERIFACTU_ENABLED: "true", VERIFACTU_ENVIRONMENT: "TEST", VERIFACTU_WORKER_ENVIRONMENT: "TEST",
      VERIFACTU_WORKER_ALLOW_PRODUCTION: "false", VERIFACTU_ALLOW_PRODUCTION: "false"
    });
    expect(summary).toMatchObject({ appEnvironment: "TEST", isTestMode: true, databaseConfiguredAsTest: true,
      verifactuEnvironment: "TEST", workerEnvironment: "TEST", testIsolationConfigured: true });
    expect(JSON.stringify(summary)).not.toContain("secret-user");
    expect(JSON.stringify(summary)).not.toContain("secret-password");
  });

  it("recognizes staging only with its exact database and AEAT TEST gates", () => {
    const summary = readOperationalEnvironment({
      NODE_ENV: "production", APP_ENV: "staging",
      DATABASE_URL: "postgresql://crigestion_staging_app:hidden@127.0.0.1:5432/crigestion_staging?schema=public",
      VERIFACTU_ENABLED: "true", VERIFACTU_ENVIRONMENT: "TEST", VERIFACTU_WORKER_ENVIRONMENT: "TEST",
      VERIFACTU_WORKER_ALLOW_PRODUCTION: "false", VERIFACTU_ALLOW_PRODUCTION: "false"
    });
    expect(summary).toMatchObject({
      appEnvironment: "STAGING", isTestMode: true, expectedDatabaseName: "crigestion_staging",
      databaseConfiguredAsTest: true, testIsolationConfigured: true
    });
    expect(readOperationalEnvironment({
      NODE_ENV: "production", APP_ENV: "staging",
      DATABASE_URL: "postgresql://crigestion_staging_app:hidden@127.0.0.1:5432/crigestion_staging?schema=public",
      VERIFACTU_ENABLED: "false", VERIFACTU_ENVIRONMENT: "TEST", VERIFACTU_WORKER_ENVIRONMENT: "TEST",
      VERIFACTU_WORKER_ALLOW_PRODUCTION: "false", VERIFACTU_ALLOW_PRODUCTION: "false"
    }).testIsolationConfigured).toBe(true);
    expect(isVerifactuPreparationAllowed({
      APP_ENV: "staging", VERIFACTU_ENABLED: "true", VERIFACTU_ENVIRONMENT: "TEST",
      VERIFACTU_ALLOW_PRODUCTION: "false"
    })).toBe(true);
    expect(readOperationalEnvironment({
      NODE_ENV: "production", APP_ENV: "staging",
      DATABASE_URL: "postgresql://hidden:hidden@127.0.0.1:5432/crigestion_test",
      VERIFACTU_ENABLED: "false"
    }).testIsolationConfigured).toBe(false);
  });

  it("keeps production fiscal preparation behind an independent release gate", () => {
    const production = {
      APP_ENV: "production",
      VERIFACTU_ENABLED: "true",
      VERIFACTU_ENVIRONMENT: "PRODUCTION",
      VERIFACTU_WORKER_ENVIRONMENT: "PRODUCTION",
      VERIFACTU_WORKER_ALLOW_PRODUCTION: "true"
    };
    expect(isVerifactuPreparationAllowed(production)).toBe(false);
    expect(isVerifactuPreparationAllowed({
      ...production,
      VERIFACTU_ALLOW_PRODUCTION: "true",
      VERIFACTU_PRODUCTION_RELEASE_ID: "release-2026.07.15"
    })).toBe(true);
    expect(isVerifactuPreparationAllowed({
      ...production,
      APP_ENV: "test",
      VERIFACTU_ALLOW_PRODUCTION: "true",
      VERIFACTU_PRODUCTION_RELEASE_ID: "release-2026.07.15"
    })).toBe(false);
  });

  it("allows an explicit TFM demo to use only AEAT TEST on the exact local production database", () => {
    const demo = {
      NODE_ENV: "production",
      APP_ENV: "production",
      DATABASE_URL: "postgresql://crigestion_app:hidden@127.0.0.1:5433/crigestion_prod?schema=public",
      VERIFACTU_TFM_DEMO_CONFIRM: tfmDemoConfirmation,
      VERIFACTU_ENABLED: "true",
      VERIFACTU_ENVIRONMENT: "TEST",
      VERIFACTU_ALLOW_PRODUCTION: "false",
      VERIFACTU_PRODUCTION_RELEASE_ID: "",
      VERIFACTU_WORKER_ENVIRONMENT: "TEST",
      VERIFACTU_WORKER_ALLOW_PRODUCTION: "false",
      VERIFACTU_WORKER_PRODUCTION_CONFIRM: "",
      VERIFACTU_WORKER_EXPECTED_DATABASE: "crigestion_prod"
    } satisfies NodeJS.ProcessEnv;
    expect(isTfmDemoRuntimeEnvironment(demo)).toBe(true);
    expect(readOperationalEnvironment(demo)).toMatchObject({
      appEnvironment: "PRODUCTION",
      tfmDemoMode: true,
      isTestMode: true,
      expectedDatabaseName: "crigestion_prod",
      databaseConfiguredAsTest: true,
      testIsolationConfigured: true,
      verifactuEnvironment: "TEST",
      workerEnvironment: "TEST"
    });
    expect(isVerifactuPreparationAllowed(demo)).toBe(true);
    expect(isStagingProductionCapabilityForbidden(demo)).toBe(true);
  });

  it.each([
    ["VERIFACTU_ENVIRONMENT", "PRODUCTION"],
    ["VERIFACTU_ALLOW_PRODUCTION", "true"],
    ["VERIFACTU_WORKER_ALLOW_PRODUCTION", "true"],
    ["VERIFACTU_PRODUCTION_RELEASE_ID", "release-real"],
    ["VERIFACTU_WORKER_PRODUCTION_CONFIRM", "AEAT_PRODUCTION_AUTHORIZED"],
    ["VERIFACTU_WORKER_EXPECTED_DATABASE", "crigestion_test"],
    ["DATABASE_URL", "postgresql://crigestion_app:hidden@127.0.0.1:5432/crigestion_prod?schema=public"]
  ])("fails closed when the TFM demo has unsafe %s", (name, value) => {
    const demo = {
      NODE_ENV: "production", APP_ENV: "production",
      DATABASE_URL: "postgresql://crigestion_app:hidden@127.0.0.1:5433/crigestion_prod?schema=public",
      VERIFACTU_TFM_DEMO_CONFIRM: tfmDemoConfirmation,
      VERIFACTU_ENABLED: "true", VERIFACTU_ENVIRONMENT: "TEST", VERIFACTU_ALLOW_PRODUCTION: "false",
      VERIFACTU_PRODUCTION_RELEASE_ID: "", VERIFACTU_WORKER_ENVIRONMENT: "TEST",
      VERIFACTU_WORKER_ALLOW_PRODUCTION: "false", VERIFACTU_WORKER_PRODUCTION_CONFIRM: "",
      VERIFACTU_WORKER_EXPECTED_DATABASE: "crigestion_prod"
    } satisfies NodeJS.ProcessEnv;
    const unsafe = { ...demo, [name]: value };
    expect(isTfmDemoRuntimeEnvironment(unsafe)).toBe(false);
    expect(isVerifactuPreparationAllowed(unsafe)).toBe(false);
    expect(readOperationalEnvironment(unsafe).testIsolationConfigured).toBe(false);
  });

  it("marks missing, malformed and non-test database declarations as unverified", () => {
    for (const databaseUrl of [undefined, "not-a-url", "postgresql://localhost/crigestion", "mysql://localhost/crigestion_test"]) {
      expect(readOperationalEnvironment({ NODE_ENV: "test", APP_ENV: "test", DATABASE_URL: databaseUrl,
        VERIFACTU_ENABLED: "false" })).toMatchObject({ isTestMode: true, databaseConfiguredAsTest: false,
        testIsolationConfigured: false });
    }
  });

  it("does not expose the TEST banner mode outside APP_ENV test", () => {
    expect(readOperationalEnvironment({ NODE_ENV: "development", APP_ENV: "development",
      DATABASE_URL: "postgresql://localhost/crigestion_test" }).isTestMode).toBe(false);
    expect(readOperationalEnvironment({ NODE_ENV: "production", APP_ENV: "production",
      DATABASE_URL: "postgresql://localhost/crigestion_test" }).isTestMode).toBe(false);
  });

  it("fails closed for non-canonical environment and boolean flag values", () => {
    for (const appEnv of ["TEST", " test "]) {
      expect(readOperationalEnvironment({ NODE_ENV: "test", APP_ENV: appEnv,
        DATABASE_URL: "postgresql://localhost/crigestion_test", VERIFACTU_ENABLED: "false" }))
        .toMatchObject({ isTestMode: false, testIsolationConfigured: false });
    }
    for (const invalidFlag of ["TRUE", "yes"]) {
      expect(readOperationalEnvironment({ NODE_ENV: "test", APP_ENV: "test",
        DATABASE_URL: "postgresql://localhost/crigestion_test", VERIFACTU_ENABLED: invalidFlag }))
        .toMatchObject({ configurationFlagsValid: false, testIsolationConfigured: false });
      expect(readOperationalEnvironment({ NODE_ENV: "test", APP_ENV: "test",
        DATABASE_URL: "postgresql://localhost/crigestion_test", VERIFACTU_ENABLED: "false",
        VERIFACTU_WORKER_ALLOW_PRODUCTION: invalidFlag }))
        .toMatchObject({ configurationFlagsValid: false, testIsolationConfigured: false });
      expect(readOperationalEnvironment({ NODE_ENV: "test", APP_ENV: "test",
        DATABASE_URL: "postgresql://localhost/crigestion_test", VERIFACTU_ENABLED: "false",
        VERIFACTU_ALLOW_PRODUCTION: invalidFlag }))
        .toMatchObject({ configurationFlagsValid: false, testIsolationConfigured: false });
    }
  });
});
