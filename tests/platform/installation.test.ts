import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";

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

describe("platform installation", () => {
  beforeEach(async () => {
    await resetPlatformTables();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("initializes the platform transactionally and audits without secrets", async () => {
    const rawBody = JSON.stringify(baseCommand);
    const result = await initializePlatform(
      baseCommand,
      randomUUID(),
      hashRequestBody(rawBody)
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(201);

    if (!result.ok) {
      return;
    }

    expect(result.value).toEqual({
      id: expect.any(String),
      singletonKey: 1,
      status: "INITIALIZED",
      productVersion: "0.1.0"
    });

    const installationCount = await prisma.installation.count();
    const user = await prisma.user.findUniqueOrThrow({
      where: { normalizedUserName: "admin" }
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "PLATFORM_INITIALIZED" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(installationCount).toBe(1);
    expect(user.passwordHash).not.toBe(baseCommand.administrator.password);
    expect(user.passwordHash).toMatch(/^pbkdf2_sha256\$/);
    expect(auditPayload).not.toContain(baseCommand.administrator.password);
    expect(auditPayload).not.toContain(user.passwordHash);
  });

  it("replays the same idempotency key with the same request body", async () => {
    const rawBody = JSON.stringify(baseCommand);
    const idempotencyKey = randomUUID();

    const first = await initializePlatform(
      baseCommand,
      idempotencyKey,
      hashRequestBody(rawBody)
    );
    const second = await initializePlatform(
      baseCommand,
      idempotencyKey,
      hashRequestBody(rawBody)
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);

    if (first.ok && second.ok) {
      expect(second.value).toEqual(first.value);
    }
  });

  it("rejects reusing the same idempotency key with a different request body", async () => {
    const idempotencyKey = randomUUID();
    const firstBody = JSON.stringify(baseCommand);
    const secondCommand: InitializeCommand = {
      ...baseCommand,
      company: {
        ...baseCommand.company,
        taxId: "B87654321"
      }
    };
    const secondBody = JSON.stringify(secondCommand);

    await initializePlatform(baseCommand, idempotencyKey, hashRequestBody(firstBody));
    const second = await initializePlatform(
      secondCommand,
      idempotencyKey,
      hashRequestBody(secondBody)
    );

    expect(second).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "La clave de idempotencia ya se uso con otra peticion."
      }
    });
  });

  it("rejects a second initialization with a different idempotency key", async () => {
    const rawBody = JSON.stringify(baseCommand);

    await initializePlatform(baseCommand, randomUUID(), hashRequestBody(rawBody));
    const second = await initializePlatform(
      {
        ...baseCommand,
        company: {
          ...baseCommand.company,
          taxId: "B87654321"
        },
        administrator: {
          ...baseCommand.administrator,
          userName: "admin2"
        }
      },
      randomUUID(),
      hashRequestBody(rawBody)
    );

    expect(second).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "PLATFORM_ALREADY_INITIALIZED",
        message: "La plataforma ya esta inicializada."
      }
    });
  });
});

async function resetPlatformTables(): Promise<void> {
  await prisma.$transaction([
    prisma.platformMaintenanceState.deleteMany(),
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
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
