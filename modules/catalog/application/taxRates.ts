import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type {
  RequestContext,
  SessionUser
} from "@/modules/platform/application/auth";

export const defaultCatalogTaxRates = [
  {
    code: "IVA_21",
    name: "IVA general 21%",
    rate: "21.00",
    isDefault: true
  },
  {
    code: "IVA_10",
    name: "IVA reducido 10%",
    rate: "10.00",
    isDefault: false
  },
  {
    code: "IVA_4",
    name: "IVA superreducido 4%",
    rate: "4.00",
    isDefault: false
  },
  {
    code: "IVA_0",
    name: "IVA 0%",
    rate: "0.00",
    isDefault: false
  },
  {
    code: "EXEMPT",
    name: "Exento 0%",
    rate: "0.00",
    isDefault: false
  }
] as const;

export type CatalogTaxRateListItem = {
  id: string;
  code: string;
  name: string;
  rate: string;
  status: "ACTIVE" | "INACTIVE";
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

const catalogTaxRateCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[A-Za-z0-9_]+$/, "El codigo solo admite letras, numeros y guion bajo.")
  .transform((value) => value.toLocaleUpperCase("es-ES"));
const taxRateSchema = z
  .string()
  .trim()
  .regex(/^\d{1,2}(\.\d{1,2})?$|^100(\.0{1,2})?$/, "El IVA debe estar entre 0 y 100.");

export const listCatalogTaxRatesSchema = z.object({
  includeInactive: z.coerce.boolean().default(false)
});
export const createCatalogTaxRateSchema = z.object({
  code: catalogTaxRateCodeSchema,
  name: z.string().trim().min(2).max(120),
  rate: taxRateSchema,
  isDefault: z.boolean().default(false)
}).strict();
export const updateCatalogTaxRateStatusSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("deactivate")
  }).strict(),
  z.object({
    action: z.literal("reactivate")
  }).strict(),
  z.object({
    action: z.literal("setDefault")
  }).strict()
]);

export type ListCatalogTaxRatesCommand = z.infer<typeof listCatalogTaxRatesSchema>;
export type CreateCatalogTaxRateCommand = z.infer<typeof createCatalogTaxRateSchema>;
export type UpdateCatalogTaxRateStatusCommand = z.infer<
  typeof updateCatalogTaxRateStatusSchema
>;

type CatalogTaxRateCodeAlreadyUsedResult = {
  ok: false;
  status: 409;
  error: {
    code: "CATALOG_TAX_RATE_CODE_ALREADY_USED";
    message: string;
  };
};

type CatalogTaxRateNotFoundResult = {
  ok: false;
  status: 404;
  error: {
    code: "CATALOG_TAX_RATE_NOT_FOUND";
    message: string;
  };
};

type CatalogTaxRateStatusAlreadySetResult = {
  ok: false;
  status: 409;
  error: {
    code: "CATALOG_TAX_RATE_STATUS_ALREADY_SET";
    message: string;
  };
};

type CatalogTaxRateDefaultCannotBeInactiveResult = {
  ok: false;
  status: 409;
  error: {
    code: "CATALOG_TAX_RATE_DEFAULT_CANNOT_BE_INACTIVE";
    message: string;
  };
};

export type CreateCatalogTaxRateResult =
  | { ok: true; status: 201; value: CatalogTaxRateListItem }
  | CatalogTaxRateCodeAlreadyUsedResult;

export type UpdateCatalogTaxRateStatusResult =
  | { ok: true; status: 200; value: CatalogTaxRateListItem }
  | CatalogTaxRateNotFoundResult
  | CatalogTaxRateStatusAlreadySetResult
  | CatalogTaxRateDefaultCannotBeInactiveResult;

export async function seedDefaultCatalogTaxRates(
  tx: Prisma.TransactionClient
): Promise<void> {
  for (const taxRate of defaultCatalogTaxRates) {
    await tx.catalogTaxRate.upsert({
      where: { code: taxRate.code },
      update: {
        name: taxRate.name,
        rate: taxRate.rate,
        status: "ACTIVE",
        isDefault: taxRate.isDefault
      },
      create: {
        code: taxRate.code,
        name: taxRate.name,
        rate: taxRate.rate,
        status: "ACTIVE",
        isDefault: taxRate.isDefault
      }
    });
  }
}

export async function listCatalogTaxRates(
  command: ListCatalogTaxRatesCommand = { includeInactive: false }
): Promise<CatalogTaxRateListItem[]> {
  const taxRates = await prisma.catalogTaxRate.findMany({
    where: command.includeInactive ? {} : { status: "ACTIVE" },
    orderBy: [{ isDefault: "desc" }, { rate: "desc" }, { name: "asc" }],
    select: {
      id: true,
      code: true,
      name: true,
      rate: true,
      status: true,
      isDefault: true,
      createdAt: true,
      updatedAt: true
    }
  });

  return taxRates.map(mapCatalogTaxRateListItem);
}

