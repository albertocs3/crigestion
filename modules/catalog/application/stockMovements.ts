import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type {
  RequestContext,
  SessionUser
} from "@/modules/platform/application/auth";

const stockAdjustmentQuantitySchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,9}(\.\d{1,3})?$/, "La cantidad debe tener hasta tres decimales.")
  .refine((value) => !new Prisma.Decimal(value).equals(0), {
    message: "La cantidad del ajuste no puede ser cero."
  });

export const createCatalogStockAdjustmentSchema = z.object({
  quantity: stockAdjustmentQuantitySchema,
  reason: z.string().trim().min(3).max(500)
}).strict();

export type CreateCatalogStockAdjustmentCommand = z.infer<
  typeof createCatalogStockAdjustmentSchema
>;

export type CatalogStockMovementItem = {
  id: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  type: "ADJUSTMENT" | "PURCHASE_RECEIPT";
  quantity: string;
  previousStock: string;
  newStock: string;
  reason: string;
  createdAt: string;
};

type CatalogItemNotFoundResult = {
  ok: false;
  status: 404;
  error: {
    code: "CATALOG_ITEM_NOT_FOUND";
    message: string;
  };
};

type CatalogItemStockNotTrackedResult = {
  ok: false;
  status: 409;
  error: {
    code: "CATALOG_ITEM_STOCK_NOT_TRACKED";
    message: string;
  };
};

type LockedCatalogStockItem = {
  id: string;
  code: string;
  name: string;
  kind: "PRODUCT" | "SERVICE" | "SOFTWARE" | "LICENSE";
  stockTracked: boolean;
  stockCurrent: Prisma.Decimal;
};

export type CreateCatalogStockAdjustmentResult =
  | { ok: true; status: 201; value: CatalogStockMovementItem }
  | CatalogItemNotFoundResult
  | CatalogItemStockNotTrackedResult;

export async function createCatalogStockAdjustment(
  itemId: string,
  command: CreateCatalogStockAdjustmentCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CreateCatalogStockAdjustmentResult> {
  const result = await prisma.$transaction(async (tx) => {
    const item = await lockCatalogStockItem(tx, itemId);

    if (!item) {
      return { kind: "not-found" as const };
    }

    if (item.kind !== "PRODUCT" || !item.stockTracked) {
      return { kind: "stock-not-tracked" as const };
    }

    const quantity = new Prisma.Decimal(command.quantity);
    const newStock = item.stockCurrent.plus(quantity);
    const movement = await tx.catalogStockMovement.create({
      data: {
        itemId: item.id,
        type: "ADJUSTMENT",
        quantity,
        previousStock: item.stockCurrent,
        newStock,
        reason: command.reason,
        createdById: actor.id
      },
      select: catalogStockMovementSelect
    });

    await tx.catalogItem.update({
      where: { id: item.id },
      data: {
        stockCurrent: newStock,
        updatedById: actor.id
      }
    });

    await tx.auditEvent.create({
      data: {
        eventType: "CATALOG_STOCK_ADJUSTED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          itemId: item.id,
          itemCode: item.code,
          movementId: movement.id,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { kind: "created" as const, movement };
  });

  if (result.kind === "not-found") {
    return catalogItemNotFound();
  }

  if (result.kind === "stock-not-tracked") {
    return catalogItemStockNotTracked();
  }

  return {
    ok: true,
    status: 201,
    value: mapCatalogStockMovementItem(result.movement)
  };
}

const catalogStockMovementSelect = {
  id: true,
  itemId: true,
  type: true,
  quantity: true,
  previousStock: true,
  newStock: true,
  reason: true,
  createdAt: true,
  item: {
    select: {
      code: true,
      name: true
    }
  }
} satisfies Prisma.CatalogStockMovementSelect;

function mapCatalogStockMovementItem(movement: {
  id: string;
  itemId: string;
  type: "ADJUSTMENT" | "PURCHASE_RECEIPT";
  quantity: Prisma.Decimal;
  previousStock: Prisma.Decimal;
  newStock: Prisma.Decimal;
  reason: string;
  createdAt: Date;
  item: {
    code: string;
    name: string;
  };
}): CatalogStockMovementItem {
  return {
    id: movement.id,
    itemId: movement.itemId,
    itemCode: movement.item.code,
    itemName: movement.item.name,
    type: movement.type,
    quantity: decimalString(movement.quantity),
    previousStock: decimalString(movement.previousStock),
    newStock: decimalString(movement.newStock),
    reason: movement.reason,
    createdAt: movement.createdAt.toISOString()
  };
}

async function lockCatalogStockItem(
  tx: Prisma.TransactionClient,
  itemId: string
): Promise<LockedCatalogStockItem | null> {
  const rows = await tx.$queryRaw<LockedCatalogStockItem[]>`
    SELECT
      "id",
      "code",
      "name",
      "kind",
      "stockTracked",
      "stockCurrent"
    FROM "catalog_items"
    WHERE "id" = ${itemId}::uuid
    FOR UPDATE
  `;

  return rows[0] ?? null;
}

function decimalString(value: Prisma.Decimal): string {
  return value.toFixed(3);
}

function catalogItemNotFound(): CatalogItemNotFoundResult {
  return {
    ok: false,
    status: 404,
    error: {
      code: "CATALOG_ITEM_NOT_FOUND",
      message: "El elemento de catalogo no existe."
    }
  };
}

function catalogItemStockNotTracked(): CatalogItemStockNotTrackedResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CATALOG_ITEM_STOCK_NOT_TRACKED",
      message: "El elemento no es un producto con control de stock."
    }
  };
}
