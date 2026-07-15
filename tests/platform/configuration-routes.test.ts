import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { PATCH as billingPatch } from "@/app/api/platform/configuration/billing/route";
import { PATCH as companyPatch } from "@/app/api/platform/configuration/company/route";
import { GET as configurationGet } from "@/app/api/platform/configuration/route";
import { POST as credentialStagePost } from "@/app/api/platform/verifactu/credentials/route";
import { POST as verifactuInterventionPost } from "@/app/api/platform/verifactu/outbox-messages/[messageId]/intervene/route";
import { POST as sifInstallationPost } from "@/app/api/platform/verifactu/sif-installations/route";
import { prisma } from "@/lib/prisma";
import { sessionCookieName } from "@/modules/platform/application/auth";
import { hashPassword } from "@/modules/platform/application/passwords";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";

type CookieSetOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  path?: string;
  expires?: Date;
};

const cookieMock = vi.hoisted(() => {
  const values = new Map<string, string>();

  return {
    values,
    store: {
      get(name: string) {
        const value = values.get(name);
        return value ? { name, value } : undefined;
      },
      set(name: string, value: string, options: CookieSetOptions) {
        void options;
        values.set(name, value);
      },
      delete(name: string) {
        values.delete(name);
      }
    },
    reset() {
      values.clear();
    }
  };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieMock.store)
}));

const adminPassword = "Cambiar-esta-clave-2026";
const limitedPassword = "Cambiar-gestion-2026";
const baseCommand: InitializeCommand = {
  company: {
    legalName: "CriGestion Test SL",
    taxId: "B12345678",
    email: "admin@example.test"
  },
  administrator: {
    displayName: "Administrador",
    userName: "admin",
    password: adminPassword
  }
};

