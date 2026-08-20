import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type {
  RequestContext,
  SessionUser,
} from "@/modules/platform/application/auth";
import { createIncidentCreatedNotifications } from "@/modules/platform/application/notifications";
import { getSessionSecret } from "@/modules/platform/application/environment";
import { madridDateRange, supportDateOnlySchema, validateMadridDateRange } from "@/modules/support/application/listFilters";

const prioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);
const statusSchema = z.enum([
  "NEW",
  "IN_PROGRESS",
  "PENDING_CUSTOMER",
  "PENDING_THIRD_PARTY",
  "RESOLVED",
  "CLOSED",
]);
const closeReasonSchema = z.enum([
  "DUPLICATE",
  "NOT_APPLICABLE",
  "CUSTOMER_WITHDRAWS",
  "UNREACHABLE",
  "RESOLVED_EXTERNALLY",
  "OTHER",
]);
const colorSchema = z
  .string()
  .regex(
    /^#[0-9A-Fa-f]{6}$/,
    "El color debe tener formato hexadecimal #RRGGBB.",
  );

export const listSupportIncidentsSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(512).optional(),
    status: statusSchema.optional(),
    priority: prioritySchema.optional(),
    responsibleUserId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    categoryId: z.string().uuid().optional(),
    activeCollaboratorUserId: z.string().uuid().optional(),
    createdFrom: supportDateOnlySchema.optional(),
    createdTo: supportDateOnlySchema.optional(),
    search: z.string().trim().min(3).max(120).regex(/^[^\u0000-\u001F\u007F]*$/, "La búsqueda contiene caracteres no válidos.").refine((value) => /[\p{L}\p{N}]/u.test(value), "La búsqueda debe contener letras o números.").refine((value) => !/[%_\\]/.test(value), "La búsqueda contiene caracteres reservados.").optional(),
  })
  .strict()
  .superRefine((value, context) => {
    validateMadridDateRange(value.createdFrom, value.createdTo, context, "createdFrom", "createdTo");
    if (value.cursor && !decodeCursor(value.cursor, incidentFilterHash(value))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["cursor"], message: "El cursor no es válido para estos filtros." });
    }
  });

export const createSupportIncidentSchema = z
  .object({
    customerId: z.string().uuid(),
    storeId: z.string().uuid().nullable().default(null),
    categoryId: z.string().uuid(),
    responsibleUserId: z.string().uuid(),
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().min(3).max(4000),
    priority: prioritySchema.default("MEDIUM"),
  })
  .strict();

export const createIncidentFromCommunicationSchema = z
  .object({
    expectedCommunicationVersion: z.number().int().positive(),
    storeId: z.string().uuid().nullable().default(null),
    categoryId: z.string().uuid(),
    responsibleUserId: z.string().uuid(),
    title: z.string().trim().min(3).max(200),
    priority: prioritySchema.default("MEDIUM"),
  })
  .strict();

export const createSupportCategorySchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().min(3).max(500).nullable().default(null),
    color: colorSchema.default("#475569"),
  })
  .strict();

export const supportIncidentParamsSchema = z
  .object({ incidentId: z.string().uuid() })
  .strict();

export type ListSupportIncidentsCommand = z.infer<
  typeof listSupportIncidentsSchema
>;
export type CreateSupportIncidentCommand = z.infer<
  typeof createSupportIncidentSchema
>;
export type CreateIncidentFromCommunicationCommand = z.infer<
  typeof createIncidentFromCommunicationSchema
>;
export type CreateSupportCategoryCommand = z.infer<
  typeof createSupportCategorySchema
>;
export type SupportMutationContext = RequestContext & {
  idempotencyKey: string;
  requestHash: string;
  scope: string;
};

export type SupportIncidentListItem = {
  id: string;
  number: string;
  title: string;
  priority: z.infer<typeof prioritySchema>;
  status: z.infer<typeof statusSchema>;
  version: number;
  customer: {
    id: string;
    code: string;
    legalName: string;
    status: "ACTIVE" | "INACTIVE";
  };
  category: { id: string; name: string; color: string };
  responsible: { id: string; displayName: string };
  createdAt: string;
  updatedAt: string;
};

export type SupportIncidentDetail = SupportIncidentListItem & {
  description: string;
  solution: string | null;
  closeReason: z.infer<typeof closeReasonSchema> | null;
  closeReasonDetail: string | null;
  store: {
    id: string;
    code: string;
    name: string;
    status: "ACTIVE" | "INACTIVE";
  } | null;
  createdBy: { id: string; displayName: string };
  actions: Array<{
    id: string;
    text: string;
    originalText: string;
    version: number;
    performedAt: string;
    recordedAt: string;
    author: { id: string; displayName: string };
    sourceIncident: { id: string; number: string } | null;
    correctionsHasMore: boolean;
    corrections: Array<{
      id: string;
      previousText: string;
      correctedText: string;
      reason: string;
      version: number;
      correctedAt: string;
      correctedBy: { id: string; displayName: string };
    }>;
  }>;
  communications: Array<{
    id: string;
    channel: "PHONE" | "WHATSAPP";
    direction: "INBOUND" | "OUTBOUND";
    occurredAt: string;
    summary: string;
    result: "RESOLVED_NO_FOLLOW_UP" | "REQUIRES_FOLLOW_UP" | "NO_ANSWER" | "INFORMATION_PROVIDED" | "REFERRED_TO_INCIDENT";
    registeredBy: { id: string; displayName: string };
    sourceIncident: { id: string; number: string };
  }>;
  events: Array<{
    id: string;
    type: string;
    fromStatus: z.infer<typeof statusSchema> | null;
    toStatus: z.infer<typeof statusSchema> | null;
    actor: { id: string; displayName: string };
    createdAt: string;
  }>;
  transitions: Array<{
    id: string;
    fromStatus: z.infer<typeof statusSchema>;
    toStatus: z.infer<typeof statusSchema>;
    reason: string | null;
    solution: string | null;
    closeReason: z.infer<typeof closeReasonSchema> | null;
    closeReasonDetail: string | null;
    actor: { id: string; displayName: string };
    occurredAt: string;
  }>;
  collaborators: Array<{
    id: string;
    user: { id: string; displayName: string };
    addedAt: string;
    removedAt: string | null;
  }>;
  participantChanges: Array<{
    id: string;
    type: "COLLABORATOR_ADDED" | "COLLABORATOR_REMOVED" | "RESPONSIBLE_CHANGED";
    reason: string | null;
    collaborator: {
      id: string;
      user: { id: string; displayName: string };
    } | null;
    fromResponsible: { id: string; displayName: string } | null;
    toResponsible: { id: string; displayName: string } | null;
    actor: { id: string; displayName: string };
    occurredAt: string;
  }>;
  priorityChanges: Array<{
    id: string;
    fromPriority: z.infer<typeof prioritySchema>;
    toPriority: z.infer<typeof prioritySchema>;
    reason: string;
    actor: { id: string; displayName: string };
    occurredAt: string;
  }>;
  detailsChanges: Array<{
    id: string;
    previousTitle: string;
    correctedTitle: string;
    previousDescription: string;
    correctedDescription: string;
    previousCategory: { id: string; name: string };
    correctedCategory: { id: string; name: string };
    previousStore: { id: string; code: string; name: string } | null;
    correctedStore: { id: string; code: string; name: string } | null;
    reason: string;
    actor: { id: string; displayName: string };
    changedAt: string;
  }>;
  detailsChangesHasMore: boolean;
  mergedInto: { id: string; number: string } | null;
  mergedIncidents: Array<{ id: string; number: string; title: string }>;
};

