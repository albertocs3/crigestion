import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { calculateInvoiceLine } from "@/modules/billing/application/calculations";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { hashIdempotencyPayload } from "@/modules/platform/application/http";

const defaultLimit = 25;
const maxLimit = 100;
const allowedCatalogKinds = ["SERVICE", "SOFTWARE", "LICENSE"] as const;

const dateOnlySchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidDateOnly, {
  message: "La fecha no es valida."
}).refine((value) => {
  const year = Number(value.slice(0, 4));
  return year >= 2000 && year <= 9999;
}, {
  message: "El ano debe estar entre 2000 y 9999."
});
const quantitySchema = z.string().trim().regex(/^\d{1,9}(\.\d{1,3})?$/).refine(
  (value) => new Prisma.Decimal(value).gt(0),
  "La cantidad debe ser mayor que cero."
);
const moneySchema = z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/);
const percentSchema = z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/).refine(
  (value) => new Prisma.Decimal(value).lte(100),
  "El porcentaje no puede superar 100."
);

export const listSubscriptionsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  cursor: z.string().uuid().optional(),
  status: z.enum(["DRAFT", "ACTIVE", "RENEWAL_PENDING", "CANCELLED"]).optional(),
  periodicity: z.enum(["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"]).optional(),
  pricingMode: z.enum(["FIXED", "PER_LICENSE"]).optional(),
  customerId: z.string().uuid().optional(),
  search: z.string().trim().min(1).max(120).optional()
});

export const createSubscriptionSchema = z.object({
  customerId: z.string().uuid(),
  name: z.string().trim().min(2).max(200),
  periodicity: z.enum(["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"]),
  pricingMode: z.enum(["FIXED", "PER_LICENSE"]),
  startDate: dateOnlySchema,
  endDate: dateOnlySchema.nullable().default(null),
  notes: z.string().trim().min(1).max(1000).nullable().default(null),
  lines: z.array(z.object({
    catalogItemId: z.string().uuid(),
    quantity: quantitySchema.default("1.000"),
    unitPrice: moneySchema.optional(),
    discountPercent: percentSchema.default("0.00"),
    discountAmount: moneySchema.default("0.00")
  }).strict()).min(1).max(50)
}).strict().superRefine((value, context) => {
  if (value.endDate && value.endDate < value.startDate) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endDate"], message: "La fecha final no puede ser anterior al inicio." });
  }
  if (value.pricingMode === "FIXED" && value.lines.some((line) => !new Prisma.Decimal(line.quantity).equals(1))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: "Las suscripciones de importe fijo usan cantidad 1." });
  }
  if (new Set(value.lines.map((line) => line.catalogItemId)).size !== value.lines.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: "No se puede repetir un concepto de catalogo." });
  }
});

export const activateSubscriptionSchema = z.object({ version: z.number().int().positive() }).strict();
export const updateSubscriptionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  customerId: z.string().uuid(),
  name: z.string().trim().min(2).max(200),
  periodicity: z.enum(["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"]),
  pricingMode: z.enum(["FIXED", "PER_LICENSE"]),
  startDate: dateOnlySchema,
  endDate: dateOnlySchema.nullable(),
  notes: z.string().trim().min(1).max(1000).nullable(),
  lines: z.array(z.object({
    catalogItemId: z.string().uuid(),
    quantity: quantitySchema,
    unitPrice: moneySchema.optional(),
    discountPercent: percentSchema.optional(),
    discountAmount: moneySchema.optional()
  }).strict()).min(1).max(50)
}).strict().superRefine((value, context) => {
  if (value.endDate && value.endDate < value.startDate) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endDate"], message: "La fecha final no puede ser anterior al inicio." });
  }
  if (value.pricingMode === "FIXED" && value.lines.some((line) => !new Prisma.Decimal(line.quantity).equals(1))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: "Las suscripciones de importe fijo usan cantidad 1." });
  }
  if (new Set(value.lines.map((line) => line.catalogItemId)).size !== value.lines.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: "No se puede repetir un concepto de catalogo." });
  }
});
export const cancelSubscriptionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500)
}).strict();
export const scheduleSubscriptionCancellationSchema = z.object({
  expectedVersion: z.number().int().positive(),
  effectiveDate: dateOnlySchema,
  reason: z.string().trim().min(3).max(500)
}).strict();
export const cancelScheduledSubscriptionCancellationSchema = z.object({
  expectedSubscriptionVersion: z.number().int().positive(),
  expectedScheduleVersion: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500)
}).strict();
export const subscriptionParamsSchema = z.object({ subscriptionId: z.string().uuid() });
export const cancellationScheduleParamsSchema = z.object({ subscriptionId: z.string().uuid(), scheduleId: z.string().uuid() });

export type ListSubscriptionsCommand = z.infer<typeof listSubscriptionsSchema>;
export type CreateSubscriptionCommand = z.infer<typeof createSubscriptionSchema>;
export type ActivateSubscriptionCommand = z.infer<typeof activateSubscriptionSchema>;
export type UpdateSubscriptionCommand = z.infer<typeof updateSubscriptionSchema>;
export type CancelSubscriptionCommand = z.infer<typeof cancelSubscriptionSchema>;
export type ScheduleSubscriptionCancellationCommand = z.infer<typeof scheduleSubscriptionCancellationSchema>;
export type CancelScheduledSubscriptionCancellationCommand = z.infer<typeof cancelScheduledSubscriptionCancellationSchema>;

type MutationContext = Pick<RequestContext, "correlationId"> & {
  idempotencyKey: string;
  requestHash: string;
};

export type SubscriptionDto = {
  id: string;
  number: string;
  name: string;
  status: "DRAFT" | "ACTIVE" | "RENEWAL_PENDING" | "CANCELLED";
  periodicity: "MONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "ANNUAL";
  pricingMode: "FIXED" | "PER_LICENSE";
  paymentMethod: "BANK_TRANSFER" | "CASH" | "DIRECT_DEBIT";
  startDate: string;
  nextRenewalDate: string;
  endDate: string | null;
  notes: string | null;
  version: number;
  customer: { id: string; code: string; legalName: string };
  lines: Array<{
    id: string;
    position: number;
    catalogItemId: string;
    catalogItemCode: string;
    catalogItemKind: "SERVICE" | "SOFTWARE" | "LICENSE";
    description: string;
    quantity: string;
    unitPrice: string;
    discountPercent: string;
    discountAmount: string;
    taxRateCode: string;
    taxRate: string;
    total: string;
  }>;
  estimatedTotal: string;
  activatedAt: string | null;
  cancellation: { effectiveDate: string; reason: string; cancelledAt: string; mode: "IMMEDIATE" | "SCHEDULED" } | null;
  cancellationSchedules: SubscriptionCancellationScheduleDto[];
  createdAt: string;
  updatedAt: string;
};

