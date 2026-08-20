import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type {
  RequestContext,
  SessionUser,
} from "@/modules/platform/application/auth";

const channelSchema = z.enum(["PHONE", "WHATSAPP"]);
const directionSchema = z.enum(["INBOUND", "OUTBOUND"]);
const resultSchema = z.enum([
  "RESOLVED_NO_FOLLOW_UP",
  "REQUIRES_FOLLOW_UP",
  "NO_ANSWER",
  "INFORMATION_PROVIDED",
  "REFERRED_TO_INCIDENT",
]);
const contentShape = {
  channel: channelSchema,
  direction: directionSchema,
  occurredAt: z.string().datetime({ offset: true }),
  contactNumber: z.string().trim().min(3).max(40),
  durationSeconds: z.number().int().min(0).max(86_400).nullable(),
  summary: z.string().trim().min(3).max(2000),
  result: resultSchema,
  incidentId: z.string().uuid().nullable(),
  contactId: z.string().uuid().nullable().default(null),
};
export const createSupportCommunicationSchema = z
  .object({ customerId: z.string().uuid(), ...contentShape })
  .strict()
  .superRefine(validateContent);
export const correctSupportCommunicationSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    ...contentShape,
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .superRefine(validateContent);
export const listSupportCommunicationsSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z
      .string()
      .max(256)
      .refine(
        (value) => decodeCursor(value) !== null,
        "El cursor no es válido.",
      )
      .optional(),
    customerId: z.string().uuid().optional(),
    incidentId: z.string().uuid().optional(),
    channel: channelSchema.optional(),
  })
  .strict();
export const supportCommunicationParamsSchema = z
  .object({ communicationId: z.string().uuid() })
  .strict();
export type CreateCommunication = z.infer<
  typeof createSupportCommunicationSchema
>;
export type CorrectCommunication = z.infer<
  typeof correctSupportCommunicationSchema
>;
export type CommunicationContext = RequestContext & {
  idempotencyKey: string;
  requestHash: string;
  scope: string;
};
type Content = {
  channel: z.infer<typeof channelSchema>;
  direction: z.infer<typeof directionSchema>;
  occurredAt: string;
  contactNumber: string;
  contactId: string | null;
  durationSeconds: number | null;
  summary: string;
  result: z.infer<typeof resultSchema>;
  incidentId: string | null;
};
export type SupportCommunicationDto = Content & {
  id: string;
  customer: { id: string; code: string; legalName: string };
  incident: { id: string; number: string; title: string } | null;
  contact: { id: string; name: string | null; role: string | null } | null;
  registeredBy: { id: string; displayName: string };
  version: number;
  recordedAt: string;
  corrections: Array<{
    id: string;
    reason: string;
    previous: Content;
    corrected: Content;
    correctedBy: { id: string; displayName: string };
    correctedAt: string;
  }>;
};
type Failure = {
  ok: false;
  status: 404 | 409 | 422 | 429 | 503;
  error: {
    code:
      | "PLATFORM_NOT_INITIALIZED"
      | "SUPPORT_CUSTOMER_NOT_FOUND"
      | "SUPPORT_COMMUNICATION_NOT_FOUND"
      | "SUPPORT_COMMUNICATION_INCIDENT_INVALID"
      | "SUPPORT_COMMUNICATION_CONTACT_INVALID"
      | "SUPPORT_COMMUNICATION_DATE_INVALID"
      | "SUPPORT_COMMUNICATION_VERSION_CONFLICT"
      | "SUPPORT_COMMUNICATION_RATE_LIMITED"
      | "SUPPORT_COMMUNICATION_BUSY"
      | "IDEMPOTENCY_KEY_REUSED"
      | "IDEMPOTENCY_REPLAY_INVALID";
    message: string;
  };
};
type Result =
  { ok: true; status: 200 | 201; value: SupportCommunicationDto } | Failure;

