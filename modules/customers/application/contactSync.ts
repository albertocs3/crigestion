import "server-only";

import type { Prisma } from "@prisma/client";

type ContactValues = {
  name: string | null;
  role: string | null;
  phone: string | null;
  mobile: string | null;
  whatsapp: string | null;
  email: string | null;
};

export async function syncGeneralContactFromCustomer(
  tx: Prisma.TransactionClient,
  customerId: string,
  actorId: string,
  values: Pick<ContactValues, "phone" | "email">,
) {
  const existing = await tx.customerContact.findFirst({
    where: { customerId, storeId: null },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      mobile: true,
      whatsapp: true,
      status: true,
    },
  });
  if (!existing) {
    if (values.phone || values.email)
      await tx.customerContact.create({
        data: {
          customerId,
          phone: values.phone,
          email: values.email,
          createdById: actorId,
        },
      });
    return;
  }
  const hasRemainingIdentity = Boolean(
    existing.name || existing.mobile || existing.whatsapp,
  );
  if (!values.phone && !values.email && !hasRemainingIdentity) {
    if (existing.status === "ACTIVE")
      await tx.customerContact.update({
        where: { id: existing.id },
        data: {
          status: "INACTIVE",
          updatedById: actorId,
          version: { increment: 1 },
        },
      });
    return;
  }
  const targetStatus =
    values.phone || values.email ? "ACTIVE" : existing.status;
  if (
    existing.phone === values.phone &&
    existing.email === values.email &&
    existing.status === targetStatus
  )
    return;
  await tx.customerContact.update({
    where: { id: existing.id },
    data: {
      phone: values.phone,
      email: values.email,
      status: targetStatus,
      updatedById: actorId,
      version: { increment: 1 },
    },
  });
}

export async function syncStoreContactFromStore(
  tx: Prisma.TransactionClient,
  customerId: string,
  storeId: string,
  actorId: string,
  values: ContactValues,
) {
  const existing = await tx.customerContact.findUnique({
    where: { storeId },
    select: {
      id: true,
      name: true,
      role: true,
      phone: true,
      mobile: true,
      whatsapp: true,
      email: true,
      status: true,
    },
  });
  const hasValue = Boolean(
    values.name ||
    values.phone ||
    values.mobile ||
    values.whatsapp ||
    values.email,
  );
  if (!existing) {
    if (hasValue)
      await tx.customerContact.create({
        data: { customerId, storeId, ...values, createdById: actorId },
      });
    return;
  }
  if (!hasValue) {
    if (existing.status === "ACTIVE")
      await tx.customerContact.update({
        where: { id: existing.id },
        data: {
          status: "INACTIVE",
          updatedById: actorId,
          version: { increment: 1 },
        },
      });
    return;
  }
  if (
    existing.name === values.name &&
    existing.role === values.role &&
    existing.phone === values.phone &&
    existing.mobile === values.mobile &&
    existing.whatsapp === values.whatsapp &&
    existing.email === values.email &&
    existing.status === "ACTIVE"
  )
    return;
  await tx.customerContact.update({
    where: { id: existing.id },
    data: {
      ...values,
      status: "ACTIVE",
      updatedById: actorId,
      version: { increment: 1 },
    },
  });
}

export async function syncLegacyProjectionFromContact(
  tx: Prisma.TransactionClient,
  contact: ContactValues & {
    customerId: string;
    storeId: string | null;
    status: "ACTIVE" | "INACTIVE";
  },
  actorId: string,
) {
  const active = contact.status === "ACTIVE";
  if (contact.storeId) {
    await tx.customerStore.update({
      where: { id: contact.storeId },
      data: {
        contactName: active ? contact.name : null,
        contactRole: active ? contact.role : null,
        contactPhone: active ? contact.phone : null,
        contactMobile: active ? contact.mobile : null,
        contactWhatsapp: active ? contact.whatsapp : null,
        contactEmail: active ? contact.email : null,
        updatedById: actorId,
      },
    });
    return;
  }
  await tx.customer.update({
    where: { id: contact.customerId },
    data: {
      phone: active ? contact.phone : null,
      email: active ? contact.email : null,
      updatedById: actorId,
    },
  });
}