export async function createCatalogTaxRate(
  command: CreateCatalogTaxRateCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CreateCatalogTaxRateResult> {
  const normalized = normalizeCatalogTaxRateCommand(command);

  try {
    const taxRate = await prisma.$transaction(async (tx) => {
      if (normalized.isDefault) {
        await tx.catalogTaxRate.updateMany({
          where: { isDefault: true },
          data: { isDefault: false }
        });
      }

      const created = await tx.catalogTaxRate.create({
        data: {
          code: normalized.code,
          name: normalized.name,
          rate: normalized.rate,
          status: "ACTIVE",
          isDefault: normalized.isDefault
        },
        select: catalogTaxRateSelect
      });

      await tx.auditEvent.create({
        data: {
          eventType: "CATALOG_TAX_RATE_CREATED",
          actorType: "USER",
          payload: {
            actorUserId: actor.id,
            taxRateId: created.id,
            taxRateCode: created.code,
            rate: decimalString(created.rate),
            isDefault: created.isDefault,
            ...(context.correlationId ? { correlationId: context.correlationId } : {})
          }
        }
      });

      return created;
    });

    return {
      ok: true,
      status: 201,
      value: mapCatalogTaxRateListItem(taxRate)
    };
  } catch (error) {
    if (isUniqueConstraintError(error, "code")) {
      return catalogTaxRateCodeAlreadyUsed();
    }

    throw error;
  }
}

export async function updateCatalogTaxRateStatus(
  taxRateId: string,
  command: UpdateCatalogTaxRateStatusCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<UpdateCatalogTaxRateStatusResult> {
  const result = await prisma.$transaction(async (tx) => {
    const existingTaxRate = await tx.catalogTaxRate.findUnique({
      where: { id: taxRateId },
      select: {
        id: true,
        code: true,
        status: true,
        isDefault: true
      }
    });

    if (!existingTaxRate) {
      return { kind: "not-found" as const };
    }

    if (command.action === "setDefault") {
      if (existingTaxRate.status !== "ACTIVE") {
        return { kind: "default-inactive" as const };
      }

      await tx.catalogTaxRate.updateMany({
        where: { isDefault: true },
        data: { isDefault: false }
      });

      const item = await tx.catalogTaxRate.update({
        where: { id: taxRateId },
        data: { isDefault: true },
        select: catalogTaxRateSelect
      });

      await tx.auditEvent.create({
        data: {
          eventType: "CATALOG_TAX_RATE_DEFAULT_SET",
          actorType: "USER",
          payload: {
            actorUserId: actor.id,
            taxRateId,
            taxRateCode: existingTaxRate.code,
            ...(context.correlationId ? { correlationId: context.correlationId } : {})
          }
        }
      });

      return { kind: "updated" as const, item };
    }

    const nextStatus = command.action === "deactivate" ? "INACTIVE" : "ACTIVE";

    if (existingTaxRate.status === nextStatus) {
      return { kind: "already-set" as const };
    }

    if (nextStatus === "INACTIVE" && existingTaxRate.isDefault) {
      return { kind: "default-inactive" as const };
    }

    const item = await tx.catalogTaxRate.update({
      where: { id: taxRateId },
      data: { status: nextStatus },
      select: catalogTaxRateSelect
    });

    await tx.auditEvent.create({
      data: {
        eventType:
          command.action === "deactivate"
            ? "CATALOG_TAX_RATE_DEACTIVATED"
            : "CATALOG_TAX_RATE_REACTIVATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          taxRateId,
          taxRateCode: existingTaxRate.code,
          previousStatus: existingTaxRate.status,
          newStatus: nextStatus,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { kind: "updated" as const, item };
  });

  if (result.kind === "not-found") {
    return catalogTaxRateNotFound();
  }

  if (result.kind === "already-set") {
    return catalogTaxRateStatusAlreadySet();
  }

  if (result.kind === "default-inactive") {
    return catalogTaxRateDefaultCannotBeInactive();
  }

  return {
    ok: true,
    status: 200,
    value: mapCatalogTaxRateListItem(result.item)
  };
}

const catalogTaxRateSelect = {
  id: true,
  code: true,
  name: true,
  rate: true,
  status: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.CatalogTaxRateSelect;

function normalizeCatalogTaxRateCommand(command: CreateCatalogTaxRateCommand) {
  return {
    code: command.code.trim().toLocaleUpperCase("es-ES"),
    name: command.name.trim(),
    rate: command.rate.trim(),
    isDefault: command.isDefault
  };
}

function mapCatalogTaxRateListItem(taxRate: {
  id: string;
  code: string;
  name: string;
  rate: Prisma.Decimal;
  status: "ACTIVE" | "INACTIVE";
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}): CatalogTaxRateListItem {
  return {
    id: taxRate.id,
    code: taxRate.code,
    name: taxRate.name,
    rate: decimalString(taxRate.rate),
    status: taxRate.status,
    isDefault: taxRate.isDefault,
    createdAt: taxRate.createdAt.toISOString(),
    updatedAt: taxRate.updatedAt.toISOString()
  };
}

function decimalString(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

function catalogTaxRateCodeAlreadyUsed(): CatalogTaxRateCodeAlreadyUsedResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CATALOG_TAX_RATE_CODE_ALREADY_USED",
      message: "Ya existe un tipo de IVA con ese codigo."
    }
  };
}

function catalogTaxRateNotFound(): CatalogTaxRateNotFoundResult {
  return {
    ok: false,
    status: 404,
    error: {
      code: "CATALOG_TAX_RATE_NOT_FOUND",
      message: "El tipo de IVA no existe."
    }
  };
}

function catalogTaxRateStatusAlreadySet(): CatalogTaxRateStatusAlreadySetResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CATALOG_TAX_RATE_STATUS_ALREADY_SET",
      message: "El tipo de IVA ya esta en ese estado."
    }
  };
}

function catalogTaxRateDefaultCannotBeInactive(): CatalogTaxRateDefaultCannotBeInactiveResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CATALOG_TAX_RATE_DEFAULT_CANNOT_BE_INACTIVE",
      message: "El tipo de IVA por defecto debe estar activo."
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
