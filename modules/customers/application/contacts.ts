import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type {
  RequestContext,
  SessionUser,
} from "@/modules/platform/application/auth";
import { syncLegacyProjectionFromContact } from "@/modules/customers/application/contactSync";

const nullableText = (min: number, max: number) =>
  z.string().trim().min(min).max(max).nullable();
const contactFields = {
  name: nullableText(2, 160),
  role: nullableText(2, 120),
  phone: nullableText(3, 40),
  mobile: nullableText(3, 40),
  whatsapp: nullableText(3, 40),
  email: z.string().trim().email().nullable(),
};
function requireContactValue(
  value: Record<keyof typeof contactFields, string | null>,
  context: z.RefinementCtx,
) {
  if (
    ![value.name, value.phone, value.mobile, value.whatsapp, value.email].some(
      Boolean,
    )
  )
    context.addIssue({
      code: "custom",
      message: "El contacto debe incluir al menos un dato.",
    });
}
export const createCustomerContactSchema = z
  .object({
    storeId: z.string().uuid().nullable().default(null),
    ...contactFields,
  })
  .strict()
  .superRefine(requireContactValue);
export const updateCustomerContactSchema = z
  .object({ expectedVersion: z.number().int().positive(), ...contactFields })
  .strict()
  .superRefine((value, context) =>
    requireContactValue(
      {
        name: value.name,
        role: value.role,
        phone: value.phone,
        mobile: value.mobile,
        whatsapp: value.whatsapp,
        email: value.email,
      },
      context,
    ),
  );
export const customerContactActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("update"),
      contact: updateCustomerContactSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("deactivate"),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("reactivate"),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
]);
export const customerContactParamsSchema = z
  .object({
    customerId: z.string().uuid(),
    contactId: z.string().uuid().optional(),
  })
  .strict();

type Context = RequestContext & {
  idempotencyKey: string;
  requestHash: string;
  scope: string;
};
export type CustomerContactDto = {
  id: string;
  customerId: string;
  store: { id: string; code: string; name: string } | null;
  name: string | null;
  role: string | null;
  phone: string | null;
  mobile: string | null;
  whatsapp: string | null;
  email: string | null;
  status: "ACTIVE" | "INACTIVE";
  version: number;
  createdAt: string;
  updatedAt: string;
};
type Failure = {
  ok: false;
  status: 404 | 409 | 422 | 503;
  error: {
    code:
      | "CUSTOMER_NOT_FOUND"
      | "CUSTOMER_CONTACT_NOT_FOUND"
      | "CUSTOMER_CONTACT_STORE_INVALID"
      | "CUSTOMER_CONTACT_SLOT_OCCUPIED"
      | "CUSTOMER_CONTACT_VERSION_CONFLICT"
      | "CUSTOMER_CONTACT_STATUS_ALREADY_SET"
      | "CUSTOMER_CONTACT_BUSY"
      | "IDEMPOTENCY_KEY_REUSED"
      | "IDEMPOTENCY_REPLAY_INVALID";
    message: string;
  };
};
type Result =
  { ok: true; status: 200 | 201; value: CustomerContactDto } | Failure;
const select = {
  id: true,
  customerId: true,
  name: true,
  role: true,
  phone: true,
  mobile: true,
  whatsapp: true,
  email: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  store: { select: { id: true, code: true, name: true } },
} satisfies Prisma.CustomerContactSelect;
type Row = Prisma.CustomerContactGetPayload<{ select: typeof select }>;
const replaySchema: z.ZodType<CustomerContactDto> = z
  .object({
    id: z.string().uuid(),
    customerId: z.string().uuid(),
    store: z
      .object({ id: z.string().uuid(), code: z.string(), name: z.string() })
      .strict()
      .nullable(),
    ...contactFields,
    status: z.enum(["ACTIVE", "INACTIVE"]),
    version: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export async function listCustomerContacts(
  customerId: string,
  actor: SessionUser,
) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, code: true, legalName: true, status: true },
  });
  if (!customer) return null;
  const rows = await prisma.customerContact.findMany({
    where: { customerId },
    orderBy: [
      { status: "asc" },
      { storeId: "asc" },
      { name: "asc" },
      { id: "asc" },
    ],
    select,
  });
  await prisma.auditEvent.create({
    data: {
      eventType: "CUSTOMER_CONTACTS_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        customerId,
        customerCode: customer.code,
        resultCount: rows.length,
      },
    },
  });
  return { customer, contacts: rows.map(map) };
}

