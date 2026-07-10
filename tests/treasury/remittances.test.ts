import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  cancelCustomerRemittanceDraft,
  createCustomerRemittanceDraft,
  listCustomerRemittances
} from "@/modules/treasury/application/remittances";
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

describe("customer remittances", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await initializeForTreasury();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("creates draft remittances for eligible direct debit due dates", async () => {
    const actor = await adminActor();
    const dueDate = await createIssuedDirectDebitDueDate(actor.id);

    const result = await createCustomerRemittanceDraft(
      {
        chargeDate: "2026-07-15",
        concept: "Remesa julio",
        dueDateIds: [dueDate.id]
      },
      actor,
      { correlationId: "corr-remittance-create" }
    );
    const list = await listCustomerRemittances({ limit: 25, year: 2026 }, actor);
    const auditCount = await prisma.auditEvent.count({
      where: { eventType: "CUSTOMER_REMITTANCE_DRAFT_CREATED" }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.code);
    }
    expect(result.value).toMatchObject({
      number: "RC2026/000001",
      status: "DRAFT",
      chargeDate: "2026-07-15",
      totalAmount: "121.00",
      lineCount: 1,
      lines: [
        {
          dueDateId: dueDate.id,
          invoiceNumber: "F2600001",
          amount: "121.00",
          mandateReference: "MANDATO-001"
        }
      ]
    });
    expect(list.remittances).toHaveLength(1);
    expect(list.remittances[0]?.number).toBe("RC2026/000001");
    expect(auditCount).toBe(1);
  });

  it("rejects non eligible and already included due dates", async () => {
    const actor = await adminActor();
    const dueDate = await createIssuedDirectDebitDueDate(actor.id);
    const transferDueDate = await createIssuedDirectDebitDueDate(actor.id, {
      invoiceNumber: "F2600002",
      dueDatePosition: 2,
      paymentMethod: "BANK_TRANSFER"
    });
    await createCustomerRemittanceDraft(
      {
        chargeDate: "2026-07-15",
        concept: "Remesa julio",
        dueDateIds: [dueDate.id]
      },
      actor
    );

    const duplicate = await createCustomerRemittanceDraft(
      {
        chargeDate: "2026-07-16",
        concept: "Remesa duplicada",
        dueDateIds: [dueDate.id]
      },
      actor
    );
    const notEligible = await createCustomerRemittanceDraft(
      {
        chargeDate: "2026-07-16",
        concept: "Remesa transferencia",
        dueDateIds: [transferDueDate.id]
      },
      actor
    );

    expect(duplicate).toMatchObject({
      ok: false,
      error: { code: "REMITTANCE_DUE_DATE_ALREADY_INCLUDED" }
    });
    expect(notEligible).toMatchObject({
      ok: false,
      error: { code: "REMITTANCE_DUE_DATE_NOT_ELIGIBLE" }
    });
  });

  it("cancels draft remittances and releases their due dates", async () => {
    const actor = await adminActor();
    const dueDate = await createIssuedDirectDebitDueDate(actor.id);
    const created = await createCustomerRemittanceDraft(
      {
        chargeDate: "2026-07-15",
        concept: "Remesa julio",
        dueDateIds: [dueDate.id]
      },
      actor
    );

    if (!created.ok) {
      throw new Error(created.error.code);
    }

    const cancelled = await cancelCustomerRemittanceDraft(
      created.value.id,
      actor,
      { correlationId: "corr-remittance-cancel" }
    );
    const recreated = await createCustomerRemittanceDraft(
      {
        chargeDate: "2026-07-16",
        concept: "Remesa julio corregida",
        dueDateIds: [dueDate.id]
      },
      actor
    );
    const cancelledLineCount = await prisma.customerRemittanceLine.count({
      where: {
        remittanceId: created.value.id,
        status: "CANCELLED"
      }
    });
    const auditCount = await prisma.auditEvent.count({
      where: { eventType: "CUSTOMER_REMITTANCE_DRAFT_CANCELLED" }
    });

    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) {
      throw new Error(cancelled.error.code);
    }
    expect(cancelled.value.status).toBe("CANCELLED");
    expect(cancelledLineCount).toBe(1);
    expect(recreated.ok).toBe(true);
    expect(auditCount).toBe(1);
  });
});

async function adminActor() {
  const user = await prisma.user.findUniqueOrThrow({
    where: { normalizedUserName: "admin" },
    include: {
      role: {
        include: {
          permissions: {
            include: { permission: true }
          }
        }
      }
    }
  });

  return {
    id: user.id,
    displayName: user.displayName,
    userName: user.userName,
    role: {
      id: user.role.id,
      code: user.role.code,
      name: user.role.name
    },
    permissions: user.role.permissions.map((item) => item.permission.code)
  };
}

