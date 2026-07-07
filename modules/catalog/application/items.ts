import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type {
  RequestContext,
  SessionUser
} from "@/modules/platform/application/auth";

const defaultLimit = 25;
const maxLimit = 100;

const catalogItemKindSchema = z.enum(["PRODUCT", "SERVICE", "SOFTWARE", "LICENSE"]);
const catalogItemStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);
const moneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, "El importe debe tener hasta dos decimales.");
const stockQuantitySchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,9}(\.\d{1,3})?$/, "La cantidad debe tener hasta tres decimales.");
const nonNegativeStockQuantitySchema = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, "La cantidad debe tener hasta tres decimales.");

const itemDataSchema = z.object({
  categoryId: z.string().uuid().nullable().default(null),
  kind: catalogItemKindSchema,
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().min(1).max(1000).nullable(),
  unitName: z.string().trim().min(1).max(40).default("Unidades"),
  salePrice: moneySchema,
  costPrice: moneySchema.default("0.00"),
  taxRateId: z.string().uuid(),
  stockTracked: z.boolean().default(false),
  stockCurrent: stockQuantitySchema.default("0.000"),
  stockMinimum: nonNegativeStockQuantitySchema.default("0.000")
}).strict().superRefine(validateCatalogItemInput);

export const listCatalogItemsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  cursor: z.string().uuid().optional(),
  status: catalogItemStatusSchema.optional(),
  kind: catalogItemKindSchema.optional(),
  categoryId: z.string().uuid().optional(),
  search: z.string().trim().min(1).max(120).optional()
});

export const createCatalogItemSchema = itemDataSchema;
export const updateCatalogItemSchema = itemDataSchema;
export const updateCatalogItemStatusSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("deactivate")
  }).strict(),
  z.object({
    action: z.literal("reactivate")
  }).strict()
]);

export type ListCatalogItemsCommand = z.infer<typeof listCatalogItemsSchema>;
export type CreateCatalogItemCommand = z.infer<typeof createCatalogItemSchema>;
export type UpdateCatalogItemCommand = z.infer<typeof updateCatalogItemSchema>;
export type UpdateCatalogItemStatusCommand = z.infer<
  typeof updateCatalogItemStatusSchema
>;

export type CatalogItemListItem = {
  id: string;
  code: string;
  category: {
    id: string;
    code: string;
    name: string;
  } | null;
  kind: "PRODUCT" | "SERVICE" | "SOFTWARE" | "LICENSE";
  status: "ACTIVE" | "INACTIVE";
  name: string;
  description: string | null;
  unitName: string;
  salePrice: string;
  costPrice: string;
  taxRate: string;
  tax: {
    id: string;
    code: string;
    name: string;
    rate: string;
  };
  stock: {
    tracked: boolean;
    current: string;
    minimum: string;
    belowMinimum: boolean;
    negative: boolean;
  };
  createdAt: string;
  updatedAt: string;
};

export type CatalogItemList = {
  items: CatalogItemListItem[];
  nextCursor: string | null;
};

type CatalogItemNameAlreadyUsedResult = {
  ok: false;
  status: 409;
  error: {
    code: "CATALOG_ITEM_NAME_ALREADY_USED";
    message: string;
  };
};

type CatalogItemNotFoundResult = {
  ok: false;
  status: 404;
  error: {
    code: "CATALOG_ITEM_NOT_FOUND";
    message: string;
  };
};

type CatalogItemStatusAlreadySetResult = {
  ok: false;
  status: 409;
  error: {
    code: "CATALOG_ITEM_STATUS_ALREADY_SET";
    message: string;
  };
};

type CatalogTaxRateNotFoundResult = {
  ok: false;
  status: 422;
  error: {
    code: "CATALOG_TAX_RATE_NOT_FOUND";
    message: string;
  };
};

