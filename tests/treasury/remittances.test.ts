import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  cancelCustomerRemittanceDraft,
  closeCustomerRemittance,
  createCustomerRemittanceDraft,
  generateCustomerRemittanceSepa,
  getCustomerRemittance,
  getCustomerRemittanceSepaFile,
  listCustomerRemittances,
  markCustomerRemittanceSent,
  processCustomerRemittance,
  rejectCustomerRemittance
} from "@/modules/treasury/application/remittances";
import { registerCustomerPaymentReturn } from "@/modules/treasury/application/payments";
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
            code: "C-F2600001",
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
    expect(storedDueDate.status).toBe("PAID");
    expect(storedDueDate.invoice.paymentStatus).toBe("PAID");
    expect(auditCount).toBe(1);
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
