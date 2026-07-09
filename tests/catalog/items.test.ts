import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { login } from "@/modules/platform/application/auth";
import {
  createCatalogItem,
  createCatalogItemSchema,
  listCatalogItems,
  updateCatalogItem,
  updateCatalogItemStatus
} from "@/modules/catalog/application/items";
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
let defaultCatalogTaxRateId = "";

describe("catalog items application service", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await resetCatalogItemCodeSequence();
    await initializeForCatalog();
    defaultCatalogTaxRateId = await findDefaultCatalogTaxRateId();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("creates catalog items with automatic codes and safe audit payloads", async () => {
    const actor = await loginAsAdmin();
    const result = await createCatalogItem(itemPayload(), actor, {
      correlationId: "catalog-create-0001"
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CATALOG_ITEM_CREATED" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(result).toMatchObject({
      ok: true,
      status: 201,
      value: {
        code: "1",
        kind: "SERVICE",
        status: "ACTIVE",
        name: "Servicio mensual",
        salePrice: "49.90",
        costPrice: "10.00",
        taxRate: "21.00",
        tax: {
          code: "IVA_21",
          name: "IVA general 21%",
          rate: "21.00"
        },
        stock: {
          tracked: false,
          current: "0.000",
          minimum: "0.000"
        }
      }
    });
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      itemCode: "1",
      kind: "SERVICE",
      stockTracked: false,
      correlationId: "catalog-create-0001"
    });
    expect(auditPayload).not.toContain("Servicio mensual");
    expect(auditPayload).not.toContain("49.90");
  });

  it("updates and deactivates catalog items with changed field audit", async () => {
    const actor = await loginAsAdmin();
    const created = await createCatalogItem(itemPayload(), actor);

    if (!created.ok) {
      throw new Error(created.error.code);
    }

    const updated = await updateCatalogItem(
      created.value.id,
      itemPayload({
        kind: "PRODUCT",
        name: "Producto fisico",
        salePrice: "99.00",
        stockTracked: true,
        stockCurrent: "5.000",
        stockMinimum: "2.000"
      }),
      actor,
      { correlationId: "catalog-update-0001" }
    );
    const deactivated = await updateCatalogItemStatus(
      created.value.id,
      { action: "deactivate" },
      actor
    );
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CATALOG_ITEM_UPDATED" }
    });

    expect(updated).toMatchObject({
      ok: true,
      value: {
        kind: "PRODUCT",
        name: "Producto fisico",
        salePrice: "99.00",
        stock: {
          tracked: true,
          current: "5.000",
          minimum: "2.000"
        }
      }
    });
    expect(deactivated).toMatchObject({
      ok: true,
      value: {
        status: "INACTIVE"
      }
    });
    expect(auditEvent.payload).toMatchObject({
      changedFields: [
        "kind",
        "name",
        "salePrice",
        "stockTracked",
        "stockCurrent",
        "stockMinimum"
      ],
      correlationId: "catalog-update-0001"
    });
  });

  it("rejects duplicate catalog item names", async () => {
    const actor = await loginAsAdmin();

    await createCatalogItem(itemPayload(), actor);
    const result = await createCatalogItem(itemPayload(), actor);

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "CATALOG_ITEM_NAME_ALREADY_USED",
        message: "Ya existe un elemento de catalogo con ese nombre."
      }
    });
  });

  it("rejects stock tracking on non-product items", async () => {
    const result = createCatalogItemSchema.safeParse(
      itemPayload({
        kind: "SERVICE",
        stockTracked: true
      })
    );

    expect(result.success).toBe(false);
  });

  it("lists and filters catalog items", async () => {
    const actor = await loginAsAdmin();

    await createCatalogItem(itemPayload({ name: "Servicio mensual" }), actor);
    await createCatalogItem(
      itemPayload({
        kind: "PRODUCT",
        name: "Producto fisico",
        stockTracked: true,
        stockCurrent: "1.000"
      }),
      actor
    );

    const result = await listCatalogItems({ limit: 25, kind: "PRODUCT" }, actor);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      name: "Producto fisico",
      kind: "PRODUCT"
    });
  });
});

function itemPayload(
  overrides: Partial<Parameters<typeof createCatalogItem>[0]> = {}
): Parameters<typeof createCatalogItem>[0] {
  return {
    categoryId: null,
    kind: "SERVICE",
    name: "Servicio mensual",
    description: "Cuota mensual de soporte",
    unitName: "Unidades",
    salePrice: "49.90",
    costPrice: "10.00",
    taxRateId: defaultCatalogTaxRateId,
    stockTracked: false,
    stockCurrent: "0.000",
    stockMinimum: "0.000",
    ...overrides
  };
}

async function findDefaultCatalogTaxRateId(): Promise<string> {
  const taxRate = await prisma.catalogTaxRate.findFirstOrThrow({
    where: {
      code: "IVA_21",
      status: "ACTIVE"
    },
    select: {
      id: true
    }
  });

  return taxRate.id;
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
    prisma.customerPaymentReturn.deleteMany(),
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

async function resetCatalogItemCodeSequence(): Promise<void> {
  await prisma.$executeRaw`ALTER SEQUENCE catalog_item_code_seq RESTART WITH 1`;
}