export type SupportCategoryDto = {
  id: string;
  name: string;
  description: string | null;
  color: string;
  isActive: boolean;
  version: number;
};

export type SupportIncidentReferences = {
  customers: Array<{
    id: string;
    code: string;
    legalName: string;
    status: "ACTIVE" | "INACTIVE";
    stores: Array<{
      id: string;
      code: string;
      name: string;
      status: "ACTIVE" | "INACTIVE";
    }>;
  }>;
  categories: SupportCategoryDto[];
  responsibleUsers: Array<{ id: string; displayName: string }>;
};

const customerReferenceSelect = {
  id: true,
  code: true,
  legalName: true,
  status: true,
  stores: {
    orderBy: [{ name: "asc" as const }, { id: "asc" as const }],
    select: { id: true, code: true, name: true, status: true },
  },
} satisfies Prisma.CustomerSelect;

type SupportErrorCode =
  | "PLATFORM_NOT_INITIALIZED"
  | "SUPPORT_CUSTOMER_NOT_FOUND"
  | "SUPPORT_STORE_NOT_FOUND"
  | "SUPPORT_CATEGORY_NOT_AVAILABLE"
  | "SUPPORT_RESPONSIBLE_NOT_AVAILABLE"
  | "SUPPORT_INCIDENT_NOT_FOUND"
  | "SUPPORT_COMMUNICATION_NOT_FOUND"
  | "SUPPORT_COMMUNICATION_ALREADY_LINKED"
  | "SUPPORT_COMMUNICATION_VERSION_CONFLICT"
  | "SUPPORT_CATEGORY_ALREADY_EXISTS"
  | "SUPPORT_CATEGORY_CHANGE_FORBIDDEN"
  | "SUPPORT_TRANSACTION_BUSY"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_REPLAY_INVALID";
type SupportFailure = {
  ok: false;
  status: 403 | 404 | 409 | 422 | 503;
  error: { code: SupportErrorCode; message: string };
};
export type CreateSupportIncidentResult =
  | { ok: true; status: 200 | 201; value: SupportIncidentDetail }
  | SupportFailure;
export type CreateSupportCategoryResult =
  { ok: true; status: 200 | 201; value: SupportCategoryDto } | SupportFailure;

const incidentListSelect = {
  id: true,
  number: true,
  title: true,
  priority: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  customer: { select: { id: true, code: true, legalName: true, status: true } },
  category: { select: { id: true, name: true, color: true } },
  responsibleUser: { select: { id: true, displayName: true } },
} satisfies Prisma.SupportIncidentSelect;

const incidentDetailSelect = {
  ...incidentListSelect,
  description: true,
  solution: true,
  closeReason: true,
  closeReasonDetail: true,
  store: { select: { id: true, code: true, name: true, status: true } },
  createdBy: { select: { id: true, displayName: true } },
  actions: {
    orderBy: [{ performedAt: "asc" as const }, { id: "asc" as const }],
    select: {
      id: true,
      text: true,
      performedAt: true,
      recordedAt: true,
      authorUser: { select: { id: true, displayName: true } },
      corrections: {
        orderBy: [{ resultingActionVersion: "desc" as const }, { id: "desc" as const }],
        take: 101,
        select: { id: true, previousText: true, correctedText: true, reason: true, resultingActionVersion: true, correctedAt: true, correctedBy: { select: { id: true, displayName: true } } },
      },
    },
  },
  communications: {
    orderBy: [{ occurredAt: "asc" as const }, { id: "asc" as const }],
    select: {
      id: true,
      channel: true,
      direction: true,
      occurredAt: true,
      summary: true,
      result: true,
      registeredBy: { select: { id: true, displayName: true } },
    },
  },
  events: {
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
    select: {
      id: true,
      eventType: true,
      fromStatus: true,
      toStatus: true,
      createdAt: true,
      actorUser: { select: { id: true, displayName: true } },
    },
  },
  transitions: {
    orderBy: [{ occurredAt: "asc" as const }, { id: "asc" as const }],
    select: {
      id: true,
      fromStatus: true,
      toStatus: true,
      reasonText: true,
      solutionText: true,
      closeReason: true,
      closeReasonDetail: true,
      occurredAt: true,
      actorUser: { select: { id: true, displayName: true } },
    },
  },
  collaborators: {
    orderBy: [{ addedAt: "asc" as const }, { id: "asc" as const }],
    select: {
      id: true,
      addedAt: true,
      removedAt: true,
      user: { select: { id: true, displayName: true } },
    },
  },
  participantChanges: {
    orderBy: [{ occurredAt: "asc" as const }, { id: "asc" as const }],
    select: {
      id: true,
      changeType: true,
      reason: true,
      occurredAt: true,
      collaborator: {
        select: { id: true, user: { select: { id: true, displayName: true } } },
      },
      fromResponsible: { select: { id: true, displayName: true } },
      toResponsible: { select: { id: true, displayName: true } },
      actorUser: { select: { id: true, displayName: true } },
    },
  },
  priorityChanges: {
    orderBy: [{ occurredAt: "asc" as const }, { id: "asc" as const }],
    select: {
      id: true,
      fromPriority: true,
      toPriority: true,
      reason: true,
      occurredAt: true,
      actorUser: { select: { id: true, displayName: true } },
    },
  },
  detailsChanges: {
    orderBy: [{ changedAt: "desc" as const }, { id: "desc" as const }],
    take: 101,
    select: {
      id: true,
      previousTitle: true,
      correctedTitle: true,
      previousDescription: true,
      correctedDescription: true,
      previousCategoryId: true,
      correctedCategoryId: true,
      previousCategoryName: true,
      correctedCategoryName: true,
      previousStoreId: true,
      correctedStoreId: true,
      previousStoreCode: true,
      previousStoreName: true,
      correctedStoreCode: true,
      correctedStoreName: true,
      reason: true,
      changedAt: true,
      actorUser: { select: { id: true, displayName: true } },
    },
  },
  mergedIntoIncident: { select: { id: true, number: true } },
  mergedDuplicates: {
    orderBy: [{ number: "asc" as const }, { id: "asc" as const }],
    select: {
      id: true,
      number: true,
      title: true,
      actions: {
        orderBy: [{ performedAt: "asc" as const }, { id: "asc" as const }],
        select: {
          id: true,
          text: true,
          performedAt: true,
          recordedAt: true,
          authorUser: { select: { id: true, displayName: true } },
          corrections: {
            orderBy: [{ resultingActionVersion: "desc" as const }, { id: "desc" as const }],
            take: 101,
            select: { id: true, previousText: true, correctedText: true, reason: true, resultingActionVersion: true, correctedAt: true, correctedBy: { select: { id: true, displayName: true } } },
          },
        },
      },
      communications: {
        orderBy: [{ occurredAt: "asc" as const }, { id: "asc" as const }],
        select: {
          id: true,
          channel: true,
          direction: true,
          occurredAt: true,
          summary: true,
          result: true,
          registeredBy: { select: { id: true, displayName: true } },
        },
      },
    },
  },
} satisfies Prisma.SupportIncidentSelect;