export type SubscriptionCancellationScheduleDto = {
  id: string;
  status: "PENDING" | "REVOKED" | "APPLIED";
  effectiveDate: string;
  reason: string;
  version: number;
  requestedAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
  appliedAt: string | null;
  appliedBusinessDate: string | null;
  appliedAgainstVersion: number | null;
  appliedSubscriptionVersion: number | null;
};

export type SubscriptionCancellationScheduleMutationDto = {
  subscriptionVersion: number;
  schedule: SubscriptionCancellationScheduleDto;
};

export type ResolveScheduledCancellationBeforeRenewalCommand = {
  companyId: string;
  subscriptionId: string;
  asOfDate?: string;
  initiatedByUserId?: string;
  correlationId?: string;
};

export type ScheduledCancellationResolution =
  | { outcome: "NOT_FOUND" }
  | { outcome: "NOT_RENEWABLE"; status: "DRAFT" }
  | { outcome: "NOT_DUE"; renewalDate: string }
  | { outcome: "NO_DUE_CANCELLATION"; subscriptionVersion: number; renewalDate: string }
  | { outcome: "CANCELLED"; scheduleId: string | null; subscriptionVersion: number; applied: boolean };

export type SubscriptionList = {
  subscriptions: Array<Omit<SubscriptionDto, "notes" | "lines" | "cancellation" | "cancellationSchedules"> & { lineCount: number }>;
  nextCursor: string | null;
};

export type SubscriptionReferences = {
  customers: Array<{ id: string; code: string; legalName: string }>;
  catalogItems: Array<{ id: string; code: string; name: string; kind: "SERVICE" | "SOFTWARE" | "LICENSE"; salePrice: string }>;
};

type SubscriptionFailure = {
  ok: false;
  status: 403 | 404 | 409 | 422;
  error: { code: string; message: string };
};

type SubscriptionResult<T> = { ok: true; status: 200 | 201; value: T } | SubscriptionFailure;

export function hashSubscriptionRequest(command: unknown): string {
  return hashIdempotencyPayload("subscription:v1", command);
}

export async function listSubscriptions(
  command: ListSubscriptionsCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<SubscriptionList> {
  const companyId = await currentCompanyId(prisma);
  if (!companyId) return { subscriptions: [], nextCursor: null };
  const rows = await prisma.subscription.findMany({
    where: {
      companyId,
      ...(command.status ? { status: command.status } : {}),
      ...(command.periodicity ? { periodicity: command.periodicity } : {}),
      ...(command.pricingMode ? { pricingMode: command.pricingMode } : {}),
      ...(command.customerId ? { customerId: command.customerId } : {}),
      ...(command.search ? {
        OR: [
          { number: { contains: command.search, mode: "insensitive" as const } },
          { name: { contains: command.search, mode: "insensitive" as const } },
          { customer: { legalName: { contains: command.search, mode: "insensitive" as const } } }
        ]
      } : {})
    },
    // The cursor is the unique id, so ordering by the same field keeps pages
    // stable even when several subscriptions share the same creation instant.
    orderBy: { id: "desc" },
    take: command.limit + 1,
    ...(command.cursor ? { cursor: { id: command.cursor }, skip: 1 } : {}),
    select: subscriptionSelect
  });
  const hasNext = rows.length > command.limit;
  const page = hasNext ? rows.slice(0, command.limit) : rows;
  await prisma.auditEvent.create({
    data: {
      eventType: "SUBSCRIPTIONS_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        companyId,
        resultCount: page.length,
        hasSearch: Boolean(command.search),
        status: command.status ?? null,
        periodicity: command.periodicity ?? null,
        pricingMode: command.pricingMode ?? null,
        customerId: command.customerId ?? null,
        ...(context.correlationId ? { correlationId: context.correlationId } : {})
      }
    }
  });

  return {
    subscriptions: page.map((row) => {
      const detail = mapSubscription(row);
      const { lines, ...detailWithoutLines } = detail;
      const { notes, cancellation, cancellationSchedules, ...summary } = detailWithoutLines;
      void notes; void cancellation; void cancellationSchedules;
      return { ...summary, lineCount: lines.length };
    }),
    nextCursor: hasNext ? page.at(-1)?.id ?? null : null
  };
}

export async function listSubscriptionReferences(): Promise<SubscriptionReferences> {
  const [customers, catalogItems] = await Promise.all([
    prisma.customer.findMany({
      where: { status: "ACTIVE" }, orderBy: [{ legalName: "asc" }, { id: "asc" }], take: 500,
      select: { id: true, code: true, legalName: true }
    }),
    prisma.catalogItem.findMany({
      where: { status: "ACTIVE", kind: { in: [...allowedCatalogKinds] } },
      orderBy: [{ name: "asc" }, { id: "asc" }], take: 500,
      select: { id: true, code: true, name: true, kind: true, salePrice: true }
    })
  ]);
  return {
    customers,
    catalogItems: catalogItems.map((item) => ({ ...item, kind: item.kind as SubscriptionReferences["catalogItems"][number]["kind"], salePrice: item.salePrice.toFixed(2) }))
  };
}

export async function getSubscription(
  subscriptionId: string,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<SubscriptionDto | null> {
  const companyId = await currentCompanyId(prisma);
  if (!companyId) return null;
  const row = await prisma.subscription.findFirst({ where: { id: subscriptionId, companyId }, select: subscriptionSelect });
  if (!row) return null;
  await prisma.auditEvent.create({
    data: {
      eventType: "SUBSCRIPTION_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        companyId,
        subscriptionId: row.id,
        number: row.number,
        ...(context.correlationId ? { correlationId: context.correlationId } : {})
      }
    }
  });
  return mapSubscription(row);
}