type CatalogCategoryNotFoundResult = {
  ok: false;
  status: 422;
  error: {
    code: "CATALOG_CATEGORY_NOT_FOUND";
    message: string;
  };
};

export type CreateCatalogItemResult =
  | { ok: true; status: 201; value: CatalogItemListItem }
  | CatalogItemNameAlreadyUsedResult
  | CatalogTaxRateNotFoundResult
  | CatalogCategoryNotFoundResult;

export type UpdateCatalogItemResult =
  | { ok: true; status: 200; value: CatalogItemListItem }
  | CatalogItemNameAlreadyUsedResult
  | CatalogItemNotFoundResult
  | CatalogTaxRateNotFoundResult
  | CatalogCategoryNotFoundResult;

export type UpdateCatalogItemStatusResult =
  | { ok: true; status: 200; value: CatalogItemListItem }
  | CatalogItemNotFoundResult
  | CatalogItemStatusAlreadySetResult;

export async function listCatalogItems(
  command: ListCatalogItemsCommand,
  actor: SessionUser
): Promise<CatalogItemList> {
  const where: Prisma.CatalogItemWhereInput = {
    ...(command.status ? { status: command.status } : {}),
    ...(command.kind ? { kind: command.kind } : {}),
    ...(command.categoryId ? { categoryId: command.categoryId } : {}),
    ...(command.search
      ? {
          OR: [
            { code: { contains: command.search, mode: "insensitive" } },
            { name: { contains: command.search, mode: "insensitive" } },
            { description: { contains: command.search, mode: "insensitive" } }
          ]
        }
      : {})
  };
  const items = await prisma.catalogItem.findMany({
    where,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    cursor: command.cursor ? { id: command.cursor } : undefined,
    skip: command.cursor ? 1 : 0,
    take: command.limit + 1,
    select: catalogItemSelect
  });
  const page = items.slice(0, command.limit);

  await prisma.auditEvent.create({
    data: {
      eventType: "CATALOG_ITEMS_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        status: command.status ?? null,
        kind: command.kind ?? null,
        hasSearch: Boolean(command.search),
        limit: command.limit,
        cursor: command.cursor ?? null,
        resultCount: page.length
      }
    }
  });

  return {
    items: page.map(mapCatalogItemListItem),
    nextCursor: items.length > command.limit ? page.at(-1)?.id ?? null : null
  };
}

