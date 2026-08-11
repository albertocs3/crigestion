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
    cursor: z.string().max(256).optional(),
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
  durationSeconds: number | null;
  summary: string;
  result: z.infer<typeof resultSchema>;
  incidentId: string | null;
};
export type SupportCommunicationDto = Content & {
  id: string;
  customer: { id: string; code: string; legalName: string };
  incident: { id: string; number: string; title: string } | null;
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
  status: 404 | 409 | 422;
  error: {
    code:
      | "PLATFORM_NOT_INITIALIZED"
      | "SUPPORT_CUSTOMER_NOT_FOUND"
      | "SUPPORT_COMMUNICATION_NOT_FOUND"
      | "SUPPORT_COMMUNICATION_INCIDENT_INVALID"
      | "SUPPORT_COMMUNICATION_DATE_INVALID"
      | "SUPPORT_COMMUNICATION_VERSION_CONFLICT"
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
  durationSeconds: true,
  summary: true,
  result: true,
  incidentId: true,
  version: true,
  recordedAt: true,
  customer: { select: { id: true, code: true, legalName: true } },
  incident: { select: { id: true, number: true, title: true } },
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
type RecordDto = Prisma.SupportCommunicationGetPayload<{
  select: typeof detailSelect;
}>;
const replaySchema = z.custom<SupportCommunicationDto>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "version" in value,
);

export async function listSupportCommunications(
  command: z.infer<typeof listSupportCommunicationsSchema>,
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
  return {
    communications: page.map(mapDetail),
    nextCursor:
      rows.length > command.limit && page.length
        ? encodeCursor(page[page.length - 1]!)
        : null,
  };
}
export async function getSupportCommunication(id: string) {
  const companyId = await currentCompanyId(prisma);
  const row = companyId
    ? await prisma.supportCommunication.findFirst({
        where: { id, companyId },
        select: detailSelect,
      })
    : null;
  return row ? mapDetail(row) : null;
}
export async function listCommunicationReferences() {
  const companyId = await currentCompanyId(prisma);
  if (!companyId) return { customers: [], incidents: [] };
  const [customers, incidents] = await Promise.all([
    prisma.customer.findMany({
      orderBy: [{ legalName: "asc" }, { id: "asc" }],
      take: 500,
      select: { id: true, code: true, legalName: true },
    }),
    prisma.supportIncident.findMany({
      where: { companyId },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 500,
      select: { id: true, customerId: true, number: true, title: true },
    }),
  ]);
  return { customers, incidents };
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
        durationSeconds: number | null;
        summary: string;
        result: Content["result"];
        incidentId: string | null;
        version: number;
      }>
    >(
      Prisma.sql`SELECT "id", "companyId", "customerId", "channel", "direction", "occurredAt", "contactNumber", "durationSeconds", "summary", "result", "incidentId", "version" FROM "support_communications" WHERE "id" = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`,
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
    );
    if (incidentFailure) return incidentFailure;
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
  return prisma.$transaction(
    async (tx) => {
      const key = `v1:support:${createHash("sha256").update(`${actor.id}:${context.scope}:${context.idempotencyKey}`).digest("hex")}`;
      const replay = await tx.idempotencyRecord.findUnique({ where: { key } });
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
}
async function validateIncident(
  tx: Prisma.TransactionClient,
  companyId: string,
  customerId: string,
  incidentId: string | null,
): Promise<Failure | null> {
  if (!incidentId) return null;
  return (await tx.supportIncident.findFirst({
    where: { id: incidentId, companyId, customerId },
    select: { id: true },
  }))
    ? null
    : fail(
        422,
        "SUPPORT_COMMUNICATION_INCIDENT_INVALID",
        "La incidencia no pertenece al cliente seleccionado.",
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
