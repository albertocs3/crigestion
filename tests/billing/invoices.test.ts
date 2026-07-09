import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  addInvoiceLine,
  createInvoiceDraft,
  createInvoiceDraftSchema,
  issueInvoice,
  issueInvoiceSchema
} from "@/modules/billing/application/invoices";
import { createCatalogItem } from "@/modules/catalog/application/items";
import { login } from "@/modules/platform/application/auth";
import { registerCustomerPayment } from "@/modules/treasury/application/payments";
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

describe("billing invoices application service", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await resetCatalogItemCodeSequence();
    await initializeForBilling();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("normalizes localized form dates before running invoice commands", () => {
    expect(
      createInvoiceDraftSchema.parse({
        customerId: randomUUID(),
        issueDate: "07/07/2026",
        operationDate: "08/07/2026",
        notes: null
      })
    ).toMatchObject({
      issueDate: "2026-07-07",
      operationDate: "2026-07-08"
    });
    expect(issueInvoiceSchema.parse({ issueDate: "07/07/2026" })).toMatchObject({
      issueDate: "2026-07-07"
    });
    expect(issueInvoiceSchema.parse({ issueDate: "7/7/2026" })).toMatchObject({
      issueDate: "2026-07-07"
    });
    expect(issueInvoiceSchema.parse({ issueDate: "07-07-2026" })).toMatchObject({
      issueDate: "2026-07-07"
    });
    expect(issueInvoiceSchema.parse({ issueDate: "2026-07-07T00:00:00.000Z" }))
      .toMatchObject({
        issueDate: "2026-07-07"
      });
  });

  it("creates a draft, adds a catalog line and issues with safe audit payloads", async () => {
    const actor = await loginAsAdmin();
    const customer = await createCustomer(actor.id);
    const taxRate = await defaultTaxRate();
    const catalogItem = await createCatalogItem(
      {
        categoryId: null,
        kind: "SERVICE",
        name: "Servicio mensual",
        description: "Cuota mensual",
        unitName: "Unidades",
        salePrice: "100.00",
        costPrice: "0.00",
        taxRateId: taxRate.id,
        stockTracked: false,
        stockCurrent: "0.000",
        stockMinimum: "0.000"
      },
      actor
    );

    if (!catalogItem.ok) {
      throw new Error(catalogItem.error.code);
    }

    const draft = await createInvoiceDraft(
      {
        customerId: customer.id,
        issueDate: "2026-07-07",
        operationDate: "2026-07-07",
        notes: "Nota interna que no debe auditarse completa"
      },
      actor,
      { correlationId: "invoice-draft-0001" }
    );

    if (!draft.ok) {
      throw new Error(draft.error.code);
    }

    const withLine = await addInvoiceLine(
      draft.value.id,
      {
        catalogItemId: catalogItem.value.id,
        description: "Servicio mensual",
        quantity: "1.000",
        unitPrice: "100.00",
        discountPercent: "0.00",
        discountAmount: "0.00",
        taxRateId: taxRate.id
      },
      actor,
      { correlationId: "invoice-line-0001" }
    );

    if (!withLine.ok) {
      throw new Error(withLine.error.code);
    }

    const issued = await issueInvoice(
      draft.value.id,
      { issueDate: "2026-07-07" },
      actor,
      { correlationId: "invoice-issue-0001" }
    );
    const issuedAudit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "INVOICE_ISSUED" }
    });
    const verifactuRecord = await prisma.invoiceVerifactuRecord.findUniqueOrThrow({
      where: { invoiceId: draft.value.id }
    });
    const auditPayload = JSON.stringify(issuedAudit.payload);

    expect(draft.value).toMatchObject({
      status: "DRAFT",
      number: null,
      customerSnapshot: {
        code: customer.code,
        legalName: customer.legalName
      },
      dueDates: [
        {
          dueDate: "2026-08-06",
          amount: "0.00",
          paymentMethod: "BANK_TRANSFER"
        }
      ]
    });
    expect(withLine.value).toMatchObject({
      totals: {
        taxableBase: "100.00",
        taxAmount: "21.00",
        total: "121.00"
      },
      dueDates: [
        {
          amount: "121.00"
        }
      ],
      taxSummary: [
        {
          taxRateCode: "IVA_21",
          taxableBase: "100.00",
          taxAmount: "21.00",
          total: "121.00"
        }
      ]
    });
    expect(issued).toMatchObject({
      ok: true,
      status: 200,
      value: {
        status: "ISSUED",
        number: "F2600001",
        verifactuStatus: "PENDING"
      }
    });
    expect(verifactuRecord.status).toBe("PENDING");
    expect(issuedAudit.payload).toMatchObject({
      actorUserId: actor.id,
      invoiceId: draft.value.id,
      number: "F2600001",
      customerId: customer.id,
      total: "121.00",
      correlationId: "invoice-issue-0001"
    });
    expect(auditPayload).not.toContain(customer.taxId);
    expect(auditPayload).not.toContain("Nota interna");
  });

  it("rejects inactive customers and non-editable invoices", async () => {
    const actor = await loginAsAdmin();
    const customer = await createCustomer(actor.id, { status: "INACTIVE" });
    const draft = await createInvoiceDraft(
      {
        customerId: customer.id,
        issueDate: "2026-07-07",
        operationDate: "2026-07-07",
        notes: null
      },
      actor
    );

    expect(draft).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "CUSTOMER_NOT_ACTIVE",
        message: "El cliente no esta activo."
      }
    });
  });

  it("does not allow adding lines to issued invoices", async () => {
    const actor = await loginAsAdmin();
    const customer = await createCustomer(actor.id);
    const taxRate = await defaultTaxRate();
    const draft = await createInvoiceDraft(
      {
        customerId: customer.id,
        issueDate: "2026-07-07",
        operationDate: "2026-07-07",
        notes: null
      },
      actor
    );

    if (!draft.ok) {
      throw new Error(draft.error.code);
    }

    const line = await addInvoiceLine(
      draft.value.id,
      {
        description: "Linea manual",
        quantity: "1.000",
        unitPrice: "50.00",
        discountPercent: "0.00",
        discountAmount: "0.00",
        taxRateId: taxRate.id
      },
      actor
    );

    if (!line.ok) {
      throw new Error(line.error.code);
    }

    const issued = await issueInvoice(
      draft.value.id,
      { issueDate: "2026-07-07" },
      actor
    );

    if (!issued.ok) {
      throw new Error(issued.error.code);
    }

    const result = await addInvoiceLine(
      draft.value.id,
      {
        description: "Linea tardia",
        quantity: "1.000",
        unitPrice: "10.00",
        discountPercent: "0.00",
        discountAmount: "0.00",
        taxRateId: taxRate.id
      },
      actor
    );
    const lineCount = await prisma.invoiceLine.count({
      where: { invoiceId: draft.value.id }
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "INVOICE_NOT_EDITABLE",
        message: "La factura no esta en borrador."
      }
    });
    expect(lineCount).toBe(1);
  });

  it("rejects empty invoices and chronology violations", async () => {
    const actor = await loginAsAdmin();
    const firstCustomer = await createCustomer(actor.id);
    const secondCustomer = await createCustomer(actor.id);
    const taxRate = await defaultTaxRate();
    const firstDraft = await createInvoiceDraft(
      {
        customerId: firstCustomer.id,
        issueDate: "2026-07-08",
        operationDate: "2026-07-08",
        notes: null
      },
      actor
    );

    if (!firstDraft.ok) {
      throw new Error(firstDraft.error.code);
    }

    const emptyIssue = await issueInvoice(
      firstDraft.value.id,
      { issueDate: "2026-07-08" },
      actor
    );

    expect(emptyIssue).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "INVOICE_EMPTY",
        message: "La factura no tiene lineas."
      }
    });

    const firstLine = await addInvoiceLine(
      firstDraft.value.id,
      {
        description: "Linea manual",
        quantity: "1.000",
        unitPrice: "50.00",
        discountPercent: "0.00",
        discountAmount: "0.00",
        taxRateId: taxRate.id
      },
      actor
    );

    if (!firstLine.ok) {
      throw new Error(firstLine.error.code);
    }

    const firstIssued = await issueInvoice(
      firstDraft.value.id,
      { issueDate: "2026-07-08" },
      actor
    );

    if (!firstIssued.ok) {
      throw new Error(firstIssued.error.code);
    }

    const secondDraft = await createInvoiceDraft(
      {
        customerId: secondCustomer.id,
        issueDate: "2026-07-07",
        operationDate: "2026-07-07",
        notes: null
      },
      actor
    );

    if (!secondDraft.ok) {
      throw new Error(secondDraft.error.code);
    }

    const secondLine = await addInvoiceLine(
      secondDraft.value.id,
      {
        description: "Linea manual",
        quantity: "1.000",
        unitPrice: "50.00",
        discountPercent: "0.00",
        discountAmount: "0.00",
        taxRateId: taxRate.id
      },
      actor
    );

    if (!secondLine.ok) {
      throw new Error(secondLine.error.code);
    }

    const secondIssued = await issueInvoice(
      secondDraft.value.id,
      { issueDate: "2026-07-07" },
      actor
    );

    expect(secondIssued).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "INVOICE_CHRONOLOGY_VIOLATION",
        message: "La fecha de emision rompe el orden cronologico de la serie."
      }
    });
  });

  it("registers partial and full customer payments with safe audit payloads", async () => {
    const actor = await loginAsAdmin();
    const customer = await createCustomer(actor.id);
    const taxRate = await defaultTaxRate();
    const draft = await createInvoiceDraft(
      {
        customerId: customer.id,
        issueDate: "2026-07-07",
        operationDate: "2026-07-07",
        notes: null
      },
      actor
    );

    if (!draft.ok) {
      throw new Error(draft.error.code);
    }

    const line = await addInvoiceLine(
      draft.value.id,
      {
        description: "Linea manual",
        quantity: "1.000",
        unitPrice: "100.00",
        discountPercent: "0.00",
        discountAmount: "0.00",
        taxRateId: taxRate.id
      },
      actor
    );

    if (!line.ok) {
      throw new Error(line.error.code);
    }

    const issued = await issueInvoice(
      draft.value.id,
      { issueDate: "2026-07-07" },
      actor
    );

    if (!issued.ok) {
      throw new Error(issued.error.code);
    }

    const dueDateId = issued.value.dueDates[0]?.id;

    if (!dueDateId) {
      throw new Error("Missing due date.");
    }

    const partial = await registerCustomerPayment(
      issued.value.id,
      {
        dueDateId,
        paymentDate: "2026-07-10",
        amount: "60.00",
        reference: "Transferencia 001",
        notes: "No debe aparecer NIF ni secretos"
      },
      actor,
      { correlationId: "customer-payment-0001" }
    );
    const paid = await registerCustomerPayment(
      issued.value.id,
      {
        dueDateId,
        paymentDate: "2026-07-11",
        amount: "61.00",
        reference: "Transferencia 002",
        notes: null
      },
      actor,
      { correlationId: "customer-payment-0002" }
    );
    const auditEvents = await prisma.auditEvent.findMany({
      where: { eventType: "CUSTOMER_PAYMENT_REGISTERED" },
      orderBy: { createdAt: "asc" }
    });
    const storedPayments = await prisma.customerPayment.findMany({
      where: { invoiceId: issued.value.id },
      orderBy: { paymentDate: "asc" }
    });
    const dueDate = await prisma.invoiceDueDate.findUniqueOrThrow({
      where: { id: dueDateId }
    });
    const auditPayload = JSON.stringify(auditEvents.map((event) => event.payload));

    expect(partial).toMatchObject({
      ok: true,
      status: 201,
      value: {
        paymentStatus: "PARTIALLY_PAID",
        dueDates: [
          {
            id: dueDateId,
            status: "PENDING"
          }
        ]
      }
    });
    expect(paid).toMatchObject({
      ok: true,
      status: 201,
      value: {
        paymentStatus: "PAID",
        dueDates: [
          {
            id: dueDateId,
            status: "PAID"
          }
        ]
      }
    });
    expect(storedPayments.map((payment) => payment.amount.toFixed(2))).toEqual([
      "60.00",
      "61.00"
    ]);
    expect(dueDate.status).toBe("PAID");
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents[0]?.payload).toMatchObject({
      actorUserId: actor.id,
      invoiceId: issued.value.id,
      dueDateId,
      customerId: customer.id,
      amount: "60.00",
      paymentDate: "2026-07-10",
      resultingPaymentStatus: "PARTIALLY_PAID",
      correlationId: "customer-payment-0001"
    });
    expect(auditPayload).not.toContain(customer.taxId);
    expect(auditPayload).not.toContain("No debe aparecer");
  });

  it("rejects customer payments for drafts and overpayments", async () => {
    const actor = await loginAsAdmin();
    const customer = await createCustomer(actor.id);
    const taxRate = await defaultTaxRate();
    const draft = await createInvoiceDraft(
      {
        customerId: customer.id,
        issueDate: "2026-07-07",
        operationDate: "2026-07-07",
        notes: null
      },
      actor
    );

    if (!draft.ok) {
      throw new Error(draft.error.code);
    }

    const line = await addInvoiceLine(
      draft.value.id,
      {
        description: "Linea manual",
        quantity: "1.000",
        unitPrice: "100.00",
        discountPercent: "0.00",
        discountAmount: "0.00",
        taxRateId: taxRate.id
      },
      actor
    );

    if (!line.ok) {
      throw new Error(line.error.code);
    }

    const draftPayment = await registerCustomerPayment(
      draft.value.id,
      {
        dueDateId: line.value.dueDates[0]?.id ?? randomUUID(),
        paymentDate: "2026-07-10",
        amount: "1.00",
        reference: null,
        notes: null
      },
      actor
    );
    const issued = await issueInvoice(
      draft.value.id,
      { issueDate: "2026-07-07" },
      actor
    );

    if (!issued.ok) {
      throw new Error(issued.error.code);
    }

    const overpayment = await registerCustomerPayment(
      issued.value.id,
      {
        dueDateId: issued.value.dueDates[0]?.id ?? randomUUID(),
        paymentDate: "2026-07-10",
        amount: "122.00",
        reference: null,
        notes: null
      },
      actor
    );

    expect(draftPayment).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "INVOICE_NOT_PAYABLE",
        message: "Solo se pueden registrar cobros en facturas emitidas."
      }
    });
    expect(overpayment).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "PAYMENT_AMOUNT_EXCEEDS_PENDING",
        message: "El importe supera el saldo pendiente del vencimiento."
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

async function defaultTaxRate() {
  return prisma.catalogTaxRate.findFirstOrThrow({
    where: { code: "IVA_21" },
    select: { id: true }
  });
}

async function createCustomer(
  createdById: string,
  overrides: {
    status?: "ACTIVE" | "INACTIVE";
    legalName?: string;
    paymentTermsType?: "IMMEDIATE" | "DAYS" | "FIXED_DAY_OF_MONTH";
    paymentDays?: number | null;
    paymentFixedDay?: number | null;
  } = {}
) {
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
      paymentTermsType: "DAYS",
      paymentDays: 30,
      createdById,
      ...overrides
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
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}

async function resetCatalogItemCodeSequence(): Promise<void> {
  await prisma.$executeRaw`ALTER SEQUENCE catalog_item_code_seq RESTART WITH 1`;
}