export async function createSubscription(
  command: CreateSubscriptionCommand,
  actor: SessionUser,
  context: MutationContext
): Promise<SubscriptionResult<SubscriptionDto>> {
  const economicsRequested = command.lines.some((line) =>
    line.unitPrice !== undefined || !new Prisma.Decimal(line.discountPercent).isZero() || !new Prisma.Decimal(line.discountAmount).isZero()
  );
  if (economicsRequested && !actor.permissions.includes("Subscriptions.ManageEconomics")) {
    const companyId = await currentCompanyId(prisma);
    await prisma.auditEvent.create({
      data: {
        eventType: "ACCESS_DENIED",
        actorType: "USER",
        payload: {
          userId: actor.id,
          permission: "Subscriptions.ManageEconomics",
          ...(companyId ? { companyId } : {}),
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });
    return failure(403, "SUBSCRIPTION_ECONOMICS_PERMISSION_REQUIRED", "No dispone de permiso para modificar precios o descuentos.");
  }

  return executeMutation(actor, context, async (tx) => {
    const replay = await replayMutation<SubscriptionDto>(tx, context);
    if (replay) return replay;

    const installation = await tx.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } });
    if (!installation?.companyId) return failure(409, "PLATFORM_NOT_INITIALIZED", "La plataforma no esta inicializada.");

    const customer = await tx.customer.findUnique({
      where: { id: command.customerId },
      select: { id: true, status: true, defaultPaymentMethod: true }
    });
    if (!customer) return failure(404, "CUSTOMER_NOT_FOUND", "El cliente no existe.");
    if (customer.status !== "ACTIVE") return failure(422, "CUSTOMER_NOT_ACTIVE", "El cliente debe estar activo.");

    const catalogItems = await tx.catalogItem.findMany({
      where: { id: { in: command.lines.map((line) => line.catalogItemId) } },
      select: {
        id: true, code: true, kind: true, status: true, name: true, salePrice: true,
        taxRateId: true, taxRateDefinition: { select: { code: true, name: true, rate: true, status: true } }
      }
    });
    const catalogById = new Map(catalogItems.map((item) => [item.id, item]));
    for (const line of command.lines) {
      const item = catalogById.get(line.catalogItemId);
      if (!item) return failure(422, "SUBSCRIPTION_CATALOG_ITEM_NOT_FOUND", "Uno de los conceptos no existe.");
      if (item.status !== "ACTIVE" || item.taxRateDefinition.status !== "ACTIVE") {
        return failure(422, "SUBSCRIPTION_CATALOG_ITEM_NOT_ACTIVE", "Todos los conceptos y tipos de IVA deben estar activos.");
      }
      if (!(allowedCatalogKinds as readonly string[]).includes(item.kind)) {
        return failure(422, "SUBSCRIPTION_CATALOG_ITEM_KIND_NOT_ALLOWED", "Solo se admiten servicios, software o licencias.");
      }
    }

    const startDate = parseDateOnly(command.startDate);
    const year = startDate.getUTCFullYear();
    const sequence = await nextSubscriptionNumber(tx, installation.companyId, year);
    const number = `SUS-${year}-${sequence.toString().padStart(5, "0")}`;
    const created = await tx.subscription.create({
      data: {
        companyId: installation.companyId,
        year,
        numberSequence: sequence,
        number,
        customerId: customer.id,
        name: command.name,
        periodicity: command.periodicity,
        pricingMode: command.pricingMode,
        paymentMethod: customer.defaultPaymentMethod,
        startDate,
        nextRenewalDate: startDate,
        endDate: command.endDate ? parseDateOnly(command.endDate) : null,
        notes: command.notes,
        createdById: actor.id,
        lines: {
          create: command.lines.map((line, index) => {
            const item = catalogById.get(line.catalogItemId)!;
            return {
              position: index + 1,
              catalogItemId: item.id,
              catalogItemCodeSnapshot: item.code,
              catalogItemKindSnapshot: item.kind,
              description: item.name,
              quantity: line.quantity,
              unitPrice: line.unitPrice ?? item.salePrice,
              discountPercent: line.discountPercent,
              discountAmount: line.discountAmount,
              taxRateId: item.taxRateId,
              taxRateCodeSnapshot: item.taxRateDefinition.code,
              taxRateNameSnapshot: item.taxRateDefinition.name,
              taxRateSnapshot: item.taxRateDefinition.rate
            };
          })
        }
      },
      select: subscriptionSelect
    });
    const dto = mapSubscription(created);
    await tx.auditEvent.create({
      data: {
        eventType: "SUBSCRIPTION_CREATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id, subscriptionId: dto.id, number: dto.number,
          customerId: dto.customer.id, lineCount: dto.lines.length,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });
    await storeMutation(tx, context, 201, dto);
    return { ok: true, status: 201, value: dto };
  });
}