const detailSelect = {
  id: true,
  channel: true,
  direction: true,
  occurredAt: true,
  contactNumber: true,
  contactId: true,
  durationSeconds: true,
  summary: true,
  result: true,
  incidentId: true,
  version: true,
  recordedAt: true,
  customer: { select: { id: true, code: true, legalName: true } },
  incident: { select: { id: true, number: true, title: true } },
  contact: { select: { id: true, name: true, role: true } },
  registeredBy: { select: { id: true, displayName: true } },
  corrections: {
    orderBy: [{ resultingVersion: "asc" as const }],
    select: {
      id: true,
      reason: true,
      previousChannel: true,
      correctedChannel: true,
      previousDirection: true,
      correctedDirection: true,
      previousOccurredAt: true,
      correctedOccurredAt: true,
      previousContactNumber: true,
      correctedContactNumber: true,
      previousContactId: true,
      correctedContactId: true,
      previousDurationSeconds: true,
      correctedDurationSeconds: true,
      previousSummary: true,
      correctedSummary: true,
      previousResult: true,
      correctedResult: true,
      previousIncidentId: true,
      correctedIncidentId: true,
      correctedAt: true,
      correctedByUser: { select: { id: true, displayName: true } },
    },
  },
} satisfies Prisma.SupportCommunicationSelect;
const customerReferenceSelect = {
  id: true,
  code: true,
  legalName: true,
} satisfies Prisma.CustomerSelect;
type RecordDto = Prisma.SupportCommunicationGetPayload<{
  select: typeof detailSelect;
}>;
const replayContentSchema = z
  .object({
    channel: channelSchema,
    direction: directionSchema,
    occurredAt: z.string().datetime({ offset: true }),
    contactNumber: z.string(),
    contactId: z.string().uuid().nullable().default(null),
    durationSeconds: z.number().int().nullable(),
    summary: z.string(),
    result: resultSchema,
    incidentId: z.string().uuid().nullable(),
  })
  .strict();
const replaySchema = z
  .object({
    id: z.string().uuid(),
    customer: z
      .object({
        id: z.string().uuid(),
        code: z.string(),
        legalName: z.string(),
      })
      .strict(),
    incident: z
      .object({ id: z.string().uuid(), number: z.string(), title: z.string() })
      .strict()
      .nullable(),
    contact: z
      .object({
        id: z.string().uuid(),
        name: z.string().nullable(),
        role: z.string().nullable(),
      })
      .strict()
      .nullable(),
    registeredBy: z
      .object({ id: z.string().uuid(), displayName: z.string() })
      .strict(),
    version: z.number().int().positive(),
    recordedAt: z.string().datetime({ offset: true }),
    corrections: z.array(
      z
        .object({
          id: z.string().uuid(),
          reason: z.string(),
          previous: replayContentSchema,
          corrected: replayContentSchema,
          correctedBy: z
            .object({ id: z.string().uuid(), displayName: z.string() })
            .strict(),
          correctedAt: z.string().datetime({ offset: true }),
        })
        .strict(),
    ),
    ...contentShape,
  })
  .strict();

