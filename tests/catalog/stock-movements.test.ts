import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createCatalogItem } from "@/modules/catalog/application/items";
import { createCatalogStockAdjustment } from "@/modules/catalog/application/stockMovements";
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

describe("catalog stock movements application service", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await resetCatalogItemCodeSequence();
    await initializeForCatalog();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("registers stock adjustments and updates current stock transactionally", async () => {
    const actor = await loginAsAdmin();
    const item = await createStockedProduct(actor);

    const result = await createCatalogStockAdjustment(
      item.id,
      {
        quantity: "-2.500",
        reason: "Regularizacion de inventario"
      },
      actor,
      { correlationId: "stock-adjust-0001" }
    );
    const updatedItem = await prisma.catalogItem.findUniqueOrThrow({
      where: { id: item.id },
      select: { stockCurrent: true }
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CATALOG_STOCK_ADJUSTED" }
    });

    expect(result).toMatchObject({
      ok: true,
      status: 201,
      value: {
        itemId: item.id,
        itemCode: "1",
        quantity: "-2.500",
        previousStock: "10.000",
        newStock: "7.500",
        reason: "Regularizacion de inventario"
      }
    });
    expect(updatedItem.stockCurrent.toFixed(3)).toBe("7.500");
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      itemId: item.id,
      itemCode: "1",
      correlationId: "stock-adjust-0001"
    });
    expect(auditEvent.payload).toHaveProperty("movementId");
    expect(auditEvent.payload).not.toHaveProperty("quantity");
    expect(auditEvent.payload).not.toHaveProperty("previousStock");
    expect(auditEvent.payload).not.toHaveProperty("newStock");
  });

  it("serializes concurrent adjustments for the same stock item", async () => {
    const actor = await loginAsAdmin();
    const item = await createStockedProduct(actor);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        createCatalogStockAdjustment(
          item.id,
          {
            quantity: "1.000",
            reason: `Recuento concurrente ${index + 1}`
          },
          actor
        )
      )
    );
    const updatedItem = await prisma.catalogItem.findUniqueOrThrow({
      where: { id: item.id },
      select: { stockCurrent: true }
    });
    const movements = await prisma.catalogStockMovement.findMany({
      where: { itemId: item.id },
      orderBy: { createdAt: "asc" },
      select: {
        previousStock: true,
        newStock: true
      }
    });

    expect(results.every((result) => result.ok)).toBe(true);
    expect(updatedItem.stockCurrent.toFixed(3)).toBe("15.000");
    expect(movements).toHaveLength(5);
    expect(
      new Set(movements.map((movement) => movement.previousStock.toFixed(3)))
    ).toEqual(new Set(["10.000", "11.000", "12.000", "13.000", "14.000"]));
    expect(
      new Set(movements.map((movement) => movement.newStock.toFixed(3)))
    ).toEqual(new Set(["11.000", "12.000", "13.000", "14.000", "15.000"]));
  });

  it("rejects stock adjustments for items without stock tracking", async () => {
    const actor = await loginAsAdmin();
    const taxRate = await defaultTaxRate();
    const service = await createCatalogItem(
      {
        categoryId: null,
        kind: "SERVICE",
        name: "Servicio sin stock",
        description: null,
        unitName: "Unidades",
        salePrice: "49.90",
        costPrice: "0.00",
        taxRateId: taxRate.id,
        stockTracked: false,
        stockCurrent: "0.000",
        stockMinimum: "0.000"
      },
      actor
    );

    if (!service.ok) {
      throw new Error(service.error.code);
    }

    const result = await createCatalogStockAdjustment(
      service.value.id,
      {
        quantity: "1.000",
        reason: "Inventario"
      },
      actor
    );

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "CATALOG_ITEM_STOCK_NOT_TRACKED",
        message: "El elemento no es un producto con control de stock."
      }
    });
  });
});

async function createStockedProduct(actor: Awaited<ReturnType<typeof loginAsAdmin>>) {
  const taxRate = await defaultTaxRate();
  const result = await createCatalogItem(
    {
      categoryId: null,
      kind: "PRODUCT",
      name: "Producto inventariable",
      description: null,
      unitName: "Unidades",
      salePrice: "99.00",
      costPrice: "40.00",
      taxRateId: taxRate.id,
      stockTracked: true,
      stockCurrent: "10.000",
      stockMinimum: "2.000"
    },
    actor
  );

  if (!result.ok) {
    throw new Error(result.error.code);
  }

  return result.value;
}

async function defaultTaxRate() {
  return prisma.catalogTaxRate.findFirstOrThrow({
    where: { code: "IVA_21" },
    select: { id: true }
  });
}

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

async function resetCatalogItemCodeSequence(): Promise<void> {
  await prisma.$executeRaw`ALTER SEQUENCE catalog_item_code_seq RESTART WITH 1`;
}