describe("configuration HTTP contracts", () => {
  beforeEach(async () => {
    process.env.APP_BASE_URL = "http://localhost:3000";
    process.env.AUTH_COOKIE_SECURE = "false";
    process.env.VERIFACTU_CREDENTIAL_ACTIVE_KEY_ID = "route-test-key";
    process.env.VERIFACTU_CREDENTIAL_KEYS = JSON.stringify({ "route-test-key": Buffer.alloc(32, 7).toString("base64") });
    process.env.VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET = "route-test-idempotency-secret-32-bytes";
    cookieMock.reset();
    await resetPlatformTables();
    await initializeForRoutes();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("rejects unauthenticated configuration reads", async () => {
    const response = await configurationGet(apiRequest("/api/platform/configuration"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      code: "UNAUTHENTICATED",
      message: "No hay una sesion activa."
    });
  });

  it("rejects users without Platform.ManageConfiguration", async () => {
    await createLimitedUserWithoutConfigurationPermission();
    await loginWith("gestion", limitedPassword);

    const response = await configurationGet(apiRequest("/api/platform/configuration"));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "FORBIDDEN",
      message: "No tienes permiso para realizar esta accion."
    });
  });

  it("returns configuration DTOs for authorized administrators", async () => {
    await loginWith("admin", adminPassword);

    const response = await configurationGet(apiRequest("/api/platform/configuration"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      company: {
        legalName: "CriGestion Test SL",
        taxId: "B12345678",
        email: "admin@example.test"
      },
      installation: {
        status: "INITIALIZED",
        productVersion: "0.1.0"
      }
    });
    expect(JSON.stringify(body)).not.toContain("passwordHash");
  });

  it("requires CSRF before updating company configuration", async () => {
    await loginWith("admin", adminPassword);

    const response = await companyPatch(
      jsonRequest("/api/platform/configuration/company", updatePayload())
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "CSRF_TOKEN_INVALID",
      message: "Token CSRF invalido."
    });
  });

  it("protects VeriFactu credential staging with session, CSRF and its dedicated permission", async () => {
    const unauthenticated = await credentialStagePost(jsonRequest("/api/platform/verifactu/credentials", {}, { method: "POST" }));
    expect(unauthenticated.status).toBe(401);

    await loginWith("admin", adminPassword);
    const missingCsrf = await credentialStagePost(jsonRequest("/api/platform/verifactu/credentials", {}, { method: "POST" }));
    expect(missingCsrf.status).toBe(403);

    cookieMock.reset();
    await createLimitedUserWithoutConfigurationPermission();
    await loginWith("gestion", limitedPassword);
    const limitedCsrf = await getCsrfToken();
    const forbidden = await credentialStagePost(jsonRequest("/api/platform/verifactu/credentials", {}, { method: "POST", csrfToken: limitedCsrf }));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("protects VeriFactu operational interventions with session, CSRF and its dedicated permission", async () => {
    const context = { params: Promise.resolve({ messageId: randomUUID() }) };
    const unauthenticated = await verifactuInterventionPost(jsonRequest("/api/platform/verifactu/outbox-messages/x/intervene", {}, { method: "POST" }), context);
    expect(unauthenticated.status).toBe(401);
    await loginWith("admin", adminPassword);
    const missingCsrf = await verifactuInterventionPost(jsonRequest("/api/platform/verifactu/outbox-messages/x/intervene", {}, { method: "POST" }), context);
    expect(missingCsrf.status).toBe(403);
    cookieMock.reset();
    await createLimitedUserWithoutConfigurationPermission();
    await loginWith("gestion", limitedPassword);
    const limitedCsrf = await getCsrfToken();
    const forbidden = await verifactuInterventionPost(jsonRequest("/api/platform/verifactu/outbox-messages/x/intervene", { expectedUpdatedAt: new Date().toISOString(), reason: "MANUAL_REVIEW" }, { method: "POST", csrfToken: limitedCsrf }), context);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("protects SIF installation creation with session, CSRF and its dedicated permission", async () => {
    const unauthenticated = await sifInstallationPost(jsonRequest("/api/platform/verifactu/sif-installations", sifInstallationPayload(), { method: "POST" }));
    expect(unauthenticated.status).toBe(401);
    await loginWith("admin", adminPassword);
    const missingCsrf = await sifInstallationPost(jsonRequest("/api/platform/verifactu/sif-installations", sifInstallationPayload(), { method: "POST" }));
    expect(missingCsrf.status).toBe(403);
    cookieMock.reset();
    await createLimitedUserWithoutConfigurationPermission();
    await loginWith("gestion", limitedPassword);
    const limitedCsrf = await getCsrfToken();
    const forbidden = await sifInstallationPost(jsonRequest("/api/platform/verifactu/sif-installations", sifInstallationPayload(), { method: "POST", csrfToken: limitedCsrf }));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("creates and idempotently replays a fixed TEST SIF installation", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();
    const idempotencyKey = randomUUID();
    const first = await sifInstallationPost(jsonRequest("/api/platform/verifactu/sif-installations", sifInstallationPayload(), { method: "POST", csrfToken, idempotencyKey }));
    const replay = await sifInstallationPost(jsonRequest("/api/platform/verifactu/sif-installations", sifInstallationPayload(), { method: "POST", csrfToken, idempotencyKey }));
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
    expect(await prisma.verifactuSifInstallation.findFirstOrThrow()).toMatchObject({ environment: "TEST", status: "ACTIVE", contractVersion: "VF_V1", schemaVersion: "tikeV1.0", systemId: "CG" });
  });

  it("validates and rate-limits SIF installation creation", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();
    const missingIdempotency = await sifInstallationPost(jsonRequest("/api/platform/verifactu/sif-installations", sifInstallationPayload(), { method: "POST", csrfToken, idempotencyKey: null }));
    expect(missingIdempotency.status).toBe(400);
    const invalid = await sifInstallationPost(jsonRequest("/api/platform/verifactu/sif-installations", { ...sifInstallationPayload(), systemId: "LONG" }, { method: "POST", csrfToken }));
    expect(invalid.status).toBe(422);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await sifInstallationPost(jsonRequest("/api/platform/verifactu/sif-installations", sifInstallationPayload(), { method: "POST", csrfToken }));
    }
    const limited = await sifInstallationPost(jsonRequest("/api/platform/verifactu/sif-installations", sifInstallationPayload(), { method: "POST", csrfToken }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(await prisma.auditEvent.count({ where: { eventType: "VERIFACTU_SIF_INSTALLATION_RATE_LIMITED" } })).toBe(1);
  });

  it("requires idempotency before parsing a credential staging payload", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();
    const response = await credentialStagePost(jsonRequest("/api/platform/verifactu/credentials", {}, { method: "POST", csrfToken, idempotencyKey: null }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
  });

  it("stages a binary multipart credential and replays it across multipart boundaries", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();
    const installation = await prisma.installation.findUniqueOrThrow({ where: { singletonKey: 1 }, select: { companyId: true } });
    if (!installation.companyId) throw new Error("COMPANY_NOT_AVAILABLE");
    const sif = await prisma.verifactuSifInstallation.create({ data: {
      companyId: installation.companyId, installationCode: "ROUTE-MULTIPART", environment: "TEST",
      contractVersion: "VF_V1", schemaVersion: "tikeV1.0", artifactManifestVersion: "AEAT_VERIFACTU_ARTIFACTS_V1",
      artifactManifestSha256: "a".repeat(64), producerTaxId: "B12345678", producerName: "CriGestion Test SL",
      systemName: "CriGestion", systemId: "CG", systemVersion: "0.1.0", installationNumber: "ROUTE-MULTIPART", activatedAt: new Date()
    } });
    const pfx = readFileSync(resolve("tests/fixtures/verifactu/mtls/client.p12"));
    const idempotencyKey = randomUUID();

    const first = await credentialStagePost(multipartCredentialRequest(sif.id, pfx, csrfToken, idempotencyKey, false));
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ version: 1, status: "STAGED" });

    const replay = await credentialStagePost(multipartCredentialRequest(sif.id, pfx, csrfToken, idempotencyKey, true));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ version: 1, status: "STAGED" });
    const reused = await credentialStagePost(multipartCredentialRequest(sif.id, pfx, csrfToken, idempotencyKey, false, "different-passphrase"));
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(await prisma.verifactuMtlsCredentialVersion.count()).toBe(1);
    const persisted = await prisma.verifactuMtlsCredentialVersion.findFirstOrThrow({ select: { materialCiphertext: true } });
    const serialized = JSON.stringify(await prisma.auditEvent.findMany({ where: { eventType: { startsWith: "VERIFACTU_MTLS_" } }, select: { payload: true } }));
    expect(Buffer.from(persisted.materialCiphertext).includes(pfx)).toBe(false);
    expect(serialized).not.toContain("fixture-only");
    expect(serialized).not.toContain(pfx.toString("base64"));
  });

  it("rejects production-capable credentials server-side in staging", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();
    const installation = await prisma.installation.findUniqueOrThrow({ where: { singletonKey: 1 }, select: { companyId: true } });
    if (!installation.companyId) throw new Error("COMPANY_NOT_AVAILABLE");
    const sif = await prisma.verifactuSifInstallation.create({ data: {
      companyId: installation.companyId, installationCode: "ROUTE-STAGING", environment: "TEST",
      contractVersion: "VF_V1", schemaVersion: "tikeV1.0", artifactManifestVersion: "AEAT_VERIFACTU_ARTIFACTS_V1",
      artifactManifestSha256: "a".repeat(64), producerTaxId: "B12345678", producerName: "CriGestion Test SL",
      systemName: "CriGestion", systemId: "CG", systemVersion: "0.1.0", installationNumber: "ROUTE-STAGING", activatedAt: new Date()
    } });
    const previousAppEnv = process.env.APP_ENV;
    const previousAppBaseUrl = process.env.APP_BASE_URL;
    const previousCookieSecure = process.env.AUTH_COOKIE_SECURE;
    process.env.APP_ENV = "staging";
    process.env.APP_BASE_URL = "https://gestion-test.crisoft.es";
    process.env.AUTH_COOKIE_SECURE = "true";
    try {
      const response = await credentialStagePost(multipartCredentialRequest(
        sif.id,
        readFileSync(resolve("tests/fixtures/verifactu/mtls/client.p12")),
        csrfToken,
        randomUUID(),
        false,
        "fixture-only",
        true,
        "https://gestion-test.crisoft.es/api/platform/verifactu/credentials"
      ));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "VERIFACTU_PRODUCTION_FORBIDDEN_IN_STAGING" });
      expect(await prisma.verifactuMtlsCredentialVersion.count()).toBe(0);
      expect(await prisma.auditEvent.count({ where: { eventType: "VERIFACTU_PRODUCTION_CONFIGURATION_DENIED" } })).toBe(1);
    } finally {
      process.env.APP_ENV = previousAppEnv;
      process.env.APP_BASE_URL = previousAppBaseUrl;
      process.env.AUTH_COOKIE_SECURE = previousCookieSecure;
    }
  });

  it("returns a stable audited error when the encrypted credential store is not configured", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();
    const installation = await prisma.installation.findUniqueOrThrow({ where: { singletonKey: 1 }, select: { companyId: true } });
    if (!installation.companyId) throw new Error("COMPANY_NOT_AVAILABLE");
    const sif = await prisma.verifactuSifInstallation.create({ data: {
      companyId: installation.companyId, installationCode: "ROUTE-NO-KEYRING", environment: "TEST",
      contractVersion: "VF_V1", schemaVersion: "tikeV1.0", artifactManifestVersion: "AEAT_VERIFACTU_ARTIFACTS_V1",
      artifactManifestSha256: "a".repeat(64), producerTaxId: "B12345678", producerName: "CriGestion Test SL",
      systemName: "CriGestion", systemId: "CG", systemVersion: "0.1.0", installationNumber: "ROUTE-NO-KEYRING", activatedAt: new Date()
    } });
    const previousActiveKeyId = process.env.VERIFACTU_CREDENTIAL_ACTIVE_KEY_ID;
    const previousKeys = process.env.VERIFACTU_CREDENTIAL_KEYS;
    delete process.env.VERIFACTU_CREDENTIAL_ACTIVE_KEY_ID;
    delete process.env.VERIFACTU_CREDENTIAL_KEYS;
    try {
      const response = await credentialStagePost(multipartCredentialRequest(sif.id, readFileSync(resolve("tests/fixtures/verifactu/mtls/client.p12")), csrfToken, randomUUID(), false));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "VERIFACTU_CREDENTIAL_STORE_NOT_CONFIGURED" });
      expect(await prisma.auditEvent.count({ where: { eventType: "VERIFACTU_MTLS_CONFIGURATION_INVALID" } })).toBe(1);
    } finally {
      process.env.VERIFACTU_CREDENTIAL_ACTIVE_KEY_ID = previousActiveKeyId;
      process.env.VERIFACTU_CREDENTIAL_KEYS = previousKeys;
    }
  });

  it("rejects JSON and malformed multipart credential staging bodies", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();
    const json = await credentialStagePost(jsonRequest("/api/platform/verifactu/credentials", {}, { method: "POST", csrfToken }));
    expect(json.status).toBe(415);
    const malformed = await credentialStagePost(new Request("http://localhost/api/platform/verifactu/credentials", {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=broken", "Idempotency-Key": randomUUID(), "X-CSRF-Token": csrfToken },
      body: "--broken\r\ninvalid"
    }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "INVALID_MULTIPART" });
    const oversized = await credentialStagePost(new Request("http://localhost/api/platform/verifactu/credentials", {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=oversized", "Idempotency-Key": randomUUID(), "X-CSRF-Token": csrfToken },
      body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(550_001)); controller.close(); } }),
      duplex: "half"
    } as RequestInit & { duplex: "half" }));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("requires an idempotency key before updating company configuration", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();

    const response = await companyPatch(
      jsonRequest("/api/platform/configuration/company", updatePayload(), {
        csrfToken,
        idempotencyKey: null
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
  });

  it("updates company configuration and does not audit submitted values", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();

    const response = await companyPatch(
      jsonRequest("/api/platform/configuration/company", updatePayload(), { csrfToken })
    );
    const body = await response.json();
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "COMPANY_CONFIGURATION_UPDATED" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ...updatePayload(),
      bankIban: "ES7921000813610123456789",
      sepaCreditorIdentifier: "ES12B12345678"
    });
    expect(auditEvent.payload).toMatchObject({
      changedFields: [
        "legalName",
        "taxId",
        "email",
        "bankIban",
        "sepaCreditorIdentifier"
      ]
    });
    expect(auditPayload).not.toContain(updatePayload().legalName);
    expect(auditPayload).not.toContain(updatePayload().taxId);
    expect(auditPayload).not.toContain(updatePayload().email);
    expect(auditPayload).not.toContain("ES7921000813610123456789");
    expect(auditPayload).not.toContain("ES12B12345678");
  });

  it("rejects company tax id changes after issued invoices exist", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();
    await createIssuedInvoice();

    const response = await companyPatch(
      jsonRequest("/api/platform/configuration/company", updatePayload(), { csrfToken })
    );
    const body = await response.json();
    const company = await prisma.company.findUniqueOrThrow({
      where: { taxId: baseCommand.company.taxId }
    });

    expect(response.status).toBe(409);
    expect(body).toEqual({
      code: "COMPANY_TAX_ID_LOCKED_BY_ISSUED_INVOICES",
      message: "El NIF de la empresa no puede cambiarse cuando existen facturas emitidas."
    });
    expect(company.taxId).toBe(baseCommand.company.taxId);
  });

  it("validates malformed update payloads", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();

    const response = await companyPatch(
      jsonRequest(
        "/api/platform/configuration/company",
        { ...updatePayload(), email: "not-email" },
        { csrfToken }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("requires an idempotency key before updating billing configuration", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();

    const response = await billingPatch(
      jsonRequest("/api/platform/configuration/billing", billingPayload(), {
        csrfToken,
        idempotencyKey: null
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
  });

  it("updates billing configuration and audits only changed field names", async () => {
    await loginWith("admin", adminPassword);
    const csrfToken = await getCsrfToken();

    const response = await billingPatch(
      jsonRequest("/api/platform/configuration/billing", billingPayload(), { csrfToken })
    );
    const body = await response.json();
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "BILLING_CONFIGURATION_UPDATED" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(response.status).toBe(200);
    expect(body).toMatchObject(billingPayload());
    expect(auditEvent.payload).toMatchObject({
      changedFields: ["invoiceLegalFooter", "invoiceAccentColor"]
    });
    expect(auditPayload).not.toContain(billingPayload().invoiceLegalFooter);
    expect(auditPayload).not.toContain(billingPayload().invoiceAccentColor);
  });
});

function updatePayload() {
  return {
    legalName: "CriGestion Actualizada SL",
    taxId: "B87654321",
    email: "contabilidad@example.test",
    bankIban: "ES79 2100 0813 6101 2345 6789",
    sepaCreditorIdentifier: "es12b12345678"
  };
}

function billingPayload() {
  return {
    invoiceLegalFooter: "Texto legal visible solo en factura.",
    invoiceAccentColor: "#123abc"
  };
}

function sifInstallationPayload() {
  return { installationCode: "TEST-ROUTE", producerTaxId: "B12345678", producerName: "Productor Test SL", systemName: "CriGestion", systemId: "CG", systemVersion: "0.1.0", installationNumber: "TEST-ROUTE" };
}

async function createLimitedUserWithoutConfigurationPermission(): Promise<void> {
  const role = await prisma.role.create({
    data: {
      code: "ConsultaAuditoria",
      name: "Consulta auditoria",
      isProtected: false,
      permissions: {
        create: {
          permission: {
            connect: {
              code: "Platform.ViewAudit"
            }
          }
        }
      }
    }
  });

  await prisma.user.create({
    data: {
      displayName: "Usuario Gestion",
      userName: "gestion",
      normalizedUserName: "gestion",
      passwordHash: hashPassword(limitedPassword),
      status: "ACTIVE",
      roleId: role.id
    }
  });
}

async function loginWith(userName: string, password: string): Promise<void> {
  const response = await loginPost(
    jsonRequest("/api/auth/login", { userName, password }, { method: "POST" })
  );

  expect(response.status).toBe(200);
  expect(cookieMock.values.has(sessionCookieName)).toBe(true);
}

async function getCsrfToken(): Promise<string> {
  const response = await csrfGet(apiRequest("/api/auth/csrf"));
  const body = (await response.json()) as { csrfToken?: string };

  expect(response.status).toBe(200);

  if (!body.csrfToken) {
    throw new Error("CSRF endpoint did not return a token.");
  }

  return body.csrfToken;
}

function jsonRequest(
  path: string,
  payload: unknown,
  options: {
    csrfToken?: string;
    idempotencyKey?: string | null;
    method?: "POST" | "PATCH";
  } = {}
): Request {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Forwarded-For": uniqueTestIp()
  });

  if (options.csrfToken) {
    headers.set("X-CSRF-Token", options.csrfToken);
  }

  if (options.idempotencyKey !== null) {
    headers.set("Idempotency-Key", options.idempotencyKey ?? randomUUID());
  }

  return new Request(`http://localhost${path}`, {
    method: options.method ?? "PATCH",
    headers,
    body: JSON.stringify(payload)
  });
}

function apiRequest(path: string): Request {
  return new Request(`http://localhost${path}`);
}

function multipartCredentialRequest(sifInstallationId: string, pfx: Buffer, csrfToken: string, idempotencyKey: string, reverseOrder: boolean, passphrase = "fixture-only", allowProduction = false, requestUrl = "http://localhost/api/platform/verifactu/credentials"): Request {
  const form = new FormData();
  const fields: Array<[string, string | File]> = [
    ["sifInstallationId", sifInstallationId],
    ["alias", "Certificado multipart TEST"],
    ["passphrase", passphrase],
    ["endpointKind", "STANDARD"],
    ["allowProduction", String(allowProduction)],
    ["certificate", new File([Uint8Array.from(pfx)], "client.p12", { type: "application/x-pkcs12" })]
  ];
  for (const [name, value] of reverseOrder ? fields.reverse() : fields) form.append(name, value);
  return new Request(requestUrl, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey, "X-CSRF-Token": csrfToken },
    body: form
  });
}