export async function createCatalogItem(
  command: CreateCatalogItemCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CreateCatalogItemResult> {
  const normalized = normalizeCatalogItemCommand(command);

  try {
    const item = await prisma.$transaction(async (tx) => {
      const taxRate = await findActiveCatalogTaxRate(tx, normalized.taxRateId);

      if (!taxRate) {
        return { kind: "tax-rate-not-found" as const };
      }

      if (normalized.categoryId) {
        const category = await findActiveCatalogCategory(tx, normalized.categoryId);

        if (!category) {
          return { kind: "category-not-found" as const };
        }
      }

      const code = await nextCatalogItemCode(tx);
      const created = await tx.catalogItem.create({
        data: {
          ...normalized,
          taxRate: taxRate.rate,
          code,
          status: "ACTIVE",
          createdById: actor.id
        },
        select: catalogItemSelect
      });

      await tx.auditEvent.create({
        data: {
          eventType: "CATALOG_ITEM_CREATED",
          actorType: "USER",
          payload: {
            actorUserId: actor.id,
            itemId: created.id,
            itemCode: created.code,
            kind: created.kind,
            stockTracked: created.stockTracked,
            ...(context.correlationId ? { correlationId: context.correlationId } : {})
          }
        }
      });

      return created;
    });

    if ("kind" in item && item.kind === "tax-rate-not-found") {
      return catalogTaxRateNotFound();
    }

    if ("kind" in item && item.kind === "category-not-found") {
      return catalogCategoryNotFound();
    }

    return {
      ok: true,
      status: 201,
      value: mapCatalogItemListItem(item)
    };
  } catch (error) {
    if (isUniqueConstraintError(error, "name")) {
      return catalogItemNameAlreadyUsed();
    }

    throw error;
  }
}

export async function updateCatalogItem(
  itemId: string,
  command: UpdateCatalogItemCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<UpdateCatalogItemResult> {
  const normalized = normalizeCatalogItemCommand(command);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existingItem = await tx.catalogItem.findUnique({
        where: { id: itemId },
        select: {
          id: true,
          code: true,
          categoryId: true,
          kind: true,
          name: true,
          description: true,
          unitName: true,
          salePrice: true,
          costPrice: true,
          taxRateId: true,
          taxRate: true,
          stockTracked: true,
          stockCurrent: true,
          stockMinimum: true
        }
      });

      if (!existingItem) {
        return { kind: "not-found" as const };
      }

      const taxRate = await findActiveCatalogTaxRate(tx, normalized.taxRateId);

      if (!taxRate) {
        return { kind: "tax-rate-not-found" as const };
      }

      if (normalized.categoryId) {
        const category = await findActiveCatalogCategory(tx, normalized.categoryId);

        if (!category) {
          return { kind: "category-not-found" as const };
        }
      }

      const changedFields = changedCatalogItemFields(existingItem, normalized);
      const item = await tx.catalogItem.update({
        where: { id: itemId },
        data: {
          ...normalized,
          taxRate: taxRate.rate,
          updatedById: actor.id
        },
        select: catalogItemSelect
      });

      await tx.auditEvent.create({
        data: {
          eventType: "CATALOG_ITEM_UPDATED",
          actorType: "USER",
          payload: {
            actorUserId: actor.id,
            itemId,
            itemCode: existingItem.code,
            changedFields,
            ...(context.correlationId ? { correlationId: context.correlationId } : {})
          }
        }
      });

      return { kind: "updated" as const, item };
    });

    if (result.kind === "not-found") {
      return catalogItemNotFound();
    }

    if (result.kind === "tax-rate-not-found") {
      return catalogTaxRateNotFound();
    }

    if (result.kind === "category-not-found") {
      return catalogCategoryNotFound();
    }

    return {
      ok: true,
      status: 200,
      value: mapCatalogItemListItem(result.item)
    };
  } catch (error) {
    if (isUniqueConstraintError(error, "name")) {
      return catalogItemNameAlreadyUsed();
    }

    throw error;
  }
}

export async function updateCatalogItemStatus(
  itemId: string,
  command: UpdateCatalogItemStatusCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<UpdateCatalogItemStatusResult> {
  const nextStatus = command.action === "deactivate" ? "INACTIVE" : "ACTIVE";
  const eventType =
    command.action === "deactivate"
      ? "CATALOG_ITEM_DEACTIVATED"
      : "CATALOG_ITEM_REACTIVATED";

  const result = await prisma.$transaction(async (tx) => {
    const existingItem = await tx.catalogItem.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        code: true,
        status: true
      }
    });

    if (!existingItem) {
      return { kind: "not-found" as const };
    }

    if (existingItem.status === nextStatus) {
      return { kind: "already-set" as const };
    }

    const item = await tx.catalogItem.update({
      where: { id: itemId },
      data: {
        status: nextStatus,
        updatedById: actor.id
      },
      select: catalogItemSelect
    });

    await tx.auditEvent.create({
      data: {
        eventType,
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          itemId,
          itemCode: existingItem.code,
          previousStatus: existingItem.status,
          newStatus: nextStatus,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { kind: "updated" as const, item };
  });

  if (result.kind === "not-found") {
    return catalogItemNotFound();
  }

  if (result.kind === "already-set") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "CATALOG_ITEM_STATUS_ALREADY_SET",
        message: "El elemento ya esta en ese estado."
      }
    };
  }

  return {
    ok: true,
    status: 200,
    value: mapCatalogItemListItem(result.item)
  };
}

