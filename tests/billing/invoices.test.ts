import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  addInvoiceLine,
  createInvoiceRectification,
  createInvoiceDraft,
  createInvoiceDraftSchema,
  issueInvoice,
  issueInvoiceSchema,
  replaceInvoiceDueDates
} from "@/modules/billing/application/invoices";
import { createCatalogItem } from "@/modules/catalog/application/items";
import { login } from "@/modules/platform/application/auth";
import {
  markCustomerDueDateUnpaid,
  registerCustomerPayment,
  registerCustomerPaymentReturn
} from "@/modules/treasury/application/payments";
import { listCustomerDueDates } from "@/modules/treasury/application/dueDates";
import { getCustomerCollectionForecast } from "@/modules/treasury/application/forecast";
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
    const accountingEntry = await prisma.accountingJournalEntry.findUniqueOrThrow({
      where: { invoiceId: draft.value.id },
      include: { lines: { include: { account: true }, orderBy: { position: "asc" } } }
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
    expect(accountingEntry).toMatchObject({
      origin: "INVOICE",
      number: "2026/000001",
      totalDebit: new Prisma.Decimal("121.00"),
      totalCredit: new Prisma.Decimal("121.00")
    });
    expect(accountingEntry.lines.map((line) => ({
      account: line.account.code,
      debit: line.debit.toFixed(2),
      credit: line.credit.toFixed(2)
    }))).toEqual([
      { account: `430${customer.code.padStart(6, "0")}`, debit: "121.00", credit: "0.00" },
      { account: "705000000", debit: "0.00", credit: "100.00" },
      { account: "477000000", debit: "0.00", credit: "21.00" }
    ]);
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

  it("creates full invoice rectifications without mutating original invoice data", async () => {
    const actor = await loginAsAdmin();
    const original = await createIssuedInvoiceWithOneLine(actor, {
      issueDate: "2026-07-07",
      legalName: "Cliente Rectificativa SL"
    });

    const rectification = await createInvoiceRectification(
      original.issued.value.id,
      {
        issueDate: "2026-07-08",
        reason: "AMOUNT_ERROR",
        notes: "Motivo interno no sensible"
      },
      actor,
      { correlationId: "invoice-rectification-0001" }
    );
    const duplicate = await createInvoiceRectification(
      original.issued.value.id,
      {
        issueDate: "2026-07-09",
        reason: "OTHER",
        notes: null
      },
      actor
    );
    const storedOriginal = await prisma.invoice.findUniqueOrThrow({
      where: { id: original.issued.value.id },
      select: {
        status: true,
        number: true,
        total: true,
        lines: {
          select: {
            quantity: true,
            lineTotal: true
          }
        }
      }
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "INVOICE_RECTIFICATION_CREATED" }
    });
    if (!rectification.ok) {
      throw new Error(rectification.error.code);
    }
    const accountingEntry = await prisma.accountingJournalEntry.findUniqueOrThrow({
      where: { invoiceId: rectification.value.id },
      include: { lines: { include: { account: true }, orderBy: { position: "asc" } } }
    });

    expect(rectification).toMatchObject({
      ok: true,
      status: 201,
      value: {
        documentType: "RECTIFICATION",
        status: "ISSUED",
        series: "R",
        number: "R2600001",
        paymentStatus: "PAID",
        rectificationReason: "AMOUNT_ERROR",
        rectifiesInvoice: {
          id: original.issued.value.id,
          number: "F2600001"
        },
        totals: {
          taxableBase: "-100.00",
          taxAmount: "-21.00",
          total: "-121.00"
        },
        lines: [
          {
            quantity: "-1.000",
            totals: {
              total: "-121.00"
            }
          }
        ],
        dueDates: [
          {
            amount: "-121.00",
            status: "PAID"
          }
        ]
      }
    });
    expect(storedOriginal.status).toBe("RECTIFIED");
    expect(storedOriginal.number).toBe("F2600001");
    expect(storedOriginal.total.toFixed(2)).toBe("121.00");
    expect(storedOriginal.lines[0]?.quantity.toFixed(3)).toBe("1.000");
    expect(storedOriginal.lines[0]?.lineTotal.toFixed(2)).toBe("121.00");
    expect(accountingEntry).toMatchObject({
      origin: "INVOICE",
      number: "2026/000002",
      totalDebit: new Prisma.Decimal("121.00"),
      totalCredit: new Prisma.Decimal("121.00")
    });
    expect(accountingEntry.lines.map((line) => ({
      account: line.account.code,
      debit: line.debit.toFixed(2),
      credit: line.credit.toFixed(2)
    }))).toEqual([
      { account: "705000000", debit: "100.00", credit: "0.00" },
      { account: "477000000", debit: "21.00", credit: "0.00" },
      { account: `430${original.customer.code.padStart(6, "0")}`, debit: "0.00", credit: "121.00" }
    ]);
    expect(duplicate).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "INVOICE_NOT_RECTIFIABLE",
        message: "Solo se pueden rectificar facturas ordinarias emitidas."
      }
    });
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      rectifiesInvoiceId: original.issued.value.id,
      originalNumber: "F2600001",
      number: "R2600001",
      total: "-121.00",
      reason: "AMOUNT_ERROR",
      issueDate: "2026-07-08",
      accountingJournalEntryId: accountingEntry.id,
      accountingJournalEntryNumber: "2026/000002",
      correlationId: "invoice-rectification-0001"
    });
  });

  it("rolls back a rectification when a required accounting account is unavailable", async () => {
    const actor = await loginAsAdmin();
    const original = await createIssuedInvoiceWithOneLine(actor, {
      issueDate: "2026-07-07",
      legalName: "Cliente Rollback Rectificativa SL"
    });
    await prisma.accountingAccount.updateMany({
      where: { code: "477000000" },
      data: { status: "INACTIVE" }
    });

    const result = await createInvoiceRectification(
      original.issued.value.id,
      { issueDate: "2026-07-08", reason: "AMOUNT_ERROR", notes: null },
      actor
    );
    const storedOriginal = await prisma.invoice.findUniqueOrThrow({
      where: { id: original.issued.value.id },
      select: { status: true }
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "INVOICE_ACCOUNTING_ACCOUNT_NOT_AVAILABLE",
        message: "Falta alguna cuenta contable activa e imputable necesaria para emitir la factura."
      }
    });
    expect(storedOriginal.status).toBe("ISSUED");
    expect(await prisma.invoice.count({ where: { documentType: "RECTIFICATION" } })).toBe(0);
    expect(await prisma.invoiceNumberSequence.findUnique({ where: { series_year: { series: "R", year: 2026 } } })).toBeNull();
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
    const paymentEntries = await prisma.accountingJournalEntry.findMany({
      where: { origin: "CUSTOMER_PAYMENT" },
      orderBy: { sequence: "asc" },
      include: { lines: { orderBy: { position: "asc" }, include: { account: true } } }
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
    expect(paymentEntries.map((entry) => ({
      paymentId: entry.customerPaymentId,
      debit: entry.totalDebit.toFixed(2),
      credit: entry.totalCredit.toFixed(2),
      accounts: entry.lines.map((line) => line.account.code)
    }))).toEqual([
      { paymentId: storedPayments[0]?.id, debit: "60.00", credit: "60.00", accounts: ["572000000", `430${customer.code.padStart(6, "0")}`] },
      { paymentId: storedPayments[1]?.id, debit: "61.00", credit: "61.00", accounts: ["572000000", `430${customer.code.padStart(6, "0")}`] }
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
    expect(auditEvents[0]?.payload).toMatchObject({
      accountingJournalEntryId: paymentEntries[0]?.id,
      accountingJournalEntryNumber: "2026/000002"
    });
    expect(auditPayload).not.toContain(customer.taxId);
    expect(auditPayload).not.toContain("No debe aparecer");
  });

  it("registers manual customer payment returns and recalculates net balances", async () => {
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

    const payment = await registerCustomerPayment(
      issued.value.id,
      {
        dueDateId,
        paymentDate: "2026-07-10",
        amount: "121.00",
        reference: "Transferencia 003",
        notes: null
      },
      actor
    );

    if (!payment.ok) {
      throw new Error(payment.error.code);
    }

    const paymentId = payment.value.payments[0]?.id;

    if (!paymentId) {
      throw new Error("Missing payment.");
    }

    const partialReturn = await registerCustomerPaymentReturn(
      issued.value.id,
      {
        paymentId,
        returnDate: "2026-07-12",
        amount: "50.00",
        reasonCode: "BANK_RETURN",
        notes: "Texto interno no auditable"
      },
      actor,
      { correlationId: "customer-payment-return-0001" }
    );
    const fullReturn = await registerCustomerPaymentReturn(
      issued.value.id,
      {
        paymentId,
        returnDate: "2026-07-13",
        amount: "71.00",
        reasonCode: null,
        notes: null
      },
      actor
    );
    const overReturn = await registerCustomerPaymentReturn(
      issued.value.id,
      {
        paymentId,
        returnDate: "2026-07-14",
        amount: "0.01",
        reasonCode: null,
        notes: null
      },
      actor
    );
    const storedReturns = await prisma.customerPaymentReturn.findMany({
      where: { paymentId },
      orderBy: { returnDate: "asc" }
    });
    const dueDate = await prisma.invoiceDueDate.findUniqueOrThrow({
      where: { id: dueDateId }
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_PAYMENT_RETURNED" },
      orderBy: { createdAt: "asc" }
    });

    expect(partialReturn).toMatchObject({
      ok: true,
      status: 201,
      value: {
        paymentStatus: "PARTIALLY_PAID",
        dueDates: [
          {
            id: dueDateId,
            paidAmount: "71.00",
            pendingAmount: "50.00",
            status: "PENDING"
          }
        ],
        payments: [
          {
            id: paymentId,
            amount: "121.00",
            returnedAmount: "50.00",
            netAmount: "71.00"
          }
        ]
      }
    });
    expect(fullReturn).toMatchObject({
      ok: true,
      status: 201,
      value: {
        paymentStatus: "PENDING",
        dueDates: [
          {
            id: dueDateId,
            paidAmount: "0.00",
            pendingAmount: "121.00",
            status: "RETURNED"
          }
        ]
      }
    });
    expect(overReturn).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "PAYMENT_RETURN_AMOUNT_EXCEEDS_PAYMENT",
        message: "La devolucion supera el importe no devuelto del cobro."
      }
    });
    expect(storedReturns.map((paymentReturn) => paymentReturn.amount.toFixed(2))).toEqual([
      "50.00",
      "71.00"
    ]);
    expect(dueDate.status).toBe("RETURNED");
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      paymentId,
      invoiceId: issued.value.id,
      dueDateId,
      customerId: customer.id,
      amount: "50.00",
      returnDate: "2026-07-12",
      resultingPaymentStatus: "PARTIALLY_PAID",
      correlationId: "customer-payment-return-0001"
    });
    expect(JSON.stringify(auditEvent.payload)).not.toContain("Texto interno");
  });

  it("posts cash payments to 570 and rolls back when the treasury account is unavailable", async () => {
    const actor = await loginAsAdmin();
    const cashInvoice = await createIssuedInvoiceWithOneLine(actor, { issueDate: "2026-07-07", legalName: "Cliente Cobro Caja SL" });
    const cashDueDateId = cashInvoice.issued.value.dueDates[0]!.id;
    await prisma.invoiceDueDate.update({ where: { id: cashDueDateId }, data: { paymentMethod: "CASH" } });
    const cashResult = await registerCustomerPayment(
      cashInvoice.issued.value.id,
      { dueDateId: cashDueDateId, paymentDate: "2026-07-10", amount: "121.00", reference: null, notes: null },
      actor
    );
    const cashEntry = await prisma.accountingJournalEntry.findFirstOrThrow({
      where: { origin: "CUSTOMER_PAYMENT" },
      include: { lines: { orderBy: { position: "asc" }, include: { account: true } } }
    });
    expect(cashResult.ok).toBe(true);
    expect(cashEntry.lines.map((line) => line.account.code)).toEqual(["570000000", `430${cashInvoice.customer.code.padStart(6, "0")}`]);

    const bankInvoice = await createIssuedInvoiceWithOneLine(actor, { issueDate: "2026-07-08", legalName: "Cliente Rollback Cobro SL" });
    const bankDueDateId = bankInvoice.issued.value.dueDates[0]!.id;
    await prisma.accountingAccount.updateMany({ where: { code: "572000000" }, data: { status: "INACTIVE" } });
    const failed = await registerCustomerPayment(
      bankInvoice.issued.value.id,
      { dueDateId: bankDueDateId, paymentDate: "2026-07-11", amount: "121.00", reference: null, notes: null },
      actor
    );
    expect(failed).toEqual({ ok: false, status: 409, error: { code: "PAYMENT_ACCOUNTING_ACCOUNT_NOT_AVAILABLE", message: "Falta alguna cuenta contable activa e imputable necesaria para registrar el cobro." } });
    expect(await prisma.customerPayment.count({ where: { invoiceId: bankInvoice.issued.value.id } })).toBe(0);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: bankInvoice.issued.value.id } })).paymentStatus).toBe("PENDING");
  });

  it("marks customer due dates as unpaid and blocks ordinary collection", async () => {
    const actor = await loginAsAdmin();
    const { customer, issued } = await createIssuedInvoiceWithOneLine(actor, {
      issueDate: "2026-07-07",
      legalName: "Cliente Impago SL"
    });
    const dueDateId = issued.value.dueDates[0]?.id;

    if (!dueDateId) {
      throw new Error("Missing due date.");
    }

    const partialPayment = await registerCustomerPayment(
      issued.value.id,
      {
        dueDateId,
        paymentDate: "2026-07-10",
        amount: "40.00",
        reference: "Transferencia parcial",
        notes: null
      },
      actor
    );

    if (!partialPayment.ok) {
      throw new Error(partialPayment.error.code);
    }

    const unpaid = await markCustomerDueDateUnpaid(
      issued.value.id,
      {
        dueDateId,
        unpaidDate: "2026-07-20",
        reasonCode: "BANK_DEFAULT",
        notes: "No debe auditar detalle interno"
      },
      actor,
      { correlationId: "customer-due-date-unpaid-0001" }
    );
    const blockedPayment = await registerCustomerPayment(
      issued.value.id,
      {
        dueDateId,
        paymentDate: "2026-07-21",
        amount: "1.00",
        reference: null,
        notes: null
      },
      actor
    );
    const storedInvoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: issued.value.id }
    });
    const storedDueDate = await prisma.invoiceDueDate.findUniqueOrThrow({
      where: { id: dueDateId }
    });
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_DUE_DATE_MARKED_UNPAID" }
    });

    expect(unpaid).toMatchObject({
      ok: true,
      status: 201,
      value: {
        paymentStatus: "UNPAID",
        dueDates: [
          {
            id: dueDateId,
            paidAmount: "40.00",
            pendingAmount: "81.00",
            status: "UNPAID"
          }
        ]
      }
    });
    expect(blockedPayment).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "INVOICE_DUE_DATE_NOT_PAYABLE",
        message: "El vencimiento no admite nuevos cobros."
      }
    });
    expect(storedInvoice.paymentStatus).toBe("UNPAID");
    expect(storedDueDate.status).toBe("UNPAID");
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      invoiceId: issued.value.id,
      dueDateId,
      customerId: customer.id,
      unpaidDate: "2026-07-20",
      reasonCode: "BANK_DEFAULT",
      pendingAmount: "81.00",
      resultingPaymentStatus: "UNPAID",
      correlationId: "customer-due-date-unpaid-0001"
    });
    expect(JSON.stringify(auditEvent.payload)).not.toContain("detalle interno");
  });

  it("lists issued customer due dates with net treasury balances", async () => {
    const actor = await loginAsAdmin();
    const first = await createIssuedInvoiceWithOneLine(actor, {
      issueDate: "2026-07-07",
      legalName: "Cliente Tesoreria Pendiente SL"
    });
    const second = await createIssuedInvoiceWithOneLine(actor, {
      issueDate: "2026-07-08",
      legalName: "Cliente Tesoreria Pagada SL"
    });
    const firstDueDateId = first.issued.value.dueDates[0]?.id;
    const secondDueDateId = second.issued.value.dueDates[0]?.id;

    if (!firstDueDateId || !secondDueDateId) {
      throw new Error("Missing due date.");
    }

    const firstPayment = await registerCustomerPayment(
      first.issued.value.id,
      {
        dueDateId: firstDueDateId,
        paymentDate: "2026-07-10",
        amount: "121.00",
        reference: null,
        notes: null
      },
      actor
    );
    const secondPayment = await registerCustomerPayment(
      second.issued.value.id,
      {
        dueDateId: secondDueDateId,
        paymentDate: "2026-07-10",
        amount: "121.00",
        reference: null,
        notes: null
      },
      actor
    );

    if (!firstPayment.ok || !secondPayment.ok) {
      throw new Error("Could not register payments.");
    }

    const firstPaymentId = firstPayment.value.payments[0]?.id;

    if (!firstPaymentId) {
      throw new Error("Missing payment.");
    }

    const returned = await registerCustomerPaymentReturn(
      first.issued.value.id,
      {
        paymentId: firstPaymentId,
        returnDate: "2026-07-12",
        amount: "21.00",
        reasonCode: "BANK_RETURN",
        notes: null
      },
      actor
    );

    if (!returned.ok) {
      throw new Error(returned.error.code);
    }

    const openDueDates = await listCustomerDueDates(
      { limit: 25, scope: "OPEN" },
      actor
    );
    const paidDueDates = await listCustomerDueDates(
      { limit: 25, scope: "PAID" },
      actor
    );
    const searchedDueDates = await listCustomerDueDates(
      { limit: 25, scope: "ALL", search: "Pendiente" },
      actor
    );
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_DUE_DATES_VIEWED" },
      orderBy: { createdAt: "asc" }
    });

    expect(openDueDates.dueDates).toEqual([
      expect.objectContaining({
        id: firstDueDateId,
        invoiceId: first.issued.value.id,
        customer: expect.objectContaining({
          legalName: "Cliente Tesoreria Pendiente SL"
        }),
        amount: "121.00",
        paidAmount: "100.00",
        returnedAmount: "21.00",
        pendingAmount: "21.00",
        status: "PENDING",
        paymentStatus: "PARTIALLY_PAID"
      })
    ]);
    expect(openDueDates.summary).toMatchObject({
      count: 1,
      totalAmount: "121.00",
      paidAmount: "100.00",
      returnedAmount: "21.00",
      pendingAmount: "21.00"
    });
    expect(paidDueDates.dueDates).toEqual([
      expect.objectContaining({
        id: secondDueDateId,
        pendingAmount: "0.00",
        status: "PAID",
        paymentStatus: "PAID"
      })
    ]);
    expect(searchedDueDates.dueDates).toHaveLength(1);
    expect(searchedDueDates.dueDates[0]?.id).toBe(firstDueDateId);
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      scope: "OPEN",
      resultCount: 1
    });
  });

  it("builds customer collection forecasts from open due dates", async () => {
    const actor = await loginAsAdmin();
    const overdue = await createIssuedInvoiceWithOneLine(actor, {
      issueDate: "2026-05-15",
      legalName: "Cliente Prevision Atrasada SL",
      paymentTermsType: "DAYS",
      paymentDays: 30
    });
    const future = await createIssuedInvoiceWithOneLine(actor, {
      issueDate: "2026-07-10",
      legalName: "Cliente Prevision Futura SL",
      paymentTermsType: "DAYS",
      paymentDays: 30
    });
    const overdueDueDateId = overdue.issued.value.dueDates[0]?.id;
    const futureDueDateId = future.issued.value.dueDates[0]?.id;

    if (!overdueDueDateId || !futureDueDateId) {
      throw new Error("Missing due date.");
    }

    const partialPayment = await registerCustomerPayment(
      overdue.issued.value.id,
      {
        dueDateId: overdueDueDateId,
        paymentDate: "2026-06-20",
        amount: "20.00",
        reference: null,
        notes: null
      },
      actor
    );

    if (!partialPayment.ok) {
      throw new Error(partialPayment.error.code);
    }

    const forecast = await getCustomerCollectionForecast(
      { year: 2026, asOf: "2026-07-10", limit: 25 },
      actor
    );
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_COLLECTION_FORECAST_VIEWED" }
    });

    expect(forecast.summary).toEqual({
      itemCount: 2,
      expectedAmount: "222.00",
      overdueAmount: "101.00"
    });
    expect(forecast.months[6]).toMatchObject({
      month: 7,
      itemCount: 1,
      expectedAmount: "101.00",
      overdueAmount: "101.00"
    });
    expect(forecast.months[7]).toMatchObject({
      month: 8,
      itemCount: 1,
      expectedAmount: "121.00",
      overdueAmount: "0.00"
    });
    expect(forecast.items).toEqual([
      expect.objectContaining({
        dueDateId: overdueDueDateId,
        forecastMonth: 7,
        pendingAmount: "101.00",
        overdue: true,
        customer: expect.objectContaining({
          legalName: "Cliente Prevision Atrasada SL"
        })
      }),
      expect.objectContaining({
        dueDateId: futureDueDateId,
        forecastMonth: 8,
        pendingAmount: "121.00",
        overdue: false,
        customer: expect.objectContaining({
          legalName: "Cliente Prevision Futura SL"
        })
      })
    ]);
    expect(auditEvent.payload).toMatchObject({
      actorUserId: actor.id,
      year: 2026,
      asOf: "2026-07-10",
      resultCount: 2
    });
  });

  it("replaces a draft due date with multiple dates whose sum matches the invoice", async () => {
    const actor = await loginAsAdmin();
    const customer = await createCustomer(actor.id);
    const taxRate = await defaultTaxRate();
    const draft = await createInvoiceDraft({ customerId: customer.id, issueDate: "2026-07-07", operationDate: "2026-07-07", notes: null }, actor);
    if (!draft.ok) throw new Error(draft.error.code);
    const line = await addInvoiceLine(draft.value.id, { description: "Servicio", quantity: "1.000", unitPrice: "100.00", discountPercent: "0.00", discountAmount: "0.00", taxRateId: taxRate.id }, actor);
    if (!line.ok) throw new Error(line.error.code);

    const mismatch = await replaceInvoiceDueDates(draft.value.id, { dueDates: [
      { dueDate: "2026-08-01", amount: "60.00", paymentMethod: "BANK_TRANSFER" },
      { dueDate: "2026-09-01", amount: "60.00", paymentMethod: "DIRECT_DEBIT" }
    ] }, actor);
    expect(mismatch).toMatchObject({ ok: false, error: { code: "INVOICE_DUE_DATES_TOTAL_MISMATCH" } });

    const replaced = await replaceInvoiceDueDates(draft.value.id, { dueDates: [
      { dueDate: "2026-08-01", amount: "60.00", paymentMethod: "BANK_TRANSFER" },
      { dueDate: "2026-09-01", amount: "61.00", paymentMethod: "DIRECT_DEBIT" }
    ] }, actor, { correlationId: "due-dates-0001" });
    expect(replaced).toMatchObject({ ok: true, value: { dueDates: [
      { position: 1, dueDate: "2026-08-01", amount: "60.00" },
      { position: 2, dueDate: "2026-09-01", amount: "61.00" }
    ] } });
    const issued = await issueInvoice(draft.value.id, { issueDate: "2026-07-07" }, actor);
    expect(issued.ok).toBe(true);
    expect(await prisma.auditEvent.count({ where: { eventType: "INVOICE_DUE_DATES_UPDATED" } })).toBe(1);
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

async function createIssuedInvoiceWithOneLine(
  actor: Awaited<ReturnType<typeof loginAsAdmin>>,
  options: {
    issueDate: string;
    legalName: string;
    paymentTermsType?: "IMMEDIATE" | "DAYS" | "FIXED_DAY_OF_MONTH";
    paymentDays?: number | null;
    paymentFixedDay?: number | null;
  }
) {
  const customer = await createCustomer(actor.id, {
    legalName: options.legalName,
    paymentTermsType: options.paymentTermsType,
    paymentDays: options.paymentDays,
    paymentFixedDay: options.paymentFixedDay
  });
  const taxRate = await defaultTaxRate();
  const draft = await createInvoiceDraft(
    {
      customerId: customer.id,
      issueDate: options.issueDate,
      operationDate: options.issueDate,
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
    { issueDate: options.issueDate },
    actor
  );

  if (!issued.ok) {
    throw new Error(issued.error.code);
  }

  return { customer, issued };
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
  const fiscalYear = await prisma.accountingFiscalYear.findFirstOrThrow({ where: { year: 2026 } });
  const customerNumber = (await prisma.customer.count()) + 1;
  const code = customerNumber.toString();
  const customer = await prisma.customer.create({
    data: {
      code,
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
  await prisma.accountingAccount.create({
    data: {
      fiscalYearId: fiscalYear.id,
      code: `430${code.padStart(6, "0")}`,
      name: `Cliente ${code}`,
      type: "ASSET",
      level: 4,
      isPostable: true,
      createdById
    }
  });
  return customer;
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
  const installation = await prisma.installation.findFirstOrThrow({ select: { companyId: true } });
  const admin = await prisma.user.findFirstOrThrow({ where: { userName: "admin" }, select: { id: true } });
  const fiscalYear = await prisma.accountingFiscalYear.create({
    data: {
      companyId: installation.companyId!,
      year: 2026,
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      endDate: new Date("2026-12-31T00:00:00.000Z"),
      planCode: "PGC_PYMES",
      planVersion: "2007",
      createdById: admin.id
    }
  });
  await prisma.accountingAccount.createMany({
    data: [
      { fiscalYearId: fiscalYear.id, code: "700000000", name: "Ventas de mercaderias", type: "INCOME", level: 4, isPostable: true, createdById: admin.id },
      { fiscalYearId: fiscalYear.id, code: "705000000", name: "Prestaciones de servicios", type: "INCOME", level: 4, isPostable: true, createdById: admin.id },
      { fiscalYearId: fiscalYear.id, code: "477000000", name: "Hacienda Publica, IVA repercutido", type: "LIABILITY", level: 4, isPostable: true, createdById: admin.id }
      ,{ fiscalYearId: fiscalYear.id, code: "570000000", name: "Caja", type: "ASSET", level: 4, isPostable: true, createdById: admin.id }
      ,{ fiscalYearId: fiscalYear.id, code: "572000000", name: "Bancos", type: "ASSET", level: 4, isPostable: true, createdById: admin.id }
    ]
  });
}

async function resetPlatformTables(): Promise<void> {
  await prisma.$transaction([
    prisma.invoiceVerifactuRecord.deleteMany(),
    prisma.customerRemittanceLine.deleteMany(),
    prisma.accountingJournalLine.deleteMany(),
    prisma.accountingJournalEntry.deleteMany(),

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
    prisma.accountingAccount.deleteMany(),
    prisma.accountingFiscalYear.deleteMany(),
    prisma.customerRemittance.deleteMany(),

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
