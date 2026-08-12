import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type {
  RequestContext,
  SessionUser,
} from "@/modules/platform/application/auth";
import { createIncidentCreatedNotifications } from "@/modules/platform/application/notifications";

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
    cursor: z
      .string()
      .max(256)
      .refine(
        (value) => decodeCursor(value) !== null,
        "El cursor no es valido.",
      )
      .optional(),
    status: statusSchema.optional(),
    priority: prioritySchema.optional(),
    responsibleUserId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    search: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

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
    performedAt: string;
    recordedAt: string;
    author: { id: string; displayName: string };
    sourceIncident: { id: string; number: string } | null;
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
  mergedInto: { id: string; number: string } | null;
  mergedIncidents: Array<{ id: string; number: string; title: string }>;
};

export type SupportCategoryDto = {
  id: string;
  name: string;
  description: string | null;
  color: string;
  isActive: boolean;
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
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_REPLAY_INVALID";
type SupportFailure = {
  ok: false;
  status: 404 | 409 | 422;
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
          performedAt: z.string().datetime(),
          recordedAt: z.string().datetime(),
          author: z
            .object({ id: z.string().uuid(), displayName: z.string() })
            .strict(),
          sourceIncident: z.object({ id: z.string().uuid(), number: z.string() }).strict().nullable().optional().transform((value) => value ?? null),
        })
        .strict(),
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
  })
  .strict();

export async function listSupportIncidents(
  command: ListSupportIncidentsCommand,
  actor: SessionUser,
) {
  const companyId = await currentCompanyId(prisma);
  if (!companyId)
    return {
      incidents: [] as SupportIncidentListItem[],
      nextCursor: null as string | null,
    };
  const cursor = command.cursor ? decodeCursor(command.cursor) : null;
  const rows = await prisma.supportIncident.findMany({
    where: {
      companyId,
      ...(command.status ? { status: command.status } : {}),
      ...(command.priority ? { priority: command.priority } : {}),
      ...(command.responsibleUserId
        ? { responsibleUserId: command.responsibleUserId }
        : {}),
      ...(command.customerId ? { customerId: command.customerId } : {}),
      ...(command.search
        ? {
            OR: [
              { number: { contains: command.search, mode: "insensitive" } },
              { title: { contains: command.search, mode: "insensitive" } },
              {
                description: { contains: command.search, mode: "insensitive" },
              },
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
  });
  const page = rows.slice(0, command.limit);
  await prisma.auditEvent.create({
    data: {
      eventType: "SUPPORT_INCIDENTS_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        companyId,
        hasSearch: Boolean(command.search),
        status: command.status ?? null,
        priority: command.priority ?? null,
        resultCount: page.length,
      },
    },
  });
  return {
    incidents: page.map(mapIncidentListItem),
    nextCursor:
      rows.length > command.limit && page.length
        ? encodeCursor(page[page.length - 1]!)
        : null,
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

export async function listSupportReferences(): Promise<SupportIncidentReferences> {
  const companyId = await currentCompanyId(prisma);
  if (!companyId)
    return { customers: [], categories: [], responsibleUsers: [] };
  const [customers, categories, responsibleUsers] = await Promise.all([
    prisma.customer.findMany({
      orderBy: [{ legalName: "asc" }, { id: "asc" }],
      take: 500,
      select: {
        id: true,
        code: true,
        legalName: true,
        status: true,
        stores: {
          orderBy: [{ name: "asc" }, { id: "asc" }],
          select: { id: true, code: true, name: true, status: true },
        },
      },
    }),
    prisma.supportIncidentCategory.findMany({
      where: { companyId, isActive: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        description: true,
        color: true,
        isActive: true,
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
  return { customers, categories, responsibleUsers };
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
    const [customer, category, responsible, store] = await Promise.all([
      tx.customer.findUnique({
        where: { id: command.customerId },
        select: { id: true },
      }),
      tx.supportIncidentCategory.findFirst({
        where: { id: command.categoryId, companyId, isActive: true },
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
    const [category, responsible, store] = await Promise.all([
      tx.supportIncidentCategory.findFirst({
        where: { id: command.categoryId, companyId, isActive: true },
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
          normalizedName: normalizeName(command.name),
          description: command.description,
          color: command.color,
        },
        select: {
          id: true,
          name: true,
          description: true,
          color: true,
          isActive: true,
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
            color: category.color,
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
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034" &&
        attempt < 2
      )
        continue;
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
      text: action.text,
      performedAt: action.performedAt.toISOString(),
      recordedAt: action.recordedAt.toISOString(),
      author: action.authorUser,
      sourceIncident,
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
function normalizeName(value: string): string {
  return value
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-ES");
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
): string {
  return Buffer.from(
    JSON.stringify([row.updatedAt.toISOString(), row.id]),
    "utf8",
  ).toString("base64url");
}
function decodeCursor(value: string): { updatedAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !z.string().datetime().safeParse(parsed[0]).success ||
      !z.string().uuid().safeParse(parsed[1]).success
    )
      return null;
    return { updatedAt: new Date(parsed[0]), id: parsed[1] };
  } catch {
    return null;
  }
}
function failure(
  status: 404 | 409 | 422,
  code: SupportErrorCode,
  message: string,
): SupportFailure {
  return { ok: false, status, error: { code, message } };
}
