import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type {
  RequestContext,
  SessionUser
} from "@/modules/platform/application/auth";

const storeStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);

const storeDataSchema = z.object({
  name: z.string().trim().min(2).max(160),
  isPrimary: z.boolean().default(false),
  addressLine: z.string().trim().min(3).max(240),
  postalCode: z.string().trim().min(2).max(20),
  city: z.string().trim().min(2).max(120),
  province: z.string().trim().min(1).max(120).nullable(),
  country: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toLocaleUpperCase("es-ES")),
  email: z.string().trim().email().nullable(),
  phone: z.string().trim().min(3).max(40).nullable(),
  whatsapp: z.string().trim().min(3).max(40).nullable(),
  contactName: z.string().trim().min(2).max(160).nullable(),
  contactRole: z.string().trim().min(2).max(120).nullable(),
  contactPhone: z.string().trim().min(3).max(40).nullable(),
  contactMobile: z.string().trim().min(3).max(40).nullable(),
  contactWhatsapp: z.string().trim().min(3).max(40).nullable(),
  contactEmail: z.string().trim().email().nullable(),
  notes: z.string().trim().min(1).max(1000).nullable()
}).strict();

export const listCustomerStoresSchema = z.object({
  status: storeStatusSchema.optional()
});

export const createCustomerStoreSchema = storeDataSchema;
export const updateCustomerStoreSchema = storeDataSchema;
export const updateCustomerStoreStatusSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("deactivate")
  }).strict(),
  z.object({
    action: z.literal("reactivate")
  }).strict()
]);

export type ListCustomerStoresCommand = z.infer<typeof listCustomerStoresSchema>;
export type CreateCustomerStoreCommand = z.infer<typeof createCustomerStoreSchema>;
export type UpdateCustomerStoreCommand = z.infer<typeof updateCustomerStoreSchema>;
export type UpdateCustomerStoreStatusCommand = z.infer<
  typeof updateCustomerStoreStatusSchema
>;

export type CustomerStoreListItem = {
  id: string;
  customerId: string;
  code: string;
  name: string;
  status: "ACTIVE" | "INACTIVE";
  isPrimary: boolean;
  address: {
    line: string;
    postalCode: string;
    city: string;
    province: string | null;
    country: string;
  };
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  contact: {
    name: string | null;
    role: string | null;
    phone: string | null;
    mobile: string | null;
    whatsapp: string | null;
    email: string | null;
  };
  createdAt: string;
  updatedAt: string;
};

export type CustomerStorePage = {
  customer: {
    id: string;
    code: string;
    legalName: string;
    status: "ACTIVE" | "INACTIVE";
  };
  stores: CustomerStoreListItem[];
};

type CustomerStoreNotFoundResult = {
  ok: false;
  status: 404;
  error: {
    code: "CUSTOMER_NOT_FOUND" | "CUSTOMER_STORE_NOT_FOUND";
    message: string;
  };
};

type CustomerStoreStatusAlreadySetResult = {
  ok: false;
  status: 409;
  error: {
    code: "CUSTOMER_STORE_STATUS_ALREADY_SET";
    message: string;
  };
};

export type CreateCustomerStoreResult =
  | { ok: true; status: 201; value: CustomerStoreListItem }
  | CustomerStoreNotFoundResult;

export type UpdateCustomerStoreResult =
  | { ok: true; status: 200; value: CustomerStoreListItem }
  | CustomerStoreNotFoundResult;

export type UpdateCustomerStoreStatusResult =
  | { ok: true; status: 200; value: CustomerStoreListItem }
  | CustomerStoreNotFoundResult
  | CustomerStoreStatusAlreadySetResult;

export async function listCustomerStores(
  customerId: string,
  command: ListCustomerStoresCommand,
  actor: SessionUser
): Promise<CustomerStorePage | null> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      id: true,
      code: true,
      legalName: true,
      status: true
    }
  });

  if (!customer) {
    return null;
  }

  const stores = await prisma.customerStore.findMany({
    where: {
      customerId,
      ...(command.status ? { status: command.status } : {})
    },
    orderBy: [{ isPrimary: "desc" }, { name: "asc" }, { id: "asc" }],
    select: customerStoreSelect
  });

  await prisma.auditEvent.create({
    data: {
      eventType: "CUSTOMER_STORES_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        customerId,
        customerCode: customer.code,
        status: command.status ?? null,
        resultCount: stores.length
      }
    }
  });

  return {
    customer,
    stores: stores.map(mapCustomerStoreListItem)
  };
}