async function createIssuedDirectDebitDueDate(
  actorUserId: string,
  overrides: {
    invoiceNumber?: string;
    dueDatePosition?: number;
    paymentMethod?: "DIRECT_DEBIT" | "BANK_TRANSFER" | "CASH";
  } = {}
) {
  const invoiceNumber = overrides.invoiceNumber ?? "F2600001";
  const mandateReference = `MANDATO-${String(overrides.dueDatePosition ?? 1).padStart(3, "0")}`;
  const customer = await prisma.customer.create({
    data: {
      code: `C-${invoiceNumber}`,
      type: "COMPANY",
      legalName: `Cliente ${invoiceNumber} SL`,
      taxId: `B${invoiceNumber.slice(-7)}`,
      normalizedTaxId: `B${invoiceNumber.slice(-7)}`,
      fiscalTreatment: "DOMESTIC",
      fiscalAddressLine: "Calle Prueba 1",
      fiscalPostalCode: "28001",
      fiscalCity: "Madrid",
      fiscalProvince: "Madrid",
      fiscalCountry: "ES",
      defaultPaymentMethod: "DIRECT_DEBIT",
      paymentTermsType: "IMMEDIATE",
      bankIban: "ES9121000418450200051332",
      createdById: actorUserId,
      sepaMandates: {
        create: {
          reference: mandateReference,
          referenceNormalized: mandateReference,
          signedAt: new Date("2026-01-01T00:00:00.000Z"),
          createdById: actorUserId
        }
      }
    }
  });
  const invoice = await prisma.invoice.create({
    data: {
      status: "ISSUED",
      paymentStatus: "PENDING",
      verifactuStatus: "PENDING",
      series: "F",
      year: 2026,
      numberSequence: overrides.dueDatePosition ?? 1,
      number: invoiceNumber,
      customerId: customer.id,
      customerCodeSnapshot: customer.code,
      customerLegalNameSnapshot: customer.legalName,
      customerTaxIdSnapshot: customer.taxId,
      customerFiscalTreatmentSnapshot: customer.fiscalTreatment,
      customerFiscalAddressSnapshot: {
        line: customer.fiscalAddressLine,
        postalCode: customer.fiscalPostalCode,
        city: customer.fiscalCity,
        province: customer.fiscalProvince,
        country: customer.fiscalCountry
      },
      issueDate: new Date("2026-07-10T00:00:00.000Z"),
      operationDate: new Date("2026-07-10T00:00:00.000Z"),
      issuedAt: new Date("2026-07-10T09:00:00.000Z"),
      subtotal: "100.00",
      taxableBase: "100.00",
      taxAmount: "21.00",
      total: "121.00",
      createdById: actorUserId,
      issuedById: actorUserId,
      dueDates: {
        create: {
          position: overrides.dueDatePosition ?? 1,
          dueDate: new Date("2026-07-15T00:00:00.000Z"),
          amount: "121.00",
          paymentMethod: overrides.paymentMethod ?? "DIRECT_DEBIT"
        }
      }
    },
    include: {
      dueDates: true
    }
  });

  return invoice.dueDates[0]!;
}

async function initializeForTreasury(): Promise<void> {
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
    prisma.invoiceVerifactuRecord.deleteMany(),
    prisma.customerRemittanceLine.deleteMany(),
    prisma.customerPaymentReturn.deleteMany(),
    prisma.customerPayment.deleteMany(),
    prisma.invoiceDueDate.deleteMany(),
    prisma.invoiceTaxSummary.deleteMany(),
    prisma.invoiceLine.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.invoiceNumberSequence.deleteMany(),
    prisma.platformMaintenanceState.deleteMany(),
    prisma.restoreOperation.deleteMany(),
    prisma.backupOperation.deleteMany(),
    prisma.idempotencyRecord.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.installation.deleteMany(),
    prisma.reservedUserName.deleteMany(),
    prisma.session.deleteMany(),
    prisma.rateLimitBucket.deleteMany(),
    prisma.loginAttempt.deleteMany(),
    prisma.customerAddress.deleteMany(),
    prisma.customerSepaMandate.deleteMany(),
    prisma.customerStore.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.catalogStockMovement.deleteMany(),
    prisma.catalogItem.deleteMany(),
    prisma.catalogCategory.deleteMany(),
    prisma.catalogTaxRate.deleteMany(),
    prisma.accountingJournalLine.deleteMany(),
    prisma.accountingJournalEntry.deleteMany(),
    prisma.accountingAccount.deleteMany(),
    prisma.customerRemittance.deleteMany(),
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
