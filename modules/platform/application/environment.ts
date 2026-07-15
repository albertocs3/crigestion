import "server-only";

import { z } from "zod";

const sessionSecretPlaceholder = "change-me-in-local-env";

const baseEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.enum(["development", "test", "staging", "production"]),
  APP_BASE_URL: z.string().trim().url().optional(),
  AUTH_COOKIE_NAME: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/)
    .default("crigestion_session"),
  AUTH_COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  AUTH_COOKIE_SAME_SITE: z.enum(["lax", "strict"]).default("lax"),
  TRUST_PROXY_HEADERS: z.enum(["true", "false"]).default("false")
});
const environmentSchema = baseEnvironmentSchema.extend({
  APP_SESSION_SECRET: z.string().min(1),
  VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET: z.string().min(32).optional()
});

export type PlatformEnvironment = z.infer<typeof environmentSchema>;
export type PlatformBaseEnvironment = z.infer<typeof baseEnvironmentSchema>;

export function readPlatformEnvironment(
  env: NodeJS.ProcessEnv = process.env
): PlatformEnvironment {
  const parsed = environmentSchema.safeParse(normalizeEnvironment(env));

  if (!parsed.success) {
    throw new Error(`Invalid platform environment: ${parsed.error.issues[0]?.path.join(".")}`);
  }

  const config = parsed.data;

  validatePlatformEnvironment(config);

  return config;
}

export function getSessionSecret(): string {
  return readPlatformEnvironment().APP_SESSION_SECRET;
}

export function getVerifactuCredentialIdempotencySecret(): string {
  const config = readPlatformEnvironment();
  if (config.VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET) return config.VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET;
  if (isDeployedAppEnvironment(config.APP_ENV)) {
    throw new Error("Invalid platform environment: VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET is required in deployed environments.");
  }
  return `development-only:${config.APP_SESSION_SECRET}`;
}

export function getSessionCookieName(): string {
  return readPlatformBaseEnvironment().AUTH_COOKIE_NAME;
}

export function isProductionEnvironment(): boolean {
  return isDeployedAppEnvironment(readPlatformBaseEnvironment().APP_ENV);
}

export function isSessionCookieSecure(): boolean {
  const config = readPlatformBaseEnvironment();

  return isDeployedAppEnvironment(config.APP_ENV) || config.AUTH_COOKIE_SECURE === "true";
}

export function getSessionCookieSameSite(): "lax" | "strict" {
  return readPlatformBaseEnvironment().AUTH_COOKIE_SAME_SITE;
}

export function getConfiguredAppBaseUrl(): string | undefined {
  return readPlatformBaseEnvironment().APP_BASE_URL;
}

export function shouldTrustProxyHeaders(): boolean {
  const config = readPlatformBaseEnvironment();

  return config.TRUST_PROXY_HEADERS === "true" || !isDeployedAppEnvironment(config.APP_ENV);
}

function readPlatformBaseEnvironment(
  env: NodeJS.ProcessEnv = process.env
): PlatformBaseEnvironment {
  const parsed = baseEnvironmentSchema.safeParse(normalizeEnvironment(env));

  if (!parsed.success) {
    throw new Error(`Invalid platform environment: ${parsed.error.issues[0]?.path.join(".")}`);
  }

  return parsed.data;
}

function normalizeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    APP_ENV: env.APP_ENV ?? env.NODE_ENV ?? "development",
    VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET: env.VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET?.trim() || undefined
  };
}

function validatePlatformEnvironment(config: PlatformEnvironment): void {
  if (config.APP_SESSION_SECRET === sessionSecretPlaceholder) {
    throw new Error("Invalid platform environment: APP_SESSION_SECRET is a placeholder.");
  }

  if (config.APP_SESSION_SECRET.length < 32) {
    throw new Error("Invalid platform environment: APP_SESSION_SECRET must be at least 32 characters.");
  }

  if (isDeployedAppEnvironment(config.APP_ENV) && !config.VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET) {
    throw new Error("Invalid platform environment: VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET is required in deployed environments.");
  }

  validateProductionRuntimeEnvironment(config);
}

function validateProductionRuntimeEnvironment(config: PlatformBaseEnvironment): void {
  if (config.NODE_ENV === "production" && !isDeployedAppEnvironment(config.APP_ENV)) {
    throw new Error("Invalid platform environment: APP_ENV must be staging or production when NODE_ENV is production.");
  }

  if (!isDeployedAppEnvironment(config.APP_ENV)) {
    return;
  }

  if (!config.APP_BASE_URL) {
    throw new Error("Invalid platform environment: APP_BASE_URL is required in deployed environments.");
  }

  if (!config.APP_BASE_URL.startsWith("https://")) {
    throw new Error("Invalid platform environment: APP_BASE_URL must use HTTPS in deployed environments.");
  }

  if (config.AUTH_COOKIE_SECURE === "false") {
    throw new Error("Invalid platform environment: AUTH_COOKIE_SECURE cannot be false in deployed environments.");
  }
}

function isDeployedAppEnvironment(value: PlatformBaseEnvironment["APP_ENV"]): boolean {
  return value === "staging" || value === "production";
}
