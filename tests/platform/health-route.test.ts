import { afterEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";
import { prisma } from "@/lib/prisma";
import { classifyWorkerHealth, isVerifactuEnvironmentCoherent, readOperationalEnvironment } from "@/modules/platform/application/operationalEnvironment";

const originalEnv = { ...process.env };

describe("public operational health contract", () => {
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  it("reports only abstract healthy states for the effective declared database", async () => {
    const [database] = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS "name"`;
    const isTestDatabase = database?.name === "crigestion_test";
    process.env.APP_ENV = isTestDatabase ? "test" : "development";
    process.env.APP_SESSION_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.DATABASE_URL = `postgresql://test-declaration:test-declaration@localhost:5432/${isTestDatabase ? "crigestion_test" : "crigestion"}`;
    process.env.VERIFACTU_ENABLED = "false";
    const response = await GET(new Request("http://localhost/api/health"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatchObject({ status: "ok", database: "ok", verifactu: "disabled", worker: "not_required" });
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(body)).not.toContain("DATABASE_URL");
    expect(JSON.stringify(body)).not.toContain("postgresql://");
    expect(Object.keys(body).sort()).toEqual(["database", "status", "timestamp", "verifactu", "worker"]);
  });

  it("returns an abstract 503 when the declared TEST database is inconsistent", async () => {
    process.env.APP_ENV = "test";
    process.env.APP_SESSION_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.DATABASE_URL = "postgresql://hidden:hidden@localhost:5432/crigestion";
    process.env.VERIFACTU_ENABLED = "false";
    const response = await GET(new Request("http://localhost/api/health"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "unavailable", database: "ok", verifactu: "degraded", worker: "not_required"
    });
  });

  it("returns an abstract 503 when staging points at a non-staging database", async () => {
    process.env.APP_ENV = "staging";
    Object.assign(process.env, { NODE_ENV: "production" });
    process.env.APP_BASE_URL = "https://gestion-test.crisoft.es";
    process.env.APP_SESSION_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET = "verifactu-idempotency-secret-32-bytes";
    process.env.DATABASE_URL = "postgresql://hidden:hidden@localhost:5432/crigestion_test";
    process.env.VERIFACTU_ENABLED = "false";
    process.env.VERIFACTU_ENVIRONMENT = "TEST";
    process.env.VERIFACTU_WORKER_ENVIRONMENT = "TEST";
    process.env.VERIFACTU_ALLOW_PRODUCTION = "false";
    process.env.VERIFACTU_WORKER_ALLOW_PRODUCTION = "false";
    const response = await GET(new Request("https://gestion-test.crisoft.es/api/health"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "unavailable", database: "unavailable", verifactu: "degraded", worker: "not_required"
    });
  });

  it("classifies worker freshness without exposing operational details", () => {
    const staleBefore = new Date("2026-07-13T10:00:00.000Z");
    const fresh = { status: "RUNNING", heartbeatAt: new Date("2026-07-13T10:01:00.000Z"),
      lastPollAt: new Date("2026-07-13T10:01:00.000Z") };
    expect(classifyWorkerHealth(fresh, staleBefore)).toBe("ok");
    expect(classifyWorkerHealth({ ...fresh, status: "FAILED" }, staleBefore)).toBe("degraded");
    expect(classifyWorkerHealth({ ...fresh, heartbeatAt: new Date("2026-07-13T09:59:59.000Z") }, staleBefore)).toBe("degraded");
    expect(classifyWorkerHealth({ ...fresh, lastPollAt: null }, staleBefore)).toBe("degraded");
    expect(classifyWorkerHealth(null, staleBefore)).toBe("degraded");
  });

  it("requires canonical and matching VeriFactu environments", () => {
    const base = { NODE_ENV: "test", APP_ENV: "test", DATABASE_URL: process.env.DATABASE_URL,
      VERIFACTU_ENABLED: "true", VERIFACTU_ENVIRONMENT: "TEST", VERIFACTU_WORKER_ENVIRONMENT: "TEST",
      VERIFACTU_WORKER_ALLOW_PRODUCTION: "false", VERIFACTU_ALLOW_PRODUCTION: "false" } satisfies NodeJS.ProcessEnv;
    expect(isVerifactuEnvironmentCoherent(readOperationalEnvironment(base))).toBe(true);
    expect(isVerifactuEnvironmentCoherent(readOperationalEnvironment({ ...base, VERIFACTU_WORKER_ENVIRONMENT: "PRODUCTION" }))).toBe(false);
    expect(isVerifactuEnvironmentCoherent(readOperationalEnvironment({ ...base, VERIFACTU_WORKER_ALLOW_PRODUCTION: "true" }))).toBe(false);
  });
});
