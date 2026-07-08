import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type {
  RequestContext,
  SessionUser
} from "@/modules/platform/application/auth";

const addressTypeSchema = z.enum(["BILLING", "SHIPPING", "OTHER"]);
const addressStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);

const addressDataSchema = z.object({
  type: addressTypeSchema,
  label: z.string().trim().min(2).max(120),
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
  contactName: z.string().trim().min(2).max(160).nullable(),
  phone: z.string().trim().min(3).max(40).nullable(),
  email: z.string().trim().email().nullable(),
  notes: z.string().trim().min(1).max(1000).nullable()
}).strict();

export const listCustomerAddressesSchema = z.object({
  status: addressStatusSchema.optional(),
  type: addressTypeSchema.optional()
});

export const createCustomerAddressSchema = addressDataSchema;
export const updateCustomerAddressSchema = addressDataSchema;
export const updateCustomerAddressStatusSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("deactivate")
  }).strict(),
  z.object({
    action: z.literal("reactivate")
  }).strict()
]);

export type ListCustomerAddressesCommand = z.infer<typeof listCustomerAddressesSchema>;
export type CreateCustomerAddressCommand = z.infer<typeof createCustomerAddressSchema>;
export type UpdateCustomerAddressCommand = z.infer<typeof updateCustomerAddressSchema>;
export type UpdateCustomerAddressStatusCommand = z.infer<
  typeof updateCustomerAddressStatusSchema
>;

export type CustomerAddressListItem = {
  id: string;
  customerId: string;
  type: "BILLING" | "SHIPPING" | "OTHER";
  status: "ACTIVE" | "INACTIVE";
  label: string;
  isPrimary: boolean;
  address: {
    line: string;
    postalCode: string;
    city: string;
    province: string | null;
    country: string;
  };
  contact: {
    name: string | null;
    phone: string | null;
    email: string | null;
  };
  createdAt: string;
  updatedAt: string;
};

export type CustomerAddressPage = {
  customer: {
    id: string;
    code: string;
    legalName: string;
    status: "ACTIVE" | "INACTIVE";
  };
  addresses: CustomerAddressListItem[];
};

type CustomerAddressNotFoundResult = {
  ok: false;
  status: 404;
  error: {
    code: "CUSTOMER_NOT_FOUND" | "CUSTOMER_ADDRESS_NOT_FOUND";
    message: string;
  };
};

type CustomerAddressStatusAlreadySetResult = {
  ok: false;
  status: 409;
  error: {
    code: "CUSTOMER_ADDRESS_STATUS_ALREADY_SET";
    message: string;
  };
};

export type CreateCustomerAddressResult =
  | { ok: true; status: 201; value: CustomerAddressListItem }
  | CustomerAddressNotFoundResult;

export type UpdateCustomerAddressResult =
  | { ok: true; status: 200; value: CustomerAddressListItem }
  | CustomerAddressNotFoundResult;

export type UpdateCustomerAddressStatusResult =
  | { ok: true; status: 200; value: CustomerAddressListItem }
  | CustomerAddressNotFoundResult
  | CustomerAddressStatusAlreadySetResult;

export async function listCustomerAddresses(
  customerId: string,
  command: ListCustomerAddressesCommand,
  actor: SessionUser
): Promise<CustomerAddressPage | null> {
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

  const addresses = await prisma.customerAddress.findMany({
    where: {
      customerId,
      ...(command.status ? { status: command.status } : {}),
      ...(command.type ? { type: command.type } : {})
    },
    orderBy: [{ type: "asc" }, { isPrimary: "desc" }, { label: "asc" }, { id: "asc" }],
    select: customerAddressSelect
  });

  await prisma.auditEvent.create({
    data: {
      eventType: "CUSTOMER_ADDRESSES_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        customerId,
        customerCode: customer.code,
        status: command.status ?? null,
        type: command.type ?? null,
        resultCount: addresses.length
      }
    }
  });

  return {
    customer,
    addresses: addresses.map(mapCustomerAddressListItem)
  };
}