function validateCatalogItemInput(
  value: {
    kind: "PRODUCT" | "SERVICE" | "SOFTWARE" | "LICENSE";
    stockTracked: boolean;
    stockCurrent: string;
    stockMinimum: string;
  },
  context: z.RefinementCtx
): void {
  if (value.kind !== "PRODUCT" && value.stockTracked) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stockTracked"],
      message: "Solo los productos pueden controlar existencias."
    });
  }

  if (value.kind !== "PRODUCT") {
    if (value.stockCurrent !== "0" && value.stockCurrent !== "0.000") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stockCurrent"],
        message: "Solo los productos pueden tener stock actual."
      });
    }

    if (value.stockMinimum !== "0" && value.stockMinimum !== "0.000") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stockMinimum"],
        message: "Solo los productos pueden tener stock minimo."
      });
    }
  }
}

function normalizeCatalogItemCommand(
  command: CreateCatalogItemCommand | UpdateCatalogItemCommand
) {
  const tracksStock = command.kind === "PRODUCT" && command.stockTracked;

  return {
    categoryId: command.categoryId ?? null,
    kind: command.kind,
    name: command.name,
    description: command.description,
    unitName: command.unitName,
    salePrice: command.salePrice,
    costPrice: command.costPrice,
    taxRateId: command.taxRateId,
    stockTracked: tracksStock,
    stockCurrent: tracksStock ? command.stockCurrent : "0.000",
    stockMinimum: tracksStock ? command.stockMinimum : "0.000"
  };
}