export async function activateSubscription(
  subscriptionId: string,
  command: ActivateSubscriptionCommand,
  actor: SessionUser,
  context: MutationContext
): Promise<SubscriptionResult<SubscriptionDto>> {
  return executeMutation(actor, context, async (tx) => {
    const replay = await replayMutation<SubscriptionDto>(tx, context);
    if (replay) return replay;
    const companyId = await currentCompanyId(tx);
    if (!companyId) return failure(404, "SUBSCRIPTION_NOT_FOUND", "La suscripcion no existe.");
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscriptionId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`);
    const existing = await tx.subscription.findFirst({
      where: { id: subscriptionId, companyId },
      select: {
        id: true,
        number: true,
        status: true,
        version: true,
        pricingMode: true,
        customer: { select: { status: true } },
        lines: { select: { catalogItemId: true, quantity: true } }
      }
    });
    if (!existing) return failure(404, "SUBSCRIPTION_NOT_FOUND", "La suscripcion no existe.");
    if (existing.version !== command.version) return failure(409, "SUBSCRIPTION_VERSION_CONFLICT", "La suscripcion ha cambiado; recargue los datos.");
    if (existing.status !== "DRAFT") return failure(409, "SUBSCRIPTION_NOT_ACTIVATABLE", "Solo se puede activar una suscripcion en borrador.");
    if (existing.customer.status !== "ACTIVE") return failure(422, "CUSTOMER_NOT_ACTIVE", "El cliente debe estar activo.");
    if (existing.lines.length === 0) return failure(422, "SUBSCRIPTION_LINES_REQUIRED", "La suscripcion necesita al menos un concepto.");
    if (new Set(existing.lines.map((line) => line.catalogItemId)).size !== existing.lines.length
      || (existing.pricingMode === "FIXED" && existing.lines.some((line) => !line.quantity.equals(1)))) {
      return failure(422, "SUBSCRIPTION_CONFIGURATION_INVALID", "La configuracion economica de la suscripcion no es valida.");
    }

    const activated = await tx.subscription.update({
      where: { id: subscriptionId },
      data: { status: "ACTIVE", version: { increment: 1 }, activatedById: actor.id, activatedAt: new Date(), updatedById: actor.id },
      select: subscriptionSelect
    });
    const dto = mapSubscription(activated);
    await tx.auditEvent.create({
      data: {
        eventType: "SUBSCRIPTION_ACTIVATED", actorType: "USER",
        payload: { actorUserId: actor.id, subscriptionId, number: existing.number, version: dto.version, ...(context.correlationId ? { correlationId: context.correlationId } : {}) }
      }
    });
    await storeMutation(tx, context, 200, dto);
    return { ok: true, status: 200, value: dto };
  });
}

export async function updateSubscription(
  subscriptionId: string,
  command: UpdateSubscriptionCommand,
  actor: SessionUser,
  context: MutationContext
): Promise<SubscriptionResult<SubscriptionDto>> {
  const economicsRequested = command.lines.some((line) =>
    line.unitPrice !== undefined || line.discountPercent !== undefined || line.discountAmount !== undefined
  );
  if (economicsRequested && !actor.permissions.includes("Subscriptions.ManageEconomics")) {
    await auditEconomicsDenied(actor, context);
    return failure(403, "SUBSCRIPTION_ECONOMICS_PERMISSION_REQUIRED", "No dispone de permiso para modificar precios o descuentos.");
  }

  return executeMutation(actor, context, async (tx) => {
    const replay = await replayMutation<SubscriptionDto>(tx, context);
    if (replay) return replay;
    const companyId = await currentCompanyId(tx);
    if (!companyId) return failure(404, "SUBSCRIPTION_NOT_FOUND", "La suscripcion no existe.");
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscriptionId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`);
    const existing = await tx.subscription.findFirst({
      where: { id: subscriptionId, companyId },
      select: {
        id: true, status: true, version: true, year: true, number: true,
        lines: { orderBy: { position: "asc" }, select: { catalogItemId: true, quantity: true, unitPrice: true, discountPercent: true, discountAmount: true } }
      }
    });
    if (!existing) return failure(404, "SUBSCRIPTION_NOT_FOUND", "La suscripcion no existe.");
    if (existing.version !== command.expectedVersion) return failure(409, "SUBSCRIPTION_VERSION_CONFLICT", "La suscripcion ha cambiado; recargue los datos.");
    if (existing.status !== "DRAFT") return failure(409, "SUBSCRIPTION_NOT_EDITABLE", "Solo se puede editar una suscripcion en borrador.");
    const startDate = parseDateOnly(command.startDate);
    if (startDate.getUTCFullYear() !== existing.year) return failure(422, "SUBSCRIPTION_START_YEAR_IMMUTABLE", "La fecha de inicio debe permanecer en el ano de numeracion del borrador.");
    const linesChanged = command.lines.length !== existing.lines.length || command.lines.some((line, index) => {
      const prior = existing.lines[index];
      return !prior || prior.catalogItemId !== line.catalogItemId || !prior.quantity.equals(line.quantity)
        || line.unitPrice !== undefined || line.discountPercent !== undefined || line.discountAmount !== undefined;
    });
    if (linesChanged && !actor.permissions.includes("Subscriptions.ManageEconomics")) {
      await tx.auditEvent.create({
        data: {
          eventType: "ACCESS_DENIED", actorType: "USER",
          payload: { userId: actor.id, permission: "Subscriptions.ManageEconomics", companyId, ...(context.correlationId ? { correlationId: context.correlationId } : {}) }
        }
      });
      return failure(403, "SUBSCRIPTION_ECONOMICS_PERMISSION_REQUIRED", "No dispone de permiso para modificar conceptos, cantidades, precios o descuentos.");
    }

    const customer = await tx.customer.findUnique({ where: { id: command.customerId }, select: { id: true, status: true, defaultPaymentMethod: true } });
    if (!customer) return failure(404, "CUSTOMER_NOT_FOUND", "El cliente no existe.");
    if (customer.status !== "ACTIVE") return failure(422, "CUSTOMER_NOT_ACTIVE", "El cliente debe estar activo.");
    const catalogItems = linesChanged ? await tx.catalogItem.findMany({
      where: { id: { in: command.lines.map((line) => line.catalogItemId) } },
      select: {
        id: true, code: true, kind: true, status: true, name: true, salePrice: true, taxRateId: true,
        taxRateDefinition: { select: { code: true, name: true, rate: true, status: true } }
      }
    }) : [];
    const catalogById = new Map(catalogItems.map((item) => [item.id, item]));
    if (linesChanged) {
      for (const line of command.lines) {
        const item = catalogById.get(line.catalogItemId);
        if (!item) return failure(422, "SUBSCRIPTION_CATALOG_ITEM_NOT_FOUND", "Uno de los conceptos no existe.");
        if (item.status !== "ACTIVE" || item.taxRateDefinition.status !== "ACTIVE") return failure(422, "SUBSCRIPTION_CATALOG_ITEM_NOT_ACTIVE", "Todos los conceptos y tipos de IVA deben estar activos.");
        if (!(allowedCatalogKinds as readonly string[]).includes(item.kind)) return failure(422, "SUBSCRIPTION_CATALOG_ITEM_KIND_NOT_ALLOWED", "Solo se admiten servicios, software o licencias.");
      }
    }

    const priorEconomics = new Map(existing.lines.map((line) => [line.catalogItemId, line]));
    if (linesChanged) await tx.subscriptionLine.deleteMany({ where: { subscriptionId } });
    const updated = await tx.subscription.update({
      where: { id: subscriptionId },
      data: {
        customerId: customer.id,
        name: command.name,
        periodicity: command.periodicity,
        pricingMode: command.pricingMode,
        paymentMethod: customer.defaultPaymentMethod,
        startDate,
        nextRenewalDate: startDate,
        endDate: command.endDate ? parseDateOnly(command.endDate) : null,
        notes: command.notes,
        version: { increment: 1 },
        updatedById: actor.id,
        ...(linesChanged ? { lines: {
          create: command.lines.map((line, index) => {
            const item = catalogById.get(line.catalogItemId)!;
            const prior = priorEconomics.get(line.catalogItemId);
            return {
              position: index + 1,
              catalogItemId: item.id,
              catalogItemCodeSnapshot: item.code,
              catalogItemKindSnapshot: item.kind,
              description: item.name,
              quantity: line.quantity,
              unitPrice: line.unitPrice ?? prior?.unitPrice ?? item.salePrice,
              discountPercent: line.discountPercent ?? prior?.discountPercent ?? 0,
              discountAmount: line.discountAmount ?? prior?.discountAmount ?? 0,
              taxRateId: item.taxRateId,
              taxRateCodeSnapshot: item.taxRateDefinition.code,
              taxRateNameSnapshot: item.taxRateDefinition.name,
              taxRateSnapshot: item.taxRateDefinition.rate
            };
          })
        } } : {})
      },
      select: subscriptionSelect
    });
    const dto = mapSubscription(updated);
    await tx.auditEvent.create({
      data: {
        eventType: "SUBSCRIPTION_UPDATED", actorType: "USER",
        payload: {
          actorUserId: actor.id, companyId, subscriptionId, previousNumber: existing.number,
          number: dto.number, version: dto.version, lineCount: dto.lines.length,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });
    await storeMutation(tx, context, 200, dto);
    return { ok: true, status: 200, value: dto };
  });
}

export async function cancelSubscription(
  subscriptionId: string,
  command: CancelSubscriptionCommand,
  actor: SessionUser,
  context: MutationContext
): Promise<SubscriptionResult<SubscriptionDto>> {
  return executeMutation(actor, context, async (tx) => {
    const replay = await replayMutation<SubscriptionDto>(tx, context);
    if (replay) return replay;
    const companyId = await currentCompanyId(tx);
    if (!companyId) return failure(404, "SUBSCRIPTION_NOT_FOUND", "La suscripcion no existe.");
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscriptionId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`);
    const existing = await tx.subscription.findFirst({ where: { id: subscriptionId, companyId }, select: { id: true, number: true, status: true, version: true, endDate: true } });
    if (!existing) return failure(404, "SUBSCRIPTION_NOT_FOUND", "La suscripcion no existe.");
    if (existing.version !== command.expectedVersion) return failure(409, "SUBSCRIPTION_VERSION_CONFLICT", "La suscripcion ha cambiado; recargue los datos.");
    if (existing.status !== "ACTIVE" && existing.status !== "RENEWAL_PENDING") return failure(409, "SUBSCRIPTION_NOT_CANCELLABLE", "Solo se puede cancelar una suscripcion activa o pendiente de renovacion.");
    if (await tx.subscriptionRenewalReservation.count({ where: { subscriptionId, companyId, status: "RESERVED" } })) {
      return failure(409, "SUBSCRIPTION_RENEWAL_RESERVED", "La renovacion esta reservada; debe liberarse antes de cancelar la suscripcion.");
    }
    const cancelledAt = new Date();
    const effectiveDateText = todayDateOnly(cancelledAt);
    const effectiveDate = parseDateOnly(effectiveDateText);
    if (existing.endDate && effectiveDate > existing.endDate) return failure(422, "SUBSCRIPTION_CANCELLATION_AFTER_END", "La suscripcion ya tiene una fecha final anterior a la fecha de negocio.");
    const pendingSchedule = await tx.subscriptionCancellationSchedule.findFirst({ where: { subscriptionId, companyId, status: "PENDING" }, select: { id: true } });
    if (pendingSchedule) {
      await tx.subscriptionCancellationSchedule.update({
        where: { id: pendingSchedule.id },
        data: { status: "REVOKED", version: { increment: 1 }, revokedById: actor.id, revokedAt: cancelledAt, revocationReason: "Cancelacion inmediata aplicada." }
      });
    }
    const cancelled = await tx.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: "CANCELLED", version: { increment: 1 }, updatedById: actor.id,
        cancelledById: actor.id, cancelledAt, cancellationEffectiveDate: effectiveDate,
        cancellationReason: command.reason, cancellationMode: "IMMEDIATE"
      },
      select: subscriptionSelect
    });
    await resolveRenewalExclusionAsCancelled(tx, {
      companyId, subscriptionId, resolvedAt: cancelledAt, resolvedById: actor.id,
      actorType: "USER", correlationId: context.correlationId
    });
    const dto = mapSubscription(cancelled);
    await tx.auditEvent.create({
      data: {
        eventType: "SUBSCRIPTION_CANCELLED", actorType: "USER",
        payload: { actorUserId: actor.id, companyId, subscriptionId, number: existing.number, effectiveDate: effectiveDateText, version: dto.version, ...(context.correlationId ? { correlationId: context.correlationId } : {}) }
      }
    });
    if (pendingSchedule) {
      await tx.auditEvent.create({
        data: {
          eventType: "SUBSCRIPTION_CANCELLATION_SCHEDULE_REVOKED", actorType: "USER",
          payload: { actorUserId: actor.id, companyId, subscriptionId, number: existing.number, scheduleId: pendingSchedule.id, cause: "IMMEDIATE_CANCELLATION", subscriptionVersion: dto.version, ...(context.correlationId ? { correlationId: context.correlationId } : {}) }
        }
      });
    }
    await storeMutation(tx, context, 200, dto);
    return { ok: true, status: 200, value: dto };
  });
}

export async function scheduleSubscriptionCancellation(
  subscriptionId: string,
  command: ScheduleSubscriptionCancellationCommand,
  actor: SessionUser,
  context: MutationContext
): Promise<SubscriptionResult<SubscriptionCancellationScheduleMutationDto>> {
  return executeMutation(actor, context, async (tx) => {
    const replay = await replayMutation<SubscriptionCancellationScheduleMutationDto>(tx, context);
    if (replay) return replay;
    const companyId = await currentCompanyId(tx);
    if (!companyId) return failure(404, "SUBSCRIPTION_NOT_FOUND", "La suscripcion no existe.");
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscriptionId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`);
    const subscription = await tx.subscription.findFirst({
      where: { id: subscriptionId, companyId },
      select: { id: true, number: true, status: true, version: true, endDate: true, nextRenewalDate: true }
    });
    if (!subscription) return failure(404, "SUBSCRIPTION_NOT_FOUND", "La suscripcion no existe.");
    if (subscription.version !== command.expectedVersion) return failure(409, "SUBSCRIPTION_VERSION_CONFLICT", "La suscripcion ha cambiado; recargue los datos.");
    if (subscription.status !== "ACTIVE" && subscription.status !== "RENEWAL_PENDING") return failure(409, "SUBSCRIPTION_CANCELLATION_NOT_SCHEDULABLE", "Solo se puede programar la baja de una suscripcion activa o pendiente de renovacion.");
    if (await tx.subscriptionRenewalReservation.count({ where: { subscriptionId, companyId, periodStart: subscription.nextRenewalDate, status: "RESERVED" } })) {
      return failure(409, "SUBSCRIPTION_RENEWAL_RESERVED", "La renovacion esta reservada; no se puede programar una baja para ese periodo.");
    }
    const now = new Date();
    const today = todayDateOnly(now);
    if (command.effectiveDate <= today) return failure(422, "SUBSCRIPTION_CANCELLATION_DATE_NOT_FUTURE", "La fecha programada debe ser posterior a la fecha de negocio actual.");
    const effectiveDate = parseDateOnly(command.effectiveDate);
    if (subscription.endDate && effectiveDate > subscription.endDate) return failure(422, "SUBSCRIPTION_CANCELLATION_AFTER_END", "La baja programada no puede ser posterior a la fecha final del contrato.");
    if (command.effectiveDate !== formatDateOnly(subscription.nextRenewalDate)) {
      return failure(422, "SUBSCRIPTION_CANCELLATION_NOT_ON_RENEWAL", "La baja programada debe coincidir con la proxima renovacion.");
    }
    if (await tx.subscriptionCancellationSchedule.count({ where: { subscriptionId, status: "PENDING" } })) {
      return failure(409, "SUBSCRIPTION_PENDING_CANCELLATION_EXISTS", "Ya existe una baja programada pendiente.");
    }
    const schedule = await tx.subscriptionCancellationSchedule.create({
      data: { companyId, subscriptionId, effectiveDate, reason: command.reason, createdAgainstVersion: subscription.version, requestedById: actor.id, requestedAt: now },
      select: cancellationScheduleSelect
    });
    await tx.subscription.update({ where: { id: subscriptionId }, data: { version: { increment: 1 }, updatedById: actor.id } });
    const dto = mapCancellationSchedule(schedule);
    const value = { subscriptionVersion: subscription.version + 1, schedule: dto };
    await tx.auditEvent.create({
      data: {
        eventType: "SUBSCRIPTION_CANCELLATION_SCHEDULED", actorType: "USER",
        payload: { actorUserId: actor.id, companyId, subscriptionId, number: subscription.number, scheduleId: dto.id, effectiveDate: dto.effectiveDate, subscriptionVersion: subscription.version + 1, ...(context.correlationId ? { correlationId: context.correlationId } : {}) }
      }
    });
    await storeMutation(tx, context, 201, value);
    return { ok: true, status: 201, value };
  });
}

