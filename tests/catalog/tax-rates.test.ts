import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createCatalogTaxRate,
  listCatalogTaxRates,
  updateCatalogTaxRateStatus
} from "@/modules/catalog/application/taxRates";
import { login } from "@/modules/platform/application/auth";
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

describe("catalog tax rates application service", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await initializeForCatalog();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("creates tax rates, sets one default and audits safely", async () => {
    const actor = await loginAsAdmin();
    const created = await createCatalogTaxRate(
      {
        code: "iva_23",
        name: "IVA general 23%",
        rate: "23.00",
        isDefault: true
      },
      actor,
      { correlationId: "tax-rate-create-0001" }
    );
    const taxRates = await listCatalogTaxRates({ includeInactive: true });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CATALOG_TAX_RATE_CREATED" }
    });

    expect(created).toMatchObject({
      ok: true,
      status: 201,
      value: {
        code: "IVA_23",
        name: "IVA general 23%",
        rate: "23.00",
        status: "ACTIVE",
        isDefault: true
      }
    });
    expect(taxRates.filter((taxRate) => taxRate.isDefault)).toHaveLength(1);
    expect(taxRates.find((taxRate) => taxRate.code === "IVA_23")).toMatchObject({
      isDefault: true
    });
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      taxRateCode: "IVA_23",
      rate: "23.00",
      isDefault: true,
      correlationId: "tax-rate-create-0001"
    });
  });

  it("does not deactivate the default tax rate", async () => {
    const actor = await loginAsAdmin();
    const defaultTaxRate = await prisma.catalogTaxRate.findFirstOrThrow({
      where: { isDefault: true },
      select: { id: true }
    });

    const result = await updateCatalogTaxRateStatus(
      defaultTaxRate.id,
      { action: "deactivate" },
      actor
    );

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "CATALOG_TAX_RATE_DEFAULT_CANNOT_BE_INACTIVE",
        message: "El tipo de IVA por defecto debe estar activo."
      }
    });
  });

  it("deactivates and reactivates non-default tax rates", async () => {
    const actor = await loginAsAdmin();
    const taxRate = await prisma.catalogTaxRate.findFirstOrThrow({
      where: { code: "IVA_10" },
      select: { id: true }
    });

    const deactivated = await updateCatalogTaxRateStatus(
      taxRate.id,
      { action: "deactivate" },
      actor
    );
    const reactivated = await updateCatalogTaxRateStatus(
      taxRate.id,
      { action: "reactivate" },
      actor
    );

    expect(deactivated).toMatchObject({
      ok: true,
      value: {
        code: "IVA_10",
        status: "INACTIVE"
      }
    });
    expect(reactivated).toMatchObject({
      ok: true,
      value: {
        code: "IVA_10",
        status: "ACTIVE"
      }
    });
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

async function initializeForCatalog(): Promise<void> {
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
    prisma.restoreOperation.deleteMany(),
    prisma.backupOperation.deleteMany(),
    prisma.invoiceVerifactuRecord.deleteMany(),
    prisma.customerPayment.deleteMany(),
    prisma.invoiceDueDate.deleteMany(),
    prisma.invoiceTaxSummary.deleteMany(),
    prisma.invoiceLine.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.invoiceNumberSequence.deleteMany(),
    prisma.customerAddress.deleteMany(),
    prisma.customerSepaMandate.deleteMany(),
    prisma.customerStore.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.catalogStockMovement.deleteMany(),
    prisma.catalogItem.deleteMany(),
    prisma.catalogTaxRate.deleteMany(),
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
