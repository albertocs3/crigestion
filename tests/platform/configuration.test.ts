import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { login } from "@/modules/platform/application/auth";
import {
  getPlatformConfiguration,
  updateCompanyConfiguration
} from "@/modules/platform/application/configuration";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";

const adminPassword = "Cambiar-esta-clave-2026";
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

describe("platform configuration", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await initializeForConfiguration();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("reads platform configuration as DTOs", async () => {
    const configuration = await getPlatformConfiguration();

    expect(configuration).toMatchObject({
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
    expect(JSON.stringify(configuration)).not.toContain("passwordHash");
  });

  it("updates company configuration and audits only changed field names", async () => {
    const actor = await loginAsAdmin();
    const result = await updateCompanyConfiguration(
      {
        legalName: "CriGestion Actualizada SL",
        taxId: "B87654321",
        email: "contabilidad@example.test"
      },
      actor
    );
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "COMPANY_CONFIGURATION_UPDATED" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      value: {
        legalName: "CriGestion Actualizada SL",
        taxId: "B87654321",
        email: "contabilidad@example.test"
      }
    });
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      changedFields: ["legalName", "taxId", "email"]
    });
    expect(auditPayload).not.toContain("CriGestion Actualizada SL");
    expect(auditPayload).not.toContain("B87654321");
    expect(auditPayload).not.toContain("contabilidad@example.test");
  });
});

async function loginAsAdmin() {
  const result = await login({
    userName: "admin",
    password: adminPassword
  });

  if (!result.ok) {
    throw new Error(result.error.code);
  }

  return result.value.user;
}

async function initializeForConfiguration(): Promise<void> {
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