type IncidentListRecord = Prisma.SupportIncidentGetPayload<{
  select: typeof incidentListSelect;
}>;
type IncidentDetailRecord = Prisma.SupportIncidentGetPayload<{
  select: typeof incidentDetailSelect;
}>;

const incidentReplaySchema = z
  .object({
    id: z.string().uuid(),
    number: z.string(),
    title: z.string(),
    priority: prioritySchema,
    status: statusSchema,
    version: z.number().int().positive(),
    customer: z
      .object({
        id: z.string().uuid(),
        code: z.string(),
        legalName: z.string(),
        status: z.enum(["ACTIVE", "INACTIVE"]),
      })
      .strict(),
    category: z
      .object({ id: z.string().uuid(), name: z.string(), color: colorSchema })
      .strict(),
    responsible: z
      .object({ id: z.string().uuid(), displayName: z.string() })
      .strict(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    description: z.string(),
    solution: z.string().nullable(),
    closeReason: closeReasonSchema.nullable(),
    closeReasonDetail: z.string().nullable(),
    store: z
      .object({
        id: z.string().uuid(),
        code: z.string(),
        name: z.string(),
        status: z.enum(["ACTIVE", "INACTIVE"]),
      })
      .strict()
      .nullable(),
    createdBy: z
      .object({ id: z.string().uuid(), displayName: z.string() })
      .strict(),
    actions: z.array(
      z
        .object({
          id: z.string().uuid(),
          text: z.string(),
          originalText: z.string().optional(),
          version: z.number().int().positive().optional(),
          performedAt: z.string().datetime(),
          recordedAt: z.string().datetime(),
          author: z
            .object({ id: z.string().uuid(), displayName: z.string() })
            .strict(),
          sourceIncident: z.object({ id: z.string().uuid(), number: z.string() }).strict().nullable().optional().transform((value) => value ?? null),
          corrections: z.array(z.object({
            id: z.string().uuid(),
            previousText: z.string(),
            correctedText: z.string(),
            reason: z.string(),
            version: z.number().int().positive(),
            correctedAt: z.string().datetime(),
            correctedBy: z.object({ id: z.string().uuid(), displayName: z.string() }).strict(),
          }).strict()).optional(),
          correctionsHasMore: z.boolean().optional(),
        })
        .strict()
        .transform((value) => ({ ...value, originalText: value.originalText ?? value.text, version: value.version ?? 1, corrections: value.corrections ?? [], correctionsHasMore: value.correctionsHasMore ?? false })),
    ),
    communications: z.array(z.object({
      id: z.string().uuid(),
      channel: z.enum(["PHONE", "WHATSAPP"]),
      direction: z.enum(["INBOUND", "OUTBOUND"]),
      occurredAt: z.string().datetime(),
      summary: z.string(),
      result: z.enum(["RESOLVED_NO_FOLLOW_UP", "REQUIRES_FOLLOW_UP", "NO_ANSWER", "INFORMATION_PROVIDED", "REFERRED_TO_INCIDENT"]),
      registeredBy: z.object({ id: z.string().uuid(), displayName: z.string() }).strict(),
      sourceIncident: z.object({ id: z.string().uuid(), number: z.string() }).strict(),
    }).strict()).optional().transform((value) => value ?? []),
    events: z.array(
      z
        .object({
          id: z.string().uuid(),
          type: z.string(),
          fromStatus: statusSchema.nullable(),
          toStatus: statusSchema.nullable(),
          actor: z
            .object({ id: z.string().uuid(), displayName: z.string() })
            .strict(),
          createdAt: z.string().datetime(),
        })
        .strict(),
    ),
    transitions: z.array(
      z
        .object({
          id: z.string().uuid(),
          fromStatus: statusSchema,
          toStatus: statusSchema,
          reason: z.string().nullable(),
          solution: z.string().nullable(),
          closeReason: closeReasonSchema.nullable(),
          closeReasonDetail: z.string().nullable(),
          actor: z
            .object({ id: z.string().uuid(), displayName: z.string() })
            .strict(),
          occurredAt: z.string().datetime(),
        })
        .strict(),
    ),
    collaborators: z.array(
      z
        .object({
          id: z.string().uuid(),
          user: z
            .object({ id: z.string().uuid(), displayName: z.string() })
            .strict(),
          addedAt: z.string().datetime(),
          removedAt: z.string().datetime().nullable(),
        })
        .strict(),
    ),
    participantChanges: z.array(
      z
        .object({
          id: z.string().uuid(),
          type: z.enum([
            "COLLABORATOR_ADDED",
            "COLLABORATOR_REMOVED",
            "RESPONSIBLE_CHANGED",
          ]),
          reason: z.string().nullable(),
          collaborator: z
            .object({
              id: z.string().uuid(),
              user: z
                .object({ id: z.string().uuid(), displayName: z.string() })
                .strict(),
            })
            .strict()
            .nullable(),
          fromResponsible: z
            .object({ id: z.string().uuid(), displayName: z.string() })
            .strict()
            .nullable(),
          toResponsible: z
            .object({ id: z.string().uuid(), displayName: z.string() })
            .strict()
            .nullable(),
          actor: z
            .object({ id: z.string().uuid(), displayName: z.string() })
            .strict(),
          occurredAt: z.string().datetime(),
        })
        .strict(),
    ),
    priorityChanges: z.array(
      z.object({
        id: z.string().uuid(),
        fromPriority: prioritySchema,
        toPriority: prioritySchema,
        reason: z.string(),
        actor: z.object({ id: z.string().uuid(), displayName: z.string() }).strict(),
        occurredAt: z.string().datetime(),
      }).strict(),
    ).optional().transform((value) => value ?? []),
    detailsChanges: z.array(z.object({
      id: z.string().uuid(),
      previousTitle: z.string(),
      correctedTitle: z.string(),
      previousDescription: z.string(),
      correctedDescription: z.string(),
      previousCategory: z.object({ id: z.string().uuid(), name: z.string() }).strict(),
      correctedCategory: z.object({ id: z.string().uuid(), name: z.string() }).strict(),
      previousStore: z.object({ id: z.string().uuid(), code: z.string(), name: z.string() }).strict().nullable(),
      correctedStore: z.object({ id: z.string().uuid(), code: z.string(), name: z.string() }).strict().nullable(),
      reason: z.string(),
      actor: z.object({ id: z.string().uuid(), displayName: z.string() }).strict(),
      changedAt: z.string().datetime(),
    }).strict()).optional().transform((value) => value ?? []),
    detailsChangesHasMore: z.boolean().optional().transform((value) => value ?? false),
    mergedInto: z
      .object({ id: z.string().uuid(), number: z.string() })
      .strict()
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    mergedIncidents: z
      .array(
        z
          .object({ id: z.string().uuid(), number: z.string(), title: z.string() })
          .strict(),
      )
      .optional()
      .transform((value) => value ?? []),
  })
  .strict();

const categoryReplaySchema: z.ZodType<SupportCategoryDto> = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    color: colorSchema,
    isActive: z.boolean(),
    version: z.number().int().positive(),
  })
  .strict();

