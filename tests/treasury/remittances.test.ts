import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  cancelCustomerRemittanceDraft,
  closeCustomerRemittance,
  createCustomerRemittanceDraft,
  generateCustomerRemittanceSepa,
  getCustomerRemittance,
  getCustomerRemittanceSepaFile,
  importCustomerRemittanceBankResponseCsv,
  listCustomerRemittances,
  markCustomerRemittanceSent,
  processCustomerRemittance,
  rejectCustomerRemittance,
  settleCustomerRemittanceBankResponse
} from "@/modules/treasury/application/remittances";
import { registerCustomerPaymentReturn } from "@/modules/treasury/application/payments";
import { getInvoiceDetail } from "@/modules/billing/application/invoices";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";
import { createTestAccountingFiscalYear } from "@/tests/helpers/accountingFiscalYear";
import {
  createBankAccount,
  createBankMovement,
  createBankReconciliation,
  listReconciliationProposals,
  scoreReconciliationProposal,
  listReconciliationCandidates,
  undoBankReconciliation
} from "@/modules/treasury/application/banking";
import { importNorma43, parseNorma43Bytes, previewNorma43 } from "@/modules/treasury/application/norma43";

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

  it("gets a remittance detail by id and audits the read", async () => {
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

    const detail = await getCustomerRemittance(created.value.id, actor);
    const missing = await getCustomerRemittance(randomUUID(), actor);
    const auditCount = await prisma.auditEvent.count({
      where: { eventType: "CUSTOMER_REMITTANCE_VIEWED" }
    });

    expect(detail).toMatchObject({
      id: created.value.id,
      number: "RC2026/000001",
      paymentAmount: "0.00",
      returnedAmount: "0.00",
      netAmount: "0.00",
      lines: [
        {
          dueDateId: dueDate.id,
          invoiceNumber: "F2600001",
          customer: {
            code: "600001",
            legalName: "Cliente F2600001 SL"
          }
        }
      ]
    });
    expect(missing).toBeNull();
    expect(auditCount).toBe(1);
  });

  it("generates and downloads a SEPA XML file for a draft remittance", async () => {
    const actor = await adminActor();
    await configureCompanySepa();
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

    const generated = await generateCustomerRemittanceSepa(
      created.value.id,
      actor,
      { correlationId: "corr-remittance-sepa" }
    );

    expect(generated.ok).toBe(true);
    if (!generated.ok) {
      throw new Error(generated.error.code);
    }
    expect(generated.value).toMatchObject({
      id: created.value.id,
      status: "GENERATED",
      sepaFormat: "pain.008.001.02",
      sepaFileName: "RC2026-000001.xml"
    });
    expect(generated.value.sepaMessageId).toContain("RC2026-000001-");
    expect(generated.value.sepaFileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(generated.value.generatedAt).not.toBeNull();

    const sepaFile = await getCustomerRemittanceSepaFile(created.value.id, actor);
    const auditPayload = JSON.stringify(
      await prisma.auditEvent.findFirstOrThrow({
        where: { eventType: "CUSTOMER_REMITTANCE_SEPA_GENERATED" }
      })
    );

    expect(sepaFile.ok).toBe(true);
    if (!sepaFile.ok) {
      throw new Error(sepaFile.error.code);
    }
    expect(sepaFile.value.filename).toBe("RC2026-000001.xml");
    expect(sepaFile.value.sha256).toBe(generated.value.sepaFileSha256);
    expect(sepaFile.value.content).toContain("<PmtMtd>DD</PmtMtd>");
    expect(sepaFile.value.content).toContain("<Cd>SEPA</Cd>");
    expect(sepaFile.value.content).toContain("<Cd>CORE</Cd>");
    expect(sepaFile.value.content).toContain("ES7921000813610123456789");
    expect(sepaFile.value.content).toContain("ES9121000418450200051332");
    expect(auditPayload).not.toContain("ES7921000813610123456789");
    expect(auditPayload).not.toContain("ES9121000418450200051332");
  });

  it("rejects SEPA generation when company SEPA configuration is missing", async () => {
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

    const generated = await generateCustomerRemittanceSepa(created.value.id, actor);

    expect(generated).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "REMITTANCE_NOT_GENERATABLE",
        message:
          "La remesa requiere estado borrador, configuracion SEPA y lineas domiciliadas completas."
      }
    });
  });

  it("allows processing a generated remittance", async () => {
    const actor = await adminActor();
    await configureCompanySepa();
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

    const generated = await generateCustomerRemittanceSepa(created.value.id, actor);

    if (!generated.ok) {
      throw new Error(generated.error.code);
    }

    const processed = await processCustomerRemittance(
      created.value.id,
      { paymentDate: "2026-07-16" },
      actor
    );

    expect(processed.ok).toBe(true);
    if (!processed.ok) {
      throw new Error(processed.error.code);
    }
    expect(processed.value.status).toBe("PROCESSED");
    expect(processed.value.paymentAmount).toBe("121.00");
  });

  it("marks generated remittances as sent and then processes them", async () => {
    const actor = await adminActor();
    await configureCompanySepa();
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

    const notSendable = await markCustomerRemittanceSent(created.value.id, actor);
    const generated = await generateCustomerRemittanceSepa(created.value.id, actor);

    if (!generated.ok) {
      throw new Error(generated.error.code);
    }

    const sent = await markCustomerRemittanceSent(
      created.value.id,
      actor,
      { correlationId: "corr-remittance-sent" }
    );

    expect(notSendable).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "REMITTANCE_NOT_SENDABLE",
        message: "Solo se pueden marcar como enviadas remesas generadas con fichero SEPA."
      }
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) {
      throw new Error(sent.error.code);
    }
    expect(sent.value.status).toBe("SENT");
    expect(sent.value.sentAt).not.toBeNull();

    const processed = await processCustomerRemittance(
      created.value.id,
      { paymentDate: "2026-07-16" },
      actor
    );
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_REMITTANCE_SENT" }
    });

    expect(processed.ok).toBe(true);
    if (!processed.ok) {
      throw new Error(processed.error.code);
    }
    expect(processed.value.status).toBe("PROCESSED");
    expect(processed.value.paymentAmount).toBe("121.00");
    expect(auditEvent.payload).toMatchObject({
      remittanceId: created.value.id,
      number: "RC2026/000001",
      correlationId: "corr-remittance-sent"
    });
  });

  it("settles sent remittances with mixed paid and rejected lines", async () => {
    const actor = await adminActor();
    await configureCompanySepa();
    const paidDueDate = await createIssuedDirectDebitDueDate(actor.id);
    const rejectedDueDate = await createIssuedDirectDebitDueDate(actor.id, {
      invoiceNumber: "F2600002",
      dueDatePosition: 2
    });
    const created = await createCustomerRemittanceDraft(
      {
        chargeDate: "2026-07-15",
        concept: "Remesa julio",
        dueDateIds: [paidDueDate.id, rejectedDueDate.id]
      },
      actor
    );

    if (!created.ok) {
      throw new Error(created.error.code);
    }

    await generateCustomerRemittanceSepa(created.value.id, actor);
    await markCustomerRemittanceSent(created.value.id, actor);

    const paidLine = created.value.lines.find(
      (line) => line.dueDateId === paidDueDate.id
    );
    const rejectedLine = created.value.lines.find(
      (line) => line.dueDateId === rejectedDueDate.id
    );

    if (!paidLine || !rejectedLine) {
      throw new Error("Expected remittance lines.");
    }

    const settled = await settleCustomerRemittanceBankResponse(
      created.value.id,
      {
        paymentDate: "2026-07-16",
        paidLineIds: [paidLine.id],
        rejectedLineIds: [rejectedLine.id],
        rejectionReason: "Banco rechaza una linea"
      },
      actor,
      { correlationId: "corr-remittance-bank-response" }
    );
    const payment = await prisma.customerPayment.findFirstOrThrow({
      where: {
        dueDateId: paidDueDate.id,
        source: "SEPA_REMITTANCE"
      }
    });
    const rejectedLineRecord = await prisma.customerRemittanceLine.findUniqueOrThrow({
      where: { id: rejectedLine.id }
    });
    const retry = await createCustomerRemittanceDraft(
      {
        chargeDate: "2026-07-18",
        concept: "Reintento linea rechazada",
        dueDateIds: [rejectedDueDate.id]
      },
      actor
    );
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_REMITTANCE_BANK_RESPONSE_SETTLED" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(settled.ok).toBe(true);
    if (!settled.ok) {
      throw new Error(settled.error.code);
    }
    expect(settled.value.status).toBe("PARTIALLY_PROCESSED");
    expect(settled.value.paymentAmount).toBe("121.00");
    expect(settled.value.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: paidLine.id,
          status: "ACTIVE",
          paymentAmount: "121.00"
        }),
        expect.objectContaining({
          id: rejectedLine.id,
          status: "CANCELLED",
          paymentAmount: "0.00"
        })
      ])
    );
    expect(payment.amount.toFixed(2)).toBe("121.00");
    expect(rejectedLineRecord.status).toBe("CANCELLED");
    expect(retry.ok).toBe(true);
    expect(auditEvent.payload).toMatchObject({
      remittanceId: created.value.id,
      previousStatus: "SENT",
      nextStatus: "PARTIALLY_PROCESSED",
      paidLineCount: 1,
      rejectedLineCount: 1,
      paidAmount: "121.00",
      rejectedAmount: "121.00",
      correlationId: "corr-remittance-bank-response"
    });
    expect(auditPayload).not.toContain("Banco rechaza una linea");
  });

  it("imports controlled CSV bank responses for sent remittances", async () => {
    const actor = await adminActor();
    await configureCompanySepa();
    const paidDueDate = await createIssuedDirectDebitDueDate(actor.id);
    const rejectedDueDate = await createIssuedDirectDebitDueDate(actor.id, {
      invoiceNumber: "F2600002",
      dueDatePosition: 2
    });
    const created = await createCustomerRemittanceDraft(
      {
        chargeDate: "2026-07-15",
        concept: "Remesa julio",
        dueDateIds: [paidDueDate.id, rejectedDueDate.id]
      },
      actor
    );

    if (!created.ok) {
      throw new Error(created.error.code);
    }

    await generateCustomerRemittanceSepa(created.value.id, actor);
    await markCustomerRemittanceSent(created.value.id, actor);

    const imported = await importCustomerRemittanceBankResponseCsv(
      created.value.id,
      {
        paymentDate: "2026-07-16",
        csv: 'linea,resultado,motivo\n1,COBRADA,\n2,RECHAZADA,"Banco rechaza, fecha"'
      },
      actor,
      { correlationId: "corr-remittance-bank-response-csv" }
    );
    const payment = await prisma.customerPayment.findFirstOrThrow({
      where: {
        dueDateId: paidDueDate.id,
        source: "SEPA_REMITTANCE"
      }
    });
    const rejectedLine = await prisma.customerRemittanceLine.findFirstOrThrow({
      where: {
        remittanceId: created.value.id,
        dueDateId: rejectedDueDate.id
      }
    });
    const retry = await createCustomerRemittanceDraft(
      {
        chargeDate: "2026-07-18",
        concept: "Reintento CSV",
        dueDateIds: [rejectedDueDate.id]
      },
      actor
    );
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_REMITTANCE_BANK_RESPONSE_SETTLED" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      throw new Error(imported.error.code);
    }
    expect(imported.value.status).toBe("PARTIALLY_PROCESSED");
    expect(imported.value.paymentAmount).toBe("121.00");
    expect(payment.amount.toFixed(2)).toBe("121.00");
    expect(rejectedLine.status).toBe("CANCELLED");
    expect(retry.ok).toBe(true);
    expect(auditEvent.payload).toMatchObject({
      remittanceId: created.value.id,
      previousStatus: "SENT",
      nextStatus: "PARTIALLY_PROCESSED",
      paidLineCount: 1,
      rejectedLineCount: 1,
      correlationId: "corr-remittance-bank-response-csv"
    });
    expect(auditPayload).not.toContain("Banco rechaza, fecha");
  });

  it("rejects incomplete controlled CSV bank responses", async () => {
    const actor = await adminActor();
    await configureCompanySepa();
    const firstDueDate = await createIssuedDirectDebitDueDate(actor.id);
    const secondDueDate = await createIssuedDirectDebitDueDate(actor.id, {
      invoiceNumber: "F2600002",
      dueDatePosition: 2
    });
    const created = await createCustomerRemittanceDraft(
      {
        chargeDate: "2026-07-15",
        concept: "Remesa julio",
        dueDateIds: [firstDueDate.id, secondDueDate.id]
      },
      actor
    );

    if (!created.ok) {
      throw new Error(created.error.code);
    }

    await generateCustomerRemittanceSepa(created.value.id, actor);
    await markCustomerRemittanceSent(created.value.id, actor);

    const imported = await importCustomerRemittanceBankResponseCsv(
      created.value.id,
      {
        paymentDate: "2026-07-16",
        csv: "linea,resultado,motivo\n1,COBRADA,"
      },
      actor
    );

    expect(imported).toMatchObject({
      ok: false,
      status: 422,
      error: {
        code: "REMITTANCE_BANK_RESPONSE_CSV_INVALID",
        issues: ["El CSV debe cubrir todas las lineas activas de la remesa."]
      }
    });
  });

  it("rejects sent remittances before collection and frees their due dates", async () => {
    const actor = await adminActor();
    await configureCompanySepa();
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

    const notRejectable = await rejectCustomerRemittance(
      created.value.id,
      { reason: "Banco rechaza el fichero" },
      actor
    );
    const generated = await generateCustomerRemittanceSepa(created.value.id, actor);

    if (!generated.ok) {
      throw new Error(generated.error.code);
    }

    const sent = await markCustomerRemittanceSent(created.value.id, actor);

    if (!sent.ok) {
      throw new Error(sent.error.code);
    }

    const rejected = await rejectCustomerRemittance(
      created.value.id,
      { reason: "Banco rechaza el fichero por fecha de cargo" },
      actor,
      { correlationId: "corr-remittance-rejected" }
    );
    const retry = await createCustomerRemittanceDraft(
      {
        chargeDate: "2026-07-18",
        concept: "Reintento remesa julio",
        dueDateIds: [dueDate.id]
      },
      actor
    );
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_REMITTANCE_REJECTED" }
    });
    const auditPayload = JSON.stringify(auditEvent.payload);

    expect(notRejectable).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "REMITTANCE_NOT_REJECTABLE",
        message: "Solo se pueden rechazar remesas enviadas sin procesar."
      }
    });
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) {
      throw new Error(rejected.error.code);
    }
    expect(rejected.value).toMatchObject({
      id: created.value.id,
      status: "REJECTED",
      rejectionReason: "Banco rechaza el fichero por fecha de cargo"
    });
    expect(rejected.value.rejectedAt).not.toBeNull();
    expect(retry.ok).toBe(true);
    if (!retry.ok) {
      throw new Error(retry.error.code);
    }
    expect(retry.value.number).toBe("RC2026/000002");
    expect(auditEvent.payload).toMatchObject({
      remittanceId: created.value.id,
      previousStatus: "SENT",
      reasonLength: 43,
      correlationId: "corr-remittance-rejected"
    });
    expect(auditPayload).not.toContain("Banco rechaza el fichero por fecha de cargo");
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

  it("processes draft remittances into customer payments", async () => {
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

    const processed = await processCustomerRemittance(
      created.value.id,
      { paymentDate: "2026-07-16" },
      actor,
      { correlationId: "corr-remittance-process" }
    );
    const detail = await getCustomerRemittance(created.value.id, actor);
    const payment = await prisma.customerPayment.findFirstOrThrow({
      where: {
        dueDateId: dueDate.id,
        source: "SEPA_REMITTANCE"
      }
    });
    const storedDueDate = await prisma.invoiceDueDate.findUniqueOrThrow({
      where: { id: dueDate.id },
      include: { invoice: true }
    });
    const accountingEntry = await prisma.accountingJournalEntry.findUniqueOrThrow({
      where: { customerPaymentId: payment.id },
      include: { lines: { include: { account: true }, orderBy: { position: "asc" } } }
    });
    const invoiceDetail = await getInvoiceDetail(storedDueDate.invoiceId, actor);
    const auditCount = await prisma.auditEvent.count({
      where: { eventType: "CUSTOMER_REMITTANCE_PROCESSED" }
    });

    expect(processed.ok).toBe(true);
    if (!processed.ok) {
      throw new Error(processed.error.code);
    }
    expect(processed.value.status).toBe("PROCESSED");
    expect(payment.amount.toFixed(2)).toBe("121.00");
    expect(payment.reference).toBe("RC2026/000001");
    expect(detail?.lines[0]).toMatchObject({
      paymentId: payment.id,
      paymentDate: "2026-07-16",
      paymentAmount: "121.00",
      returnedAmount: "0.00",
      netAmount: "121.00"
    });
    expect(detail?.lines[0]?.accountingEntry).toEqual({
      id: accountingEntry.id,
      number: accountingEntry.number
    });
    expect(invoiceDetail?.payments[0]?.accountingEntry).toEqual({
      id: accountingEntry.id,
      number: accountingEntry.number
    });
    expect(accountingEntry.origin).toBe("CUSTOMER_PAYMENT");
    expect(accountingEntry.totalDebit.toFixed(2)).toBe("121.00");
    expect(accountingEntry.totalCredit.toFixed(2)).toBe("121.00");
    expect(accountingEntry.lines.map((line) => line.account.code)).toEqual([
      "572000000",
      "430600001"
    ]);
    expect(storedDueDate.status).toBe("PAID");
    expect(storedDueDate.invoice.paymentStatus).toBe("PAID");
    expect(auditCount).toBe(1);
  });

  it("rolls back remittance payments when accounting is unavailable", async () => {
    const actor = await adminActor();
    const dueDate = await createIssuedDirectDebitDueDate(actor.id);
    const created = await createCustomerRemittanceDraft(
      {
        chargeDate: "2026-07-15",
        concept: "Remesa sin cuenta bancaria",
        dueDateIds: [dueDate.id]
      },
      actor
    );

    if (!created.ok) {
      throw new Error(created.error.code);
    }

    await prisma.accountingAccount.deleteMany({ where: { code: "572000000" } });
    const result = await processCustomerRemittance(
      created.value.id,
      { paymentDate: "2026-07-16" },
      actor,
      {
        idempotencyKey: "v1:rollback-accounting-test",
        requestHash: "a".repeat(64)
      }
    );
    const storedRemittance = await prisma.customerRemittance.findUniqueOrThrow({
      where: { id: created.value.id }
    });
    const storedDueDate = await prisma.invoiceDueDate.findUniqueOrThrow({
      where: { id: dueDate.id }
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "REMITTANCE_ACCOUNTING_ACCOUNT_NOT_AVAILABLE" }
    });
    expect(await prisma.customerPayment.count()).toBe(0);
    expect(await prisma.accountingJournalEntry.count()).toBe(0);
    expect(await prisma.idempotencyRecord.count({
      where: { key: "v1:rollback-accounting-test" }
    })).toBe(0);
    expect(storedRemittance.status).toBe("DRAFT");
    expect(storedDueDate.status).toBe("PENDING");
  });

  it("closes processed remittances without changing payments", async () => {
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

    const draftClose = await closeCustomerRemittance(created.value.id, actor);
    const processed = await processCustomerRemittance(
      created.value.id,
      { paymentDate: "2026-07-16" },
      actor
    );

    if (!processed.ok) {
      throw new Error(processed.error.code);
    }

    const closed = await closeCustomerRemittance(processed.value.id, actor, {
      correlationId: "corr-remittance-close"
    });
    const paymentCount = await prisma.customerPayment.count({
      where: { dueDateId: dueDate.id }
    });
    const auditCount = await prisma.auditEvent.count({
      where: { eventType: "CUSTOMER_REMITTANCE_CLOSED" }
    });

    expect(draftClose).toMatchObject({
      ok: false,
      error: { code: "REMITTANCE_NOT_CLOSABLE" }
    });
    expect(closed).toMatchObject({
      ok: true,
      value: {
        id: created.value.id,
        status: "CLOSED"
      }
    });
    expect(paymentCount).toBe(1);
    expect(auditCount).toBe(1);
  });

  it("marks processed remittances as partially returned when a SEPA payment is returned", async () => {
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

    const processed = await processCustomerRemittance(
      created.value.id,
      { paymentDate: "2026-07-16" },
      actor
    );

    if (!processed.ok) {
      throw new Error(processed.error.code);
    }

    const payment = await prisma.customerPayment.findFirstOrThrow({
      where: {
        dueDateId: dueDate.id,
        source: "SEPA_REMITTANCE"
      }
    });
    const returned = await registerCustomerPaymentReturn(
      payment.invoiceId,
      {
        paymentId: payment.id,
        returnDate: "2026-07-20",
        amount: "21.00",
        reasonCode: "BANK_RETURN",
        notes: null
      },
      actor,
      { correlationId: "corr-remittance-return" }
    );
    const remittance = await prisma.customerRemittance.findUniqueOrThrow({
      where: { id: created.value.id }
    });
    const detail = await getCustomerRemittance(created.value.id, actor);
    const paymentReturnAudit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_PAYMENT_RETURNED" },
      orderBy: { createdAt: "desc" }
    });
    const remittanceReturnAuditCount = await prisma.auditEvent.count({
      where: { eventType: "CUSTOMER_REMITTANCE_PARTIALLY_RETURNED" }
    });

    expect(returned.ok).toBe(true);
    expect(remittance.status).toBe("PARTIALLY_RETURNED");
    expect(detail).toMatchObject({
      paymentAmount: "121.00",
      returnedAmount: "21.00",
      netAmount: "100.00"
    });
    expect(detail?.lines[0]).toMatchObject({
      amount: "121.00",
      paymentAmount: "121.00",
      returnedAmount: "21.00",
      netAmount: "100.00"
    });
    expect(paymentReturnAudit.payload).toMatchObject({
      remittanceId: created.value.id,
      remittanceNumber: "RC2026/000001",
      previousRemittanceStatus: "PROCESSED"
    });
    expect(remittanceReturnAuditCount).toBe(1);
  });

  it("creates, partially reconciles and undoes a bank movement", async () => {
    const actor = await adminActor();
    const dueDate = await createIssuedDirectDebitDueDate(actor.id);
    const remittance = await createCustomerRemittanceDraft(
      { chargeDate: "2026-07-15", concept: "Cobros conciliables", dueDateIds: [dueDate.id] },
      actor
    );
    if (!remittance.ok) throw new Error(remittance.error.code);
    const processed = await processCustomerRemittance(remittance.value.id, { paymentDate: "2026-07-16" }, actor);
    if (!processed.ok) throw new Error(processed.error.code);
    const payment = await prisma.customerPayment.findFirstOrThrow({ where: { dueDateId: dueDate.id } });

    const account = await createBankAccount(
      { name: "Cuenta operativa", iban: "ES9121000418450200051332", currency: "EUR" },
      actor,
      mutationContext("account", "create-account")
    );
    if (!account.ok) throw new Error(account.error.code);
    const movement = await createBankMovement(
      { bankAccountId: account.value.id, bookingDate: "2026-07-17", amount: "121.00", currency: "EUR", reference: "F2600001" },
      actor,
      mutationContext("movement", "create-movement")
    );
    if (!movement.ok) throw new Error(movement.error.code);

    const proposals = await listReconciliationProposals({ movementId: movement.value.id, limit: 10 }, actor);
    expect(proposals.proposals[0]).toMatchObject({ paymentId: payment.id, score: 95, confidence: "HIGH", suggestedAmount: "121.00", reasons: ["Importe exacto", "Fechas separadas 1 dias", "Numero de factura en la referencia"] });
    expect(scoreReconciliationProposal(movement.value, { ...proposals.proposals[0]!, availableAmount: "120.00" })).toBeNull();
    expect(scoreReconciliationProposal(movement.value, { ...proposals.proposals[0]!, paymentDate: "2026-05-01" })).toBeNull();
    expect(scoreReconciliationProposal({ ...movement.value, reference: null, counterpartyName: null }, proposals.proposals[0]!)).toMatchObject({ score: 80, confidence: "MEDIUM" });
    expect(scoreReconciliationProposal({ ...movement.value, reference: "Cobro F/26-00001" }, proposals.proposals[0]!)).toMatchObject({ score: 95, confidence: "HIGH" });
    expect(await prisma.bankReconciliation.count()).toBe(0);

    const reconciled = await createBankReconciliation(
      { bankMovementId: movement.value.id, applications: [{ customerPaymentId: payment.id, amount: "60.00" }] },
      actor,
      mutationContext("reconciliation", "create-reconciliation", movement.value.id)
    );
    if (!reconciled.ok) throw new Error(reconciled.error.code);
    expect(reconciled.value).toMatchObject({ status: "PARTIALLY_RECONCILED", reconciledAmount: "60.00", pendingAmount: "61.00" });

    const candidates = await listReconciliationCandidates({ movementId: movement.value.id, limit: 25 }, actor);
    expect(candidates.candidates[0]).toMatchObject({ paymentId: payment.id, availableAmount: "61.00" });
    const reconciliationId = reconciled.value.activeReconciliations[0]!.id;
    const undone = await undoBankReconciliation(reconciliationId, actor, mutationContext("undo", "undo-reconciliation", reconciliationId));
    expect(undone).toMatchObject({ ok: true, value: { status: "PENDING", reconciledAmount: "0.00", pendingAmount: "121.00" } });
    expect(await prisma.auditEvent.count({ where: { eventType: { in: ["BANK_RECONCILIATION_CREATED", "BANK_RECONCILIATION_UNDONE"] } } })).toBe(2);
  });

  it("replays bank movement creation and rejects over-reconciliation", async () => {
    const actor = await adminActor();
    const dueDate = await createIssuedDirectDebitDueDate(actor.id);
    const remittance = await createCustomerRemittanceDraft({ chargeDate: "2026-07-15", concept: "Cobro", dueDateIds: [dueDate.id] }, actor);
    if (!remittance.ok) throw new Error(remittance.error.code);
    const processed = await processCustomerRemittance(remittance.value.id, { paymentDate: "2026-07-16" }, actor);
    if (!processed.ok) throw new Error(processed.error.code);
    const payment = await prisma.customerPayment.findFirstOrThrow({ where: { dueDateId: dueDate.id } });
    const account = await createBankAccount({ name: "Banco", iban: "ES7921000813610123456789", currency: "EUR" }, actor, mutationContext("account-replay", "create-account"));
    if (!account.ok) throw new Error(account.error.code);
    const context = mutationContext("movement-replay", "create-movement");
    const command = { bankAccountId: account.value.id, bookingDate: "2026-07-17", amount: "50.00", currency: "EUR" as const };
    const [first, replay] = await Promise.all([
      createBankMovement(command, actor, context),
      createBankMovement(command, actor, context)
    ]);
    expect(replay).toEqual(first);
    expect(await prisma.bankMovement.count()).toBe(1);
    if (!first.ok) throw new Error(first.error.code);
    const exceeded = await createBankReconciliation({ bankMovementId: first.value.id, applications: [{ customerPaymentId: payment.id, amount: "50.01" }] }, actor, mutationContext("exceeded", "create-reconciliation", first.value.id));
    expect(exceeded).toMatchObject({ ok: false, status: 409, error: { code: "BANK_MOVEMENT_AMOUNT_EXCEEDED" } });
    expect(await prisma.bankReconciliation.count()).toBe(0);
  });

  it("returns stable conflicts for concurrent bank account and movement duplicates", async () => {
    const actor = await adminActor();
    const accountCommand = { name: "Cuenta concurrente", iban: "ES9121000418450200051332", currency: "EUR" as const };
    const accountResults = await Promise.all([
      createBankAccount(accountCommand, actor, mutationContext("account-concurrent-a", "create-account")),
      createBankAccount(accountCommand, actor, mutationContext("account-concurrent-b", "create-account"))
    ]);

    expect(accountResults.filter((result) => result.ok)).toHaveLength(1);
    expect(accountResults.find((result) => !result.ok)).toMatchObject({
      status: 409,
      error: { code: "BANK_ACCOUNT_ALREADY_EXISTS" }
    });
    const account = accountResults.find((result) => result.ok);
    if (!account?.ok) throw new Error("BANK_ACCOUNT_NOT_CREATED");

    const movementCommand = {
      bankAccountId: account.value.id,
      bookingDate: "2026-07-17",
      amount: "50.00",
      currency: "EUR" as const,
      externalMovementNumber: "EXT-CONCURRENT-1"
    };
    const movementResults = await Promise.all([
      createBankMovement(movementCommand, actor, mutationContext("movement-concurrent-a", "create-movement")),
      createBankMovement(movementCommand, actor, mutationContext("movement-concurrent-b", "create-movement"))
    ]);

    expect(movementResults.filter((result) => result.ok)).toHaveLength(1);
    expect(movementResults.find((result) => !result.ok)).toMatchObject({
      status: 409,
      error: { code: "BANK_MOVEMENT_ALREADY_EXISTS" }
    });
    expect(await prisma.bankMovement.count()).toBe(1);
  });

  it("parses, previews and imports a balanced Norma 43 statement", async () => {
    const actor = await adminActor();
    const account = await createBankAccount({ name: "Norma 43", iban: "ES9121000418450200051332", currency: "EUR" }, actor, mutationContext("n43-account", "create-account"));
    if (!account.ok) throw new Error(account.error.code);
    const bytes = Buffer.from(validNorma43(), "latin1");
    const parsed = parseNorma43Bytes(bytes);
    expect(parsed).toMatchObject({ ok: true, value: { dateFrom: "2026-07-01", dateTo: "2026-07-31", openingBalance: "1000.00", closingBalance: "1121.00", movements: [{ amount: "121.00" }] } });
    const command = { bankAccountId: account.value.id, contentBase64: bytes.toString("base64") };
    const preview = await previewNorma43(command, actor);
    expect(preview).toMatchObject({ ok: true, value: { duplicate: false, overlap: false, maskedIban: "ES91 **** **** 1332" } });
    const imported = await importNorma43(command, actor, { idempotencyKey: "n43-import", requestHash: "b".repeat(64), correlationId: "corr-n43-import" });
    expect(imported).toMatchObject({ ok: true, status: 201, value: { movementCount: 1 } });
    if (!imported.ok) throw new Error(imported.error.code);
    expect(await prisma.bankStatement.count()).toBe(1);
    expect(await prisma.bankMovement.findFirstOrThrow()).toMatchObject({ source: "NORMA43", statementOrdinal: 1, statementDocumentNumber: "0000000001" });
    await expect(prisma.bankStatement.create({
      data: {
        companyId: (await prisma.installation.findFirstOrThrow()).companyId!,
        bankAccountId: account.value.id,
        dateFrom: new Date("2026-07-31T00:00:00.000Z"),
        dateTo: new Date("2026-08-15T00:00:00.000Z"),
        openingBalance: new Prisma.Decimal("1121.00"),
        closingBalance: new Prisma.Decimal("1121.00"),
        rawSha256: "c".repeat(64),
        recordCount: 4,
        movementCount: 1,
        importedById: actor.id
      }
    })).rejects.toThrow();
    const otherAccount = await createBankAccount({ name: "Otra cuenta", iban: "ES7921000813610123456789", currency: "EUR" }, actor, mutationContext("n43-other-account", "create-account"));
    if (!otherAccount.ok) throw new Error(otherAccount.error.code);
    await expect(prisma.bankMovement.create({
      data: {
        bankAccountId: otherAccount.value.id,
        bankStatementId: imported.value.statementId,
        statementOrdinal: 2,
        bookingDate: new Date("2026-07-16T00:00:00.000Z"),
        valueDate: new Date("2026-07-16T00:00:00.000Z"),
        amount: new Prisma.Decimal("1.00"),
        source: "NORMA43",
        createdById: actor.id
      }
    })).rejects.toThrow();
    const duplicate = await previewNorma43(command, actor);
    expect(duplicate).toMatchObject({ ok: true, value: { duplicate: true, overlap: true } });
  });

  it("rejects malformed and unbalanced Norma 43 statements", () => {
    const malformed = Buffer.from(validNorma43().replace("00000000012100", "00000000012200"), "latin1");
    expect(parseNorma43Bytes(malformed)).toMatchObject({ ok: false, status: 422, error: { code: "N43_CONTROL_TOTAL_MISMATCH" } });
    expect(parseNorma43Bytes(Buffer.from("11short", "latin1"))).toMatchObject({ ok: false, status: 422, error: { code: "N43_RECORD_INVALID" } });
    expect(parseNorma43Bytes(Uint8Array.from([0x80]))).toMatchObject({ ok: false, status: 422, error: { code: "N43_ENCODING_UNSUPPORTED" } });
  });
});

