import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as getInstallation } from "@/app/api/platform/installation/route";
import { POST as initializeInstallation } from "@/app/api/platform/installation/initialize/route";
import { prisma } from "@/lib/prisma";
import type { InitializeCommand } from "@/modules/platform/application/installation";

const appBaseUrl = "http://localhost:3000";
let testIpCounter = 1;
const baseCommand: InitializeCommand = {
  company: {
    legalName: "CriGestion Test SL",
    taxId: "B12345678",
    email: "admin@example.test"
  },
  administrator: {
    displayName: "Administrador",
    userName: "admin",
    password: "Cambiar-esta-clave-2026"
  }
};

describe("platform installation HTTP contracts", () => {
  beforeEach(async () => {
    process.env.APP_BASE_URL = appBaseUrl;
    await resetPlatformTables();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("reports an uninitialized platform as a stable DTO", async () => {
    const response = await getInstallation();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      initialized: false,
      installation: null
    });
  });

  it("rejects unsupported media types before reading the body", async () => {
    const response = await initializeInstallation(
      new Request("http://localhost/api/platform/installation/initialize", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Idempotency-Key": randomUUID(),
          "X-Forwarded-For": uniqueTestIp()
        },
        body: "not-json"
      })
    );
    const body = await response.json();

    expect(response.status).toBe(415);
    expect(body).toEqual({
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "La peticion debe enviarse como JSON."
    });
  });

  it("requires an idempotency key", async () => {
    const response = await initializeInstallation(
      jsonRequest(baseCommand, {
        idempotencyKey: null
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      code: "IDEMPOTENCY_KEY_REQUIRED",
      message: "La cabecera Idempotency-Key es obligatoria."
    });
  });

  it("rejects malformed JSON with a stable error", async () => {
    const response = await initializeInstallation(
      new Request("http://localhost/api/platform/installation/initialize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
          "X-Forwarded-For": uniqueTestIp()
        },
        body: "{"
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      code: "INVALID_JSON",
      message: "El cuerpo de la peticion no es JSON valido."
    });
  });

  it("rejects validation errors without echoing submitted passwords", async () => {
    const response = await initializeInstallation(
      jsonRequest({
        ...baseCommand,
        administrator: {
          ...baseCommand.administrator,
          password: "short"
        }
      })
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(body)).not.toContain("short");
  });

  it("initializes once and replays the same idempotency key", async () => {
    const idempotencyKey = randomUUID();
    const firstResponse = await initializeInstallation(
      jsonRequest(baseCommand, { idempotencyKey })
    );
    const firstBody = await firstResponse.json();
    const replayResponse = await initializeInstallation(
      jsonRequest(baseCommand, { idempotencyKey })
    );
    const replayBody = await replayResponse.json();

    expect(firstResponse.status).toBe(201);
    expect(firstBody).toEqual({
      id: expect.any(String),
      singletonKey: 1,
      status: "INITIALIZED",
      productVersion: "0.1.0"
    });
    expect(JSON.stringify(firstBody)).not.toContain(baseCommand.administrator.password);
    expect(replayResponse.status).toBe(200);
    expect(replayBody).toEqual(firstBody);
  });

  it("rejects a disallowed origin", async () => {
    const response = await initializeInstallation(
      jsonRequest(baseCommand, {
        origin: "http://evil.example"
      })
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: "ORIGIN_NOT_ALLOWED",
      message: "Origen no permitido."
    });
  });

  it("rate limits repeated initialization attempts by client IP", async () => {
    const ipAddress = uniqueTestIp();
    let response: Response | null = null;

    for (let attempt = 0; attempt < 11; attempt += 1) {
      response = await initializeInstallation(
        new Request("http://localhost/api/platform/installation/initialize", {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            "Idempotency-Key": randomUUID(),
            "X-Forwarded-For": ipAddress
          },
          body: "not-json"
        })
      );
    }

    expect(response?.status).toBe(429);
    expect(await response?.json()).toEqual({
      code: "RATE_LIMITED",
      message: "Demasiados intentos de inicializacion. Espera antes de reintentar."
    });
  });
});

function jsonRequest(
  payload: unknown,
  options: {
    idempotencyKey?: string | null;
    origin?: string;
  } = {}
): Request {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Forwarded-For": uniqueTestIp()
  });

  if (options.idempotencyKey !== null) {
    headers.set("Idempotency-Key", options.idempotencyKey ?? randomUUID());
  }

  if (options.origin) {
    headers.set("Origin", options.origin);
  }

  return new Request("http://localhost/api/platform/installation/initialize", {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
}

function uniqueTestIp(): string {
  testIpCounter += 1;
  return `203.0.113.${testIpCounter}`;
}

async function resetPlatformTables(): Promise<void> {
  await prisma.$transaction([
    prisma.idempotencyRecord.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.installation.deleteMany(),
    prisma.reservedUserName.deleteMany(),
    prisma.session.deleteMany(),
    prisma.loginAttempt.deleteMany(),
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