export async function listSupportIncidents(
  command: ListSupportIncidentsCommand,
  actor: SessionUser,
  context: RequestContext = {},
) {
  const companyId = await currentCompanyId(prisma);
  if (!companyId)
    return {
      incidents: [] as SupportIncidentListItem[],
      nextCursor: null as string | null,
      rateLimited: false,
      searchBusy: false,
      searchTooBroad: false,
    };
  if (command.search && await consumeSupportSearchRateLimit(companyId, actor, context.correlationId)) {
    return { incidents: [] as SupportIncidentListItem[], nextCursor: null as string | null, rateLimited: true, searchBusy: false, searchTooBroad: false };
  }
  const filterHash = incidentFilterHash(command);
  const cursor = command.cursor ? decodeCursor(command.cursor, filterHash) : null;
  const createdAt = command.createdFrom && command.createdTo ? madridDateRange(command.createdFrom, command.createdTo) : undefined;
  const incidentQuery = (actionIncidentIds: string[]) => ({
    where: {
      companyId,
      ...(command.status ? { status: command.status } : {}),
      ...(command.priority ? { priority: command.priority } : {}),
      ...(command.responsibleUserId
        ? { responsibleUserId: command.responsibleUserId }
        : {}),
      ...(command.customerId ? { customerId: command.customerId } : {}),
      ...(command.categoryId ? { categoryId: command.categoryId } : {}),
      ...(command.activeCollaboratorUserId ? { collaborators: { some: { companyId, userId: command.activeCollaboratorUserId, removedAt: null } } } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(command.search
        ? {
            OR: [
              { number: { contains: command.search, mode: "insensitive" } },
              { title: { contains: command.search, mode: "insensitive" } },
              {
                description: { contains: command.search, mode: "insensitive" },
              },
              ...(actionIncidentIds.length ? [{ id: { in: actionIncidentIds } }] : []),
            ],
          }
        : {}),
      ...(cursor
        ? {
            OR: [
              { updatedAt: { lt: cursor.updatedAt } },
              { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: command.limit + 1,
    select: incidentListSelect,
  }) satisfies Prisma.SupportIncidentFindManyArgs;
  let rows: IncidentListRecord[];
  try {
    rows = command.search
      ? await prisma.$transaction(async (tx) => {
          await tx.$queryRaw(Prisma.sql`SELECT set_config('statement_timeout', ${"3000ms"}, true)`);
          const actionMatches = await tx.$queryRaw<Array<{ incidentId: string }>>(Prisma.sql`
            SELECT DISTINCT matches."incidentId"
            FROM (
              SELECT action."incidentId"
              FROM "support_incident_actions" action
              WHERE action."companyId" = ${companyId}::uuid
                AND action."text" ILIKE ${`%${command.search}%`}
                AND NOT EXISTS (
                  SELECT 1 FROM "support_incident_action_corrections" correction
                  WHERE correction."actionId" = action."id"
                )
              UNION ALL
              SELECT correction."incidentId"
              FROM "support_incident_action_corrections" correction
              WHERE correction."companyId" = ${companyId}::uuid
                AND correction."correctedText" ILIKE ${`%${command.search}%`}
                AND NOT EXISTS (
                  SELECT 1 FROM "support_incident_action_corrections" newer
                  WHERE newer."actionId" = correction."actionId"
                    AND newer."resultingActionVersion" > correction."resultingActionVersion"
                )
            ) matches
            LIMIT 10001
          `);
          if (actionMatches.length > 10_000) throw new SupportIncidentSearchCapacityError();
          return tx.supportIncident.findMany(incidentQuery(actionMatches.map((match) => match.incidentId)));
        }, { maxWait: 1_000, timeout: 4_500 })
      : await prisma.supportIncident.findMany(incidentQuery([]));
  } catch (error) {
    if (error instanceof SupportIncidentSearchCapacityError) {
      await prisma.auditEvent.create({
        data: {
          eventType: "SUPPORT_INCIDENT_SEARCH_REJECTED",
          actorType: "USER",
          payload: {
            actorUserId: actor.id,
            companyId,
            reason: "TOO_BROAD",
            ...(context.correlationId ? { correlationId: context.correlationId } : {}),
          },
        },
      });
      return { incidents: [] as SupportIncidentListItem[], nextCursor: null as string | null, rateLimited: false, searchBusy: false, searchTooBroad: true };
    }
    if (!isStatementTimeout(error)) throw error;
    await prisma.auditEvent.create({
      data: {
        eventType: "SUPPORT_INCIDENT_SEARCH_BUSY",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          companyId,
          ...(context.correlationId ? { correlationId: context.correlationId } : {}),
        },
      },
    });
    return { incidents: [] as SupportIncidentListItem[], nextCursor: null as string | null, rateLimited: false, searchBusy: true, searchTooBroad: false };
  }
  const page = rows.slice(0, command.limit);
  await prisma.auditEvent.create({
    data: {
      eventType: "SUPPORT_INCIDENTS_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        companyId,
        hasSearch: Boolean(command.search),
        hasCursor: Boolean(command.cursor),
        status: command.status ?? null,
        priority: command.priority ?? null,
        customerId: command.customerId ?? null,
        responsibleUserId: command.responsibleUserId ?? null,
        categoryId: command.categoryId ?? null,
        activeCollaboratorUserId: command.activeCollaboratorUserId ?? null,
        createdFrom: command.createdFrom ?? null,
        createdTo: command.createdTo ?? null,
        resultCount: page.length,
        ...(context.correlationId ? { correlationId: context.correlationId } : {}),
      },
    },
  });
  return {
    incidents: page.map(mapIncidentListItem),
    nextCursor:
      rows.length > command.limit && page.length
        ? encodeCursor(page[page.length - 1]!, filterHash)
        : null,
    rateLimited: false,
    searchBusy: false,
    searchTooBroad: false,
  };
}

export async function getSupportIncident(
  incidentId: string,
  actor: SessionUser,
): Promise<SupportIncidentDetail | null> {
  const companyId = await currentCompanyId(prisma);
  const row = companyId
    ? await prisma.supportIncident.findFirst({
        where: { id: incidentId, companyId },
        select: incidentDetailSelect,
      })
    : null;
  if (!row) return null;
  await prisma.auditEvent.create({
    data: {
      eventType: "SUPPORT_INCIDENT_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        companyId,
        incidentId,
        incidentNumber: row.number,
      },
    },
  });
  return mapIncidentDetail(row, actor.permissions.includes("Support.ViewCommunications"));
}

export async function listSupportReferences(
  preferredCustomerId?: string,
): Promise<SupportIncidentReferences> {
  const companyId = await currentCompanyId(prisma);
  if (!companyId)
    return { customers: [], categories: [], responsibleUsers: [] };
  const [listedCustomers, preferredCustomer, categories, responsibleUsers] = await Promise.all([
    prisma.customer.findMany({
      orderBy: [{ legalName: "asc" }, { id: "asc" }],
      take: 500,
      select: customerReferenceSelect,
    }),
    preferredCustomerId
      ? prisma.customer.findUnique({
          where: { id: preferredCustomerId },
          select: customerReferenceSelect,
        })
      : Promise.resolve(null),
    prisma.supportIncidentCategory.findMany({
      where: { companyId, isActive: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        description: true,
        color: true,
        isActive: true,
        version: true,
      },
    }),
    prisma.user.findMany({
      where: {
        status: "ACTIVE",
        AND: [
          {
            role: {
              permissions: { some: { permission: { code: "Support.View" } } },
            },
          },
          {
            role: {
              permissions: {
                some: { permission: { code: "Support.AddActions" } },
              },
            },
          },
        ],
      },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      select: { id: true, displayName: true },
    }),
  ]);
  const customers = preferredCustomer && !listedCustomers.some((customer) => customer.id === preferredCustomer.id)
    ? [...listedCustomers, preferredCustomer].sort((left, right) => left.legalName.localeCompare(right.legalName, "es") || left.id.localeCompare(right.id))
    : listedCustomers;
  return { customers, categories, responsibleUsers };
}

export async function listSupportIncidentDetailsReferences(customerId: string) {
  const companyId = await currentCompanyId(prisma);
  if (!companyId) return { categories: [], stores: [] };
  const [categories, stores] = await Promise.all([
    prisma.supportIncidentCategory.findMany({
      where: { companyId, isActive: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true },
    }),
    prisma.customerStore.findMany({
      where: { customerId, status: "ACTIVE" },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, code: true, name: true },
    }),
  ]);
  return { categories, stores };
}

export async function listSupportIncidentFilterReferences(selectedCustomerId?: string) {
  const companyId = await currentCompanyId(prisma);
  if (!companyId) return { customers: [], categories: [], responsibleUsers: [], collaboratorUsers: [] };
  const [listedCustomers, selectedCustomer, categories, responsibleUsers, collaboratorUsers] = await Promise.all([
    prisma.customer.findMany({ where: { supportIncidents: { some: { companyId } } }, orderBy: [{ legalName: "asc" }, { id: "asc" }], take: 500, select: { id: true, code: true, legalName: true } }),
    selectedCustomerId ? prisma.customer.findFirst({ where: { id: selectedCustomerId, supportIncidents: { some: { companyId } } }, select: { id: true, code: true, legalName: true } }) : Promise.resolve(null),
    prisma.supportIncidentCategory.findMany({ where: { companyId }, orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, name: true, isActive: true } }),
    prisma.user.findMany({
      where: { responsibleSupportIncidents: { some: { companyId } } },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      select: { id: true, displayName: true, status: true },
    }),
    prisma.user.findMany({
      where: { supportIncidentCollaborations: { some: { companyId, removedAt: null } } },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      select: { id: true, displayName: true, status: true },
    }),
  ]);
  const customers = selectedCustomer && !listedCustomers.some((item) => item.id === selectedCustomer.id)
    ? [...listedCustomers, selectedCustomer].sort((left, right) => left.legalName.localeCompare(right.legalName, "es") || left.id.localeCompare(right.id))
    : listedCustomers;
  return { customers, categories, responsibleUsers, collaboratorUsers };
}

export async function listSupportCategories(): Promise<SupportCategoryDto[]> {
  const companyId = await currentCompanyId(prisma);
  if (!companyId) return [];
  return prisma.supportIncidentCategory.findMany({
    where: { companyId },
    orderBy: [{ isActive: "desc" }, { name: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      color: true,
      isActive: true,
      version: true,
    },
  });
}

export async function createSupportIncident(
  command: CreateSupportIncidentCommand,
  actor: SessionUser,
  context: SupportMutationContext,
): Promise<CreateSupportIncidentResult> {
  return executeMutation<SupportIncidentDetail>(actor, context, incidentReplaySchema, async (tx) => {
    const companyId = await currentCompanyId(tx);
    if (!companyId)
      return failure(
        409,
        "PLATFORM_NOT_INITIALIZED",
        "La plataforma no esta inicializada.",
      );
    const category = (await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "support_incident_categories"
      WHERE "id" = ${command.categoryId}::uuid AND "companyId" = ${companyId}::uuid AND "isActive" = true
      FOR SHARE
    `))[0];
    const [customer, responsible, store] = await Promise.all([
      tx.customer.findUnique({
        where: { id: command.customerId },
        select: { id: true },
      }),
      tx.user.findFirst({
        where: {
          id: command.responsibleUserId,
          status: "ACTIVE",
          AND: [
            {
              role: {
                permissions: { some: { permission: { code: "Support.View" } } },
              },
            },
            {
              role: {
                permissions: {
                  some: { permission: { code: "Support.AddActions" } },
                },
              },
            },
          ],
        },
        select: { id: true },
      }),
      command.storeId
        ? tx.customerStore.findFirst({
            where: { id: command.storeId, customerId: command.customerId },
            select: { id: true },
          })
        : Promise.resolve({ id: null }),
    ]);
    if (!customer)
      return failure(
        404,
        "SUPPORT_CUSTOMER_NOT_FOUND",
        "El cliente no existe.",
      );
    if (!store)
      return failure(
        422,
        "SUPPORT_STORE_NOT_FOUND",
        "La tienda no pertenece al cliente seleccionado.",
      );
    if (!category)
      return failure(
        422,
        "SUPPORT_CATEGORY_NOT_AVAILABLE",
        "La categoria no esta disponible.",
      );
    if (!responsible)
      return failure(
        422,
        "SUPPORT_RESPONSIBLE_NOT_AVAILABLE",
        "El responsable no esta disponible para incidencias.",
      );
    const year = madridYear(new Date());
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-incident:${companyId}:${year}`}, 0))`;
    const sequence = await tx.supportIncidentNumberSequence.upsert({
      where: { companyId_year: { companyId, year } },
      update: { nextValue: { increment: 1 } },
      create: { companyId, year, nextValue: 2 },
      select: { nextValue: true },
    });
    const sequenceNumber = sequence.nextValue - 1;
    const number = `INC-${year}-${String(sequenceNumber).padStart(5, "0")}`;
    const created = await tx.supportIncident.create({
      data: {
        companyId,
        year,
        sequenceNumber,
        number,
        customerId: command.customerId,
        storeId: command.storeId,
        categoryId: command.categoryId,
        responsibleUserId: command.responsibleUserId,
        createdById: actor.id,
        title: command.title,
        description: command.description,
        priority: command.priority,
        status: "NEW",
        events: {
          create: {
            company: { connect: { id: companyId } },
            actorUser: { connect: { id: actor.id } },
            responsibleUserAtEvent: { connect: { id: command.responsibleUserId } },
            eventType: "CREATED",
            toStatus: "NEW",
            resultingVersion: 1,
          },
        },
      },
      select: incidentDetailSelect,
    });
    const createdEvent = created.events.find((event) => event.eventType === "CREATED");
    if (!createdEvent) throw new Error("SUPPORT_INCIDENT_CREATED_EVENT_MISSING");
    await createIncidentCreatedNotifications(tx, {
      companyId,
      incidentId: created.id,
      sourceEventId: createdEvent.id,
      incidentNumber: number,
      responsibleUserId: command.responsibleUserId,
      priority: command.priority,
      correlationId: context.correlationId,
    });
    const value = mapIncidentDetail(created, actor.permissions.includes("Support.ViewCommunications"));
    await tx.auditEvent.create({
      data: {
        eventType: "SUPPORT_INCIDENT_CREATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          companyId,
          incidentId: created.id,
          incidentNumber: number,
          customerId: command.customerId,
          categoryId: command.categoryId,
          responsibleUserId: command.responsibleUserId,
          priority: command.priority,
          hasStore: Boolean(command.storeId),
          ...(context.correlationId
            ? { correlationId: context.correlationId }
            : {}),
        },
      },
    });
    return { ok: true, status: 201, value };
  });
}

export async function createIncidentFromCommunication(
  communicationId: string,
  command: CreateIncidentFromCommunicationCommand,
  actor: SessionUser,
  context: SupportMutationContext,
): Promise<CreateSupportIncidentResult> {
  return executeMutation<SupportIncidentDetail>(actor, context, incidentReplaySchema, async (tx) => {
    const companyId = await currentCompanyId(tx);
    if (!companyId)
      return failure(
        409,
        "PLATFORM_NOT_INITIALIZED",
        "La plataforma no esta inicializada.",
      );
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        customerId: string;
        incidentId: string | null;
        contactId: string | null;
        registeredByUserId: string;
        channel: "PHONE" | "WHATSAPP";
        direction: "INBOUND" | "OUTBOUND";
        occurredAt: Date;
        contactNumber: string;
        durationSeconds: number | null;
        summary: string;
        result:
          | "RESOLVED_NO_FOLLOW_UP"
          | "REQUIRES_FOLLOW_UP"
          | "NO_ANSWER"
          | "INFORMATION_PROVIDED"
          | "REFERRED_TO_INCIDENT";
        version: number;
      }>
    >(Prisma.sql`
      SELECT "id", "customerId", "incidentId", "contactId", "registeredByUserId", "channel", "direction",
        "occurredAt", "contactNumber", "durationSeconds", "summary", "result", "version"
      FROM "support_communications"
      WHERE "id" = ${communicationId}::uuid AND "companyId" = ${companyId}::uuid
      FOR UPDATE
    `);
    const communication = rows[0];
    if (!communication)
      return failure(
        404,
        "SUPPORT_COMMUNICATION_NOT_FOUND",
        "La comunicacion no existe.",
      );
    if (communication.incidentId)
      return failure(
        409,
        "SUPPORT_COMMUNICATION_ALREADY_LINKED",
        "La comunicacion ya esta vinculada a una incidencia.",
      );
    if (communication.version !== command.expectedCommunicationVersion)
      return failure(
        409,
        "SUPPORT_COMMUNICATION_VERSION_CONFLICT",
        "La comunicacion ha cambiado. Recarga antes de continuar.",
      );
    const category = (await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "support_incident_categories"
      WHERE "id" = ${command.categoryId}::uuid AND "companyId" = ${companyId}::uuid AND "isActive" = true
      FOR SHARE
    `))[0];
    const [responsible, store] = await Promise.all([
      tx.user.findFirst({
        where: {
          id: command.responsibleUserId,
          status: "ACTIVE",
          AND: [
            {
              role: {
                permissions: { some: { permission: { code: "Support.View" } } },
              },
            },
            {
              role: {
                permissions: {
                  some: { permission: { code: "Support.AddActions" } },
                },
              },
            },
          ],
        },
        select: { id: true },
      }),
      command.storeId
        ? tx.customerStore.findFirst({
            where: {
              id: command.storeId,
              customerId: communication.customerId,
            },
            select: { id: true },
          })
        : Promise.resolve({ id: null }),
    ]);
    if (!store)
      return failure(
        422,
        "SUPPORT_STORE_NOT_FOUND",
        "La tienda no pertenece al cliente seleccionado.",
      );
    if (!category)
      return failure(
        422,
        "SUPPORT_CATEGORY_NOT_AVAILABLE",
        "La categoria no esta disponible.",
      );
    if (!responsible)
      return failure(
        422,
        "SUPPORT_RESPONSIBLE_NOT_AVAILABLE",
        "El responsable no esta disponible para incidencias.",
      );
    const numbering = await allocateIncidentNumber(tx, companyId);
    const created = await tx.supportIncident.create({
      data: {
        companyId,
        ...numbering,
        customerId: communication.customerId,
        storeId: command.storeId,
        categoryId: command.categoryId,
        responsibleUserId: command.responsibleUserId,
        createdById: actor.id,
        title: command.title,
        description: communication.summary,
        priority: command.priority,
        status: "NEW",
        events: {
          create: {
            company: { connect: { id: companyId } },
            actorUser: { connect: { id: actor.id } },
            responsibleUserAtEvent: { connect: { id: command.responsibleUserId } },
            eventType: "CREATED",
            toStatus: "NEW",
            resultingVersion: 1,
          },
        },
      },
      select: incidentDetailSelect,
    });
    const createdEvent = created.events.find((event) => event.eventType === "CREATED");
    if (!createdEvent) throw new Error("SUPPORT_INCIDENT_CREATED_EVENT_MISSING");
    await createIncidentCreatedNotifications(tx, {
      companyId,
      incidentId: created.id,
      sourceEventId: createdEvent.id,
      incidentNumber: created.number,
      responsibleUserId: command.responsibleUserId,
      priority: command.priority,
      correlationId: context.correlationId,
    });
    const resultingVersion = communication.version + 1;
    await tx.supportCommunicationCorrection.create({
      data: {
        companyId,
        communicationId,
        correctedByUserId: actor.id,
        resultingVersion,
        previousChannel: communication.channel,
        correctedChannel: communication.channel,
        previousDirection: communication.direction,
        correctedDirection: communication.direction,
        previousOccurredAt: communication.occurredAt,
        correctedOccurredAt: communication.occurredAt,
        previousContactNumber: communication.contactNumber,
        correctedContactNumber: communication.contactNumber,
        previousContactId: communication.contactId,
        correctedContactId: communication.contactId,
        previousDurationSeconds: communication.durationSeconds,
        correctedDurationSeconds: communication.durationSeconds,
        previousSummary: communication.summary,
        correctedSummary: communication.summary,
        previousResult: communication.result,
        correctedResult: "REFERRED_TO_INCIDENT",
        previousIncidentId: null,
        correctedIncidentId: created.id,
        reason: "Incidencia creada desde la comunicacion.",
      },
    });
    await tx.supportCommunication.update({
      where: { id: communicationId },
      data: {
        incidentId: created.id,
        result: "REFERRED_TO_INCIDENT",
        version: resultingVersion,
      },
    });
    await tx.auditEvent.create({
      data: {
        eventType: "SUPPORT_INCIDENT_CREATED_FROM_COMMUNICATION",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          companyId,
          incidentId: created.id,
          incidentNumber: created.number,
          communicationId,
          customerId: communication.customerId,
          categoryId: command.categoryId,
          responsibleUserId: command.responsibleUserId,
          priority: command.priority,
          hasStore: Boolean(command.storeId),
          ...(context.correlationId
            ? { correlationId: context.correlationId }
            : {}),
        },
      },
    });
    return { ok: true, status: 201, value: mapIncidentDetail(created, actor.permissions.includes("Support.ViewCommunications")) };
  });
}

