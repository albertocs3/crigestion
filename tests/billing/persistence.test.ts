import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";

const baseCommand: InitializeCommand = {
  company: {
    legalName: "CriGestion Test SL",
    taxId: "B12345678",
    email: "admin@example.test"
  },
  administrator: {
    displayName: "Administrador",
    userName: "admin",
    password: "Cambiar-esta-clave-2026"
  }
};

describe("billing persistence", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await initializeForBilling();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("seeds billing permissions for the protected administrator role", async () => {
    const permissions = await prisma.permission.findMany({
      where: {
        code: {
          in: [
            "Billing.View",
            "Billing.ManageDrafts",
            "Billing.Issue",
            "Treasury.ManagePayments"
          ]
        }
      },
      orderBy: { code: "asc" },
      select: { code: true }
    });
    const admin = await prisma.user.findUniqueOrThrow({
      where: { normalizedUserName: "admin" },
      select: {
        role: {
          select: {
            permissions: {
              select: {
                permission: {
                  select: { code: true }
                }
              }
            }
          }
        }
      }
    });
    const adminPermissionCodes = admin.role.permissions.map(
      (rolePermission) => rolePermission.permission.code
    );

    expect(permissions.map((permission) => permission.code)).toEqual([
      "Billing.Issue",
      "Billing.ManageDrafts",
      "Billing.View",
      "Treasury.ManagePayments"
    ]);
    expect(adminPermissionCodes).toEqual(
      expect.arrayContaining([
        "Billing.View",
        "Billing.ManageDrafts",
        "Billing.Issue",
        "Treasury.ManagePayments"
      ])
    );
  });

  it("stores a draft invoice graph with fiscal snapshots and calculated totals", async () => {
    const admin = await findAdmin();
    const customer = await createCustomer(admin.id);
    const taxRate = await prisma.catalogTaxRate.findFirstOrThrow({
      where: { code: "IVA_21" }
    });
    const invoice = await prisma.invoice.create({
      data: {
        year: 2026,
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
        subtotal: "100.00",
        discountTotal: "0.00",
        taxableBase: "100.00",
        taxAmount: "21.00",
        total: "121.00",
        createdById: admin.id,
        lines: {
          create: {
            position: 1,
            description: "Servicio mensual",
            quantity: "1.000",
            unitPrice: "100.00",
            discountPercent: "0.00",
            discountAmount: "0.00",
            taxRateId: taxRate.id,
            taxRateCodeSnapshot: taxRate.code,
            taxRateNameSnapshot: taxRate.name,
            taxRateSnapshot: taxRate.rate,
            lineSubtotal: "100.00",
            lineDiscountTotal: "0.00",
            lineTaxableBase: "100.00",
            lineTaxAmount: "21.00",
            lineTotal: "121.00"
          }
        },
        taxSummaries: {
          create: {
            taxRateCode: taxRate.code,
            taxRate: taxRate.rate,
            taxableBase: "100.00",
            taxAmount: "21.00",
            total: "121.00"
          }
        },
        dueDates: {
          create: {
            position: 1,
            dueDate: new Date("2026-07-07T00:00:00.000Z"),
            amount: "121.00",
            paymentMethod: "BANK_TRANSFER"
          }
        }
      },
      include: {
        lines: true,
        taxSummaries: true,
        dueDates: true
      }
    });

    expect(invoice.status).toBe("DRAFT");
    expect(invoice.number).toBeNull();
    expect(invoice.lines).toHaveLength(1);
    expect(invoice.taxSummaries).toHaveLength(1);
    expect(invoice.dueDates).toHaveLength(1);
    expect(invoice.total.toFixed(2)).toBe("121.00");
  });

  it("enforces issued invoice and line integrity constraints in PostgreSQL", async () => {
    const admin = await findAdmin();
    const customer = await createCustomer(admin.id);
    const taxRate = await prisma.catalogTaxRate.findFirstOrThrow({
      where: { code: "IVA_21" }
    });

    await expect(
      prisma.invoice.create({
        data: {
          status: "ISSUED",
          year: 2026,
          customerId: customer.id,
          customerCodeSnapshot: customer.code,
          customerLegalNameSnapshot: customer.legalName,
          customerTaxIdSnapshot: customer.taxId,
          customerFiscalTreatmentSnapshot: customer.fiscalTreatment,
          customerFiscalAddressSnapshot: { country: "ES" },
          issueDate: new Date("2026-07-07T00:00:00.000Z"),
          operationDate: new Date("2026-07-07T00:00:00.000Z"),
          createdById: admin.id
        }
      })
    ).rejects.toThrow();

    const draft = await prisma.invoice.create({
      data: {
        year: 2026,
        customerId: customer.id,
        customerCodeSnapshot: customer.code,
        customerLegalNameSnapshot: customer.legalName,
        customerTaxIdSnapshot: customer.taxId,
        customerFiscalTreatmentSnapshot: customer.fiscalTreatment,
        customerFiscalAddressSnapshot: { country: "ES" },
        issueDate: new Date("2026-07-07T00:00:00.000Z"),
        operationDate: new Date("2026-07-07T00:00:00.000Z"),
        createdById: admin.id
      }
    });

    await expect(
      prisma.invoiceLine.create({
        data: {
          invoiceId: draft.id,
          position: 1,
          description: "Linea invalida",
          quantity: "0.000",
          unitPrice: "100.00",
          taxRateId: taxRate.id,
          taxRateCodeSnapshot: taxRate.code,
          taxRateNameSnapshot: taxRate.name,
          taxRateSnapshot: taxRate.rate,
          lineSubtotal: "0.00",
          lineDiscountTotal: "0.00",
          lineTaxableBase: "0.00",
          lineTaxAmount: "0.00",
          lineTotal: "0.00"
        }
      })
    ).rejects.toThrow();
  });
});

async function findAdmin() {
  return prisma.user.findUniqueOrThrow({
    where: { normalizedUserName: "admin" },
    select: { id: true }
  });
}

async function createCustomer(createdById: string) {
  return prisma.customer.create({
    data: {
      code: `C-${randomUUID().slice(0, 8)}`,
      type: "COMPANY",
      legalName: "Cliente Facturacion SL",
      taxId: `B${Math.floor(Math.random() * 100000000)
        .toString()
        .padStart(8, "0")}`,
      normalizedTaxId: `BILLING-${randomUUID()}`,
      fiscalTreatment: "DOMESTIC",
      fiscalAddressLine: "Calle Factura 1",
      fiscalPostalCode: "28001",
      fiscalCity: "Madrid",
      fiscalProvince: "Madrid",
      fiscalCountry: "ES",
      createdById
    }
  });
}

async function initializeForBilling(): Promise<void> {
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
