import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { login } from "@/modules/platform/application/auth";
import {
  createCustomer,
  createCustomerSchema,
  getCustomerDetail,
  listCustomers,
  updateCustomer,
  updateCustomerStatus
} from "@/modules/customers/application/customers";
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

describe("customers application service", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await resetCustomerCodeSequence();
    await initializeForCustomers();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("creates customers with automatic codes and safe audit payloads", async () => {
    const actor = await loginAsAdmin();
    const result = await createCustomer(customerPayload(), actor, {
      correlationId: "customer-test-0001"
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_CREATED" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(result).toMatchObject({
      ok: true,
      status: 201,
      value: {
        code: "1",
        legalName: "Cliente Demo SL",
        taxId: "B12345674",
        status: "ACTIVE",
        bankAccount: {
          iban: "ES9121000418450200051332",
          sepaMandate: {
            reference: "SEPA-CLIENTE-1",
            status: "ACTIVE",
            signedAt: "2026-07-01",
            revokedAt: null
          }
        }
      }
    });
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      customerCode: "1",
      type: "COMPANY",
      fiscalTreatment: "DOMESTIC",
      correlationId: "customer-test-0001"
    });
    expect(auditPayload).not.toContain("B12345674");
    expect(auditPayload).not.toContain("ES9121000418450200051332");
    expect(auditPayload).not.toContain("cliente@example.test");
    expect(auditPayload).not.toContain("Calle Mayor");
  });

  it("rejects duplicate fiscal identifiers after normalization", async () => {
    const actor = await loginAsAdmin();

    await createCustomer(customerPayload({ taxId: "B-12345674" }), actor);
    const result = await createCustomer(customerPayload({ taxId: "B 12345674" }), actor);

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "CUSTOMER_TAX_ID_ALREADY_USED",
        message: "El identificador fiscal ya esta asignado a otro cliente."
      }
    });
  });

  it("lists and filters customers without exposing notes", async () => {
    const actor = await loginAsAdmin();

    await createCustomer(customerPayload({ legalName: "Cliente Demo SL" }), actor);
    await createCustomer(
      customerPayload({
        legalName: "Otro Cliente SL",
        tradeName: "Otro Cliente",
        taxId: "B00000000",
        email: "otro@example.test"
      }),
      actor
    );

    const result = await listCustomers({ limit: 25, search: "demo" }, actor);

    expect(result.customers).toHaveLength(1);
    expect(result.customers[0]).toMatchObject({
      legalName: "Cliente Demo SL",
      status: "ACTIVE"
    });
    expect(JSON.stringify(result)).not.toContain("Observacion interna");
  });

  it("gets customer detail without exposing notes in the contract or audit payload", async () => {
    const actor = await loginAsAdmin();
    const created = await createCustomer(customerPayload(), actor);

    if (!created.ok) {
      throw new Error(created.error.code);
    }

    const result = await getCustomerDetail(created.value.id, actor);
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_VIEWED" }
    });
    const serializedResult = JSON.stringify(result);
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(result).toMatchObject({
      id: created.value.id,
      code: "1",
      legalName: "Cliente Demo SL",
      storeCounts: {
        active: 0,
        inactive: 0
      },
      stores: []
    });
    expect(serializedResult).not.toContain("Observacion interna");
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      customerId: created.value.id,
      customerCode: "1",
      storeCount: 0
    });
    expect(auditPayload).not.toContain("B12345674");
    expect(auditPayload).not.toContain("cliente@example.test");
  });

  it("changes customer status and audits the transition", async () => {
    const actor = await loginAsAdmin();
    const created = await createCustomer(customerPayload(), actor);

    if (!created.ok) {
      throw new Error(created.error.code);
    }

    const result = await updateCustomerStatus(
      created.value.id,
      { action: "deactivate" },
      actor
    );
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_DEACTIVATED" }
    });

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      value: {
        id: created.value.id,
        status: "INACTIVE"
      }
    });
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      customerId: created.value.id,
      previousStatus: "ACTIVE",
      newStatus: "INACTIVE"
    });
  });

  it("updates customer data and audits only changed field names", async () => {
    const actor = await loginAsAdmin();
    const created = await createCustomer(customerPayload(), actor);

    if (!created.ok) {
      throw new Error(created.error.code);
    }

    const result = await updateCustomer(
      created.value.id,
      {
        type: "SELF_EMPLOYED",
        legalName: "Cliente Actualizado SL",
        tradeName: null,
        taxId: "B11111119",
        fiscalTreatment: "EU",
        email: "nuevo@example.test",
        phone: null,
        fiscalAddressLine: "Avenida Nueva 2",
        fiscalPostalCode: "08001",
        fiscalCity: "Barcelona",
        fiscalProvince: "Barcelona",
        fiscalCountry: "ES",
        defaultPaymentMethod: "DIRECT_DEBIT",
        paymentTermsType: "DAYS",
        paymentDays: 30,
        paymentFixedDay: null,
        creditLimit: "1500.50",
        bankIban: "ES79 2100 0813 6101 2345 6789",
        sepaMandate: {
          reference: "SEPA-CLIENTE-2",
          signedAt: "2026-07-02"
        }
      },
      actor,
      { correlationId: "customer-update-0001" }
    );
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_UPDATED" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      value: {
        id: created.value.id,
        legalName: "Cliente Actualizado SL",
        tradeName: null,
        taxId: "B11111119",
        fiscalTreatment: "EU",
        email: "nuevo@example.test",
        phone: null,
        commercialTerms: {
          defaultPaymentMethod: "DIRECT_DEBIT",
          paymentTermsType: "DAYS",
          paymentDays: 30,
          paymentFixedDay: null,
          creditLimit: "1500.50"
        },
        bankAccount: {
          iban: "ES7921000813610123456789",
          sepaMandate: {
            reference: "SEPA-CLIENTE-2",
            status: "ACTIVE",
            signedAt: "2026-07-02",
            revokedAt: null
          }
        }
      }
    });
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      customerId: created.value.id,
      customerCode: created.value.code,
      changedFields: [
        "type",
        "legalName",
        "tradeName",
        "taxId",
        "fiscalTreatment",
        "email",
        "phone",
        "fiscalAddressLine",
        "fiscalPostalCode",
        "fiscalCity",
        "fiscalProvince",
        "defaultPaymentMethod",
        "paymentTermsType",
        "paymentDays",
        "creditLimit",
        "bankIban",
        "sepaMandate"
      ],
      correlationId: "customer-update-0001"
    });
    expect(auditPayload).not.toContain("B11111119");
    expect(auditPayload).not.toContain("ES7921000813610123456789");
    expect(auditPayload).not.toContain("nuevo@example.test");
    expect(auditPayload).not.toContain("Avenida Nueva");
  });

  it("does not allow changing customer tax id after issued invoices exist", async () => {
    const actor = await loginAsAdmin();
    const created = await createCustomer(customerPayload(), actor);

    if (!created.ok) {
      throw new Error(created.error.code);
    }

    await createIssuedInvoiceForCustomer(created.value.id, actor.id);

    const result = await updateCustomer(
      created.value.id,
      updateCustomerPayload({
        taxId: "B11111119"
      }),
      actor
    );
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: created.value.id },
      select: { taxId: true, normalizedTaxId: true }
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "CUSTOMER_TAX_ID_LOCKED_BY_ISSUED_INVOICES",
        message: "El NIF del cliente no puede cambiarse cuando existen facturas emitidas."
      }
    });
    expect(customer).toEqual({
      taxId: "B12345674",
      normalizedTaxId: "B12345674"
    });
  });

  it("allows changing non-tax customer fields after issued invoices exist", async () => {
    const actor = await loginAsAdmin();
    const created = await createCustomer(customerPayload(), actor);

    if (!created.ok) {
      throw new Error(created.error.code);
    }

    await createIssuedInvoiceForCustomer(created.value.id, actor.id);

    const result = await updateCustomer(
      created.value.id,
      updateCustomerPayload({
        legalName: "Cliente Actualizado SL",
        taxId: "B12345674",
        email: "nuevo@example.test"
      }),
      actor
    );

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      value: {
        id: created.value.id,
        legalName: "Cliente Actualizado SL",
        taxId: "B12345674",
        email: "nuevo@example.test"
      }
    });
  });

  it("invalidates the active SEPA mandate when the customer IBAN changes", async () => {
    const actor = await loginAsAdmin();
    const created = await createCustomer(
      customerPayload({
        defaultPaymentMethod: "DIRECT_DEBIT"
      }),
      actor
    );

    if (!created.ok) {
      throw new Error(created.error.code);
    }

    const result = await updateCustomer(
      created.value.id,
      {
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
        defaultPaymentMethod: "DIRECT_DEBIT",
        paymentTermsType: "IMMEDIATE",
        paymentDays: null,
        paymentFixedDay: null,
        creditLimit: null,
        bankIban: "ES79 2100 0813 6101 2345 6789",
        sepaMandate: {
          reference: "SEPA-CLIENTE-2",
          signedAt: "2026-07-02"
        }
      },
      actor
    );
    const mandates = await prisma.customerSepaMandate.findMany({
      where: { customerId: created.value.id },
      orderBy: { createdAt: "asc" },
      select: {
        reference: true,
        status: true,
        revokedAt: true
      }
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        bankAccount: {
          iban: "ES7921000813610123456789",
          sepaMandate: {
            reference: "SEPA-CLIENTE-2",
            status: "ACTIVE"
          }
        }
      }
    });
    expect(mandates).toMatchObject([
      {
        reference: "SEPA-CLIENTE-1",
        status: "INVALIDATED"
      },
      {
        reference: "SEPA-CLIENTE-2",
        status: "ACTIVE",
        revokedAt: null
      }
    ]);
    expect(mandates[0].revokedAt).toBeInstanceOf(Date);
  });

  it("rejects updating a customer to a duplicate fiscal identifier", async () => {
    const actor = await loginAsAdmin();
    const first = await createCustomer(
      customerPayload({
        taxId: "B11111119",
        sepaMandate: {
          reference: "SEPA-CLIENTE-1",
          signedAt: "2026-07-01"
        }
      }),
      actor
    );
    const second = await createCustomer(
      customerPayload({
        taxId: "B22222228",
        sepaMandate: {
          reference: "SEPA-CLIENTE-2",
          signedAt: "2026-07-01"
        }
      }),
      actor
    );

    if (!first.ok || !second.ok) {
      throw new Error("Customer setup failed.");
    }

    const result = await updateCustomer(
      second.value.id,
      {
        type: "COMPANY",
        legalName: "Segundo Cliente SL",
        tradeName: "Segundo",
        taxId: "B-11111119",
        fiscalTreatment: "DOMESTIC",
        email: "segundo@example.test",
        phone: "+34910000002",
        fiscalAddressLine: "Calle Segunda 2",
        fiscalPostalCode: "28002",
        fiscalCity: "Madrid",
        fiscalProvince: "Madrid",
        fiscalCountry: "ES",
        defaultPaymentMethod: "BANK_TRANSFER",
        paymentTermsType: "IMMEDIATE",
        paymentDays: null,
        paymentFixedDay: null,
        creditLimit: null,
        bankIban: null,
        sepaMandate: null
      },
      actor
    );

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "CUSTOMER_TAX_ID_ALREADY_USED",
        message: "El identificador fiscal ya esta asignado a otro cliente."
      }
    });
  });

  it("rejects inconsistent payment terms", async () => {
    const result = createCustomerSchema.safeParse(
      customerPayload({
        paymentTermsType: "DAYS",
        paymentDays: null
      })
    );

    expect(result.success).toBe(false);
  });

  it("rejects invalid Spanish tax identifiers", async () => {
    const result = createCustomerSchema.safeParse(
      customerPayload({
        taxId: "B12345678",
        fiscalCountry: "ES"
      })
    );

    expect(result.success).toBe(false);
  });

  it("allows foreign tax identifiers pending VAT validation", async () => {
    const result = createCustomerSchema.safeParse(
      customerPayload({
        taxId: "FR12345678901",
        fiscalCountry: "FR"
      })
    );

    expect(result.success).toBe(true);
  });

  it("rejects invalid IBAN values", async () => {
    const result = createCustomerSchema.safeParse(
      customerPayload({
        bankIban: "ES00 0000 0000 0000 0000 0000"
      })
    );

    expect(result.success).toBe(false);
  });

  it("requires IBAN and SEPA mandate for direct debit customers", async () => {
    const result = createCustomerSchema.safeParse(
      customerPayload({
        defaultPaymentMethod: "DIRECT_DEBIT",
        bankIban: undefined,
        sepaMandate: undefined
      })
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors).toMatchObject({
        bankIban: ["La domiciliacion requiere informar el IBAN."],
        sepaMandate: ["La domiciliacion requiere un mandato SEPA firmado."]
      });
    }
  });
});