export async function createSupportCategory(
  command: CreateSupportCategoryCommand,
  actor: SessionUser,
  context: SupportMutationContext,
): Promise<CreateSupportCategoryResult> {
  if (!actor.permissions.includes("Support.View") || !actor.permissions.includes("Support.ManageCategories")) {
    return failure(403, "SUPPORT_CATEGORY_CHANGE_FORBIDDEN", "No tienes permiso para gestionar categorías.");
  }
  return executeMutation(
    actor,
    context,
    categoryReplaySchema,
    async (tx) => {
      const companyId = await currentCompanyId(tx);
      if (!companyId)
        return failure(
          409,
          "PLATFORM_NOT_INITIALIZED",
          "La plataforma no esta inicializada.",
        );
      const category = await tx.supportIncidentCategory.create({
        data: {
          companyId,
          name: command.name,
          normalizedName: await normalizeSupportCategoryName(tx, command.name),
          description: command.description,
          color: command.color,
        },
        select: {
          id: true,
          name: true,
          description: true,
          color: true,
          isActive: true,
          version: true,
        },
      });
      await tx.auditEvent.create({
        data: {
          eventType: "SUPPORT_INCIDENT_CATEGORY_CREATED",
          actorType: "USER",
          payload: {
            actorUserId: actor.id,
            companyId,
            categoryId: category.id,
            ...(context.correlationId
              ? { correlationId: context.correlationId }
              : {}),
          },
        },
      });
      return { ok: true, status: 201, value: category };
    },
    () =>
      failure(
        409,
        "SUPPORT_CATEGORY_ALREADY_EXISTS",
        "Ya existe una categoria con ese nombre.",
      ),
  );
}

