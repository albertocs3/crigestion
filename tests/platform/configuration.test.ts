import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { login } from "@/modules/platform/application/auth";
import {
  getPlatformConfiguration,
  updateCompanyConfiguration
} from "@/modules/platform/application/configuration";
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

describe("platform configuration", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await initializeForConfiguration();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("reads platform configuration as DTOs", async () => {
    const configuration = await getPlatformConfiguration();

    expect(configuration).toMatchObject({
      company: {
        legalName: "CriGestion Test SL",
        taxId: "B12345678",
        email: "admin@example.test"
      },
      installation: {
        status: "INITIALIZED",
        productVersion: "0.1.0"
      }
    });
    expect(JSON.stringify(configuration)).not.toContain("passwordHash");
  });

  it("updates company configuration and audits only changed field names", async () => {
    const actor = await loginAsAdmin();
    const result = await updateCompanyConfiguration(
      {
        legalName: "CriGestion Actualizada SL",
        taxId: "B87654321",
        email: "contabilidad@example.test"
      },
      actor
    );
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "COMPANY_CONFIGURATION_UPDATED" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      value: {
        legalName: "CriGestion Actualizada SL",
        taxId: "B87654321",
        email: "contabilidad@example.test"
      }
    });
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      changedFields: ["legalName", "taxId", "email"]
    });
    expect(auditPayload).not.toContain("CriGestion Actualizada SL");
    expect(auditPayload).not.toContain("B87654321");
    expect(auditPayload).not.toContain("contabilidad@example.test");
  });

  it("does not allow changing company tax id after issued invoices exist", async () => {
    const actor = await loginAsAdmin();
    await createIssuedInvoice(actor.id);

    const result = await updateCompanyConfiguration(
      {
        legalName: "CriGestion Actualizada SL",
        taxId: "B87654321",
        email: "contabilidad@example.test"
      },
      actor
    );
    const configuration = await getPlatformConfiguration();

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "COMPANY_TAX_ID_LOCKED_BY_ISSUED_INVOICES",
        message: "El NIF de la empresa no puede cambiarse cuando existen facturas emitidas."
      }
    });
    expect(configuration?.company.taxId).toBe("B12345678");
  });

  it("allows changing non-tax company fields after issued invoices exist", async () => {
    const actor = await loginAsAdmin();
    await createIssuedInvoice(actor.id);

    const result = await updateCompanyConfiguration(
      {
        legalName: "CriGestion Actualizada SL",
        taxId: "B12345678",
        email: "contabilidad@example.test"
      },
      actor
    );

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      value: {
        legalName: "CriGestion Actualizada SL",
        taxId: "B12345678",
        email: "contabilidad@example.test"
      }
    });
  });
});

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

async function initializeForConfiguration(): Promise<void> {
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

async function createIssuedInvoice(actorUserId: string): Promise<void> {
  const customer = await prisma.customer.create({
    data: {
      code: "C-FISCAL",
      type: "COMPANY",
      legalName: "Cliente Fiscal SL",
      taxId: "B12345674",
      normalizedTaxId: "B12345674",
      fiscalTreatment: "DOMESTIC",
      fiscalAddressLine: "Calle Fiscal 1",
      fiscalPostalCode: "28001",
      fiscalCity: "Madrid",
      fiscalProvince: "Madrid",
      fiscalCountry: "ES",
      createdById: actorUserId
    }
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
    prisma.invoiceVerifactuRecord.deleteMany(),
    prisma.invoiceDueDate.deleteMany(),
    prisma.invoiceTaxSummary.deleteMany(),
    prisma.invoiceLine.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.invoiceNumberSequence.deleteMany(),
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