export async function cancelScheduledSubscriptionCancellation(
  subscriptionId: string,
  scheduleId: string,
  command: CancelScheduledSubscriptionCancellationCommand,
  actor: SessionUser,
  context: MutationContext
): Promise<SubscriptionResult<SubscriptionCancellationScheduleMutationDto>> {
  return executeMutation(actor, context, async (tx) => {
    const replay = await replayMutation<SubscriptionCancellationScheduleMutationDto>(tx, context);
    if (replay) return replay;
    const companyId = await currentCompanyId(tx);
    if (!companyId) return failure(404, "SUBSCRIPTION_CANCELLATION_SCHEDULE_NOT_FOUND", "La baja programada no existe.");
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscriptionId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`);
    const subscription = await tx.subscription.findFirst({ where: { id: subscriptionId, companyId }, select: { id: true, number: true, status: true, version: true } });
    if (!subscription) return failure(404, "SUBSCRIPTION_CANCELLATION_SCHEDULE_NOT_FOUND", "La baja programada no existe.");
    if (subscription.version !== command.expectedSubscriptionVersion) return failure(409, "SUBSCRIPTION_VERSION_CONFLICT", "La suscripcion ha cambiado; recargue los datos.");
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscription_cancellation_schedules" WHERE "id" = ${scheduleId}::uuid AND "subscriptionId" = ${subscriptionId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`);
    const schedule = await tx.subscriptionCancellationSchedule.findFirst({ where: { id: scheduleId, subscriptionId, companyId }, select: cancellationScheduleSelect });
    if (!schedule) return failure(404, "SUBSCRIPTION_CANCELLATION_SCHEDULE_NOT_FOUND", "La baja programada no existe.");
    if (schedule.version !== command.expectedScheduleVersion) return failure(409, "SUBSCRIPTION_CANCELLATION_SCHEDULE_VERSION_CONFLICT", "La baja programada ha cambiado; recargue los datos.");
    if (schedule.status !== "PENDING") return failure(409, "SUBSCRIPTION_CANCELLATION_SCHEDULE_NOT_PENDING", "Solo se puede cancelar una baja programada pendiente.");
    const revokedAt = new Date();
    const revoked = await tx.subscriptionCancellationSchedule.update({
      where: { id: scheduleId },
      data: { status: "REVOKED", version: { increment: 1 }, revokedById: actor.id, revokedAt, revocationReason: command.reason },
      select: cancellationScheduleSelect
    });
    await tx.subscription.update({ where: { id: subscriptionId }, data: { version: { increment: 1 }, updatedById: actor.id } });
    const dto = mapCancellationSchedule(revoked);
    const value = { subscriptionVersion: subscription.version + 1, schedule: dto };
    await tx.auditEvent.create({
      data: {
        eventType: "SUBSCRIPTION_CANCELLATION_SCHEDULE_REVOKED", actorType: "USER",
        payload: { actorUserId: actor.id, companyId, subscriptionId, number: subscription.number, scheduleId, subscriptionVersion: subscription.version + 1, scheduleVersion: dto.version, ...(context.correlationId ? { correlationId: context.correlationId } : {}) }
      }
    });
    await storeMutation(tx, context, 200, value);
    return { ok: true, status: 200, value };
  });
}