export function hashSupportRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function executeMutation<T>(
  actor: SessionUser,
  context: SupportMutationContext,
  replaySchema: z.ZodType<T, z.ZodTypeDef, unknown>,
  work: (
    tx: Prisma.TransactionClient,
  ) => Promise<{ ok: true; status: 201; value: T } | SupportFailure>,
  uniqueConflict?: (
    error: Prisma.PrismaClientKnownRequestError,
  ) => SupportFailure,
): Promise<{ ok: true; status: 200 | 201; value: T } | SupportFailure> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const key = scopedKey(actor, context);
          const replay = await tx.idempotencyRecord.findUnique({
            where: { key },
          });
          if (replay) {
            if (replay.requestHash !== context.requestHash)
              return failure(
                409,
                "IDEMPOTENCY_KEY_REUSED",
                "La clave de idempotencia ya se uso con otra peticion.",
              );
            const parsed = replaySchema.safeParse(replay.responseBody);
            if (!parsed.success)
              return failure(
                409,
                "IDEMPOTENCY_REPLAY_INVALID",
                "La respuesta idempotente almacenada no es valida.",
              );
            return { ok: true, status: 200, value: parsed.data };
          }
          const result = await work(tx);
          if (result.ok)
            await tx.idempotencyRecord.create({
              data: {
                key,
                requestHash: context.requestHash,
                responseStatus: result.status,
                responseBody: result.value as unknown as Prisma.InputJsonValue,
              },
            });
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001"))) {
        if (attempt < 2) continue;
        return failure(503, "SUPPORT_TRANSACTION_BUSY", "No se pudo completar la operación por concurrencia. Inténtalo de nuevo.");
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const replay = await prisma.idempotencyRecord.findUnique({
          where: { key: scopedKey(actor, context) },
        });
        if (replay) {
          if (replay.requestHash !== context.requestHash)
            return failure(
              409,
              "IDEMPOTENCY_KEY_REUSED",
              "La clave de idempotencia ya se uso con otra peticion.",
            );
          const parsed = replaySchema.safeParse(replay.responseBody);
          return parsed.success
            ? { ok: true, status: 200, value: parsed.data }
            : failure(
                409,
                "IDEMPOTENCY_REPLAY_INVALID",
                "La respuesta idempotente almacenada no es valida.",
              );
        }
        if (uniqueConflict) return uniqueConflict(error);
      }
      throw error;
    }
  }
  throw new Error("SUPPORT_TRANSACTION_RETRY_EXHAUSTED");
}

