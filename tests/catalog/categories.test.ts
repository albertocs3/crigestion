import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createCatalogCategory,
  updateCatalogCategoryStatus
} from "@/modules/catalog/application/categories";
import { createCatalogItem } from "@/modules/catalog/application/items";
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

describe("catalog categories application service", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await resetCatalogCategoryCodeSequence();
    await resetCatalogItemCodeSequence();
    await initializeForCatalog();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("creates categories with automatic codes and audits safely", async () => {
    const actor = await loginAsAdmin();
    const result = await createCatalogCategory(
      {
        name: "Servicios recurrentes",
        description: "Cuotas y mantenimientos"
      },
      actor,
      { correlationId: "category-create-0001" }
    );
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CATALOG_CATEGORY_CREATED" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(result).toMatchObject({
      ok: true,
      status: 201,
      value: {
        code: "1",
        name: "Servicios recurrentes",
        description: "Cuotas y mantenimientos",
        status: "ACTIVE"
      }
    });
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      categoryCode: "1",
      correlationId: "category-create-0001"
    });
    expect(auditPayload).not.toContain("Servicios recurrentes");
  });

  it("assigns active categories to catalog items", async () => {
    const actor = await loginAsAdmin();
    const category = await createCatalogCategory(
      { name: "Productos fisicos", description: null },
      actor
    );
    const taxRate = await prisma.catalogTaxRate.findFirstOrThrow({
      where: { code: "IVA_21" },
      select: { id: true }
    });

    if (!category.ok) {
      throw new Error(category.error.code);
    }

    const item = await createCatalogItem(
      {
        categoryId: category.value.id,
        kind: "PRODUCT",
        name: "Producto con categoria",
        description: null,
        unitName: "Unidades",
        salePrice: "99.00",
        costPrice: "40.00",
        taxRateId: taxRate.id,
        stockTracked: true,
        stockCurrent: "5.000",
        stockMinimum: "1.000"
      },
      actor
    );

    expect(item).toMatchObject({
      ok: true,
      value: {
        category: {
          id: category.value.id,
          code: "1",
          name: "Productos fisicos"
        }
      }
    });
  });

  it("deactivates and reactivates categories", async () => {
    const actor = await loginAsAdmin();
    const category = await createCatalogCategory(
      { name: "Software", description: null },
      actor
    );

    if (!category.ok) {
      throw new Error(category.error.code);
    }

    const deactivated = await updateCatalogCategoryStatus(
      category.value.id,
      { action: "deactivate" },
      actor
    );
    const reactivated = await updateCatalogCategoryStatus(
      category.value.id,
      { action: "reactivate" },
      actor
    );

    expect(deactivated).toMatchObject({
      ok: true,
      value: {
        status: "INACTIVE"
      }
    });
    expect(reactivated).toMatchObject({
      ok: true,
      value: {
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
    prisma.catalogCategory.deleteMany(),
    prisma.catalogTaxRate.deleteMany(),
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}

async function resetCatalogCategoryCodeSequence(): Promise<void> {
  await prisma.$executeRaw`ALTER SEQUENCE catalog_category_code_seq RESTART WITH 1`;
}

async function resetCatalogItemCodeSequence(): Promise<void> {
  await prisma.$executeRaw`ALTER SEQUENCE catalog_item_code_seq RESTART WITH 1`;
}