function customerPayload(
  overrides: Partial<Parameters<typeof createCustomer>[0]> = {}
): Parameters<typeof createCustomer>[0] {
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

function updateCustomerPayload(
  overrides: Partial<Parameters<typeof updateCustomer>[1]> = {}
): Parameters<typeof updateCustomer>[1] {
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
    bankIban: "ES9121000418450200051332",
    sepaMandate: {
      reference: "SEPA-CLIENTE-1",
      signedAt: "2026-07-01"
    },
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

async function createIssuedInvoiceForCustomer(
  customerId: string,
  actorUserId: string
): Promise<void> {
  const customer = await prisma.customer.findUniqueOrThrow({
    where: { id: customerId }
  });

  await prisma.invoice.create({
    data: {
      status: "ISSUED",
      verifactuStatus: "PENDING",
      series: "F",
      year: 2026,
      numberSequence: 1,
      number: "F2600001",
      customerId: customer.id,
      customerCodeSnapshot: customer.code,
      customerLegalNameSnapshot: customer.legalName,
      customerTaxIdSnapshot: customer.taxId,
      customerFiscalTreatmentSnapshot: customer.fiscalTreatment,
      customerFiscalAddressSnapshot: {
        line1: customer.fiscalAddressLine,
        postalCode: customer.fiscalPostalCode,
        city: customer.fiscalCity,
        province: customer.fiscalProvince,
        country: customer.fiscalCountry
      },
      issueDate: new Date("2026-07-07T00:00:00.000Z"),
      operationDate: new Date("2026-07-07T00:00:00.000Z"),
      issuedAt: new Date("2026-07-07T10:00:00.000Z"),
      total: "0.00",
      createdById: actorUserId,
      issuedById: actorUserId
    }
  });
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
    prisma.customerPaymentReturn.deleteMany(),
    prisma.customerPayment.deleteMany(),
    prisma.invoiceDueDate.deleteMany(),
    prisma.invoiceTaxSummary.deleteMany(),
    prisma.invoiceLine.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.customerSepaMandate.deleteMany(),
    prisma.customerAddress.deleteMany(),

    prisma.customerStore.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.catalogItem.deleteMany(),

    prisma.accountingJournalLine.deleteMany(),
    prisma.accountingJournalEntry.deleteMany(),
    prisma.accountingAccount.deleteMany(),
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
