import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type {
  RequestContext,
  SessionUser
} from "@/modules/platform/application/auth";

export const listCatalogCategoriesSchema = z.object({
  includeInactive: z.coerce.boolean().default(false)
});
export const createCatalogCategorySchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().min(1).max(500).nullable()
}).strict();
export const updateCatalogCategoryStatusSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("deactivate")
  }).strict(),
  z.object({
    action: z.literal("reactivate")
  }).strict()
]);

export type ListCatalogCategoriesCommand = z.infer<typeof listCatalogCategoriesSchema>;
export type CreateCatalogCategoryCommand = z.infer<typeof createCatalogCategorySchema>;
export type UpdateCatalogCategoryStatusCommand = z.infer<
  typeof updateCatalogCategoryStatusSchema
>;

export type CatalogCategoryListItem = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: "ACTIVE" | "INACTIVE";
  createdAt: string;
  updatedAt: string;
};

type CatalogCategoryNameAlreadyUsedResult = {
  ok: false;
  status: 409;
  error: {
    code: "CATALOG_CATEGORY_NAME_ALREADY_USED";
    message: string;
  };
};

type CatalogCategoryNotFoundResult = {
  ok: false;
  status: 404;
  error: {
    code: "CATALOG_CATEGORY_NOT_FOUND";
    message: string;
  };
};

type CatalogCategoryStatusAlreadySetResult = {
  ok: false;
  status: 409;
  error: {
    code: "CATALOG_CATEGORY_STATUS_ALREADY_SET";
    message: string;
  };
};

export type CreateCatalogCategoryResult =
  | { ok: true; status: 201; value: CatalogCategoryListItem }
  | CatalogCategoryNameAlreadyUsedResult;

export type UpdateCatalogCategoryStatusResult =
  | { ok: true; status: 200; value: CatalogCategoryListItem }
  | CatalogCategoryNotFoundResult
  | CatalogCategoryStatusAlreadySetResult;

export async function listCatalogCategories(
  command: ListCatalogCategoriesCommand = { includeInactive: false }
): Promise<CatalogCategoryListItem[]> {
  const categories = await prisma.catalogCategory.findMany({
    where: command.includeInactive ? {} : { status: "ACTIVE" },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: catalogCategorySelect
  });

  return categories.map(mapCatalogCategoryListItem);
}

export async function createCatalogCategory(
  command: CreateCatalogCategoryCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CreateCatalogCategoryResult> {
  const normalized = normalizeCatalogCategoryCommand(command);

  try {
    const category = await prisma.$transaction(async (tx) => {
      const code = await nextCatalogCategoryCode(tx);
      const created = await tx.catalogCategory.create({
        data: {
          ...normalized,
          code,
          status: "ACTIVE"
        },
        select: catalogCategorySelect
      });

      await tx.auditEvent.create({
        data: {
          eventType: "CATALOG_CATEGORY_CREATED",
          actorType: "USER",
          payload: {
            actorUserId: actor.id,
            categoryId: created.id,
            categoryCode: created.code,
            ...(context.correlationId ? { correlationId: context.correlationId } : {})
          }
        }
      });

      return created;
    });

    return {
      ok: true,
      status: 201,
      value: mapCatalogCategoryListItem(category)
    };
  } catch (error) {
    if (isUniqueConstraintError(error, "name")) {
      return catalogCategoryNameAlreadyUsed();
    }

    throw error;
  }
}

export async function updateCatalogCategoryStatus(
  categoryId: string,
  command: UpdateCatalogCategoryStatusCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<UpdateCatalogCategoryStatusResult> {
  const nextStatus = command.action === "deactivate" ? "INACTIVE" : "ACTIVE";
  const eventType =
    command.action === "deactivate"
      ? "CATALOG_CATEGORY_DEACTIVATED"
      : "CATALOG_CATEGORY_REACTIVATED";

  const result = await prisma.$transaction(async (tx) => {
    const existingCategory = await tx.catalogCategory.findUnique({
      where: { id: categoryId },
      select: {
        id: true,
        code: true,
        status: true
      }
    });

    if (!existingCategory) {
      return { kind: "not-found" as const };
    }

    if (existingCategory.status === nextStatus) {
      return { kind: "already-set" as const };
    }

    const category = await tx.catalogCategory.update({
      where: { id: categoryId },
      data: { status: nextStatus },
      select: catalogCategorySelect
    });

    await tx.auditEvent.create({
      data: {
        eventType,
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          categoryId,
          categoryCode: existingCategory.code,
          previousStatus: existingCategory.status,
          newStatus: nextStatus,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { kind: "updated" as const, category };
  });

  if (result.kind === "not-found") {
    return catalogCategoryNotFound();
  }

  if (result.kind === "already-set") {
    return catalogCategoryStatusAlreadySet();
  }

  return {
    ok: true,
    status: 200,
    value: mapCatalogCategoryListItem(result.category)
  };
}

async function nextCatalogCategoryCode(
  tx: Prisma.TransactionClient
): Promise<string> {
  const result = await tx.$queryRaw<Array<{ value: bigint }>>`
    SELECT nextval('catalog_category_code_seq') AS value
  `;
  const value = result[0]?.value;

  if (value === undefined) {
    throw new Error("CATALOG_CATEGORY_CODE_SEQUENCE_UNAVAILABLE");
  }

  return value.toString();
}

const catalogCategorySelect = {
  id: true,
  code: true,
  name: true,
  description: true,
  status: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.CatalogCategorySelect;

function normalizeCatalogCategoryCommand(command: CreateCatalogCategoryCommand) {
  return {
    name: command.name.trim(),
    description: command.description
  };
}

function mapCatalogCategoryListItem(category: {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: "ACTIVE" | "INACTIVE";
  createdAt: Date;
  updatedAt: Date;
}): CatalogCategoryListItem {
  return {
    id: category.id,
    code: category.code,
    name: category.name,
    description: category.description,
    status: category.status,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString()
  };
}

function catalogCategoryNameAlreadyUsed(): CatalogCategoryNameAlreadyUsedResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CATALOG_CATEGORY_NAME_ALREADY_USED",
      message: "Ya existe una categoria de catalogo con ese nombre."
    }
  };
}

function catalogCategoryNotFound(): CatalogCategoryNotFoundResult {
  return {
    ok: false,
    status: 404,
    error: {
      code: "CATALOG_CATEGORY_NOT_FOUND",
      message: "La categoria de catalogo no existe."
    }
  };
}

function catalogCategoryStatusAlreadySet(): CatalogCategoryStatusAlreadySetResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CATALOG_CATEGORY_STATUS_ALREADY_SET",
      message: "La categoria ya esta en ese estado."
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