export async function listSupportCommunications(
  command: z.infer<typeof listSupportCommunicationsSchema>,
  actor: SessionUser,
  context: RequestContext = {},
) {
  const companyId = await currentCompanyId(prisma);
  if (!companyId)
    return {
      communications: [] as SupportCommunicationDto[],
      nextCursor: null as string | null,
    };
  const cursor = command.cursor ? decodeCursor(command.cursor) : null;
  const rows = await prisma.supportCommunication.findMany({
    where: {
      companyId,
      ...(command.customerId ? { customerId: command.customerId } : {}),
      ...(command.incidentId ? { incidentId: command.incidentId } : {}),
      ...(command.channel ? { channel: command.channel } : {}),
      ...(cursor
        ? {
            OR: [
              { occurredAt: { lt: cursor.occurredAt } },
              { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: command.limit + 1,
    select: detailSelect,
  });
  const page = rows.slice(0, command.limit);
  await prisma.auditEvent.create({
    data: {
      eventType: "SUPPORT_COMMUNICATIONS_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        companyId,
        filteredByCustomer: Boolean(command.customerId),
        filteredByIncident: Boolean(command.incidentId),
        channel: command.channel ?? null,
        resultCount: page.length,
        ...(context.correlationId
          ? { correlationId: context.correlationId }
          : {}),
      },
    },
  });
  return {
    communications: page.map(mapDetail),
    nextCursor:
      rows.length > command.limit && page.length
        ? encodeCursor(page[page.length - 1]!)
        : null,
  };
}
export async function getSupportCommunication(
  id: string,
  actor: SessionUser,
  context: RequestContext = {},
) {
  const companyId = await currentCompanyId(prisma);
  const row = companyId
    ? await prisma.supportCommunication.findFirst({
        where: { id, companyId },
        select: detailSelect,
      })
    : null;
  if (!row) return null;
  await prisma.auditEvent.create({
    data: {
      eventType: "SUPPORT_COMMUNICATION_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        companyId,
        communicationId: row.id,
        customerId: row.customer.id,
        ...(context.correlationId
          ? { correlationId: context.correlationId }
          : {}),
      },
    },
  });
  return mapDetail(row);
}
export async function listCommunicationReferences(preferredCustomerId?: string) {
  const companyId = await currentCompanyId(prisma);
  if (!companyId) return { customers: [], incidents: [], contacts: [] };
  const [listedCustomers, preferredCustomer] = await Promise.all([
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
  ]);
  const customers =
    preferredCustomer &&
    !listedCustomers.some((customer) => customer.id === preferredCustomer.id)
      ? [...listedCustomers, preferredCustomer].sort(
          (left, right) =>
            left.legalName.localeCompare(right.legalName, "es") ||
            left.id.localeCompare(right.id),
        )
      : listedCustomers;
  const [incidents, contacts] = await Promise.all([
    prisma.supportIncident.findMany({
      where: { companyId, mergedIntoIncidentId: null },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 500,
      select: { id: true, customerId: true, number: true, title: true },
    }),
    prisma.customerContact.findMany({
      where: {
        status: "ACTIVE",
        customerId: { in: customers.map((customer) => customer.id) },
      },
      orderBy: [
        { customerId: "asc" },
        { storeId: "asc" },
        { name: "asc" },
        { id: "asc" },
      ],
      take: 1_000,
      select: {
        id: true,
        customerId: true,
        name: true,
        role: true,
        phone: true,
        mobile: true,
        whatsapp: true,
        store: { select: { code: true, name: true } },
      },
    }),
  ]);
  return { customers, incidents, contacts };
}

export async function createSupportCommunication(
  command: CreateCommunication,
  actor: SessionUser,
  context: CommunicationContext,
): Promise<Result> {
  return mutate(actor, context, async (tx) => {
    const companyId = await currentCompanyId(tx);
    if (!companyId)
      return fail(
        409,
        "PLATFORM_NOT_INITIALIZED",
        "La plataforma no está inicializada.",
      );
    if (
      !(await tx.customer.findUnique({
        where: { id: command.customerId },
        select: { id: true },
      }))
    )
      return fail(404, "SUPPORT_CUSTOMER_NOT_FOUND", "El cliente no existe.");
    const incidentFailure = await validateIncident(
      tx,
      companyId,
      command.customerId,
      command.incidentId,
    );
    if (incidentFailure) return incidentFailure;
    const contactFailure = await validateContact(
      tx,
      command.customerId,
      command.contactId,
      command.channel,
      command.contactNumber,
    );
    if (contactFailure) return contactFailure;
    const occurredAt = new Date(command.occurredAt);
    if (occurredAt.getTime() > Date.now() + 300_000)
      return fail(
        422,
        "SUPPORT_COMMUNICATION_DATE_INVALID",
        "La fecha de la comunicación no puede ser futura.",
      );
    const row = await tx.supportCommunication.create({
      data: {
        companyId,
        customerId: command.customerId,
        registeredByUserId: actor.id,
        channel: command.channel,
        direction: command.direction,
        occurredAt,
        contactNumber: command.contactNumber,
        contactId: command.contactId,
        durationSeconds: command.durationSeconds,
        summary: command.summary,
        result: command.result,
        incidentId: command.incidentId,
      },
      select: detailSelect,
    });
    const value = mapDetail(row);
    await tx.auditEvent.create({
      data: {
        eventType: "SUPPORT_COMMUNICATION_CREATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          companyId,
          communicationId: row.id,
          customerId: command.customerId,
          incidentId: command.incidentId,
          channel: command.channel,
          direction: command.direction,
          result: command.result,
          hasSummary: true,
          ...(context.correlationId
            ? { correlationId: context.correlationId }
            : {}),
        },
      },
    });
    return { ok: true, status: 201, value };
  });
}

export async function correctSupportCommunication(
  id: string,
  command: CorrectCommunication,
  actor: SessionUser,
  context: CommunicationContext,
): Promise<Result> {
  return mutate(actor, context, async (tx) => {
    const companyId = await currentCompanyId(tx);
    if (!companyId)
      return fail(
        404,
        "SUPPORT_COMMUNICATION_NOT_FOUND",
        "La comunicación no existe.",
      );
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        companyId: string;
        customerId: string;
        channel: Content["channel"];
        direction: Content["direction"];
        occurredAt: Date;
        contactNumber: string;
        contactId: string | null;
        durationSeconds: number | null;
        summary: string;
        result: Content["result"];
        incidentId: string | null;
        version: number;
      }>
    >(
      Prisma.sql`SELECT "id", "companyId", "customerId", "channel", "direction", "occurredAt", "contactNumber", "contactId", "durationSeconds", "summary", "result", "incidentId", "version" FROM "support_communications" WHERE "id" = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`,
    );
    const old = rows[0];
    if (!old)
      return fail(
        404,
        "SUPPORT_COMMUNICATION_NOT_FOUND",
        "La comunicación no existe.",
      );
    if (old.version !== command.expectedVersion)
      return fail(
        409,
        "SUPPORT_COMMUNICATION_VERSION_CONFLICT",
        "La comunicación ha cambiado. Recarga antes de continuar.",
      );
    const incidentFailure = await validateIncident(
      tx,
      companyId,
      old.customerId,
      command.incidentId,
      old.incidentId,
    );
    if (incidentFailure) return incidentFailure;
    const preservesHistoricalContact =
      command.contactId === old.contactId &&
      command.contactNumber === old.contactNumber &&
      command.channel === old.channel;
    if (!preservesHistoricalContact) {
      const contactFailure = await validateContact(
        tx,
        old.customerId,
        command.contactId,
        command.channel,
        command.contactNumber,
      );
      if (contactFailure) return contactFailure;
    }
    const occurredAt = new Date(command.occurredAt);
    if (occurredAt.getTime() > Date.now() + 300_000)
      return fail(
        422,
        "SUPPORT_COMMUNICATION_DATE_INVALID",
        "La fecha de la comunicación no puede ser futura.",
      );
    const resultingVersion = old.version + 1;
    await tx.supportCommunicationCorrection.create({
      data: {
        companyId,
        communicationId: id,
        correctedByUserId: actor.id,
        resultingVersion,
        previousChannel: old.channel,
        correctedChannel: command.channel,
        previousDirection: old.direction,
        correctedDirection: command.direction,
        previousOccurredAt: old.occurredAt,
        correctedOccurredAt: occurredAt,
        previousContactNumber: old.contactNumber,
        correctedContactNumber: command.contactNumber,
        previousContactId: old.contactId,
        correctedContactId: command.contactId,
        previousDurationSeconds: old.durationSeconds,
        correctedDurationSeconds: command.durationSeconds,
        previousSummary: old.summary,
        correctedSummary: command.summary,
        previousResult: old.result,
        correctedResult: command.result,
        previousIncidentId: old.incidentId,
        correctedIncidentId: command.incidentId,
        reason: command.reason,
      },
    });
    await tx.supportCommunication.update({
      where: { id },
      data: {
        channel: command.channel,
        direction: command.direction,
        occurredAt,
        contactNumber: command.contactNumber,
        contactId: command.contactId,
        durationSeconds: command.durationSeconds,
        summary: command.summary,
        result: command.result,
        incidentId: command.incidentId,
        version: resultingVersion,
      },
    });
    const row = await tx.supportCommunication.findUniqueOrThrow({
      where: { id },
      select: detailSelect,
    });
    const value = mapDetail(row);
    await tx.auditEvent.create({
      data: {
        eventType: "SUPPORT_COMMUNICATION_CORRECTED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          companyId,
          communicationId: id,
          customerId: old.customerId,
          previousVersion: old.version,
          version: resultingVersion,
          incidentChanged: old.incidentId !== command.incidentId,
          hasReason: true,
          hasSummary: true,
          ...(context.correlationId
            ? { correlationId: context.correlationId }
            : {}),
        },
      },
    });
    return { ok: true, status: 201, value };
  });
}

