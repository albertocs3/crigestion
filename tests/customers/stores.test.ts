import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createCustomer } from "@/modules/customers/application/customers";
import {
  createCustomerStore,
  listCustomerStores,
  updateCustomerStore,
  updateCustomerStoreStatus
} from "@/modules/customers/application/stores";
import { login } from "@/modules/platform/application/auth";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";

const adminPassword = "Cambiar-esta-clave-2026";
const baseCommand: InitializeCommand = {
  company: {
    legalName: "CriGestion Test SL",
    taxId: "B12345678",
    email: "admin@example.test"
  },
  administrator: {
    displayName: "Administrador",
    userName: "admin",
    password: adminPassword
  }
};

describe("customer stores application service", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await resetSequences();
    await initializeForStores();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("creates stores with automatic codes and safe audit payloads", async () => {
    const actor = await loginAsAdmin();
    const customer = await createCustomer(customerPayload(), actor);

    if (!customer.ok) {
      throw new Error(customer.error.code);
    }

    const result = await createCustomerStore(customer.value.id, storePayload(), actor, {
      correlationId: "store-test-0001"
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_STORE_CREATED" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(result).toMatchObject({
      ok: true,
      status: 201,
      value: {
        code: "1",
        name: "Tienda Centro",
        status: "ACTIVE",
        isPrimary: true
      }
    });
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      customerId: customer.value.id,
      customerCode: customer.value.code,
      storeCode: "1",
      isPrimary: true,
      correlationId: "store-test-0001"
    });
    expect(auditPayload).not.toContain("Calle Tienda");
    expect(auditPayload).not.toContain("tienda@example.test");
    expect(auditPayload).not.toContain("Contacto Tienda");
  });

  it("keeps a single primary store per customer", async () => {
    const actor = await loginAsAdmin();
    const customer = await createCustomer(customerPayload(), actor);

    if (!customer.ok) {
      throw new Error(customer.error.code);
    }

    const first = await createCustomerStore(customer.value.id, storePayload(), actor);
    const second = await createCustomerStore(
      customer.value.id,
      storePayload({ name: "Tienda Norte" }),
      actor
    );

    if (!first.ok || !second.ok) {
      throw new Error("Store setup failed.");
    }

    const stores = await listCustomerStores(customer.value.id, {}, actor);

    expect(stores?.stores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.value.id, isPrimary: false }),
        expect.objectContaining({ id: second.value.id, isPrimary: true })
      ])
    );
  });

  it("updates store data and audits changed field names only", async () => {
    const actor = await loginAsAdmin();
    const customer = await createCustomer(customerPayload(), actor);

    if (!customer.ok) {
      throw new Error(customer.error.code);
    }

    const created = await createCustomerStore(customer.value.id, storePayload(), actor);

    if (!created.ok) {
      throw new Error(created.error.code);
    }

    const result = await updateCustomerStore(
      customer.value.id,
      created.value.id,
      storePayload({
        name: "Tienda Actualizada",
        isPrimary: false,
        addressLine: "Avenida Tienda 2",
        email: "nueva-tienda@example.test",
        contactName: "Nuevo Contacto"
      }),
      actor,
      { correlationId: "store-update-0001" }
    );
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_STORE_UPDATED" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      value: {
        name: "Tienda Actualizada",
        isPrimary: false,
        email: "nueva-tienda@example.test",
        contact: {
          name: "Nuevo Contacto"
        }
      }
    });
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      customerId: customer.value.id,
      storeId: created.value.id,
      storeCode: created.value.code,
      changedFields: [
        "name",
        "isPrimary",
        "addressLine",
        "email",
        "contactName"
      ],
      correlationId: "store-update-0001"
    });
    expect(auditPayload).not.toContain("Avenida Tienda");
    expect(auditPayload).not.toContain("nueva-tienda@example.test");
    expect(auditPayload).not.toContain("Nuevo Contacto");
  });

  it("changes store status", async () => {
    const actor = await loginAsAdmin();
    const customer = await createCustomer(customerPayload(), actor);

    if (!customer.ok) {
      throw new Error(customer.error.code);
    }

    const created = await createCustomerStore(customer.value.id, storePayload(), actor);

    if (!created.ok) {
      throw new Error(created.error.code);
    }

    const result = await updateCustomerStoreStatus(
      customer.value.id,
      created.value.id,
      { action: "deactivate" },
      actor
    );

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      value: {
        id: created.value.id,
        status: "INACTIVE"
      }
    });
  });
});

function customerPayload(): Parameters<typeof createCustomer>[0] {
  return {
    type: "COMPANY",
    legalName: "Cliente Demo SL",
    tradeName: "Cliente Demo",
    taxId: "B12345674",
    fiscalTreatment: "DOMESTIC",
    email: "cliente@example.test",
    phone: "+34910000000",
    fiscalAddressLine: "Calle Mayor 1",
    fiscalPostalCode: "28001",
    fiscalCity: "Madrid",
    fiscalProvince: "Madrid",
    fiscalCountry: "ES",
    defaultPaymentMethod: "BANK_TRANSFER",
    paymentTermsType: "IMMEDIATE",
    paymentDays: null,
    paymentFixedDay: null,
    creditLimit: null,
    notes: "Observacion interna"
  };
}

function storePayload(
  overrides: Partial<Parameters<typeof createCustomerStore>[1]> = {}
): Parameters<typeof createCustomerStore>[1] {
  return {
    name: "Tienda Centro",
    isPrimary: true,
    addressLine: "Calle Tienda 1",
    postalCode: "28001",
    city: "Madrid",
    province: "Madrid",
    country: "ES",
    email: "tienda@example.test",
    phone: "+34910000001",
    whatsapp: "+34910000002",
    contactName: "Contacto Tienda",
    contactRole: "Gerencia",
    contactPhone: "+34910000003",
    contactMobile: "+34600000001",
    contactWhatsapp: "+34600000002",
    contactEmail: "contacto@example.test",
    notes: "Observacion tienda",
    ...overrides
  };
}

async function loginAsAdmin() {
  const result = await login({
    userName: "admin",
    password: adminPassword
  });

  if (!result.ok) {
    throw new Error(result.error.code);
  }

  return result.value.user;
}

async function initializeForStores(): Promise<void> {
  const rawBody = JSON.stringify(baseCommand);
  const result = await initializePlatform(
    baseCommand,
    randomUUID(),
    hashRequestBody(rawBody)
  );

  if (!result.ok) {
    throw new Error(result.error.code);
  }
}

async function resetPlatformTables(): Promise<void> {
  await prisma.$transaction([
    prisma.platformMaintenanceState.deleteMany(),
    prisma.idempotencyRecord.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.installation.deleteMany(),
    prisma.reservedUserName.deleteMany(),
    prisma.session.deleteMany(),
    prisma.rateLimitBucket.deleteMany(),
    prisma.loginAttempt.deleteMany(),
    prisma.invoiceVerifactuRecord.deleteMany(),
    prisma.invoiceDueDate.deleteMany(),
    prisma.invoiceTaxSummary.deleteMany(),
    prisma.invoiceLine.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.customerSepaMandate.deleteMany(),
    prisma.customerAddress.deleteMany(),

    prisma.customerStore.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.catalogItem.deleteMany(),

    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}

async function resetSequences(): Promise<void> {
  await prisma.$executeRaw`ALTER SEQUENCE customer_code_seq RESTART WITH 1`;
  await prisma.$executeRaw`ALTER SEQUENCE customer_store_code_seq RESTART WITH 1`;
}
