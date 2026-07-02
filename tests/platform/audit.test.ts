import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { listAuditEvents } from "@/modules/platform/application/audit";
import { login, type SessionUser } from "@/modules/platform/application/auth";
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

describe("platform audit listing", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await initializeForAudit();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("lists audit events as DTOs and audits the consultation", async () => {
    const actor = await loginAsAdmin();
    const result = await listAuditEvents({ limit: 10 }, actor);
    const viewedEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "AUDIT_VIEWED" }
    });

    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events[0]).toEqual({
      id: expect.any(String),
      eventType: expect.any(String),
      actorType: expect.any(String),
      payload: expect.anything(),
      createdAt: expect.any(String)
    });
    expect(JSON.stringify(result.events)).not.toContain(adminPassword);
    expect(viewedEvent.payload).toMatchObject({
      actorUserId: actor.id,
      limit: 10,
      resultCount: result.events.length
    });
  });

  it("redacts sensitive payload keys before returning audit events", async () => {
    const actor = await loginAsAdmin();

    await prisma.auditEvent.create({
      data: {
        eventType: "SENSITIVE_TEST",
        actorType: "USER",
        payload: {
          userId: actor.id,
          password: "No-debe-salir-2026",
          nested: {
            tokenHash: "hash-secreto",
            safeValue: "visible"
          }
        }
      }
    });

    const result = await listAuditEvents(
      { limit: 5, eventType: "SENSITIVE_TEST" },
      actor
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0].payload).toEqual({
      userId: actor.id,
      password: "[REDACTED]",
      nested: {
        tokenHash: "[REDACTED]",
        safeValue: "visible"
      }
    });
  });

  it("returns a cursor when more events exist than the requested limit", async () => {
    const actor = await loginAsAdmin();
    await createAuditEvents("PAGED_TEST", 3);

    const firstPage = await listAuditEvents(
      { limit: 2, eventType: "PAGED_TEST" },
      actor
    );
    const secondPage = await listAuditEvents(
      {
        limit: 2,
        eventType: "PAGED_TEST",
        cursor: firstPage.nextCursor ?? undefined
      },
      actor
    );

    expect(firstPage.events).toHaveLength(2);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(secondPage.events).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
  });
});

async function loginAsAdmin(): Promise<SessionUser> {
  const result = await login({
    userName: "admin",
    password: adminPassword
  });

  if (!result.ok) {
    throw new Error(result.error.code);
  }

  return result.value.user;
}

async function createAuditEvents(eventType: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await prisma.auditEvent.create({
      data: {
        eventType,
        actorType: "SYSTEM",
        payload: { index }
      }
    });
  }
}

async function initializeForAudit(): Promise<void> {
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
    prisma.platformMaintenanceState.deleteMany(),
prisma.idempotencyRecord.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.installation.deleteMany(),
    prisma.reservedUserName.deleteMany(),
    prisma.session.deleteMany(),
    prisma.rateLimitBucket.deleteMany(),
    prisma.loginAttempt.deleteMany(),
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