export function hashSupportCommunicationRequest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
async function mutate(
  actor: SessionUser,
  context: CommunicationContext,
  work: (
    tx: Prisma.TransactionClient,
  ) => Promise<
    { ok: true; status: 201; value: SupportCommunicationDto } | Failure
  >,
): Promise<Result> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const key = `v1:support:${createHash("sha256").update(`${actor.id}:${context.scope}:${context.idempotencyKey}`).digest("hex")}`;
          const replay = await tx.idempotencyRecord.findUnique({
            where: { key },
          });
          if (replay) {
            if (replay.requestHash !== context.requestHash)
              return fail(
                409,
                "IDEMPOTENCY_KEY_REUSED",
                "La clave de idempotencia ya se usó con otra petición.",
              );
            const parsed = replaySchema.safeParse(replay.responseBody);
            return parsed.success
              ? { ok: true, status: 200, value: parsed.data }
              : fail(
                  409,
                  "IDEMPOTENCY_REPLAY_INVALID",
                  "La respuesta idempotente almacenada no es válida.",
                );
          }
          const companyId = await currentCompanyId(tx);
          if (companyId) {
            const action =
              context.scope === "communication:create" ? "create" : "correct";
            const limited = await consumeRateLimit(
              tx,
              actor,
              companyId,
              action,
              context.correlationId,
            );
            if (limited)
              return fail(
                429,
                "SUPPORT_COMMUNICATION_RATE_LIMITED",
                "Demasiadas mutaciones de comunicaciones. Espere quince minutos.",
              );
          }
          const result = await work(tx);
          if (result.ok)
            await tx.idempotencyRecord.create({
              data: {
                key,
                requestHash: context.requestHash,
                responseStatus: 201,
                responseBody: result.value as unknown as Prisma.InputJsonValue,
              },
            });
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isRetryableTransactionError(error)) {
        if (attempt < 2) continue;
        return fail(
          503,
          "SUPPORT_COMMUNICATION_BUSY",
          "Las comunicaciones están ocupadas. Vuelva a intentarlo.",
        );
      }
      throw error;
    }
  }
  return fail(
    503,
    "SUPPORT_COMMUNICATION_BUSY",
    "Las comunicaciones están ocupadas. Vuelva a intentarlo.",
  );
}
async function consumeRateLimit(
  tx: Prisma.TransactionClient,
  actor: SessionUser,
  companyId: string,
  action: "create" | "correct",
  correlationId?: string,
): Promise<boolean> {
  const key = `support-communication-${action}:${companyId}:${actor.id}`;
  const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), ${key}, clock_timestamp(), 1, clock_timestamp(), clock_timestamp())
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '15 minutes' THEN 1
        ELSE "rate_limit_buckets"."count" + 1
      END,
      "windowStart" = CASE
        WHEN "rate_limit_buckets"."windowStart" <= clock_timestamp() - INTERVAL '15 minutes' THEN clock_timestamp()
        ELSE "rate_limit_buckets"."windowStart"
      END,
      "updatedAt" = clock_timestamp()
    RETURNING "count"
  `);
  const count = rows[0]?.count ?? 0;
  if (count === 21)
    await tx.auditEvent.create({
      data: {
        eventType: "SUPPORT_COMMUNICATION_RATE_LIMITED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          companyId,
          action,
          ...(correlationId ? { correlationId } : {}),
        },
      },
    });
  return count > 20;
}
function isRetryableTransactionError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" ||
      (error.code === "P2010" && error.meta?.code === "40001"))
  );
}
async function validateIncident(
  tx: Prisma.TransactionClient,
  companyId: string,
  customerId: string,
  incidentId: string | null,
  existingIncidentId: string | null = null,
): Promise<Failure | null> {
  if (!incidentId) return null;
  const rows = await tx.$queryRaw<Array<{ id: string; mergedIntoIncidentId: string | null }>>(Prisma.sql`
    SELECT "id", "mergedIntoIncidentId"
    FROM "support_incidents"
    WHERE "id" = ${incidentId}::uuid
      AND "companyId" = ${companyId}::uuid
      AND "customerId" = ${customerId}::uuid
    FOR SHARE
  `);
  const incident = rows[0];
  return (incident && (!incident.mergedIntoIncidentId || incidentId === existingIncidentId))
    ? null
    : fail(
        422,
        "SUPPORT_COMMUNICATION_INCIDENT_INVALID",
        "La incidencia no pertenece al cliente seleccionado o ya fue fusionada.",
      );
}
async function validateContact(
  tx: Prisma.TransactionClient,
  customerId: string,
  contactId: string | null,
  channel: Content["channel"],
  contactNumber: string,
): Promise<Failure | null> {
  if (!contactId) return null;
  const contact = await tx.customerContact.findFirst({
    where: { id: contactId, customerId, status: "ACTIVE" },
    select: { phone: true, mobile: true, whatsapp: true },
  });
  const validNumbers = contact
    ? channel === "WHATSAPP"
      ? [contact.whatsapp]
      : [contact.phone, contact.mobile]
    : [];
  return validNumbers.includes(contactNumber)
    ? null
    : fail(
        422,
        "SUPPORT_COMMUNICATION_CONTACT_INVALID",
        "El contacto o el número no son válidos para el canal seleccionado.",
      );
}
function validateContent(
  value: {
    channel: string;
    durationSeconds: number | null;
    result: string;
    incidentId: string | null;
  },
  ctx: z.RefinementCtx,
) {
  if (value.channel === "WHATSAPP" && value.durationSeconds !== null)
    ctx.addIssue({
      code: "custom",
      path: ["durationSeconds"],
      message: "WhatsApp no admite duración de llamada.",
    });
  if (
    (value.result === "REQUIRES_FOLLOW_UP" ||
      value.result === "REFERRED_TO_INCIDENT") &&
    !value.incidentId
  )
    ctx.addIssue({
      code: "custom",
      path: ["incidentId"],
      message: "El resultado requiere una incidencia vinculada.",
    });
}
function mapDetail(row: RecordDto): SupportCommunicationDto {
  const current: Content = {
    channel: row.channel,
    direction: row.direction,
    occurredAt: row.occurredAt.toISOString(),
    contactNumber: row.contactNumber,
    contactId: row.contactId,
    durationSeconds: row.durationSeconds,
    summary: row.summary,
    result: row.result,
    incidentId: row.incidentId,
  };
  return {
    id: row.id,
    ...current,
    customer: row.customer,
    incident: row.incident,
    contact: row.contact,
    registeredBy: row.registeredBy,
    version: row.version,
    recordedAt: row.recordedAt.toISOString(),
    corrections: row.corrections.map((item) => ({
      id: item.id,
      reason: item.reason,
      previous: {
        channel: item.previousChannel,
        direction: item.previousDirection,
        occurredAt: item.previousOccurredAt.toISOString(),
        contactNumber: item.previousContactNumber,
        contactId: item.previousContactId,
        durationSeconds: item.previousDurationSeconds,
        summary: item.previousSummary,
        result: item.previousResult,
        incidentId: item.previousIncidentId,
      },
      corrected: {
        channel: item.correctedChannel,
        direction: item.correctedDirection,
        occurredAt: item.correctedOccurredAt.toISOString(),
        contactNumber: item.correctedContactNumber,
        contactId: item.correctedContactId,
        durationSeconds: item.correctedDurationSeconds,
        summary: item.correctedSummary,
        result: item.correctedResult,
        incidentId: item.correctedIncidentId,
      },
      correctedBy: item.correctedByUser,
      correctedAt: item.correctedAt.toISOString(),
    })),
  };
}
function encodeCursor(row: { occurredAt: Date; id: string }) {
  return Buffer.from(
    JSON.stringify({ occurredAt: row.occurredAt.toISOString(), id: row.id }),
    "utf8",
  ).toString("base64url");
}
function decodeCursor(value: string): { occurredAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as { occurredAt?: string; id?: string };
    const occurredAt = new Date(parsed.occurredAt ?? "");
    return parsed.id &&
      z.string().uuid().safeParse(parsed.id).success &&
      !Number.isNaN(occurredAt.getTime())
      ? { occurredAt, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}
async function currentCompanyId(
  client: Pick<Prisma.TransactionClient, "installation">,
) {
  return (
    (
      await client.installation.findFirst({
        where: { companyId: { not: null } },
        select: { companyId: true },
      })
    )?.companyId ?? null
  );
}
function fail(
  status: Failure["status"],
  code: Failure["error"]["code"],
  message: string,
): Failure {
  return { ok: false, status, error: { code, message } };
}