/**
 * Resolves the cancellation gate inside the transaction owned by the renewal
 * orchestrator. NO_DUE_CANCELLATION only clears this cancellation gate; it is
 * not billing eligibility and does not reserve or create a renewal period.
 */
export async function resolveScheduledCancellationBeforeRenewal(
  tx: Prisma.TransactionClient,
  command: ResolveScheduledCancellationBeforeRenewalCommand
): Promise<ScheduledCancellationResolution> {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "subscriptions"
    WHERE "id" = ${command.subscriptionId}::uuid AND "companyId" = ${command.companyId}::uuid
    FOR UPDATE
  `);
  const subscription = await tx.subscription.findFirst({
    where: { id: command.subscriptionId, companyId: command.companyId },
    select: {
      id: true, number: true, status: true, version: true, nextRenewalDate: true,
      cancellationMode: true
    }
  });
  if (!subscription) return { outcome: "NOT_FOUND" };
  if (subscription.status === "CANCELLED") {
    const appliedSchedule = subscription.cancellationMode === "SCHEDULED"
      ? await tx.subscriptionCancellationSchedule.findFirst({
          where: { subscriptionId: subscription.id, companyId: command.companyId, status: "APPLIED" },
          select: { id: true }
        })
      : null;
    return {
      outcome: "CANCELLED", scheduleId: appliedSchedule?.id ?? null,
      subscriptionVersion: subscription.version, applied: false
    };
  }
  if (subscription.status === "DRAFT") return { outcome: "NOT_RENEWABLE", status: "DRAFT" };

  const clockBeforeSchedule = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS "now"
  `;
  const businessClock = clockBeforeSchedule[0]?.now;
  if (!businessClock) throw new Error("SUBSCRIPTION_DATABASE_CLOCK_UNAVAILABLE");
  const currentBusinessDateText = todayDateOnly(businessClock);
  const businessDateText = command.asOfDate ?? currentBusinessDateText;
  if (!isValidDateOnly(businessDateText) || businessDateText > currentBusinessDateText) {
    throw new Error("SUBSCRIPTION_RENEWAL_AS_OF_DATE_INVALID");
  }
  const renewalDate = formatDateOnly(subscription.nextRenewalDate);
  if (renewalDate > businessDateText) return { outcome: "NOT_DUE", renewalDate };

  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "subscription_cancellation_schedules"
    WHERE "subscriptionId" = ${subscription.id}::uuid
      AND "companyId" = ${command.companyId}::uuid
      AND "status" = 'PENDING'
    ORDER BY "effectiveDate", "id"
    FOR UPDATE
  `);
  const schedule = await tx.subscriptionCancellationSchedule.findFirst({
    where: { subscriptionId: subscription.id, companyId: command.companyId, status: "PENDING" },
    select: { id: true, effectiveDate: true, reason: true, requestedById: true, version: true }
  });
  if (!schedule) {
    return { outcome: "NO_DUE_CANCELLATION", subscriptionVersion: subscription.version, renewalDate };
  }
  const clockAfterSchedule = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS "now"
  `;
  const appliedAt = clockAfterSchedule[0]?.now;
  if (!appliedAt) throw new Error("SUBSCRIPTION_DATABASE_CLOCK_UNAVAILABLE");
  const applicationBusinessDateText = businessDateText;
  const effectiveDate = formatDateOnly(schedule.effectiveDate);
  if (effectiveDate !== renewalDate) throw new Error("SUBSCRIPTION_CANCELLATION_RENEWAL_DATE_DRIFT");
  if (effectiveDate > applicationBusinessDateText) return { outcome: "NOT_DUE", renewalDate };

  const resultingVersion = subscription.version + 1;
  await tx.subscriptionCancellationSchedule.update({
    where: { id: schedule.id },
    data: {
      status: "APPLIED", version: { increment: 1 }, appliedAt,
      appliedBusinessDate: parseDateOnly(applicationBusinessDateText),
      appliedAgainstVersion: subscription.version,
      appliedSubscriptionVersion: resultingVersion
    }
  });
  await tx.subscription.update({
    where: { id: subscription.id },
    data: {
      status: "CANCELLED", version: { increment: 1 }, cancellationMode: "SCHEDULED",
      cancelledById: schedule.requestedById, cancelledAt: appliedAt,
      cancellationEffectiveDate: schedule.effectiveDate, cancellationReason: schedule.reason
    }
  });
  await resolveRenewalExclusionAsCancelled(tx, {
    companyId: command.companyId, subscriptionId: subscription.id, resolvedAt: appliedAt,
    resolvedById: schedule.requestedById, actorType: "SYSTEM", correlationId: command.correlationId,
    initiatedByUserId: command.initiatedByUserId
  });
  await tx.auditEvent.create({
    data: {
      eventType: "SUBSCRIPTION_CANCELLATION_SCHEDULE_APPLIED", actorType: "SYSTEM",
      payload: {
        companyId: command.companyId, subscriptionId: subscription.id, number: subscription.number,
        scheduleId: schedule.id, effectiveDate, previousVersion: subscription.version,
        subscriptionVersion: resultingVersion,
        ...(command.initiatedByUserId ? { initiatedByUserId: command.initiatedByUserId } : {}),
        ...(command.correlationId ? { correlationId: command.correlationId } : {})
      }
    }
  });
  return { outcome: "CANCELLED", scheduleId: schedule.id, subscriptionVersion: resultingVersion, applied: true };
}

