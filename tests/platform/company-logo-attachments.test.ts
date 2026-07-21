import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { login } from "@/modules/platform/application/auth";
import {
  companyLogoRequestHash,
  downloadCompanyLogo,
  uploadCompanyLogo,
  type CompanyLogoAttachmentDependencies,
  type CompanyLogoStorage
} from "@/modules/platform/application/companyLogoAttachments";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";
import type { AttachmentScanResult } from "@/modules/platform/infrastructure/attachmentScanner";
import { AttachmentIntegrityError } from "@/modules/platform/infrastructure/attachmentStorage";

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

describe("company logo attachments", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await initializeForLogo();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("publishes, persists, audits and replays the same idempotent upload", async () => {
    const actor = await loginAsAdmin();
    const storage = new MemoryStorage();
    const dependencies = cleanDependencies(storage);
    const input = logoInput(null, "idempotency-logo-1");

    const first = await uploadCompanyLogo(
      input,
      actor,
      { correlationId: "correlation-upload-1" },
      dependencies
    );
    const replay = await uploadCompanyLogo(
      input,
      actor,
      { correlationId: "correlation-upload-replay" },
      dependencies
    );
    const company = await prisma.company.findFirstOrThrow();
    const attachments = await prisma.attachment.findMany();
    const audits = await prisma.auditEvent.findMany({
      where: { eventType: "COMPANY_LOGO_UPLOADED" }
    });

    expect(first).toMatchObject({ ok: true, status: 201, value: { replaced: false } });
    expect(replay).toEqual(first);
    expect(attachments).toHaveLength(1);
    expect(company.logoAttachmentId).toBe(attachments[0]?.id);
    expect(attachments[0]).toMatchObject({
      purpose: "COMPANY_LOGO",
      status: "AVAILABLE",
      scanResult: "CLEAN",
      detectedMimeType: "image/png"
    });
    expect(audits).toHaveLength(1);
    expect(storage.published.size).toBe(1);
  });

  it("rejects reuse of an idempotency key with different content", async () => {
    const actor = await loginAsAdmin();
    const storage = new MemoryStorage();
    const dependencies = cleanDependencies(storage);
    const firstInput = logoInput(null, "same-idempotency-key");
    await uploadCompanyLogo(firstInput, actor, { correlationId: randomUUID() }, dependencies);

    const secondBytes = Buffer.from("different-original");
    const second = await uploadCompanyLogo(
      {
        ...firstInput,
        bytes: secondBytes,
        requestHash: companyLogoRequestHash({
          bytes: secondBytes,
          fileName: "logo.png",
          declaredMimeType: "image/png",
          expectedLogoId: null
        })
      },
      actor,
      { correlationId: randomUUID() },
      dependencies
    );

    expect(second).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "La clave de idempotencia ya se uso con otra peticion."
      }
    });
    expect(await prisma.attachment.count()).toBe(1);
  });

  it("replaces the prior logo atomically and retains its history", async () => {
    const actor = await loginAsAdmin();
    const storage = new MemoryStorage();
    const dependencies = cleanDependencies(storage);
    const first = await uploadCompanyLogo(
      logoInput(null, "replace-logo-1"),
      actor,
      { correlationId: randomUUID() },
      dependencies
    );
    if (!first.ok) throw new Error(first.error.code);

    const second = await uploadCompanyLogo(
      logoInput(first.value.logo.id, "replace-logo-2"),
      actor,
      { correlationId: randomUUID() },
      dependencies
    );
    if (!second.ok) throw new Error(second.error.code);

    const company = await prisma.company.findFirstOrThrow();
    const prior = await prisma.attachment.findUniqueOrThrow({
      where: { id: first.value.logo.id }
    });

    expect(second.status).toBe(200);
    expect(second.value.replaced).toBe(true);
    expect(company.logoAttachmentId).toBe(second.value.logo.id);
    expect(prior.status).toBe("REPLACED");
    expect(prior.replacedAt).not.toBeNull();
    expect(await prisma.attachment.count()).toBe(2);
  });

  it.each(["infected", "inconclusive"] as const)(
    "fails closed when the antivirus result is %s",
    async (outcome) => {
      const actor = await loginAsAdmin();
      const storage = new MemoryStorage();
      const dependencies = cleanDependencies(storage, outcome);

      const result = await uploadCompanyLogo(
        logoInput(null, `scan-${outcome}`),
        actor,
        { correlationId: randomUUID() },
        dependencies
      );

      expect(result).toMatchObject({
        ok: false,
        status: outcome === "infected" ? 422 : 503
      });
      expect(await prisma.attachment.count()).toBe(0);
      expect(storage.published.size).toBe(0);
      expect(storage.temporary.size).toBe(0);
    }
  );

  it("refuses a download when the stored object fails integrity verification", async () => {
    const actor = await loginAsAdmin();
    const storage = new MemoryStorage();
    const dependencies = cleanDependencies(storage);
    const created = await uploadCompanyLogo(
      logoInput(null, "download-integrity"),
      actor,
      { correlationId: randomUUID() },
      dependencies
    );
    if (!created.ok) throw new Error(created.error.code);
    storage.failIntegrity = true;

    const result = await downloadCompanyLogo(
      actor,
      { correlationId: "correlation-integrity" },
      storage
    );

    expect(result).toMatchObject({
      ok: false,
      status: 503,
      error: { code: "COMPANY_LOGO_INTEGRITY_FAILED" }
    });
    expect(await prisma.auditEvent.count({
      where: { eventType: "COMPANY_LOGO_INTEGRITY_FAILED" }
    })).toBe(1);
  });

  it("enforces company ownership for the active logo in PostgreSQL", async () => {
    const actor = await loginAsAdmin();
    const primary = await prisma.company.findFirstOrThrow();
    const other = await prisma.company.create({
      data: { legalName: "Otra Empresa SL", taxId: "B87654321" }
    });
    const now = new Date();
    const foreignLogo = await prisma.$transaction(async (tx) => {
      const attachment = await tx.attachment.create({
        data: {
          companyId: other.id,
          purpose: "COMPANY_LOGO",
          originalFileName: "foreign.png",
          extension: "png",
          declaredMimeType: "image/png",
          detectedMimeType: "image/png",
          sizeBytes: 10,
          sha256: "a".repeat(64),
          storageKey: `company-logo/${other.id}/${randomUUID()}.png`,
          status: "AVAILABLE",
          scanResult: "CLEAN",
          scanEngine: "test-scanner",
          scanCompletedAt: now,
          availableAt: now,
          uploadedById: actor.id
        }
      });
      await tx.company.update({
        where: { id: other.id },
        data: { logoAttachmentId: attachment.id }
      });
      return attachment;
    });

    await expect(prisma.company.update({
      where: { id: primary.id },
      data: { logoAttachmentId: foreignLogo.id }
    })).rejects.toThrow();
    expect((await prisma.company.findUniqueOrThrow({ where: { id: primary.id } }))
      .logoAttachmentId).toBeNull();
  });

  it("preserves and reconciles the object when the commit result is uncertain", async () => {
    const actor = await loginAsAdmin();
    const storage = new MemoryStorage();
    const dependencies = cleanDependencies(storage);
    dependencies.afterPersistenceResolved = async () => {
      throw new Error("SIMULATED_CONNECTION_LOSS_AFTER_COMMIT");
    };

    const result = await uploadCompanyLogo(
      logoInput(null, "uncertain-commit"),
      actor,
      { correlationId: "correlation-uncertain-commit" },
      dependencies
    );

    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(await prisma.attachment.count({ where: { status: "AVAILABLE" } })).toBe(1);
    expect(storage.published.size).toBe(1);
    expect(await prisma.auditEvent.count({
      where: { eventType: "ATTACHMENT_PERSISTENCE_OUTCOME_UNCERTAIN" }
    })).toBe(0);
  });

  it("converges concurrent uploads with the same idempotency key", async () => {
    const actor = await loginAsAdmin();
    const storage = new MemoryStorage();
    const dependencies = cleanDependencies(storage);
    const input = logoInput(null, "concurrent-same-key");

    const results = await Promise.all([
      uploadCompanyLogo(input, actor, { correlationId: randomUUID() }, dependencies),
      uploadCompanyLogo(input, actor, { correlationId: randomUUID() }, dependencies)
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results[0]).toEqual(results[1]);
    expect(await prisma.attachment.count()).toBe(1);
    expect(storage.published.size).toBe(1);
  });

  it("allows only one concurrent upload from the same expected logo version", async () => {
    const actor = await loginAsAdmin();
    const storage = new MemoryStorage();
    const dependencies = cleanDependencies(storage);

    const results = await Promise.all([
      uploadCompanyLogo(
        logoInput(null, "concurrent-key-a"), actor, { correlationId: randomUUID() }, dependencies
      ),
      uploadCompanyLogo(
        logoInput(null, "concurrent-key-b"), actor, { correlationId: randomUUID() }, dependencies
      )
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([
      { status: 409, error: { code: "COMPANY_LOGO_CHANGED" } }
    ]);
    expect(await prisma.attachment.count()).toBe(1);
    expect(storage.published.size).toBe(1);
  });
});

class MemoryStorage implements CompanyLogoStorage {
  readonly temporary = new Map<string, Buffer>();
  readonly published = new Map<string, Buffer>();
  failIntegrity = false;

  async writeTemporary(bytes: Buffer, kind: "upload" | "canonical"): Promise<string> {
    const key = `${randomUUID()}.${kind}`;
    this.temporary.set(key, Buffer.from(bytes));
    return key;
  }

  async publish(temporaryPath: string, storageKey: string): Promise<void> {
    if (this.published.has(storageKey)) throw new Error("OBJECT_EXISTS");
    const bytes = this.temporary.get(temporaryPath);
    if (!bytes) throw new Error("TEMPORARY_NOT_FOUND");
    this.published.set(storageKey, Buffer.from(bytes));
    this.temporary.delete(temporaryPath);
  }

  async readVerified(storageKey: string): Promise<Buffer> {
    if (this.failIntegrity) throw new AttachmentIntegrityError();
    const bytes = this.published.get(storageKey);
    if (!bytes) throw new AttachmentIntegrityError();
    return Buffer.from(bytes);
  }

  async removeTemporary(temporaryPath: string | null): Promise<void> {
    if (temporaryPath) this.temporary.delete(temporaryPath);
  }

  async removePublished(storageKey: string): Promise<void> {
    this.published.delete(storageKey);
  }
}

function cleanDependencies(
  storage: MemoryStorage,
  outcome: AttachmentScanResult["outcome"] = "clean"
): CompanyLogoAttachmentDependencies {
  return {
    storage,
    scanner: {
      scan: async () => ({ outcome, engine: "test-scanner", version: "1" })
    },
    canonicalize: async ({ originalFileName }) => ({
      bytes: Buffer.from("canonical-logo"),
      originalFileName,
      extension: "png",
      mediaType: "image/png",
      width: 32,
      height: 16
    })
  };
}

function logoInput(expectedLogoId: string | null, clientIdempotencyKey: string) {
  const bytes = Buffer.from("original-logo");
  return {
    bytes,
    fileName: "logo.png",
    declaredMimeType: "image/png",
    expectedLogoId,
    clientIdempotencyKey,
    requestHash: companyLogoRequestHash({
      bytes,
      fileName: "logo.png",
      declaredMimeType: "image/png",
      expectedLogoId
    })
  };
}

async function loginAsAdmin() {
  const result = await login({ userName: "admin", password: adminPassword });
  if (!result.ok) throw new Error(result.error.code);
  return result.value.user;
}

async function initializeForLogo(): Promise<void> {
  const rawBody = JSON.stringify(baseCommand);
  const result = await initializePlatform(baseCommand, randomUUID(), hashRequestBody(rawBody));
  if (!result.ok) throw new Error(result.error.code);
}

async function resetPlatformTables(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.company.updateMany({ data: { logoAttachmentId: null } });
    await tx.attachment.deleteMany();
    await tx.idempotencyRecord.deleteMany();
    await tx.auditEvent.deleteMany();
    await tx.installation.deleteMany();
    await tx.reservedUserName.deleteMany();
    await tx.session.deleteMany();
    await tx.rateLimitBucket.deleteMany();
    await tx.loginAttempt.deleteMany();
    await tx.user.deleteMany();
    await tx.rolePermission.deleteMany();
    await tx.permission.deleteMany();
    await tx.role.deleteMany();
    await tx.company.deleteMany();
  });
}