function mutationContext(key: string, operation: string, resourceId?: string) {
  return { idempotencyKey: key, requestHash: key.padEnd(64, "0").slice(0, 64), operation, resourceId, correlationId: `corr-${key}` };
}

function validNorma43(): string {
  const account = "210004180200051332";
  const header = `11${account}260701260731H000000001000009781${"CRIGESTION".padEnd(26)}   `;
  const movement = `22${" ".repeat(8)}260715260715040012${"12100".padStart(14, "0")}${"1".padStart(10, "0")}${"0".repeat(12)}${"F2600001".padEnd(16)}`;
  const concept = `2301${"TRANSFERENCIA CLIENTE".padEnd(38)}${"FACTURA F2600001".padEnd(38)}`;
  const end = `33${account}00000${"0".repeat(14)}00001${"12100".padStart(14, "0")}H${"112100".padStart(14, "0")}978${" ".repeat(4)}`;
  const fileEnd = `88${"9".repeat(18)}${"4".padStart(6, "0")}${" ".repeat(54)}`;
  return [header, movement, concept, end, fileEnd].join("\r\n");
}

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
      code: invoiceNumber.replace(/\D/g, "").slice(-6),
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
  const fiscalYear = await prisma.accountingFiscalYear.findFirstOrThrow({
    where: { year: 2026 }
  });
  await prisma.accountingAccount.create({
    data: {
      fiscalYearId: fiscalYear.id,
      code: `430${customer.code.padStart(6, "0")}`,
      name: customer.legalName,
      type: "ASSET",
      level: 9,
      isPostable: true,
      createdById: actorUserId
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
  await createTestAccountingFiscalYear();
  const fiscalYear = await prisma.accountingFiscalYear.findFirstOrThrow({
    where: { year: 2026 }
  });
  const installation = await prisma.installation.findFirstOrThrow();
  await prisma.accountingAccount.createMany({
    data: ["570000000", "572000000"].map((code) => ({
      fiscalYearId: fiscalYear.id,
      code,
      name: code === "570000000" ? "Caja" : "Bancos",
      type: "ASSET",
      level: 9,
      isPostable: true,
      createdById: installation.initialAdministratorId!
    }))
  });
}

async function configureCompanySepa(): Promise<void> {
  await prisma.company.update({
    where: { taxId: baseCommand.company.taxId },
    data: {
      bankIban: "ES7921000813610123456789",
      sepaCreditorIdentifier: "ES12B12345678"
    }
  });
}

async function resetPlatformTables(): Promise<void> {
  await prisma.$transaction([
    prisma.invoiceVerifactuRecord.deleteMany(),
    prisma.customerRemittanceLine.deleteMany(),
    prisma.accountingJournalLine.deleteMany(),
    prisma.accountingJournalEntry.deleteMany(),
    prisma.bankReconciliationApplication.deleteMany(),
    prisma.bankReconciliation.deleteMany(),
    prisma.bankMovement.deleteMany(),
    prisma.bankStatement.deleteMany(),
    prisma.bankAccount.deleteMany(),
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