async function resolveRenewalExclusionAsCancelled(
  tx: Prisma.TransactionClient,
  command: {
    companyId: string; subscriptionId: string; resolvedAt: Date; resolvedById: string;
    actorType: "USER" | "SYSTEM"; correlationId?: string; initiatedByUserId?: string;
  }
): Promise<void> {
  const exclusions = await tx.subscriptionRenewalExclusion.findMany({
    where: { companyId: command.companyId, subscriptionId: command.subscriptionId, status: "OPEN" },
    select: { id: true, periodStart: true }
  });
  for (const exclusion of exclusions) {
    await tx.subscriptionRenewalExclusion.update({
      where: { id: exclusion.id },
      data: {
        status: "RESOLVED", resolvedAt: command.resolvedAt, resolvedById: command.resolvedById,
        resolution: "CANCELLED", lastErrorCode: null
      }
    });
  }
  if (exclusions.length > 0) {
    await tx.auditEvent.create({ data: {
      eventType: "SUBSCRIPTION_RENEWAL_EXCLUSION_RESOLVED", actorType: command.actorType,
      payload: {
        companyId: command.companyId, subscriptionId: command.subscriptionId,
        exclusionIds: exclusions.map((exclusion) => exclusion.id), resolution: "CANCELLED",
        resolvedByUserId: command.resolvedById,
        ...(command.initiatedByUserId ? { initiatedByUserId: command.initiatedByUserId } : {}),
        ...(command.correlationId ? { correlationId: command.correlationId } : {})
      }
    } });
  }
}

async function nextSubscriptionNumber(tx: Prisma.TransactionClient, companyId: string, year: number): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ value: number }>>(Prisma.sql`
    INSERT INTO "subscription_number_sequences" ("id", "companyId", "year", "nextNumber", "updatedAt")
    VALUES (gen_random_uuid(), ${companyId}::uuid, ${year}, 2, CURRENT_TIMESTAMP)
    ON CONFLICT ("companyId", "year") DO UPDATE
      SET "nextNumber" = "subscription_number_sequences"."nextNumber" + 1, "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "nextNumber" - 1 AS value
  `);
  const value = rows[0]?.value;
  if (!value) throw new Error("SUBSCRIPTION_NUMBER_SEQUENCE_UNAVAILABLE");
  return value;
}