function mapIncidentListItem(row: IncidentListRecord): SupportIncidentListItem {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    priority: row.priority,
    status: row.status,
    version: row.version,
    customer: row.customer,
    category: row.category,
    responsible: row.responsibleUser,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
function mapIncidentDetail(row: IncidentDetailRecord, canViewCommunications: boolean): SupportIncidentDetail {
  const incidentRef = { id: row.id, number: row.number };
  const actions = [
    ...row.actions.map((action) => ({ action, sourceIncident: incidentRef })),
    ...row.mergedDuplicates.flatMap((incident) => incident.actions.map((action) => ({ action, sourceIncident: { id: incident.id, number: incident.number } }))),
  ].sort((left, right) => left.action.performedAt.getTime() - right.action.performedAt.getTime() || left.action.id.localeCompare(right.action.id));
  const communications = canViewCommunications ? [
    ...row.communications.map((communication) => ({ communication, sourceIncident: incidentRef })),
    ...row.mergedDuplicates.flatMap((incident) => incident.communications.map((communication) => ({ communication, sourceIncident: { id: incident.id, number: incident.number } }))),
  ].sort((left, right) => left.communication.occurredAt.getTime() - right.communication.occurredAt.getTime() || left.communication.id.localeCompare(right.communication.id)) : [];
  return {
    ...mapIncidentListItem(row),
    description: row.description,
    solution: row.solution,
    closeReason: row.closeReason,
    closeReasonDetail: row.closeReasonDetail,
    store: row.store,
    createdBy: row.createdBy,
    actions: actions.map(({ action, sourceIncident }) => ({
      id: action.id,
      text: action.corrections[0]?.correctedText ?? action.text,
      originalText: action.text,
      version: action.corrections[0]?.resultingActionVersion ?? 1,
      performedAt: action.performedAt.toISOString(),
      recordedAt: action.recordedAt.toISOString(),
      author: action.authorUser,
      sourceIncident,
      correctionsHasMore: action.corrections.length > 100,
      corrections: action.corrections.slice(0, 100).reverse().map((correction) => ({
        id: correction.id,
        previousText: correction.previousText,
        correctedText: correction.correctedText,
        reason: correction.reason,
        version: correction.resultingActionVersion,
        correctedAt: correction.correctedAt.toISOString(),
        correctedBy: correction.correctedBy,
      })),
    })),
    communications: communications.map(({ communication, sourceIncident }) => ({
      id: communication.id,
      channel: communication.channel,
      direction: communication.direction,
      occurredAt: communication.occurredAt.toISOString(),
      summary: communication.summary,
      result: communication.result,
      registeredBy: communication.registeredBy,
      sourceIncident,
    })),
    events: row.events.map((event) => ({
      id: event.id,
      type: event.eventType,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      actor: event.actorUser,
      createdAt: event.createdAt.toISOString(),
    })),
    transitions: row.transitions.map((transition) => ({
      id: transition.id,
      fromStatus: transition.fromStatus,
      toStatus: transition.toStatus,
      reason: transition.reasonText,
      solution: transition.solutionText,
      closeReason: transition.closeReason,
      closeReasonDetail: transition.closeReasonDetail,
      actor: transition.actorUser,
      occurredAt: transition.occurredAt.toISOString(),
    })),
    collaborators: row.collaborators.map((collaborator) => ({
      ...collaborator,
      addedAt: collaborator.addedAt.toISOString(),
      removedAt: collaborator.removedAt?.toISOString() ?? null,
    })),
    participantChanges: row.participantChanges.map((change) => ({
      id: change.id,
      type: change.changeType,
      reason: change.reason,
      collaborator: change.collaborator,
      fromResponsible: change.fromResponsible,
      toResponsible: change.toResponsible,
      actor: change.actorUser,
      occurredAt: change.occurredAt.toISOString(),
    })),
    priorityChanges: row.priorityChanges.map((change) => ({
      id: change.id,
      fromPriority: change.fromPriority,
      toPriority: change.toPriority,
      reason: change.reason,
      actor: change.actorUser,
      occurredAt: change.occurredAt.toISOString(),
    })),
    detailsChanges: row.detailsChanges.slice(0, 100).reverse().map((change) => ({
      id: change.id,
      previousTitle: change.previousTitle,
      correctedTitle: change.correctedTitle,
      previousDescription: change.previousDescription,
      correctedDescription: change.correctedDescription,
      previousCategory: { id: change.previousCategoryId, name: change.previousCategoryName },
      correctedCategory: { id: change.correctedCategoryId, name: change.correctedCategoryName },
      previousStore: change.previousStoreId && change.previousStoreCode && change.previousStoreName ? { id: change.previousStoreId, code: change.previousStoreCode, name: change.previousStoreName } : null,
      correctedStore: change.correctedStoreId && change.correctedStoreCode && change.correctedStoreName ? { id: change.correctedStoreId, code: change.correctedStoreCode, name: change.correctedStoreName } : null,
      reason: change.reason,
      actor: change.actorUser,
      changedAt: change.changedAt.toISOString(),
    })),
    detailsChangesHasMore: row.detailsChanges.length > 100,
    mergedInto: row.mergedIntoIncident,
    mergedIncidents: row.mergedDuplicates.map(({ id, number, title }) => ({ id, number, title })),
  };
}
async function allocateIncidentNumber(
  tx: Prisma.TransactionClient,
  companyId: string,
) {
  const year = madridYear(new Date());
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-incident:${companyId}:${year}`}, 0))`;
  const sequence = await tx.supportIncidentNumberSequence.upsert({
    where: { companyId_year: { companyId, year } },
    update: { nextValue: { increment: 1 } },
    create: { companyId, year, nextValue: 2 },
    select: { nextValue: true },
  });
  const sequenceNumber = sequence.nextValue - 1;
  return {
    year,
    sequenceNumber,
    number: `INC-${year}-${String(sequenceNumber).padStart(5, "0")}`,
  };
}
function scopedKey(
  actor: SessionUser,
  context: SupportMutationContext,
): string {
  return `v1:support:${createHash("sha256").update(`${actor.id}:${context.scope}:${context.idempotencyKey}`).digest("hex")}`;
}
async function currentCompanyId(
  client: Pick<Prisma.TransactionClient, "installation">,
): Promise<string | null> {
  return (
    (
      await client.installation.findFirst({
        where: { companyId: { not: null } },
        select: { companyId: true },
      })
    )?.companyId ?? null
  );
}
async function normalizeSupportCategoryName(client: Prisma.TransactionClient, value: string): Promise<string> {
  const [row] = await client.$queryRaw<Array<{ value: string }>>(Prisma.sql`SELECT lower(unaccent(btrim(${value}))) AS "value"`);
  if (!row) throw new Error("SUPPORT_CATEGORY_NORMALIZATION_FAILED");
  return row.value;
}
function madridYear(value: Date): number {
  const part = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
  })
    .formatToParts(value)
    .find((item) => item.type === "year")?.value;
  if (!part) throw new Error("SUPPORT_BUSINESS_YEAR_UNAVAILABLE");
  return Number(part);
}
function encodeCursor(
  row: Pick<IncidentListRecord, "updatedAt" | "id">,
  filterHash: string,
): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, updatedAt: row.updatedAt.toISOString(), id: row.id, filterHash }), "utf8").toString("base64url");
  return `${payload}.${signCursor(payload)}`;
}
function decodeCursor(value: string, filterHash: string): { updatedAt: Date; id: string } | null {
  try {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    const expected = signCursor(payload);
    const submitted = Buffer.from(signature, "base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    if (submitted.toString("base64url") !== signature || submitted.length !== expectedBytes.length || !timingSafeEqual(submitted, expectedBytes)) return null;
    const parsed = z.object({ v: z.literal(1), updatedAt: z.string().datetime(), id: z.string().uuid(), filterHash: z.string().length(64) }).strict().safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return parsed.success && parsed.data.filterHash === filterHash ? { updatedAt: new Date(parsed.data.updatedAt), id: parsed.data.id } : null;
  } catch {
    return null;
  }
}
function signCursor(payload: string): string { return createHmac("sha256", getSessionSecret()).update(`support-incident-list-cursor:v1:${payload}`).digest("base64url"); }
function incidentFilterHash(command: Omit<ListSupportIncidentsCommand, "cursor" | "limit"> & { cursor?: string; limit?: number }): string {
  return createHash("sha256").update(JSON.stringify({ status: command.status ?? null, priority: command.priority ?? null, responsibleUserId: command.responsibleUserId ?? null, customerId: command.customerId ?? null, categoryId: command.categoryId ?? null, activeCollaboratorUserId: command.activeCollaboratorUserId ?? null, createdFrom: command.createdFrom ?? null, createdTo: command.createdTo ?? null, search: command.search ?? null })).digest("hex");
}
async function consumeSupportSearchRateLimit(companyId: string, actor: SessionUser, correlationId?: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const key = `support-incident-search:${companyId}:${actor.id}`;
    const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${key}, clock_timestamp(), 1, clock_timestamp(), clock_timestamp())
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '15 minutes' THEN 1 ELSE LEAST("rate_limit_buckets"."count" + 1, 32) END,
        "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '15 minutes' THEN clock_timestamp() ELSE "rate_limit_buckets"."windowStart" END,
        "updatedAt" = clock_timestamp()
      RETURNING "count"
    `);
    const count = rows[0]?.count ?? 0;
    if (count === 31) await tx.auditEvent.create({ data: { eventType: "SUPPORT_INCIDENT_SEARCH_RATE_LIMITED", actorType: "USER", payload: { actorUserId: actor.id, companyId, ...(correlationId ? { correlationId } : {}) } } });
    return count > 30;
  });
}
function isStatementTimeout(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2010" && error.meta?.code === "57014";
  }
  return error instanceof Prisma.PrismaClientUnknownRequestError
    && error.message.includes('code: "57014"')
    && error.message.includes("canceling statement due to statement timeout");
}
class SupportIncidentSearchCapacityError extends Error {}
function failure(
  status: 403 | 404 | 409 | 422 | 503,
  code: SupportErrorCode,
  message: string,
): SupportFailure {
  return { ok: false, status, error: { code, message } };
}