export async function createCustomerAddress(
  customerId: string,
  command: CreateCustomerAddressCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CreateCustomerAddressResult> {
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
      await clearPrimaryAddress(tx, customerId, command.type, actor.id);
    }

    const address = await tx.customerAddress.create({
      data: {
        ...command,
        customerId,
        status: "ACTIVE",
        createdById: actor.id
      },
      select: customerAddressSelect
    });

    await tx.auditEvent.create({
      data: {
        eventType: "CUSTOMER_ADDRESS_CREATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          customerId,
          customerCode: customer.code,
          addressId: address.id,
          type: address.type,
          isPrimary: address.isPrimary,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { kind: "created" as const, address };
  });

  if (result.kind === "customer-not-found") {
    return customerNotFound();
  }

  return {
    ok: true,
    status: 201,
    value: mapCustomerAddressListItem(result.address)
  };
}

export async function updateCustomerAddress(
  customerId: string,
  addressId: string,
  command: UpdateCustomerAddressCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<UpdateCustomerAddressResult> {
  const result = await prisma.$transaction(async (tx) => {
    const existingAddress = await tx.customerAddress.findFirst({
      where: { id: addressId, customerId },
      select: {
        id: true,
        type: true,
        label: true,
        isPrimary: true,
        addressLine: true,
        postalCode: true,
        city: true,
        province: true,
        country: true,
        contactName: true,
        phone: true,
        email: true,
        notes: true,
        customer: {
          select: {
            code: true
          }
        }
      }
    });

    if (!existingAddress) {
      const customer = await tx.customer.findUnique({
        where: { id: customerId },
        select: { id: true }
      });

      return customer
        ? { kind: "address-not-found" as const }
        : { kind: "customer-not-found" as const };
    }

    if (command.isPrimary) {
      await clearPrimaryAddress(tx, customerId, command.type, actor.id, addressId);
    }

    const changedFields = changedAddressFields(existingAddress, command);
    const address = await tx.customerAddress.update({
      where: { id: addressId },
      data: {
        ...command,
        updatedById: actor.id
      },
      select: customerAddressSelect
    });

    await tx.auditEvent.create({
      data: {
        eventType: "CUSTOMER_ADDRESS_UPDATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          customerId,
          customerCode: existingAddress.customer.code,
          addressId,
          type: address.type,
          changedFields,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { kind: "updated" as const, address };
  });

  if (result.kind === "customer-not-found") {
    return customerNotFound();
  }

  if (result.kind === "address-not-found") {
    return customerAddressNotFound();
  }

  return {
    ok: true,
    status: 200,
    value: mapCustomerAddressListItem(result.address)
  };
}

export async function updateCustomerAddressStatus(
  customerId: string,
  addressId: string,
  command: UpdateCustomerAddressStatusCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<UpdateCustomerAddressStatusResult> {
  const nextStatus = command.action === "deactivate" ? "INACTIVE" : "ACTIVE";
  const eventType =
    command.action === "deactivate"
      ? "CUSTOMER_ADDRESS_DEACTIVATED"
      : "CUSTOMER_ADDRESS_REACTIVATED";

  const result = await prisma.$transaction(async (tx) => {
    const existingAddress = await tx.customerAddress.findFirst({
      where: { id: addressId, customerId },
      select: {
        id: true,
        type: true,
        status: true,
        isPrimary: true,
        customer: {
          select: {
            code: true
          }
        }
      }
    });

    if (!existingAddress) {
      const customer = await tx.customer.findUnique({
        where: { id: customerId },
        select: { id: true }
      });

      return customer
        ? { kind: "address-not-found" as const }
        : { kind: "customer-not-found" as const };
    }

    if (existingAddress.status === nextStatus) {
      return { kind: "already-set" as const };
    }

    if (nextStatus === "ACTIVE" && existingAddress.isPrimary) {
      await clearPrimaryAddress(tx, customerId, existingAddress.type, actor.id, addressId);
    }

    const address = await tx.customerAddress.update({
      where: { id: addressId },
      data: {
        status: nextStatus,
        isPrimary: nextStatus === "INACTIVE" ? false : existingAddress.isPrimary,
        updatedById: actor.id
      },
      select: customerAddressSelect
    });

    await tx.auditEvent.create({
      data: {
        eventType,
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          customerId,
          customerCode: existingAddress.customer.code,
          addressId,
          type: existingAddress.type,
          previousStatus: existingAddress.status,
          newStatus: nextStatus,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { kind: "updated" as const, address };
  });

  if (result.kind === "customer-not-found") {
    return customerNotFound();
  }

  if (result.kind === "address-not-found") {
    return customerAddressNotFound();
  }

  if (result.kind === "already-set") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "CUSTOMER_ADDRESS_STATUS_ALREADY_SET",
        message: "La direccion ya esta en ese estado."
      }
    };
  }

  return {
    ok: true,
    status: 200,
    value: mapCustomerAddressListItem(result.address)
  };
}

async function clearPrimaryAddress(
  tx: Prisma.TransactionClient,
  customerId: string,
  type: CustomerAddressListItem["type"],
  actorUserId: string,
  exceptAddressId?: string
): Promise<void> {
  await tx.customerAddress.updateMany({
    where: {
      customerId,
      type,
      status: "ACTIVE",
      isPrimary: true,
      ...(exceptAddressId ? { id: { not: exceptAddressId } } : {})
    },
    data: {
      isPrimary: false,
      updatedById: actorUserId
    }
  });
}

const customerAddressSelect = {
  id: true,
  customerId: true,
  type: true,
  status: true,
  label: true,
  isPrimary: true,
  addressLine: true,
  postalCode: true,
  city: true,
  province: true,
  country: true,
  contactName: true,
  phone: true,
  email: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.CustomerAddressSelect;

function mapCustomerAddressListItem(address: {
  id: string;
  customerId: string;
  type: CustomerAddressListItem["type"];
  status: CustomerAddressListItem["status"];
  label: string;
  isPrimary: boolean;
  addressLine: string;
  postalCode: string;
  city: string;
  province: string | null;
  country: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  createdAt: Date;
  updatedAt: Date;
}): CustomerAddressListItem {
  return {
    id: address.id,
    customerId: address.customerId,
    type: address.type,
    status: address.status,
    label: address.label,
    isPrimary: address.isPrimary,
    address: {
      line: address.addressLine,
      postalCode: address.postalCode,
      city: address.city,
      province: address.province,
      country: address.country
    },
    contact: {
      name: address.contactName,
      phone: address.phone,
      email: address.email
    },
    createdAt: address.createdAt.toISOString(),
    updatedAt: address.updatedAt.toISOString()
  };
}

function changedAddressFields(
  previous: {
    type: CustomerAddressListItem["type"];
    label: string;
    isPrimary: boolean;
    addressLine: string;
    postalCode: string;
    city: string;
    province: string | null;
    country: string;
    contactName: string | null;
    phone: string | null;
    email: string | null;
    notes: string | null;
  },
  next: UpdateCustomerAddressCommand
): string[] {
  return [
    previous.type !== next.type ? "type" : null,
    previous.label !== next.label ? "label" : null,
    previous.isPrimary !== next.isPrimary ? "isPrimary" : null,
    previous.addressLine !== next.addressLine ? "addressLine" : null,
    previous.postalCode !== next.postalCode ? "postalCode" : null,
    previous.city !== next.city ? "city" : null,
    previous.province !== next.province ? "province" : null,
    previous.country !== next.country ? "country" : null,
    previous.contactName !== next.contactName ? "contactName" : null,
    previous.phone !== next.phone ? "phone" : null,
    previous.email !== next.email ? "email" : null,
    previous.notes !== next.notes ? "notes" : null
  ].filter((field): field is string => Boolean(field));
}

function customerNotFound(): CustomerAddressNotFoundResult {
  return {
    ok: false,
    status: 404,
    error: {
      code: "CUSTOMER_NOT_FOUND",
      message: "El cliente no existe."
    }
  };
}

function customerAddressNotFound(): CustomerAddressNotFoundResult {
  return {
    ok: false,
    status: 404,
    error: {
      code: "CUSTOMER_ADDRESS_NOT_FOUND",
      message: "La direccion no existe."
    }
  };
}