function uniqueTestIp(): string {
  return `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
}

async function initializeForRoutes(): Promise<void> {
  const rawBody = JSON.stringify(baseCommand);
  const result = await initializePlatform(
    baseCommand,
    randomUUID(),
    hashRequestBody(rawBody)
  );

  if (!result.ok) {
    throw new Error(result.error.code);
  }
}

async function createIssuedInvoice(): Promise<void> {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { normalizedUserName: "admin" },
    select: { id: true }
  });
  const customer = await prisma.customer.create({
    data: {
      code: "C-FISCAL",
      type: "COMPANY",
      legalName: "Cliente Fiscal SL",
      taxId: "B12345674",
      normalizedTaxId: "B12345674",
      fiscalTreatment: "DOMESTIC",
      fiscalAddressLine: "Calle Fiscal 1",
      fiscalPostalCode: "28001",
      fiscalCity: "Madrid",
      fiscalProvince: "Madrid",
      fiscalCountry: "ES",
      createdById: admin.id
    }
  });

  await prisma.invoice.create({
    data: {
      status: "ISSUED",
      verifactuStatus: "PENDING",
      series: "F",
      year: 2026,
      numberSequence: 1,
      number: "F2600001",
      customerId: customer.id,
      customerCodeSnapshot: customer.code,
      customerLegalNameSnapshot: customer.legalName,
      customerTaxIdSnapshot: customer.taxId,
      customerFiscalTreatmentSnapshot: customer.fiscalTreatment,
      customerFiscalAddressSnapshot: {
        line1: customer.fiscalAddressLine,
        postalCode: customer.fiscalPostalCode,
        city: customer.fiscalCity,
        province: customer.fiscalProvince,
        country: customer.fiscalCountry
      },
      issueDate: new Date("2026-07-07T00:00:00.000Z"),
      operationDate: new Date("2026-07-07T00:00:00.000Z"),
      issuedAt: new Date("2026-07-07T10:00:00.000Z"),
      total: "0.00",
      createdById: admin.id,
      issuedById: admin.id
    }
  });
}

async function resetPlatformTables(): Promise<void> {
  await prisma.$executeRaw`TRUNCATE TABLE "verifactu_submission_attempts", "verifactu_outbox_messages", "verifactu_fiscal_records", "verifactu_sif_installations", "verifactu_mtls_credential_versions", "verifactu_mtls_credentials" CASCADE`;
  await prisma.$transaction([
    prisma.invoiceVerifactuRecord.deleteMany(),
    prisma.customerRemittanceLine.deleteMany(),

    prisma.customerPaymentReturn.deleteMany(),
    prisma.customerPayment.deleteMany(),
    prisma.invoiceDueDate.deleteMany(),
    prisma.invoiceTaxSummary.deleteMany(),
    prisma.invoiceLine.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.invoiceNumberSequence.deleteMany(),
    prisma.platformMaintenanceState.deleteMany(),
    prisma.billingConfiguration.deleteMany(),
    prisma.idempotencyRecord.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.installation.deleteMany(),
    prisma.reservedUserName.deleteMany(),
    prisma.session.deleteMany(),
    prisma.rateLimitBucket.deleteMany(),
    prisma.loginAttempt.deleteMany(),
    prisma.restoreOperation.deleteMany(),
    prisma.backupOperation.deleteMany(),
    prisma.customerAddress.deleteMany(),

    prisma.customerStore.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.catalogItem.deleteMany(),

    prisma.accountingJournalLine.deleteMany(),
    prisma.accountingJournalEntry.deleteMany(),
    prisma.accountingAccount.deleteMany(),
    prisma.customerRemittance.deleteMany(),

    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