export async function createCustomerStore(
  customerId: string,
  command: CreateCustomerStoreCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CreateCustomerStoreResult> {
  const result = await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        code: true
      }
    });

    if (!customer) {
      return { kind: "customer-not-found" as const };
    }

    if (command.isPrimary) {
      await tx.customerStore.updateMany({
        where: { customerId, isPrimary: true },
        data: { isPrimary: false, updatedById: actor.id }
      });
    }

    const code = await nextCustomerStoreCode(tx);
    const store = await tx.customerStore.create({
      data: {
        ...command,
        code,
        customerId,
        status: "ACTIVE",
        createdById: actor.id
      },
      select: customerStoreSelect
    });

    await tx.auditEvent.create({
      data: {
        eventType: "CUSTOMER_STORE_CREATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          customerId,
          customerCode: customer.code,
          storeId: store.id,
          storeCode: store.code,
          isPrimary: store.isPrimary,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { kind: "created" as const, store };
  });

  if (result.kind === "customer-not-found") {
    return customerNotFound();
  }

  return {
    ok: true,
    status: 201,
    value: mapCustomerStoreListItem(result.store)
  };
}

export async function updateCustomerStore(
  customerId: string,
  storeId: string,
  command: UpdateCustomerStoreCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<UpdateCustomerStoreResult> {
  const result = await prisma.$transaction(async (tx) => {
    const existingStore = await tx.customerStore.findFirst({
      where: { id: storeId, customerId },
      select: {
        id: true,
        code: true,
        name: true,
        isPrimary: true,
        addressLine: true,
        postalCode: true,
        city: true,
        province: true,
        country: true,
        email: true,
        phone: true,
        whatsapp: true,
        contactName: true,
        contactRole: true,
        contactPhone: true,
        contactMobile: true,
        contactWhatsapp: true,
        contactEmail: true,
        notes: true,
        customer: {
          select: {
            code: true
          }
        }
      }
    });

    if (!existingStore) {
      const customer = await tx.customer.findUnique({
        where: { id: customerId },
        select: { id: true }
      });

      return customer
        ? { kind: "store-not-found" as const }
        : { kind: "customer-not-found" as const };
    }

    if (command.isPrimary) {
      await tx.customerStore.updateMany({
        where: { customerId, isPrimary: true, id: { not: storeId } },
        data: { isPrimary: false, updatedById: actor.id }
      });
    }

    const changedFields = changedStoreFields(existingStore, command);
    const store = await tx.customerStore.update({
      where: { id: storeId },
      data: {
        ...command,
        updatedById: actor.id
      },
      select: customerStoreSelect
    });

    await tx.auditEvent.create({
      data: {
        eventType: "CUSTOMER_STORE_UPDATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          customerId,
          customerCode: existingStore.customer.code,
          storeId,
          storeCode: existingStore.code,
          changedFields,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { kind: "updated" as const, store };
  });

  if (result.kind === "customer-not-found") {
    return customerNotFound();
  }

  if (result.kind === "store-not-found") {
    return customerStoreNotFound();
  }

  return {
    ok: true,
    status: 200,
    value: mapCustomerStoreListItem(result.store)
  };
}

export async function updateCustomerStoreStatus(
  customerId: string,
  storeId: string,
  command: UpdateCustomerStoreStatusCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<UpdateCustomerStoreStatusResult> {
  const nextStatus = command.action === "deactivate" ? "INACTIVE" : "ACTIVE";
  const eventType =
    command.action === "deactivate"
      ? "CUSTOMER_STORE_DEACTIVATED"
      : "CUSTOMER_STORE_REACTIVATED";

  const result = await prisma.$transaction(async (tx) => {
    const existingStore = await tx.customerStore.findFirst({
      where: { id: storeId, customerId },
      select: {
        id: true,
        code: true,
        status: true,
        customer: {
          select: {
            code: true
          }
        }
      }
    });

    if (!existingStore) {
      const customer = await tx.customer.findUnique({
        where: { id: customerId },
        select: { id: true }
      });

      return customer
        ? { kind: "store-not-found" as const }
        : { kind: "customer-not-found" as const };
    }

    if (existingStore.status === nextStatus) {
      return { kind: "already-set" as const };
    }

    const store = await tx.customerStore.update({
      where: { id: storeId },
      data: {
        status: nextStatus,
        updatedById: actor.id
      },
      select: customerStoreSelect
    });

    await tx.auditEvent.create({
      data: {
        eventType,
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          customerId,
          customerCode: existingStore.customer.code,
          storeId,
          storeCode: existingStore.code,
          previousStatus: existingStore.status,
          newStatus: nextStatus,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { kind: "updated" as const, store };
  });

  if (result.kind === "customer-not-found") {
    return customerNotFound();
  }

  if (result.kind === "store-not-found") {
    return customerStoreNotFound();
  }

  if (result.kind === "already-set") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "CUSTOMER_STORE_STATUS_ALREADY_SET",
        message: "La tienda ya esta en ese estado."
      }
    };
  }

  return {
    ok: true,
    status: 200,
    value: mapCustomerStoreListItem(result.store)
  };
}

const customerStoreSelect = {
  id: true,
  customerId: true,
  code: true,
  name: true,
  status: true,
  isPrimary: true,
  addressLine: true,
  postalCode: true,
  city: true,
  province: true,
  country: true,
  email: true,
  phone: true,
  whatsapp: true,
  contactName: true,
  contactRole: true,
  contactPhone: true,
  contactMobile: true,
  contactWhatsapp: true,
  contactEmail: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.CustomerStoreSelect;

function mapCustomerStoreListItem(store: {
  id: string;
  customerId: string;
  code: string;
  name: string;
  status: CustomerStoreListItem["status"];
  isPrimary: boolean;
  addressLine: string;
  postalCode: string;
  city: string;
  province: string | null;
  country: string;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  contactName: string | null;
  contactRole: string | null;
  contactPhone: string | null;
  contactMobile: string | null;
  contactWhatsapp: string | null;
  contactEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
}): CustomerStoreListItem {
  return {
    id: store.id,
    customerId: store.customerId,
    code: store.code,
    name: store.name,
    status: store.status,
    isPrimary: store.isPrimary,
    address: {
      line: store.addressLine,
      postalCode: store.postalCode,
      city: store.city,
      province: store.province,
      country: store.country
    },
    email: store.email,
    phone: store.phone,
    whatsapp: store.whatsapp,
    contact: {
      name: store.contactName,
      role: store.contactRole,
      phone: store.contactPhone,
      mobile: store.contactMobile,
      whatsapp: store.contactWhatsapp,
      email: store.contactEmail
    },
    createdAt: store.createdAt.toISOString(),
    updatedAt: store.updatedAt.toISOString()
  };
}

async function nextCustomerStoreCode(tx: Prisma.TransactionClient): Promise<string> {
  const result = await tx.$queryRaw<Array<{ value: bigint }>>`
    SELECT nextval('customer_store_code_seq') AS value
  `;
  const value = result[0]?.value;

  if (value === undefined) {
    throw new Error("CUSTOMER_STORE_CODE_SEQUENCE_UNAVAILABLE");
  }

  return value.toString();
}

function changedStoreFields(
  previous: {
    name: string;
    isPrimary: boolean;
    addressLine: string;
    postalCode: string;
    city: string;
    province: string | null;
    country: string;
    email: string | null;
    phone: string | null;
    whatsapp: string | null;
    contactName: string | null;
    contactRole: string | null;
    contactPhone: string | null;
    contactMobile: string | null;
    contactWhatsapp: string | null;
    contactEmail: string | null;
    notes: string | null;
  },
  next: UpdateCustomerStoreCommand
): string[] {
  return [
    previous.name !== next.name ? "name" : null,
    previous.isPrimary !== next.isPrimary ? "isPrimary" : null,
    previous.addressLine !== next.addressLine ? "addressLine" : null,
    previous.postalCode !== next.postalCode ? "postalCode" : null,
    previous.city !== next.city ? "city" : null,
    previous.province !== next.province ? "province" : null,
    previous.country !== next.country ? "country" : null,
    previous.email !== next.email ? "email" : null,
    previous.phone !== next.phone ? "phone" : null,
    previous.whatsapp !== next.whatsapp ? "whatsapp" : null,
    previous.contactName !== next.contactName ? "contactName" : null,
    previous.contactRole !== next.contactRole ? "contactRole" : null,
    previous.contactPhone !== next.contactPhone ? "contactPhone" : null,
    previous.contactMobile !== next.contactMobile ? "contactMobile" : null,
    previous.contactWhatsapp !== next.contactWhatsapp ? "contactWhatsapp" : null,
    previous.contactEmail !== next.contactEmail ? "contactEmail" : null,
    previous.notes !== next.notes ? "notes" : null
  ].filter((field): field is string => Boolean(field));
}

function customerNotFound(): CustomerStoreNotFoundResult {
  return {
    ok: false,
    status: 404,
    error: {
      code: "CUSTOMER_NOT_FOUND",
      message: "El cliente no existe."
    }
  };
}

function customerStoreNotFound(): CustomerStoreNotFoundResult {
  return {
    ok: false,
    status: 404,
    error: {
      code: "CUSTOMER_STORE_NOT_FOUND",
      message: "La tienda no existe."
    }
  };
}