const catalogItemSelect = {
  id: true,
  code: true,
  categoryId: true,
  category: {
    select: {
      id: true,
      code: true,
      name: true
    }
  },
  kind: true,
  status: true,
  name: true,
  description: true,
  unitName: true,
  salePrice: true,
  costPrice: true,
  taxRateId: true,
  taxRate: true,
  taxRateDefinition: {
    select: {
      id: true,
      code: true,
      name: true,
      rate: true
    }
  },
  stockTracked: true,
  stockCurrent: true,
  stockMinimum: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.CatalogItemSelect;

function mapCatalogItemListItem(item: {
  id: string;
  code: string;
  categoryId: string | null;
  category: {
    id: string;
    code: string;
    name: string;
  } | null;
  kind: CatalogItemListItem["kind"];
  status: CatalogItemListItem["status"];
  name: string;
  description: string | null;
  unitName: string;
  salePrice: Prisma.Decimal;
  costPrice: Prisma.Decimal;
  taxRateId: string;
  taxRate: Prisma.Decimal;
  taxRateDefinition: {
    id: string;
    code: string;
    name: string;
    rate: Prisma.Decimal;
  };
  stockTracked: boolean;
  stockCurrent: Prisma.Decimal;
  stockMinimum: Prisma.Decimal;
  createdAt: Date;
  updatedAt: Date;
}): CatalogItemListItem {
  const stockCurrent = decimalString(item.stockCurrent, 3);
  const stockMinimum = decimalString(item.stockMinimum, 3);

  return {
    id: item.id,
    code: item.code,
    category: item.category,
    kind: item.kind,
    status: item.status,
    name: item.name,
    description: item.description,
    unitName: item.unitName,
    salePrice: decimalString(item.salePrice, 2),
    costPrice: decimalString(item.costPrice, 2),
    taxRate: decimalString(item.taxRate, 2),
    tax: {
      id: item.taxRateDefinition.id,
      code: item.taxRateDefinition.code,
      name: item.taxRateDefinition.name,
      rate: decimalString(item.taxRateDefinition.rate, 2)
    },
    stock: {
      tracked: item.stockTracked,
      current: stockCurrent,
      minimum: stockMinimum,
      belowMinimum: item.stockTracked && Number(stockCurrent) <= Number(stockMinimum),
      negative: item.stockTracked && Number(stockCurrent) < 0
    },
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString()
  };
}

async function nextCatalogItemCode(tx: Prisma.TransactionClient): Promise<string> {
  const result = await tx.$queryRaw<Array<{ value: bigint }>>`
    SELECT nextval('catalog_item_code_seq') AS value
  `;
  const value = result[0]?.value;

  if (value === undefined) {
    throw new Error("CATALOG_ITEM_CODE_SEQUENCE_UNAVAILABLE");
  }

  return value.toString();
}

async function findActiveCatalogTaxRate(
  tx: Prisma.TransactionClient,
  taxRateId: string
): Promise<{ id: string; rate: Prisma.Decimal } | null> {
  return tx.catalogTaxRate.findFirst({
    where: {
      id: taxRateId,
      status: "ACTIVE"
    },
    select: {
      id: true,
      rate: true
    }
  });
}

async function findActiveCatalogCategory(
  tx: Prisma.TransactionClient,
  categoryId: string
): Promise<{ id: string } | null> {
  return tx.catalogCategory.findFirst({
    where: {
      id: categoryId,
      status: "ACTIVE"
    },
    select: {
      id: true
    }
  });
}

function changedCatalogItemFields(
  previous: {
    categoryId: string | null;
    kind: CatalogItemListItem["kind"];
    name: string;
    description: string | null;
    unitName: string;
    salePrice: Prisma.Decimal;
    costPrice: Prisma.Decimal;
    taxRateId: string;
    taxRate: Prisma.Decimal;
    stockTracked: boolean;
    stockCurrent: Prisma.Decimal;
    stockMinimum: Prisma.Decimal;
  },
  next: ReturnType<typeof normalizeCatalogItemCommand>
): string[] {
  return [
    previous.categoryId !== next.categoryId ? "categoryId" : null,
    previous.kind !== next.kind ? "kind" : null,
    previous.name !== next.name ? "name" : null,
    previous.description !== next.description ? "description" : null,
    previous.unitName !== next.unitName ? "unitName" : null,
    decimalString(previous.salePrice, 2) !== next.salePrice ? "salePrice" : null,
    decimalString(previous.costPrice, 2) !== next.costPrice ? "costPrice" : null,
    previous.taxRateId !== next.taxRateId ? "taxRate" : null,
    previous.stockTracked !== next.stockTracked ? "stockTracked" : null,
    decimalString(previous.stockCurrent, 3) !== next.stockCurrent ? "stockCurrent" : null,
    decimalString(previous.stockMinimum, 3) !== next.stockMinimum ? "stockMinimum" : null
  ].filter((field): field is string => Boolean(field));
}

function decimalString(value: Prisma.Decimal, decimals: number): string {
  return value.toFixed(decimals);
}

function catalogItemNameAlreadyUsed(): CatalogItemNameAlreadyUsedResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CATALOG_ITEM_NAME_ALREADY_USED",
      message: "Ya existe un elemento de catalogo con ese nombre."
    }
  };
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

function catalogTaxRateNotFound(): CatalogTaxRateNotFoundResult {
  return {
    ok: false,
    status: 422,
    error: {
      code: "CATALOG_TAX_RATE_NOT_FOUND",
      message: "El tipo de IVA seleccionado no existe o no esta activo."
    }
  };
}

function catalogCategoryNotFound(): CatalogCategoryNotFoundResult {
  return {
    ok: false,
    status: 422,
    error: {
      code: "CATALOG_CATEGORY_NOT_FOUND",
      message: "La categoria seleccionada no existe o no esta activa."
    }
  };
}

function isUniqueConstraintError(error: unknown, field: string): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }

  const target = error.meta?.target;

  if (Array.isArray(target)) {
    return target.includes(field);
  }

  return (
    typeof target === "string" &&
    target.toLocaleLowerCase("es-ES").includes(field.toLocaleLowerCase("es-ES"))
  );
}