async function replayMutation<T>(tx: Prisma.TransactionClient, context: MutationContext): Promise<SubscriptionResult<T> | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.idempotencyKey}, 0))`;
  const row = await tx.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
  if (!row) return null;
  if (row.requestHash !== context.requestHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
  return { ok: true, status: row.responseStatus as 200 | 201, value: row.responseBody as unknown as T };
}

async function storeMutation<T>(tx: Prisma.TransactionClient, context: MutationContext, status: 200 | 201, value: T): Promise<void> {
  await tx.idempotencyRecord.create({
    data: { key: context.idempotencyKey, requestHash: context.requestHash, responseStatus: status, responseBody: value as Prisma.InputJsonValue }
  });
}

async function executeMutation<T>(
  actor: SessionUser,
  context: MutationContext,
  work: (tx: Prisma.TransactionClient) => Promise<SubscriptionResult<T>>
): Promise<SubscriptionResult<T>> {
  void actor;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isRetryableTransactionError(error) && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error("SUBSCRIPTION_TRANSACTION_RETRY_EXHAUSTED");
}

function isRetryableTransactionError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001");
}

function mapSubscription(row: Prisma.SubscriptionGetPayload<{ select: typeof subscriptionSelect }>): SubscriptionDto {
  const lines = row.lines.map((line) => {
    if (!(allowedCatalogKinds as readonly string[]).includes(line.catalogItemKindSnapshot)) {
      throw new Error("SUBSCRIPTION_CATALOG_KIND_INTEGRITY_VIOLATION");
    }
    const calculation = calculateInvoiceLine({
      quantity: line.quantity, unitPrice: line.unitPrice, discountPercent: line.discountPercent,
      discountAmount: line.discountAmount, taxRate: line.taxRateSnapshot
    });
    return {
      id: line.id, position: line.position, catalogItemId: line.catalogItemId,
      catalogItemCode: line.catalogItemCodeSnapshot,
      catalogItemKind: line.catalogItemKindSnapshot as SubscriptionDto["lines"][number]["catalogItemKind"],
      description: line.description, quantity: line.quantity.toFixed(3), unitPrice: line.unitPrice.toFixed(2),
      discountPercent: line.discountPercent.toFixed(2), discountAmount: line.discountAmount.toFixed(2),
      taxRateCode: line.taxRateCodeSnapshot, taxRate: line.taxRateSnapshot.toFixed(2), total: calculation.lineTotal.toFixed(2)
    };
  });
  const estimatedTotal = lines.reduce((total, line) => total.plus(line.total), new Prisma.Decimal(0));
  return {
    id: row.id, number: row.number, name: row.name, status: row.status, periodicity: row.periodicity,
    pricingMode: row.pricingMode, paymentMethod: row.paymentMethod, startDate: formatDateOnly(row.startDate),
    nextRenewalDate: formatDateOnly(row.nextRenewalDate), endDate: row.endDate ? formatDateOnly(row.endDate) : null,
    notes: row.notes, version: row.version, customer: row.customer, lines,
    estimatedTotal: estimatedTotal.toFixed(2), activatedAt: row.activatedAt?.toISOString() ?? null,
    cancellation: row.cancellationEffectiveDate && row.cancellationReason && row.cancelledAt && row.cancellationMode ? {
      effectiveDate: formatDateOnly(row.cancellationEffectiveDate), reason: row.cancellationReason,
      cancelledAt: row.cancelledAt.toISOString(), mode: row.cancellationMode
    } : null,
    cancellationSchedules: row.cancellationSchedules.map(mapCancellationSchedule),
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString()
  };
}

const cancellationScheduleSelect = {
  id: true, status: true, effectiveDate: true, reason: true, version: true,
  requestedAt: true, revokedAt: true, revocationReason: true, appliedAt: true,
  appliedBusinessDate: true, appliedAgainstVersion: true, appliedSubscriptionVersion: true
} satisfies Prisma.SubscriptionCancellationScheduleSelect;

const subscriptionSelect = {
  id: true, number: true, name: true, status: true, periodicity: true, pricingMode: true,
  paymentMethod: true, startDate: true, nextRenewalDate: true, endDate: true, notes: true,
  version: true, activatedAt: true, cancelledAt: true, cancellationEffectiveDate: true,
  cancellationReason: true, cancellationMode: true, createdAt: true, updatedAt: true,
  customer: { select: { id: true, code: true, legalName: true } },
  lines: {
    orderBy: { position: "asc" as const },
    select: {
      id: true, position: true, catalogItemId: true, catalogItemCodeSnapshot: true,
      catalogItemKindSnapshot: true, description: true, quantity: true, unitPrice: true,
      discountPercent: true, discountAmount: true, taxRateCodeSnapshot: true, taxRateSnapshot: true
    }
  },
  cancellationSchedules: { orderBy: [{ requestedAt: "desc" as const }, { id: "desc" as const }], take: 20, select: cancellationScheduleSelect }
} satisfies Prisma.SubscriptionSelect;

function mapCancellationSchedule(row: Prisma.SubscriptionCancellationScheduleGetPayload<{ select: typeof cancellationScheduleSelect }>): SubscriptionCancellationScheduleDto {
  return {
    id: row.id, status: row.status, effectiveDate: formatDateOnly(row.effectiveDate), reason: row.reason,
    version: row.version, requestedAt: row.requestedAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null,
    revocationReason: row.revocationReason, appliedAt: row.appliedAt?.toISOString() ?? null,
    appliedBusinessDate: row.appliedBusinessDate ? formatDateOnly(row.appliedBusinessDate) : null,
    appliedAgainstVersion: row.appliedAgainstVersion,
    appliedSubscriptionVersion: row.appliedSubscriptionVersion
  };
}

function failure(status: SubscriptionFailure["status"], code: string, message: string): SubscriptionFailure {
  return { ok: false, status, error: { code, message } };
}

function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function isValidDateOnly(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && formatDateOnly(parsed) === value;
}

async function currentCompanyId(
  client: Pick<Prisma.TransactionClient, "installation"> | Pick<typeof prisma, "installation">
): Promise<string | null> {
  return (await client.installation.findFirst({
    where: { companyId: { not: null } },
    select: { companyId: true }
  }))?.companyId ?? null;
}

async function auditEconomicsDenied(actor: SessionUser, context: Pick<RequestContext, "correlationId">): Promise<void> {
  const companyId = await currentCompanyId(prisma);
  await prisma.auditEvent.create({
    data: {
      eventType: "ACCESS_DENIED", actorType: "USER",
      payload: { userId: actor.id, permission: "Subscriptions.ManageEconomics", ...(companyId ? { companyId } : {}), ...(context.correlationId ? { correlationId: context.correlationId } : {}) }
    }
  });
}

function todayDateOnly(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