export async function createCustomerContact(
  customerId: string,
  command: z.infer<typeof createCustomerContactSchema>,
  actor: SessionUser,
  context: Context,
): Promise<Result> {
  return mutate(actor, context, async (tx) => {
    const customers = await tx.$queryRaw<Array<{ id: string; code: string }>>(
      Prisma.sql`SELECT "id", "code" FROM "customers" WHERE "id" = ${customerId}::uuid FOR UPDATE`,
    );
    const customer = customers[0];
    if (!customer)
      return fail(404, "CUSTOMER_NOT_FOUND", "El cliente no existe.");
    if (command.storeId) {
      const stores = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT "id" FROM "customer_stores" WHERE "id" = ${command.storeId}::uuid AND "customerId" = ${customerId}::uuid FOR UPDATE`,
      );
      if (!stores[0])
        return fail(
          422,
          "CUSTOMER_CONTACT_STORE_INVALID",
          "La tienda no pertenece al cliente.",
        );
    }
    if (
      await tx.customerContact.findFirst({
        where: { customerId, storeId: command.storeId },
        select: { id: true },
      })
    )
      return fail(
        409,
        "CUSTOMER_CONTACT_SLOT_OCCUPIED",
        "El cliente o la tienda ya tiene contacto.",
      );
    const row = await tx.customerContact.create({
      data: { customerId, ...command, createdById: actor.id },
      select,
    });
    await syncLegacyProjectionFromContact(
      tx,
      {
        customerId,
        storeId: row.store?.id ?? null,
        name: row.name,
        role: row.role,
        phone: row.phone,
        mobile: row.mobile,
        whatsapp: row.whatsapp,
        email: row.email,
        status: row.status,
      },
      actor.id,
    );
    await audit(
      tx,
      "CUSTOMER_CONTACT_CREATED",
      actor,
      context,
      customerId,
      row.id,
      {
        customerCode: customer.code,
        hasStore: Boolean(command.storeId),
      },
    );
    return { ok: true, status: 201, value: map(row) };
  });
}

export async function changeCustomerContact(
  customerId: string,
  contactId: string,
  command: z.infer<typeof customerContactActionSchema>,
  actor: SessionUser,
  context: Context,
): Promise<Result> {
  return mutate(actor, context, async (tx) => {
    const customers = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "customers" WHERE "id" = ${customerId}::uuid FOR UPDATE`,
    );
    if (!customers[0])
      return fail(404, "CUSTOMER_CONTACT_NOT_FOUND", "El contacto no existe.");
    const scope = await tx.customerContact.findFirst({
      where: { id: contactId, customerId },
      select: { storeId: true },
    });
    if (!scope)
      return fail(404, "CUSTOMER_CONTACT_NOT_FOUND", "El contacto no existe.");
    if (scope.storeId)
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "customer_stores" WHERE "id" = ${scope.storeId}::uuid AND "customerId" = ${customerId}::uuid FOR UPDATE`,
      );
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "customer_contacts" WHERE "id" = ${contactId}::uuid AND "customerId" = ${customerId}::uuid FOR UPDATE`,
    );
    const old = await tx.customerContact.findFirst({
      where: { id: contactId, customerId },
      select,
    });
    if (!old)
      return fail(404, "CUSTOMER_CONTACT_NOT_FOUND", "El contacto no existe.");
    const expectedVersion =
      command.action === "update"
        ? command.contact.expectedVersion
        : command.expectedVersion;
    if (old.version !== expectedVersion)
      return fail(
        409,
        "CUSTOMER_CONTACT_VERSION_CONFLICT",
        "El contacto ha cambiado. Recarga antes de continuar.",
      );
    const nextStatus =
      command.action === "deactivate"
        ? "INACTIVE"
        : command.action === "reactivate"
          ? "ACTIVE"
          : old.status;
    if (command.action !== "update" && old.status === nextStatus)
      return fail(
        409,
        "CUSTOMER_CONTACT_STATUS_ALREADY_SET",
        "El contacto ya tiene ese estado.",
      );
    const data = (() => {
      if (command.action !== "update")
        return {
          status: nextStatus,
          updatedById: actor.id,
          version: { increment: 1 },
        };
      return {
        name: command.contact.name,
        role: command.contact.role,
        phone: command.contact.phone,
        mobile: command.contact.mobile,
        whatsapp: command.contact.whatsapp,
        email: command.contact.email,
        updatedById: actor.id,
        version: { increment: 1 },
      };
    })();
    const row = await tx.customerContact.update({
      where: { id: contactId },
      data,
      select,
    });
    await syncLegacyProjectionFromContact(
      tx,
      {
        customerId,
        storeId: row.store?.id ?? null,
        name: row.name,
        role: row.role,
        phone: row.phone,
        mobile: row.mobile,
        whatsapp: row.whatsapp,
        email: row.email,
        status: row.status,
      },
      actor.id,
    );
    await audit(
      tx,
      command.action === "update"
        ? "CUSTOMER_CONTACT_UPDATED"
        : nextStatus === "ACTIVE"
          ? "CUSTOMER_CONTACT_REACTIVATED"
          : "CUSTOMER_CONTACT_DEACTIVATED",
      actor,
      context,
      customerId,
      contactId,
      {
        previousVersion: old.version,
        version: row.version,
        ...(command.action === "update"
          ? { changedFields: changedFields(old, command.contact) }
          : {}),
      },
    );
    return { ok: true, status: 200, value: map(row) };
  });
}

