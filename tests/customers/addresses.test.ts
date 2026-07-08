import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createCustomer,
  type CreateCustomerCommand
} from "@/modules/customers/application/customers";
import {
  createCustomerAddress,
  listCustomerAddresses,
  updateCustomerAddress,
  updateCustomerAddressStatus
} from "@/modules/customers/application/addresses";
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

describe("customer addresses application service", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await resetCustomerCodeSequence();
    await initializeForCustomers();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("creates addresses and keeps one active primary per customer and type", async () => {
    const actor = await loginAsAdmin();
    const customer = await createCustomer(customerPayload(), actor);

    if (!customer.ok) {
      throw new Error(customer.error.code);
    }

    const first = await createCustomerAddress(
      customer.value.id,
      addressPayload({ label: "Almacen norte", isPrimary: true }),
      actor,
      { correlationId: "address-create-0001" }
    );
    const second = await createCustomerAddress(
      customer.value.id,
      addressPayload({ label: "Almacen sur", isPrimary: true }),
      actor
    );
    const list = await listCustomerAddresses(customer.value.id, {}, actor);
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_ADDRESS_CREATED" },
      orderBy: { createdAt: "asc" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(first).toMatchObject({
      ok: true,
      status: 201,
      value: {
        label: "Almacen norte",
        type: "SHIPPING",
        isPrimary: true
      }
    });
    expect(second).toMatchObject({
      ok: true,
      status: 201,
      value: {
        label: "Almacen sur",
        isPrimary: true
      }
    });
    expect(list?.addresses).toMatchObject([
      {
        label: "Almacen sur",
        isPrimary: true
      },
      {
        label: "Almacen norte",
        isPrimary: false
      }
    ]);
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      customerId: customer.value.id,
      customerCode: customer.value.code,
      type: "SHIPPING",
      isPrimary: true,
      correlationId: "address-create-0001"
    });
    expect(auditPayload).not.toContain("Calle Envio");
    expect(auditPayload).not.toContain("contacto@example.test");
  });

  it("updates address data and deactivates addresses without leaking values", async () => {
    const actor = await loginAsAdmin();
    const customer = await createCustomer(customerPayload(), actor);

    if (!customer.ok) {
      throw new Error(customer.error.code);
    }

    const created = await createCustomerAddress(
      customer.value.id,
      addressPayload({ isPrimary: true }),
      actor
    );

    if (!created.ok) {
      throw new Error(created.error.code);
    }

    const updated = await updateCustomerAddress(
      customer.value.id,
      created.value.id,
      addressPayload({
        type: "BILLING",
        label: "Facturacion central",
        city: "Barcelona"
      }),
      actor,
      { correlationId: "address-update-0001" }
    );
    const deactivated = await updateCustomerAddressStatus(
      customer.value.id,
      created.value.id,
      { action: "deactivate" },
      actor
    );
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_ADDRESS_UPDATED" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(updated).toMatchObject({
      ok: true,
      value: {
        type: "BILLING",
        label: "Facturacion central",
        address: {
          city: "Barcelona"
        }
      }
    });
    expect(deactivated).toMatchObject({
      ok: true,
      value: {
        status: "INACTIVE",
        isPrimary: false
      }
    });
    expect(auditEvent.payload).toMatchObject({
      changedFields: ["type", "label", "isPrimary", "city"],
      correlationId: "address-update-0001"
    });
    expect(auditPayload).not.toContain("Facturacion central");
    expect(auditPayload).not.toContain("Barcelona");
  });
});

function addressPayload(
  overrides: Partial<Parameters<typeof createCustomerAddress>[1]> = {}
): Parameters<typeof createCustomerAddress>[1] {
  return {
    type: "SHIPPING",
    label: "Almacen principal",
    isPrimary: false,
    addressLine: "Calle Envio 1",
    postalCode: "28001",
    city: "Madrid",
    province: "Madrid",
    country: "ES",
    contactName: "Contacto Envio",
    phone: "+34910000010",
    email: "contacto@example.test",
    notes: "Observacion interna",
    ...overrides
  };
}

function customerPayload(overrides: Partial<CreateCustomerCommand> = {}): CreateCustomerCommand {
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
    bankIban: "ES91 2100 0418 4502 0005 1332",
    sepaMandate: {
      reference: "SEPA-CLIENTE-1",
      signedAt: "2026-07-01"
    },
    notes: "Observacion interna",
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

async function initializeForCustomers(): Promise<void> {
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
    prisma.restoreOperation.deleteMany(),
    prisma.backupOperation.deleteMany(),
    prisma.invoiceVerifactuRecord.deleteMany(),
    prisma.invoiceDueDate.deleteMany(),
    prisma.invoiceTaxSummary.deleteMany(),
    prisma.invoiceLine.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.customerAddress.deleteMany(),
    prisma.customerSepaMandate.deleteMany(),
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

async function resetCustomerCodeSequence(): Promise<void> {
  await prisma.$executeRaw`ALTER SEQUENCE customer_code_seq RESTART WITH 1`;
}