export function hashCustomerContactRequest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
async function mutate(
  actor: SessionUser,
  context: Context,
  work: (
    tx: Prisma.TransactionClient,
  ) => Promise<
    { ok: true; status: 200 | 201; value: CustomerContactDto } | Failure
  >,
): Promise<Result> {
  const key = scopedKey(actor, context);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const replay = await tx.idempotencyRecord.findUnique({
            where: { key },
          });
          if (replay)
            return parseReplay(
              replay.requestHash,
              context.requestHash,
              replay.responseBody,
            );
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
      if (isRetryableTransactionError(error)) {
        if (attempt < 2) continue;
        return fail(
          503,
          "CUSTOMER_CONTACT_BUSY",
          "Los contactos están ocupados. Vuelva a intentarlo.",
        );
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const replay = await prisma.idempotencyRecord.findUnique({
          where: { key },
        });
        if (replay)
          return parseReplay(
            replay.requestHash,
            context.requestHash,
            replay.responseBody,
          );
        return fail(
          409,
          "CUSTOMER_CONTACT_SLOT_OCCUPIED",
          "El cliente o la tienda ya tiene contacto.",
        );
      }
      throw error;
    }
  }
  return fail(
    503,
    "CUSTOMER_CONTACT_BUSY",
    "Los contactos están ocupados. Vuelva a intentarlo.",
  );
}
function scopedKey(actor: SessionUser, context: Context) {
  return `v1:customer-contact:${createHash("sha256").update(`${actor.id}:${context.scope}:${context.idempotencyKey}`).digest("hex")}`;
}
function parseReplay(
  storedHash: string,
  requestHash: string,
  responseBody: Prisma.JsonValue,
): Result {
  if (storedHash !== requestHash)
    return fail(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "La clave ya se uso con otra peticion.",
    );
  const parsed = replaySchema.safeParse(responseBody);
  return parsed.success
    ? { ok: true, status: 200, value: parsed.data }
    : fail(
        409,
        "IDEMPOTENCY_REPLAY_INVALID",
        "El replay almacenado no es valido.",
      );
}
function isRetryableTransactionError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" ||
      (error.code === "P2010" && error.meta?.code === "40001"))
  );
}
async function audit(
  tx: Prisma.TransactionClient,
  eventType: string,
  actor: SessionUser,
  context: Context,
  customerId: string,
  contactId: string,
  extra: Record<string, unknown>,
) {
  await tx.auditEvent.create({
    data: {
      eventType,
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        customerId,
        contactId,
        ...extra,
        ...(context.correlationId
          ? { correlationId: context.correlationId }
          : {}),
      },
    },
  });
}
function map(row: Row): CustomerContactDto {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
function changedFields(
  old: Row,
  next: z.infer<typeof updateCustomerContactSchema>,
) {
  return (
    ["name", "role", "phone", "mobile", "whatsapp", "email"] as const
  ).filter((key) => old[key] !== next[key]);
}
function fail(
  status: Failure["status"],
  code: Failure["error"]["code"],
  message: string,
): Failure {
  return { ok: false, status, error: { code, message } };
}
