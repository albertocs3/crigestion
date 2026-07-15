import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { commitPreparedVerifactuAlta, commitPreparedVerifactuAnulacion } from "@/modules/billing/application/verifactuPersistence";
import { getInvoiceDetail } from "@/modules/billing/application/invoices";
import { processNextVerifactuOutboxMessage, type VerifactuTransport, type VerifactuTransportResult } from "@/modules/billing/application/verifactuOutboxWorker";
import { getVerifactuCredentialManagement, stageVerifactuCredential, testAndActivateVerifactuCredential } from "@/modules/billing/application/verifactuCredentials";
import { getVerifactuOperations, hashVerifactuInterventionBody, interveneVerifactuDeadMessage } from "@/modules/billing/application/verifactuOperations";
import { createVerifactuSifInstallation, createVerifactuSifInstallationSchema, hashVerifactuSifInstallationBody } from "@/modules/billing/application/verifactuSifInstallations";
import { createVerifactuPayloadCipher } from "@/modules/billing/infrastructure/verifactu/payloadCipher";
import { createPrismaVerifactuCredentialSource, loadStagedVerifactuCredential } from "@/modules/billing/infrastructure/verifactu/credentialStore";
import { readVerifactuCertificateMetadata } from "@/modules/billing/infrastructure/verifactu/pkcs12";
import { createSecureEnvelopeKeyring } from "@/modules/billing/infrastructure/verifactu/secureEnvelope";
import { verifyVerifactuAeatTestCycle, type AeatTestCycleConfig, type AeatTestCycleRepository } from "@/modules/billing/application/verifyVerifactuAeatTestCycle";
import { createPrismaAeatTestCycleRepository } from "@/modules/billing/infrastructure/verifactu/aeatTestCycleRepository";
import { finalizeInvoiceTechnicalVoiding, hashInvoiceTechnicalVoidingBody, invoiceTechnicalVoidingSchema } from "@/modules/billing/application/invoiceTechnicalVoiding";
import { assertDisposableTestDatabase } from "@/tests/helpers/disposableTestDatabase";
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
            "Billing.ViewVerifactuOperations",
            "Billing.ManageVerifactuOperations",
            "Billing.RequestVerifactuCancellation",
            "Billing.FinalizeVerifactuCancellation",
            "Billing.ManageVerifactuInstallations",
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
      "Billing.FinalizeVerifactuCancellation",
      "Billing.Issue",
      "Billing.ManageDrafts",
      "Billing.ManageVerifactuInstallations",
      "Billing.ManageVerifactuOperations",
      "Billing.RequestVerifactuCancellation",
      "Billing.View",
      "Billing.ViewVerifactuOperations",
      "Treasury.ManagePayments"
    ]);
    expect(adminPermissionCodes).toEqual(
      expect.arrayContaining([
        "Billing.View",
        "Billing.ManageDrafts",
        "Billing.Issue",
        "Billing.ViewVerifactuOperations",
        "Billing.ManageVerifactuOperations",
        "Billing.RequestVerifactuCancellation",
        "Billing.FinalizeVerifactuCancellation",
        "Billing.ManageVerifactuInstallations",
        "Treasury.ManagePayments"
      ])
    );
  });

  it("creates a fixed TEST SIF installation idempotently and audits no producer identity", async () => {
    const admin = await findAdmin();
    const command = createVerifactuSifInstallationSchema.parse({
      installationCode: "test-01",
      producerTaxId: "b-12345678",
      producerName: "Productor de pruebas SL",
      systemName: "CriGestion",
      systemId: "cg",
      systemVersion: "0.1.0",
      installationNumber: "TEST-01"
    });
    const idempotencyKey = `sif-test:${randomUUID()}`;
    const requestHash = hashVerifactuSifInstallationBody(command);
    const first = await createVerifactuSifInstallation(command, admin, { idempotencyKey, requestHash, now: new Date("2026-07-13T12:00:00.000Z") });
    const replay = await createVerifactuSifInstallation(command, admin, { idempotencyKey, requestHash, now: new Date("2026-07-13T12:01:00.000Z") });

    expect(first).toMatchObject({ ok: true, status: 201, value: { installationCode: "TEST-01", environment: "TEST", status: "ACTIVE", contractVersion: "VF_V1", schemaVersion: "tikeV1.0" } });
    expect(replay).toMatchObject({ ok: true, status: 200, value: { id: first.ok ? first.value.id : "" } });
    expect(await prisma.verifactuSifInstallation.findFirstOrThrow()).toMatchObject({
      installationCode: "TEST-01", environment: "TEST", status: "ACTIVE", nextPosition: 1n,
      lastRecordId: null, lastRecordHash: null, producerTaxId: "B12345678", systemId: "CG",
      artifactManifestVersion: "AEAT_VERIFACTU_ARTIFACTS_V1"
    });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "VERIFACTU_SIF_INSTALLATION_CREATED" } });
    const serializedAudit = JSON.stringify(audit.payload);
    expect(serializedAudit).not.toContain(command.producerTaxId);
    expect(serializedAudit).not.toContain(command.producerName);
    expect(await prisma.verifactuSifInstallation.count()).toBe(1);

    const reused = await createVerifactuSifInstallation({ ...command, installationNumber: "OTHER" }, admin, { idempotencyKey, requestHash: hashVerifactuSifInstallationBody({ ...command, installationNumber: "OTHER" }) });
    expect(reused).toMatchObject({ ok: false, status: 409, error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    const duplicate = await createVerifactuSifInstallation({ ...command, installationCode: "TEST-02" }, admin, { idempotencyKey: `sif-test:${randomUUID()}`, requestHash: hashVerifactuSifInstallationBody({ ...command, installationCode: "TEST-02" }) });
    expect(duplicate).toMatchObject({ ok: false, status: 409, error: { code: "VERIFACTU_TEST_INSTALLATION_ALREADY_ACTIVE" } });
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

  it("enforces append-only VeriFactu records, a single chain, and durable outbox state", async () => {
    const admin = await findAdmin();
    const installationState = await prisma.installation.findFirstOrThrow({ select: { companyId: true } });
    if (!installationState.companyId) throw new Error("COMPANY_NOT_AVAILABLE");
    const customer = await createCustomer(admin.id);
    const invoice = await prisma.invoice.create({
      data: {
        companyId: installationState.companyId,
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
        customerFiscalAddressSnapshot: { country: "ES" },
        issueDate: new Date("2026-07-12T00:00:00.000Z"),
        operationDate: new Date("2026-07-12T00:00:00.000Z"),
        issuedAt: new Date("2026-07-12T10:00:00.000Z"),
        total: "121.00",
        createdById: admin.id,
        issuedById: admin.id
      }
    });
    const sif = await prisma.verifactuSifInstallation.create({
      data: {
        companyId: installationState.companyId,
        installationCode: "TEST-SIF-1",
        environment: "TEST",
        contractVersion: "VF_V1",
        schemaVersion: "tikeV1.0",
        artifactManifestVersion: "AEAT_VERIFACTU_ARTIFACTS_V1",
        artifactManifestSha256: "a".repeat(64),
        producerTaxId: "B12345678",
        producerName: "CriGestion Test SL",
        systemName: "CriGestion",
        systemId: "CG",
        systemVersion: "0.1.0",
        installationNumber: "TEST-1",
        activatedAt: new Date("2026-07-12T09:00:00.000Z")
      }
    });
    const first = await prisma.verifactuFiscalRecord.create({
      data: fiscalRecordData({
        companyId: installationState.companyId,
        sifInstallationId: sif.id,
        invoiceId: invoice.id,
        idSuffix: "first",
        chainPosition: 1n
      })
    });
    await prisma.verifactuSifInstallation.update({
      where: { id: sif.id },
      data: { nextPosition: 2n, lastRecordId: first.id, lastRecordHash: first.recordHash }
    });
    await prisma.verifactuSubmissionAttempt.create({
      data: {
        fiscalRecordId: first.id,
        attemptNumber: 1,
        kind: "SUBMIT",
        idempotencyKey: "vf-attempt-first-accepted",
        startedAt: new Date("2026-07-12T10:00:00.000Z"),
        completedAt: new Date("2026-07-12T10:00:01.000Z"),
        outcome: "ACCEPTED",
        requestSha256: "e".repeat(64)
      }
    });
    const second = await prisma.verifactuFiscalRecord.create({
      data: fiscalRecordData({
        companyId: installationState.companyId,
        sifInstallationId: sif.id,
        invoiceId: invoice.id,
        idSuffix: "second",
        chainPosition: 2n,
        previousRecordId: first.id,
        previousHash: first.recordHash,
        recordType: "ANULACION",
        cancelledRecordId: first.id
      })
    });
    await prisma.verifactuOutboxMessage.create({
      data: {
        fiscalRecordId: first.id,
        operation: "SUBMIT",
        idempotencyKey: "vf-outbox-first",
        bodySha256: "d".repeat(64)
      }
    });
    const attempt = await prisma.verifactuSubmissionAttempt.create({
      data: {
        fiscalRecordId: first.id,
        attemptNumber: 2,
        kind: "SUBMIT",
        idempotencyKey: "vf-attempt-first",
        startedAt: new Date("2026-07-12T10:01:00.000Z"),
        completedAt: new Date("2026-07-12T10:01:01.000Z"),
        outcome: "UNKNOWN",
        requestSha256: "e".repeat(64),
        stableErrorCode: "AEAT_RESULT_UNKNOWN"
      }
    });

    await expect(prisma.verifactuFiscalRecord.update({ where: { id: first.id }, data: { qrUrl: "https://example.test" } })).rejects.toThrow();
    await expect(prisma.verifactuFiscalRecord.delete({ where: { id: second.id } })).rejects.toThrow();
    await expect(prisma.verifactuSubmissionAttempt.update({ where: { id: attempt.id }, data: { stableErrorCode: "CHANGED" } })).rejects.toThrow();
    await expect(prisma.verifactuFiscalRecord.create({
      data: fiscalRecordData({
        companyId: installationState.companyId,
        sifInstallationId: sif.id,
        invoiceId: invoice.id,
        idSuffix: "fork",
        chainPosition: 3n,
        previousRecordId: first.id,
        previousHash: first.recordHash
      })
    })).rejects.toThrow();
    await expect(prisma.verifactuOutboxMessage.create({
      data: {
        fiscalRecordId: second.id,
        operation: "SUBMIT",
        idempotencyKey: "vf-invalid-claimed",
        bodySha256: "f".repeat(64),
        status: "CLAIMED"
      }
    })).rejects.toThrow();
  });

  it("commits a prepared VeriFactu record, outbox and chain head atomically and idempotently", async () => {
    const admin = await findAdmin();
    const state = await prisma.installation.findFirstOrThrow({ select: { companyId: true } });
    if (!state.companyId) throw new Error("COMPANY_NOT_AVAILABLE");
    const customer = await createCustomer(admin.id);
    const invoice = await prisma.invoice.create({
      data: issuedInvoiceData(state.companyId, customer, admin.id)
    });
    const sif = await prisma.verifactuSifInstallation.create({
      data: sifInstallationData(state.companyId, "ATOMIC-SIF")
    });
    const command = preparedAltaCommand(invoice.id, sif.id, "atomic-first");

    const committed = await commitPreparedVerifactuAlta(command, { id: admin.id }, { correlationId: "test-vf-atomic" });
    expect(committed).toMatchObject({ ok: true, replayed: false, record: { chainPosition: 1n } });
    if (!committed.ok) throw new Error(committed.error.code);
    expect(await prisma.verifactuOutboxMessage.findFirstOrThrow({ where: { fiscalRecordId: committed.record.id } })).toMatchObject({
      status: "PENDING",
      bodySha256: command.payloadSha256
    });
    expect(await prisma.verifactuSifInstallation.findUniqueOrThrow({ where: { id: sif.id } })).toMatchObject({
      nextPosition: 2n,
      lastRecordId: committed.record.id,
      lastRecordHash: command.recordHash
    });
    expect(await prisma.verifactuFiscalRecord.findUniqueOrThrow({ where: { id: committed.record.id } })).toMatchObject({
      fiscalSnapshot: {
        recordType: "ALTA",
        invoiceId: invoice.id,
        contractVersion: "VF_V1",
        schemaVersion: "tikeV1.0",
        payloadSha256: command.payloadSha256
      }
    });

    const replayed = await commitPreparedVerifactuAlta(command, { id: admin.id });
    expect(replayed).toMatchObject({ ok: true, replayed: true, record: { id: committed.record.id } });
    const reused = await commitPreparedVerifactuAlta({ ...command, recordHash: "9".repeat(64) }, { id: admin.id });
    expect(reused).toMatchObject({ ok: false, error: { code: "VERIFACTU_PREPARATION_KEY_REUSED" } });
    expect(await prisma.auditEvent.count({ where: { eventType: "VERIFACTU_RECORD_PREPARED" } })).toBe(1);
  });

  it("appends an ANULACION only for an accepted ALTA and preserves both immutable records", async () => {
    const admin = await findAdmin();
    const state = await prisma.installation.findFirstOrThrow({ select: { companyId: true } });
    if (!state.companyId) throw new Error("COMPANY_NOT_AVAILABLE");
    const customer = await createCustomer(admin.id);
    const invoice = await prisma.invoice.create({ data: issuedInvoiceData(state.companyId, customer, admin.id, "F2600030", 30) });
    const credential = await prisma.verifactuMtlsCredential.create({
      data: { companyId: state.companyId, ref: `vfcred:cancellation:${randomUUID()}`, alias: "Cancellation fixture" }
    });
    const sif = await prisma.verifactuSifInstallation.create({ data: { ...sifInstallationData(state.companyId, "CANCELLATION-SIF"), credentialRef: credential.ref } });
    const altaCommand = preparedAltaCommand(invoice.id, sif.id, "cancellation-alta");
    const alta = await commitPreparedVerifactuAlta(altaCommand, { id: admin.id });
    if (!alta.ok) throw new Error(alta.error.code);
    await prisma.verifactuOutboxMessage.updateMany({ where: { fiscalRecordId: alta.record.id }, data: { status: "PROCESSED", processedAt: new Date("2026-07-13T10:01:00.000Z") } });
    await prisma.verifactuSubmissionAttempt.create({ data: {
      fiscalRecordId: alta.record.id,
      attemptNumber: 1,
      kind: "SUBMIT",
      idempotencyKey: `accepted:${alta.record.id}`,
      startedAt: new Date("2026-07-13T10:00:00.000Z"),
      completedAt: new Date("2026-07-13T10:01:00.000Z"),
      outcome: "ACCEPTED",
      requestSha256: altaCommand.payloadSha256
    } });
    const cancellationCipher = createVerifactuPayloadCipher({ keyId: "cancellation-key", key: Buffer.alloc(32, 8), random: () => Buffer.alloc(12, 4) });
    const cancellationPlaintext = Buffer.from("<RegistroAnulacion>fixture</RegistroAnulacion>", "utf8");
    const cancellationPayloadSha256 = createHash("sha256").update(cancellationPlaintext).digest("hex");
    const cancellationPreparationKey = `vf-cancel:${randomUUID()}`;
    const cancellationCommand = {
      invoiceId: invoice.id,
      sifInstallationId: sif.id,
      cancelledRecordId: alta.record.id,
      reasonCode: "ISSUED_BY_MISTAKE" as const,
      preparationKey: cancellationPreparationKey,
      generatedAt: new Date("2026-07-13T10:02:00.000Z"),
      canonicalizationVersion: "AEAT_HASH_0.1.2",
      expectedPreviousRecordId: alta.record.id,
      expectedPreviousHash: alta.record.recordHash,
      recordHash: "B".repeat(64),
      payloadCiphertext: cancellationCipher.encrypt(cancellationPlaintext, {
        companyId: state.companyId,
        sifInstallationId: sif.id,
        invoiceId: invoice.id,
        preparationKey: cancellationPreparationKey,
        payloadSha256: cancellationPayloadSha256,
        recordType: "ANULACION",
        environment: "TEST"
      }),
      payloadSha256: cancellationPayloadSha256,
      encryptionKeyId: cancellationCipher.keyId
    };
    const cancellation = await commitPreparedVerifactuAnulacion(cancellationCommand, { id: admin.id }, { correlationId: "cancel-test" });
    expect(cancellation).toMatchObject({ ok: true, replayed: false, record: { chainPosition: 2n } });
    if (!cancellation.ok) throw new Error(cancellation.error.code);
    expect(await prisma.verifactuFiscalRecord.findUniqueOrThrow({ where: { id: cancellation.record.id } })).toMatchObject({
      recordType: "ANULACION",
      cancelledRecordId: alta.record.id,
      previousRecordId: alta.record.id,
      previousHash: alta.record.recordHash,
      qrUrl: null
    });
    expect(await prisma.verifactuFiscalRecord.count({ where: { invoiceId: invoice.id } })).toBe(2);
    expect(await prisma.verifactuOutboxMessage.findFirstOrThrow({ where: { fiscalRecordId: cancellation.record.id } })).toMatchObject({ status: "PENDING" });
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ verifactuStatus: "PENDING" });
    expect(await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "VERIFACTU_CANCELLATION_PREPARED" } })).toMatchObject({
      payload: expect.objectContaining({ cancelledRecordId: alta.record.id, fiscalRecordId: cancellation.record.id, reasonCode: "ISSUED_BY_MISTAKE" })
    });
    let submittedCancellation = "";
    const processed = await processNextVerifactuOutboxMessage({
      workerId: "cancellation-worker",
      companyId: state.companyId,
      environment: "TEST",
      cipher: cancellationCipher,
      now: () => new Date("2026-07-13T10:03:00.000Z"),
      transport: {
        submit: async ({ xml, context }) => {
          submittedCancellation = Buffer.from(xml).toString("utf8");
          expect(context.recordType).toBe("ANULACION");
          return { outcome: "ACCEPTED", stableCode: null, aeatCsv: "CSV-CANCELLED" };
        },
        reconcile: async () => ({ outcome: "ACCEPTED", stableCode: null })
      }
    });
    expect(processed).toEqual({ kind: "processed", outcome: "ACCEPTED" });
    expect(submittedCancellation).toBe("<RegistroAnulacion>fixture</RegistroAnulacion>");
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ verifactuStatus: "CANCELLED" });
    await expect(commitPreparedVerifactuAnulacion({ ...cancellationCommand, preparationKey: `vf-cancel:${randomUUID()}` }, { id: admin.id }))
      .resolves.toMatchObject({ ok: false, error: { code: "VERIFACTU_CHAIN_ADVANCED" } });
  });

  it("rejects an ANULACION target without accepted AEAT evidence at the database boundary", async () => {
    const admin = await findAdmin();
    const state = await prisma.installation.findFirstOrThrow({ select: { companyId: true } });
    if (!state.companyId) throw new Error("COMPANY_NOT_AVAILABLE");
    const customer = await createCustomer(admin.id);
    const invoice = await prisma.invoice.create({ data: issuedInvoiceData(state.companyId, customer, admin.id, "F2600031", 31) });
    const sif = await prisma.verifactuSifInstallation.create({ data: sifInstallationData(state.companyId, "CANCELLATION-DB-SIF") });
    const alta = await commitPreparedVerifactuAlta(preparedAltaCommand(invoice.id, sif.id, "unaccepted-alta"), { id: admin.id });
    if (!alta.ok) throw new Error(alta.error.code);
    const target = await prisma.verifactuFiscalRecord.findUniqueOrThrow({ where: { id: alta.record.id } });
    await expect(prisma.verifactuFiscalRecord.create({ data: {
      companyId: target.companyId, sifInstallationId: target.sifInstallationId, invoiceId: target.invoiceId,
      recordType: "ANULACION", chainPosition: 2n, previousRecordId: target.id, cancelledRecordId: target.id,
      issuerTaxId: target.issuerTaxId, issuerName: target.issuerName, invoiceSeries: target.invoiceSeries,
      invoiceNumber: target.invoiceNumber, invoiceIssueDate: target.invoiceIssueDate,
      generatedAt: new Date("2026-07-13T10:02:00.000Z"), contractVersion: target.contractVersion,
      schemaVersion: target.schemaVersion, canonicalizationVersion: target.canonicalizationVersion,
      previousHash: target.recordHash, recordHash: "C".repeat(64), fiscalSnapshot: {},
      payloadCiphertext: Buffer.from("ciphertext"), encryptionKeyId: "test-key-v1", payloadSha256: "7".repeat(64),
      preparationKey: `vf-invalid-cancel:${randomUUID()}`
    } })).rejects.toThrow();
  });

  it("serializes concurrent VeriFactu preparations without forking the chain", async () => {
    const admin = await findAdmin();
    const state = await prisma.installation.findFirstOrThrow({ select: { companyId: true } });
    if (!state.companyId) throw new Error("COMPANY_NOT_AVAILABLE");
    const customer = await createCustomer(admin.id);
    const [firstInvoice, secondInvoice] = await Promise.all([
      prisma.invoice.create({ data: issuedInvoiceData(state.companyId, customer, admin.id, "F2600020", 20) }),
      prisma.invoice.create({ data: issuedInvoiceData(state.companyId, customer, admin.id, "F2600021", 21) })
    ]);
    const sif = await prisma.verifactuSifInstallation.create({
      data: sifInstallationData(state.companyId, "CONCURRENT-SIF")
    });
    const [first, second] = await Promise.all([
      commitPreparedVerifactuAlta(preparedAltaCommand(firstInvoice.id, sif.id, "concurrent-first"), { id: admin.id }),
      commitPreparedVerifactuAlta({
        ...preparedAltaCommand(secondInvoice.id, sif.id, "concurrent-second"),
        recordHash: "6".repeat(64),
        payloadSha256: "7".repeat(64)
      }, { id: admin.id })
    ]);

    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: "VERIFACTU_CHAIN_ADVANCED" }) })
    ]);
    expect(await prisma.verifactuFiscalRecord.count()).toBe(1);
    expect(await prisma.verifactuOutboxMessage.count()).toBe(1);
    expect(await prisma.auditEvent.count({ where: { eventType: "VERIFACTU_RECORD_PREPARED" } })).toBe(1);
  });

  it("claims, decrypts and finalizes VeriFactu outbox delivery outside the claim transaction", async () => {
    const fixture = await createWorkerFixture("worker-accepted");
    let submittedXml = "";
    const processed = await processNextVerifactuOutboxMessage({
      workerId: "worker-1",
      companyId: fixture.companyId,
      environment: "TEST",
      cipher: fixture.cipher,
      now: () => new Date("2026-07-12T23:05:00.000Z"),
      transport: {
        submit: async ({ xml }) => {
          submittedXml = Buffer.from(xml).toString("utf8");
          return { outcome: "ACCEPTED", stableCode: null, externalSubmissionId: "AEAT-1", aeatCsv: "CSV-1" };
        },
        reconcile: async () => ({ outcome: "ACCEPTED", stableCode: null })
      }
    });
    expect(processed).toEqual({ kind: "processed", outcome: "ACCEPTED" });
    expect(submittedXml).toBe("<RegistroAlta>fixture</RegistroAlta>");
    expect(await prisma.verifactuOutboxMessage.findFirstOrThrow()).toMatchObject({ status: "PROCESSED", attemptCount: 1 });
    expect(await prisma.verifactuSubmissionAttempt.findFirstOrThrow()).toMatchObject({ outcome: "ACCEPTED", attemptNumber: 1 });
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: fixture.invoiceId } })).toMatchObject({ verifactuStatus: "ACCEPTED" });
  });

  it("does not claim PRODUCTION messages from a TEST worker", async () => {
    const fixture = await createWorkerFixture("worker-environment-isolation");
    await prisma.verifactuSifInstallation.update({
      where: { id: fixture.sifInstallationId },
      data: { environment: "PRODUCTION" }
    });
    let transportCalls = 0;
    const result = await processNextVerifactuOutboxMessage({
      workerId: "test-only-worker",
      companyId: fixture.companyId,
      environment: "TEST",
      cipher: fixture.cipher,
      transport: {
        submit: async () => { transportCalls += 1; return { outcome: "ACCEPTED", stableCode: null }; },
        reconcile: async () => { transportCalls += 1; return { outcome: "ACCEPTED", stableCode: null }; }
      }
    });
    expect(result).toEqual({ kind: "idle" });
    expect(transportCalls).toBe(0);
    expect(await prisma.verifactuOutboxMessage.findFirstOrThrow()).toMatchObject({ status: "PENDING", attemptCount: 0 });
  });

  it("does not claim or recover VeriFactu messages during platform maintenance", async () => {
    const fixture = await createWorkerFixture("worker-maintenance");
    const admin = await findAdmin();
    const backup = await prisma.backupOperation.create({
      data: { requestedById: admin.id, productVersion: "test" }
    });
    const restore = await prisma.restoreOperation.create({
      data: { backupOperationId: backup.id, requestedById: admin.id, reason: "Test maintenance" }
    });
    await prisma.platformMaintenanceState.create({
      data: {
        singletonKey: 1,
        enabled: true,
        mode: "RESTORE",
        reason: "Test maintenance",
        restoreOperationId: restore.id,
        enabledById: admin.id,
        enabledAt: new Date()
      }
    });
    const result = await processNextVerifactuOutboxMessage({
      workerId: "maintenance-worker",
      companyId: fixture.companyId,
      environment: "TEST",
      cipher: fixture.cipher,
      transport: {
        submit: async () => ({ outcome: "ACCEPTED", stableCode: null }),
        reconcile: async () => ({ outcome: "ACCEPTED", stableCode: null })
      }
    });
    expect(result).toEqual({ kind: "idle" });
    expect(await prisma.verifactuOutboxMessage.findFirstOrThrow()).toMatchObject({ status: "PENDING", attemptCount: 0 });
  });

  it("reconciles UNKNOWN submissions before allowing later chain positions", async () => {
    const fixture = await createWorkerFixture("worker-unknown");
    const outcomes: string[] = [];
    const transport = {
      submit: async () => {
        outcomes.push("submit");
        return { outcome: "UNKNOWN" as const, stableCode: "AEAT_TIMEOUT", externalSubmissionId: "AEAT-UNKNOWN-1" };
      },
      reconcile: async ({ externalSubmissionId }: { externalSubmissionId: string | null }) => {
        outcomes.push(`reconcile:${externalSubmissionId}`);
        return { outcome: "ACCEPTED" as const, stableCode: null };
      }
    };
    expect(await processNextVerifactuOutboxMessage({ workerId: "worker-1", companyId: fixture.companyId, environment: "TEST", cipher: fixture.cipher, transport, now: () => new Date("2026-07-12T23:05:00.000Z") }))
      .toMatchObject({ kind: "processed", outcome: "UNKNOWN" });
    expect(await prisma.verifactuOutboxMessage.findFirstOrThrow({ where: { operation: "RECONCILE" } })).toMatchObject({ status: "PENDING" });
    expect(await processNextVerifactuOutboxMessage({ workerId: "worker-2", companyId: fixture.companyId, environment: "TEST", cipher: fixture.cipher, transport, now: () => new Date("2026-07-12T23:06:00.000Z") }))
      .toMatchObject({ kind: "processed", outcome: "ACCEPTED" });
    expect(outcomes).toEqual(["submit", "reconcile:AEAT-UNKNOWN-1"]);
    expect(await prisma.verifactuSubmissionAttempt.findMany({ orderBy: { attemptNumber: "asc" }, select: { attemptNumber: true, kind: true, outcome: true } }))
      .toEqual([
        { attemptNumber: 1, kind: "SUBMIT", outcome: "UNKNOWN" },
        { attemptNumber: 2, kind: "RECONCILE", outcome: "ACCEPTED" }
      ]);
  });

  it("treats a thrown SUBMIT transport error as unknown and schedules reconciliation", async () => {
    const fixture = await createWorkerFixture("worker-thrown-submit");
    let submitCalls = 0;
    const result = await processNextVerifactuOutboxMessage({
      workerId: "worker-thrown-submit",
      companyId: fixture.companyId,
      environment: "TEST",
      cipher: fixture.cipher,
      now: () => new Date("2026-07-12T23:05:00.000Z"),
      transport: {
        submit: async () => { submitCalls += 1; throw new Error("socket reset after request write"); },
        reconcile: async () => ({ outcome: "ACCEPTED", stableCode: null })
      }
    });

    expect(result).toEqual({ kind: "processed", outcome: "UNKNOWN" });
    expect(submitCalls).toBe(1);
    expect(await prisma.verifactuSubmissionAttempt.findFirstOrThrow()).toMatchObject({
      kind: "SUBMIT",
      outcome: "UNKNOWN",
      stableErrorCode: "VERIFACTU_TRANSPORT_RESULT_UNKNOWN"
    });
    expect(await prisma.verifactuOutboxMessage.findMany({
      orderBy: { operation: "asc" },
      select: { operation: true, status: true }
    })).toEqual([
      { operation: "SUBMIT", status: "PROCESSED" },
      { operation: "RECONCILE", status: "PENDING" }
    ]);
  });

  it("turns an expired SUBMIT lease into reconciliation instead of blind resubmission", async () => {
    const fixture = await createWorkerFixture("worker-expired");
    const message = await prisma.verifactuOutboxMessage.findFirstOrThrow({ where: { operation: "SUBMIT" } });
    await prisma.verifactuOutboxMessage.update({
      where: { id: message.id },
      data: {
        status: "CLAIMED",
        attemptCount: 1,
        leaseOwner: "crashed-worker",
        leaseToken: randomUUID(),
        leaseUntil: new Date("2026-07-12T22:00:00.000Z")
      }
    });
    let submitCalls = 0;
    let reconcileCalls = 0;
    const result = await processNextVerifactuOutboxMessage({
      workerId: "recovery-worker",
      companyId: fixture.companyId,
      environment: "TEST",
      cipher: fixture.cipher,
      now: () => new Date("2026-07-12T23:00:00.000Z"),
      transport: {
        submit: async () => { submitCalls += 1; return { outcome: "ACCEPTED", stableCode: null }; },
        reconcile: async () => { reconcileCalls += 1; return { outcome: "ACCEPTED", stableCode: null }; }
      }
    });
    expect(result).toMatchObject({ kind: "processed", outcome: "ACCEPTED" });
    expect({ submitCalls, reconcileCalls }).toEqual({ submitCalls: 0, reconcileCalls: 1 });
    expect(await prisma.verifactuSubmissionAttempt.findMany({ orderBy: { attemptNumber: "asc" }, select: { kind: true, outcome: true } }))
      .toEqual([{ kind: "SUBMIT", outcome: "UNKNOWN" }, { kind: "RECONCILE", outcome: "ACCEPTED" }]);
  });

  it("dead-letters local VeriFactu credential failures without calling the transport", async () => {
    const fixture = await createWorkerFixture("worker-no-credential");
    await prisma.verifactuSifInstallation.update({ where: { id: fixture.sifInstallationId }, data: { credentialRef: null } });
    let transportCalls = 0;
    const result = await processNextVerifactuOutboxMessage({
      workerId: "worker-credential-check",
      companyId: fixture.companyId,
      environment: "TEST",
      cipher: fixture.cipher,
      now: () => new Date("2026-07-12T23:05:00.000Z"),
      transport: {
        submit: async () => { transportCalls += 1; return { outcome: "ACCEPTED", stableCode: null }; },
        reconcile: async () => { transportCalls += 1; return { outcome: "ACCEPTED", stableCode: null }; }
      }
    });
    expect(result).toEqual({ kind: "processed", outcome: "RETRYABLE_FAILURE" });
    expect(transportCalls).toBe(0);
    expect(await prisma.verifactuOutboxMessage.findFirstOrThrow()).toMatchObject({
      status: "DEAD",
      lastErrorCode: "VERIFACTU_CREDENTIAL_UNAVAILABLE"
    });
    expect(await prisma.verifactuSubmissionAttempt.findFirstOrThrow()).toMatchObject({
      outcome: "RETRYABLE_FAILURE",
      stableErrorCode: "VERIFACTU_CREDENTIAL_UNAVAILABLE"
    });
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: fixture.invoiceId } })).toMatchObject({ verifactuStatus: "PENDING" });
  });

  it("projects safe VeriFactu incidents and requeues a DEAD pre-send failure idempotently", async () => {
    const fixture = await createWorkerFixture("ops-retry");
    await prisma.verifactuSifInstallation.update({ where: { id: fixture.sifInstallationId }, data: { credentialRef: null } });
    await processNextVerifactuOutboxMessage({ workerId: "ops-worker", companyId: fixture.companyId, environment: "TEST", cipher: fixture.cipher, transport: { submit: async () => ({ outcome: "ACCEPTED", stableCode: null }), reconcile: async () => ({ outcome: "ACCEPTED", stableCode: null }) } });
    const deadBeforeLimit = await prisma.verifactuOutboxMessage.findFirstOrThrow({ where: { status: "DEAD" } });
    const dead = await prisma.verifactuOutboxMessage.update({ where: { id: deadBeforeLimit.id }, data: { maxAttempts: deadBeforeLimit.attemptCount } });
    const dashboard = await getVerifactuOperations({ status: "INCIDENTS", operation: "ALL", environment: "ALL", search: "" }, new Date("2026-07-13T12:00:00.000Z"));
    expect(dashboard?.messages).toMatchObject([{ id: dead.id, status: "DEAD", action: "RETRY_SUBMIT", lastErrorCode: "VERIFACTU_CREDENTIAL_UNAVAILABLE" }]);
    const serialized = JSON.stringify(dashboard);
    for (const sensitive of ["payloadCiphertext", "requestCiphertext", "responseCiphertext", "encryptionKeyId", "idempotencyKey", "credentialRef", "leaseToken"]) expect(serialized).not.toContain(sensitive);
    const admin = await prisma.user.findUniqueOrThrow({ where: { normalizedUserName: "admin" }, select: { id: true } });
    const actor = { id: admin.id, displayName: "Administrador", userName: "admin", role: { code: "Administrador", name: "Administrador" }, permissions: ["Billing.ManageVerifactuOperations"] };
    const invoiceDetail = await getInvoiceDetail(fixture.invoiceId, { ...actor, permissions: ["Billing.View"] });
    expect(invoiceDetail?.verifactuTrace).toMatchObject({ operationalStatus: "ACTION_REQUIRED", queue: { id: dead.id, status: "DEAD", lastErrorCode: "VERIFACTU_CREDENTIAL_UNAVAILABLE" } });
    const command = { expectedUpdatedAt: dead.updatedAt.toISOString(), reason: "CREDENTIAL_CORRECTED" as const };
    const context = { messageId: dead.id, ...command, actor, idempotencyKey: `ops:${randomUUID()}`, requestHash: hashVerifactuInterventionBody(command), correlationId: "ops-retry", now: new Date("2026-07-13T12:01:00.000Z") };
    const result = await interveneVerifactuDeadMessage(context);
    expect(result).toMatchObject({ ok: true, value: { messageId: dead.id, action: "RETRY_SUBMIT", status: "PENDING" } });
    expect(await interveneVerifactuDeadMessage(context)).toEqual(result);
    expect(await prisma.verifactuOutboxMessage.findUniqueOrThrow({ where: { id: dead.id }, select: { status: true, attemptCount: true, maxAttempts: true } })).toEqual({ status: "PENDING", attemptCount: dead.attemptCount, maxAttempts: dead.attemptCount + 1 });
    expect(await prisma.auditEvent.count({ where: { eventType: "VERIFACTU_OUTBOX_INTERVENTION_REQUESTED" } })).toBe(1);
  });

  it("turns an ambiguous DEAD submit into reconciliation without resubmitting", async () => {
    await createWorkerFixture("ops-reconcile");
    const submit = await prisma.verifactuOutboxMessage.findFirstOrThrow({ where: { operation: "SUBMIT" } });
    const dead = await prisma.verifactuOutboxMessage.update({ where: { id: submit.id }, data: { status: "DEAD", lastErrorCode: "VERIFACTU_ADAPTER_FAILURE" } });
    const admin = await prisma.user.findUniqueOrThrow({ where: { normalizedUserName: "admin" }, select: { id: true } });
    const actor = { id: admin.id, displayName: "Administrador", userName: "admin", role: { code: "Administrador", name: "Administrador" }, permissions: ["Billing.ManageVerifactuOperations"] };
    const command = { expectedUpdatedAt: dead.updatedAt.toISOString(), reason: "MANUAL_REVIEW" as const };
    const result = await interveneVerifactuDeadMessage({ messageId: dead.id, ...command, actor, idempotencyKey: `ops:${randomUUID()}`, requestHash: hashVerifactuInterventionBody(command), now: new Date("2026-07-13T12:02:00.000Z") });
    expect(result).toMatchObject({ ok: true, value: { sourceMessageId: dead.id, action: "RECONCILE", status: "PENDING" } });
    expect(await prisma.verifactuOutboxMessage.findMany({ orderBy: { operation: "asc" }, select: { operation: true, status: true } })).toEqual([{ operation: "SUBMIT", status: "PROCESSED" }, { operation: "RECONCILE", status: "PENDING" }]);
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

  it("enforces one active mTLS version and credential lifecycle constraints", async () => {
    const installation = await prisma.installation.findFirstOrThrow({ select: { companyId: true } });
    if (!installation.companyId) throw new Error("COMPANY_NOT_AVAILABLE");
    const credential = await prisma.verifactuMtlsCredential.create({
      data: { companyId: installation.companyId, ref: `vfcred:${randomUUID()}`, alias: "Fixture mTLS" }
    });
    const stagedData = {
      credentialId: credential.id,
      status: "STAGED" as const,
      endpointKind: "STANDARD" as const,
      allowTest: true,
      allowProduction: false,
      validFrom: new Date("2026-01-01T00:00:00Z"),
      validUntil: new Date("2027-01-01T00:00:00Z"),
      materialCiphertext: Buffer.from("encrypted-fixture"),
      encryptionKeyId: "fixture-key",
      pfxSha256: "a".repeat(64)
    };
    const stagedVersion = await prisma.verifactuMtlsCredentialVersion.create({ data: { ...stagedData, version: 1 } });
    await expect(prisma.verifactuMtlsCredentialVersion.create({
      data: { ...stagedData, version: 2, status: "ACTIVE", testedAt: new Date(), testedPfxSha256: "a".repeat(64), activatedAt: new Date() }
    })).rejects.toThrow();
    await expect(prisma.verifactuMtlsCredentialVersion.update({
      where: { id: stagedVersion.id }, data: { pfxSha256: "b".repeat(64) }
    })).rejects.toThrow();
    await expect(prisma.verifactuMtlsCredentialVersion.update({ where: { id: stagedVersion.id }, data: { status: "ACTIVE", activatedAt: new Date() } })).rejects.toThrow();
    await expect(prisma.verifactuMtlsCredentialVersion.delete({ where: { id: stagedVersion.id } })).rejects.toThrow();
  });

  it("reads legacy encrypted JSON credential material and clears released PFX buffers", async () => {
    const admin = await findAdmin();
    const installation = await prisma.installation.findFirstOrThrow({ select: { companyId: true } });
    if (!installation.companyId) throw new Error("COMPANY_NOT_AVAILABLE");
    const pfxFixture = readFileSync(resolve("tests/fixtures/verifactu/mtls/client.p12"));
    const passphrase = "fixture-only";
    const metadata = readVerifactuCertificateMetadata(pfxFixture, passphrase);
    const pfxSha256 = createHash("sha256").update(pfxFixture).digest("hex");
    const cipher = createSecureEnvelopeKeyring({ activeKeyId: "legacy-test-key", keys: { "legacy-test-key": Buffer.alloc(32, 8) }, random: () => Buffer.alloc(12, 6) });
    const credentialId = randomUUID();
    const versionId = randomUUID();
    const credentialRef = `vfcred:legacy:${randomUUID()}`;
    const context = ["VERIFACTU-MTLS-CREDENTIAL", installation.companyId, credentialId, versionId, "1", "STANDARD", "true", "false", metadata.validFrom.toISOString(), metadata.validUntil.toISOString(), pfxSha256];
    const legacyPlaintext = Buffer.from(JSON.stringify({ pfxBase64: pfxFixture.toString("base64"), passphrase }), "utf8");
    const materialCiphertext = cipher.encrypt(legacyPlaintext, context);
    legacyPlaintext.fill(0);
    await prisma.verifactuMtlsCredential.create({ data: { id: credentialId, companyId: installation.companyId, ref: credentialRef, alias: "Legacy fixture" } });
    await prisma.verifactuMtlsCredentialVersion.create({ data: {
      id: versionId, credentialId, version: 1, status: "STAGED", endpointKind: "STANDARD", allowTest: true, allowProduction: false,
      validFrom: metadata.validFrom, validUntil: metadata.validUntil, materialCiphertext: Uint8Array.from(materialCiphertext), encryptionKeyId: cipher.keyId, pfxSha256
    } });

    const staged = await loadStagedVerifactuCredential({ versionId, companyId: installation.companyId, cipher });
    expect(staged?.pfx.equals(pfxFixture)).toBe(true);
    const stagedPfx = staged?.pfx;
    staged?.release();
    expect(stagedPfx?.every((byte) => byte === 0)).toBe(true);

    const testedAt = new Date("2026-07-13T12:00:00.000Z");
    const attempt = await prisma.verifactuMtlsCredentialTestAttempt.create({ data: {
      versionId, idempotencyKey: `legacy:${randomUUID()}`, requestHash: "8".repeat(64), outcome: "PASSED", pfxSha256,
      startedAt: testedAt, completedAt: testedAt, stableCode: "VERIFACTU_AEAT_TEST_PASSED", actorUserId: admin.id
    } });
    await prisma.verifactuMtlsCredentialVersion.update({ where: { id: versionId }, data: { status: "TESTED", testedAt, testedPfxSha256: pfxSha256, testedAttemptId: attempt.id } });
    await prisma.verifactuMtlsCredentialVersion.update({ where: { id: versionId }, data: { status: "ACTIVE", activatedAt: testedAt } });
    const active = await createPrismaVerifactuCredentialSource(cipher).load(credentialRef, installation.companyId);
    expect(active ? Buffer.from(active.pfx).equals(pfxFixture) : false).toBe(true);
    const activePfx = active?.pfx;
    active?.release();
    expect(activePfx?.every((byte) => byte === 0)).toBe(true);
    pfxFixture.fill(0);
  });

  it("tests, activates and rotates encrypted mTLS credential versions atomically", async () => {
    const admin = await findAdmin();
    const state = await prisma.installation.findFirstOrThrow({ select: { companyId: true } });
    if (!state.companyId) throw new Error("COMPANY_NOT_AVAILABLE");
    const customer = await createCustomer(admin.id);
    const invoice = await prisma.invoice.create({ data: issuedInvoiceData(state.companyId, customer, admin.id, "F2600091", 91) });
    const sif = await prisma.verifactuSifInstallation.create({ data: sifInstallationData(state.companyId, "CREDENTIAL-CYCLE") });
    const fiscal = await prisma.verifactuFiscalRecord.create({ data: fiscalRecordData({ companyId: state.companyId, sifInstallationId: sif.id, invoiceId: invoice.id, idSuffix: "credential-cycle", chainPosition: 1n }) });
    const cipher = createSecureEnvelopeKeyring({ activeKeyId: "credential-test-key", keys: { "credential-test-key": Buffer.alloc(32, 9) }, random: () => Buffer.alloc(12, 4) });
    const pfxFixture = readFileSync(resolve("tests/fixtures/verifactu/mtls/client.p12"));
    const pfxBase64 = pfxFixture.toString("base64");
    const actor = { id: admin.id, displayName: "Administrador", userName: "admin", role: { code: "Administrador", name: "Administrador" }, permissions: ["Billing.ManageVerifactuCredentials"] };
    const now = new Date("2026-07-13T12:00:00.000Z");
    const dependencies = { credentialCipher: cipher, now: () => now, probe: async () => ({ outcome: "PASSED" as const, stableCode: "VERIFACTU_AEAT_TEST_PASSED", responseSha256: "d".repeat(64) }) };
    const command = { sifInstallationId: sif.id, alias: "Certificado TEST", passphrase: "fixture-only", endpointKind: "STANDARD" as const, allowTest: true, allowProduction: false };

    const stagedV1 = await stageVerifactuCredential({ ...command, pfx: Buffer.from(pfxFixture) }, actor, { idempotencyKey: `stage:${randomUUID()}`, requestHash: "1".repeat(64), correlationId: "credential-cycle" }, dependencies);
    expect(stagedV1).toMatchObject({ ok: true, status: 201, value: { version: 1, status: "STAGED" } });
    if (!stagedV1.ok) throw new Error(stagedV1.error.code);
    expect(await prisma.verifactuSifInstallation.findUniqueOrThrow({ where: { id: sif.id }, select: { credentialRef: true } })).toEqual({ credentialRef: null });
    const managementBeforeActivation = await getVerifactuCredentialManagement();
    expect(managementBeforeActivation?.credentials).toMatchObject([{
      alias: "Certificado TEST",
      assignments: [],
      versions: [{ id: stagedV1.value.versionId, version: 1, status: "STAGED" }]
    }]);
    const safeManagement = JSON.stringify(managementBeforeActivation);
    expect(safeManagement).not.toContain(pfxBase64);
    expect(safeManagement).not.toContain("fixture-only");
    expect(safeManagement).not.toContain("materialCiphertext");
    expect(safeManagement).not.toContain("encryptionKeyId");
    expect(safeManagement).not.toContain("pfxSha256");
    const activatedV1 = await testAndActivateVerifactuCredential(stagedV1.value.versionId, { sifInstallationId: sif.id, fiscalRecordId: fiscal.id }, actor, { idempotencyKey: `activate:${randomUUID()}`, requestHash: "2".repeat(64), correlationId: "credential-cycle" }, dependencies);
    expect(activatedV1).toMatchObject({ ok: true, value: { version: 1, status: "ACTIVE", retiredVersionId: null } });

    const stagedV2 = await stageVerifactuCredential({ ...command, pfx: Buffer.from(pfxFixture) }, actor, { idempotencyKey: `stage:${randomUUID()}`, requestHash: "3".repeat(64) }, dependencies);
    if (!stagedV2.ok) throw new Error(stagedV2.error.code);
    const activationV2Context = { idempotencyKey: `activate:${randomUUID()}`, requestHash: "4".repeat(64) };
    const activatedV2 = await testAndActivateVerifactuCredential(stagedV2.value.versionId, { sifInstallationId: sif.id, fiscalRecordId: fiscal.id }, actor, activationV2Context, dependencies);
    expect(activatedV2).toMatchObject({ ok: true, value: { version: 2, status: "ACTIVE", retiredVersionId: stagedV1.value.versionId } });
    expect(await testAndActivateVerifactuCredential(stagedV2.value.versionId, { sifInstallationId: sif.id, fiscalRecordId: fiscal.id }, actor, activationV2Context, dependencies)).toEqual(activatedV2);
    expect(await prisma.verifactuMtlsCredentialVersion.findMany({ orderBy: { version: "asc" }, select: { version: true, status: true, testedPfxSha256: true, testedAttemptId: true } })).toEqual([
      { version: 1, status: "RETIRED", testedPfxSha256: expect.stringMatching(/^[0-9a-f]{64}$/), testedAttemptId: expect.any(String) },
      { version: 2, status: "ACTIVE", testedPfxSha256: expect.stringMatching(/^[0-9a-f]{64}$/), testedAttemptId: expect.any(String) }
    ]);
    const audits = await prisma.auditEvent.findMany({ where: { eventType: { startsWith: "VERIFACTU_MTLS_" } }, select: { payload: true } });
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(pfxBase64);
    expect(serialized).not.toContain("fixture-only");
    expect(serialized).not.toContain("materialCiphertext");

    const stagedV3 = await stageVerifactuCredential({ ...command, pfx: Buffer.from(pfxFixture) }, actor, { idempotencyKey: `stage:${randomUUID()}`, requestHash: "5".repeat(64) }, { ...dependencies, probe: async () => ({ outcome: "FAILED" as const, stableCode: "VERIFACTU_AEAT_TEST_SOAP_FAULT" }) });
    if (!stagedV3.ok) throw new Error(stagedV3.error.code);
    const stagedV3Row = await prisma.verifactuMtlsCredentialVersion.findUniqueOrThrow({ where: { id: stagedV3.value.versionId }, select: { pfxSha256: true } });
    const staleKey = `activate:${randomUUID()}`;
    await prisma.verifactuMtlsCredentialTestAttempt.create({ data: { versionId: stagedV3.value.versionId, idempotencyKey: staleKey, requestHash: "7".repeat(64), outcome: "RUNNING", pfxSha256: stagedV3Row.pfxSha256, startedAt: new Date(now.getTime() - 10 * 60_000), actorUserId: admin.id } });
    const stale = await testAndActivateVerifactuCredential(stagedV3.value.versionId, { sifInstallationId: sif.id, fiscalRecordId: fiscal.id }, actor, { idempotencyKey: staleKey, requestHash: "7".repeat(64) }, dependencies);
    expect(stale).toMatchObject({ ok: false, status: 503, error: { code: "VERIFACTU_CREDENTIAL_TEST_EXPIRED" } });
    expect(await prisma.verifactuMtlsCredentialTestAttempt.findUniqueOrThrow({ where: { idempotencyKey: staleKey }, select: { outcome: true } })).toEqual({ outcome: "UNKNOWN" });
    const failed = await testAndActivateVerifactuCredential(stagedV3.value.versionId, { sifInstallationId: sif.id, fiscalRecordId: fiscal.id }, actor, { idempotencyKey: `activate:${randomUUID()}`, requestHash: "6".repeat(64) }, { ...dependencies, probe: async () => ({ outcome: "FAILED" as const, stableCode: "VERIFACTU_AEAT_TEST_SOAP_FAULT" }) });
    expect(failed).toMatchObject({ ok: false, status: 502, error: { code: "VERIFACTU_AEAT_TEST_SOAP_FAULT" } });
    expect(await prisma.verifactuMtlsCredentialVersion.findUniqueOrThrow({ where: { id: stagedV3.value.versionId }, select: { status: true } })).toEqual({ status: "STAGED" });
    expect(await prisma.verifactuMtlsCredentialVersion.count({ where: { status: "ACTIVE" } })).toBe(1);
  });
  it("persists encrypted AEAT TEST cycle evidence and safe SYSTEM audit", async () => {
    const fixture = await createAcceptedAeatTestCycleFixture();
    const repository = createPrismaAeatTestCycleRepository(prisma);
    await verifyVerifactuAeatTestCycle(fixture.config, cycleDependencies(repository, fixture, "cycle-success"));

    const attempt = await prisma.verifactuSubmissionAttempt.findFirstOrThrow({
      where: { fiscalRecordId: fixture.cancellationId, kind: "RECONCILE" }
    });
    expect(attempt).toMatchObject({ attemptNumber: 2, outcome: "ACCEPTED", requestSha256: "8".repeat(64),
      responseSha256: "9".repeat(64), encryptionKeyId: "response-test-v1", credentialVersionId: fixture.credentialVersionId });
    expect(Buffer.from(attempt.responseCiphertext ?? []).toString("utf8")).not.toContain("plain-soap-secret");
    expect(attempt.responseCiphertext?.byteLength).toBeGreaterThan(32);
    const audits = await prisma.auditEvent.findMany({ where: { eventType: { startsWith: "VERIFACTU_AEAT_TEST_CYCLE_" } } });
    expect(audits.map((audit) => audit.eventType).sort()).toEqual([
      "VERIFACTU_AEAT_TEST_CYCLE_COMPLETED", "VERIFACTU_AEAT_TEST_CYCLE_STARTED"
    ]);
    expect(audits.every((audit) => audit.actorType === "SYSTEM")).toBe(true);
    expect(JSON.stringify(audits)).toContain('"claimedOperatorId":"integration.operator"');
    expect(JSON.stringify(audits)).not.toContain("B12345678");
    expect(JSON.stringify(audits)).not.toContain("plain-soap-secret");
  });

  it("finalizes an accepted technical cancellation with an append-only reversal entry", async () => {
    const fixture = await createAcceptedAeatTestCycleFixture();
    const admin = await findAdmin();
    const command = invoiceTechnicalVoidingSchema.parse({
      voidDate: "2026-07-13",
      reasonCode: "ISSUED_BY_MISTAKE",
      confirmation: "VOID_AFTER_ACCEPTED_VERIFACTU_CANCELLATION"
    });
    const idempotencyKey = `technical-voiding:${randomUUID()}`;
    const input = {
      invoiceId: fixture.config.invoiceId,
      command,
      actor: { id: admin.id, displayName: "Administrador", userName: "admin", role: { code: "Administrador", name: "Administrador" }, permissions: ["Billing.FinalizeVerifactuCancellation"] },
      idempotencyKey,
      requestHash: hashInvoiceTechnicalVoidingBody(command),
      correlationId: "technical-voiding-test"
    };

    const result = await finalizeInvoiceTechnicalVoiding(input);
    const replay = await finalizeInvoiceTechnicalVoiding(input);
    expect(result).toMatchObject({ ok: true, status: 201, value: { status: "VOIDED", paymentStatus: "CANCELLED", cancellationRecordId: fixture.cancellationId } });
    expect(replay).toMatchObject({ ok: true, status: 200, value: result.ok ? result.value : {} });

    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: fixture.config.invoiceId },
      select: {
        status: true,
        paymentStatus: true,
        dueDates: { select: { status: true } },
        accountingEntry: { select: { id: true, status: true, lines: { orderBy: { position: "asc" }, select: { debit: true, credit: true } } } },
        voidingAccountingEntry: { select: { origin: true, reversesEntryId: true, lines: { orderBy: { position: "asc" }, select: { debit: true, credit: true } } } },
        verifactuFiscalRecords: { select: { id: true } }
      }
    });
    expect(invoice.status).toBe("VOIDED");
    expect(invoice.paymentStatus).toBe("CANCELLED");
    expect(invoice.dueDates).toEqual([{ status: "CANCELLED" }]);
    expect(invoice.accountingEntry?.status).toBe("POSTED");
    expect(invoice.voidingAccountingEntry).toMatchObject({ origin: "INVOICE_VOIDING", reversesEntryId: invoice.accountingEntry?.id });
    expect(invoice.voidingAccountingEntry?.lines.map((line) => [line.debit.toFixed(2), line.credit.toFixed(2)])).toEqual(
      invoice.accountingEntry?.lines.map((line) => [line.credit.toFixed(2), line.debit.toFixed(2)])
    );
    expect(invoice.verifactuFiscalRecords).toHaveLength(2);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "INVOICE_TECHNICAL_VOIDING_FINALIZED" } });
    expect(JSON.stringify(audit.payload)).not.toContain("B12345678");
  });

  it("fails closed before transport when the selected cancellation does not match", async () => {
    const fixture = await createAcceptedAeatTestCycleFixture();
    let calls = 0;
    const dependencies = cycleDependencies(createPrismaAeatTestCycleRepository(prisma), fixture, "cycle-mismatch");
    dependencies.transport.reconcile = async () => { calls += 1; return acceptedCycleResult(fixture); };
    await expect(verifyVerifactuAeatTestCycle({ ...fixture.config, expectedCancellationId: randomUUID() }, dependencies))
      .rejects.toThrow("VERIFACTU_AEAT_TEST_CYCLE_LINK_INVALID");
    expect(calls).toBe(0);
    expect(await prisma.auditEvent.count({ where: { eventType: { startsWith: "VERIFACTU_AEAT_TEST_CYCLE_" } } })).toBe(0);
  });

  it("audits a sanitized transport failure without persisting an attempt", async () => {
    const fixture = await createAcceptedAeatTestCycleFixture();
    const dependencies = cycleDependencies(createPrismaAeatTestCycleRepository(prisma), fixture, "cycle-transport-fail");
    dependencies.transport.reconcile = async () => { throw new Error("plain-soap-secret B12345678"); };
    await expect(verifyVerifactuAeatTestCycle(fixture.config, dependencies))
      .rejects.toThrow("VERIFACTU_AEAT_TEST_CYCLE_TRANSPORT_FAILED");
    expect(await prisma.verifactuSubmissionAttempt.count({ where: { fiscalRecordId: fixture.cancellationId } })).toBe(1);
    const audits = await prisma.auditEvent.findMany({ where: { eventType: { startsWith: "VERIFACTU_AEAT_TEST_CYCLE_" } } });
    expect(audits.map((audit) => audit.eventType).sort()).toEqual([
      "VERIFACTU_AEAT_TEST_CYCLE_FAILED", "VERIFACTU_AEAT_TEST_CYCLE_STARTED"
    ]);
    expect(JSON.stringify(audits)).not.toContain("plain-soap-secret");
    expect(JSON.stringify(audits)).not.toContain("B12345678");
  });

  it("audits a persistence failure after the simulated AEAT response", async () => {
    const fixture = await createAcceptedAeatTestCycleFixture();
    const realRepository = createPrismaAeatTestCycleRepository(prisma);
    const repository = { ...realRepository, persistResult: async () => { throw new Error("database-secret"); } };
    await expect(verifyVerifactuAeatTestCycle(fixture.config, cycleDependencies(repository, fixture, "cycle-db-fail")))
      .rejects.toThrow("VERIFACTU_AEAT_TEST_CYCLE_PERSISTENCE_FAILED");
    expect(await prisma.verifactuSubmissionAttempt.count({ where: { fiscalRecordId: fixture.cancellationId } })).toBe(1);
    const failed = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "VERIFACTU_AEAT_TEST_CYCLE_FAILED" } });
    expect(failed.payload).toEqual(expect.objectContaining({ stableCode: "VERIFACTU_AEAT_TEST_CYCLE_PERSISTENCE_FAILED" }));
  });

  it("can retry after a non-clean RECONCILE result without losing terminal SUBMIT evidence", async () => {
    const fixture = await createAcceptedAeatTestCycleFixture();
    const repository = createPrismaAeatTestCycleRepository(prisma);
    const first = cycleDependencies(repository, fixture, "cycle-retry-first");
    first.transport.reconcile = async () => ({ ...acceptedCycleResult(fixture), outcome: "RETRYABLE_FAILURE",
      stableCode: "VERIFACTU_CANCELLATION_NOT_VISIBLE" });
    await expect(verifyVerifactuAeatTestCycle(fixture.config, first))
      .rejects.toThrow("VERIFACTU_AEAT_TEST_CYCLE_QUERY_NOT_ANULADO");

    await expect(verifyVerifactuAeatTestCycle(fixture.config,
      cycleDependencies(repository, fixture, "cycle-retry-second"))).resolves.toEqual({ requestId: "cycle-retry-second" });
    const attempts = await prisma.verifactuSubmissionAttempt.findMany({
      where: { fiscalRecordId: fixture.cancellationId }, orderBy: { attemptNumber: "asc" }, select: { kind: true, outcome: true }
    });
    expect(attempts).toEqual([
      { kind: "SUBMIT", outcome: "ACCEPTED" },
      { kind: "RECONCILE", outcome: "RETRYABLE_FAILURE" },
      { kind: "RECONCILE", outcome: "ACCEPTED" }
    ]);
  });

  it("serializes concurrent evidence attempts without colliding attempt numbers", async () => {
    const fixture = await createAcceptedAeatTestCycleFixture();
    const repository = createPrismaAeatTestCycleRepository(prisma);
    let arrivals = 0;
    let release!: () => void;
    const bothAtTransport = new Promise<void>((resolve) => { release = resolve; });
    const reconcile = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothAtTransport;
      return acceptedCycleResult(fixture);
    };
    const first = cycleDependencies(repository, fixture, "cycle-concurrent-a");
    const second = cycleDependencies(repository, fixture, "cycle-concurrent-b");
    first.transport.reconcile = reconcile;
    second.transport.reconcile = reconcile;
    await Promise.all([
      verifyVerifactuAeatTestCycle(fixture.config, first),
      verifyVerifactuAeatTestCycle(fixture.config, second)
    ]);
    const attempts = await prisma.verifactuSubmissionAttempt.findMany({
      where: { fiscalRecordId: fixture.cancellationId, kind: "RECONCILE" }, orderBy: { attemptNumber: "asc" }
    });
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([2, 3]);
    expect(await prisma.auditEvent.count({ where: { eventType: "VERIFACTU_AEAT_TEST_CYCLE_COMPLETED" } })).toBe(2);
  });
});

async function createAcceptedAeatTestCycleFixture(): Promise<{
  config: AeatTestCycleConfig; cancellationId: string; credentialVersionId: string;
}> {
  const admin = await findAdmin();
  const state = await prisma.installation.findFirstOrThrow({ select: { companyId: true } });
  if (!state.companyId) throw new Error("COMPANY_NOT_AVAILABLE");
  const customer = await createCustomer(admin.id);
  const invoice = await prisma.invoice.create({ data: issuedInvoiceData(state.companyId, customer, admin.id, "F2600099", 99) });
  const fiscalYear = await prisma.accountingFiscalYear.create({ data: {
    companyId: state.companyId, year: 2026, startDate: new Date("2026-01-01T00:00:00.000Z"),
    endDate: new Date("2026-12-31T00:00:00.000Z"), planCode: "PGC_PYMES", planVersion: "2007", createdById: admin.id
  } });
  await prisma.accountingAccount.createMany({ data: [
    { fiscalYearId: fiscalYear.id, code: "430000001", name: "Cliente fixture", type: "ASSET", level: 4, isPostable: true, createdById: admin.id },
    { fiscalYearId: fiscalYear.id, code: "705000000", name: "Servicios fixture", type: "INCOME", level: 4, isPostable: true, createdById: admin.id },
    { fiscalYearId: fiscalYear.id, code: "477000000", name: "IVA fixture", type: "LIABILITY", level: 4, isPostable: true, createdById: admin.id }
  ] });
  const fixtureAccounts = await prisma.accountingAccount.findMany({ where: { fiscalYearId: fiscalYear.id }, select: { id: true, code: true } });
  const fixtureAccountByCode = new Map(fixtureAccounts.map((account) => [account.code, account.id]));
  await prisma.accountingJournalEntry.create({ data: {
    fiscalYearId: fiscalYear.id, invoiceId: invoice.id, year: 2026, sequence: 1, number: "2026/000001",
    accountingDate: new Date("2026-07-12T00:00:00.000Z"), concept: "Factura fixture", origin: "INVOICE",
    totalDebit: "121.00", totalCredit: "121.00", createdById: admin.id,
    lines: { create: [
      { accountId: fixtureAccountByCode.get("430000001")!, position: 1, concept: "Factura fixture", debit: "121.00", credit: "0.00" },
      { accountId: fixtureAccountByCode.get("705000000")!, position: 2, concept: "Factura fixture", debit: "0.00", credit: "100.00" },
      { accountId: fixtureAccountByCode.get("477000000")!, position: 3, concept: "Factura fixture", debit: "0.00", credit: "21.00" }
    ] }
  } });
  await prisma.invoiceDueDate.create({ data: {
    invoiceId: invoice.id, position: 1, dueDate: new Date("2026-07-13T00:00:00.000Z"), amount: "121.00", paymentMethod: "BANK_TRANSFER"
  } });
  const credential = await prisma.verifactuMtlsCredential.create({
    data: { companyId: state.companyId, ref: `vfcred:cycle:${randomUUID()}`, alias: "AEAT cycle fixture" }
  });
  const credentialVersion = await prisma.verifactuMtlsCredentialVersion.create({ data: {
    credentialId: credential.id, version: 1, status: "STAGED", endpointKind: "STANDARD",
    allowTest: true, allowProduction: false, validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validUntil: new Date("2027-01-01T00:00:00.000Z"), materialCiphertext: Buffer.from("encrypted-pfx-fixture"),
    encryptionKeyId: "credential-test-v1", pfxSha256: "7".repeat(64)
  } });
  const sif = await prisma.verifactuSifInstallation.create({
    data: { ...sifInstallationData(state.companyId, `CYCLE-${randomUUID().slice(0, 8)}`), credentialRef: credential.ref }
  });
  const altaCommand = preparedAltaCommand(invoice.id, sif.id, `cycle-alta-${randomUUID()}`);
  const alta = await commitPreparedVerifactuAlta(altaCommand, { id: admin.id });
  if (!alta.ok) throw new Error(alta.error.code);
  await prisma.verifactuOutboxMessage.updateMany({ where: { fiscalRecordId: alta.record.id },
    data: { status: "PROCESSED", processedAt: new Date("2026-07-13T10:01:00.000Z") } });
  await prisma.verifactuSubmissionAttempt.create({ data: {
    fiscalRecordId: alta.record.id, attemptNumber: 1, kind: "SUBMIT", idempotencyKey: `cycle-alta:${randomUUID()}`,
    startedAt: new Date("2026-07-13T10:00:00.000Z"), completedAt: new Date("2026-07-13T10:01:00.000Z"),
    outcome: "ACCEPTED", requestSha256: altaCommand.payloadSha256
  } });
  const cancellation = await commitPreparedVerifactuAnulacion({
    invoiceId: invoice.id, sifInstallationId: sif.id, cancelledRecordId: alta.record.id,
    reasonCode: "ISSUED_BY_MISTAKE", preparationKey: `vf-cycle-cancel:${randomUUID()}`,
    generatedAt: new Date("2026-07-13T10:02:00.000Z"), canonicalizationVersion: "AEAT_HASH_0.1.2",
    expectedPreviousRecordId: alta.record.id, expectedPreviousHash: alta.record.recordHash,
    recordHash: "B".repeat(64), payloadCiphertext: Buffer.from("encrypted-cancellation"),
    payloadSha256: "6".repeat(64), encryptionKeyId: "payload-test-v1"
  }, { id: admin.id }, { correlationId: "cycle-fixture" });
  if (!cancellation.ok) throw new Error(cancellation.error.code);
  await prisma.verifactuOutboxMessage.updateMany({ where: { fiscalRecordId: cancellation.record.id },
    data: { status: "PROCESSED", processedAt: new Date("2026-07-13T10:03:00.000Z") } });
  await prisma.verifactuSubmissionAttempt.create({ data: {
    fiscalRecordId: cancellation.record.id, attemptNumber: 1, kind: "SUBMIT", idempotencyKey: `cycle-cancel:${randomUUID()}`,
    startedAt: new Date("2026-07-13T10:02:00.000Z"), completedAt: new Date("2026-07-13T10:03:00.000Z"),
    outcome: "ACCEPTED", requestSha256: "6".repeat(64)
  } });
  await prisma.invoice.update({ where: { id: invoice.id }, data: { verifactuStatus: "CANCELLED" } });
  return { cancellationId: cancellation.record.id, credentialVersionId: credentialVersion.id, config: {
    invoiceId: invoice.id, expectedInvoiceNumber: invoice.number ?? "", expectedDatabase: "crigestion_ci_test",
    expectedCompanyId: state.companyId, expectedSifInstallationId: sif.id,
    expectedCancellationId: cancellation.record.id, operatorId: "integration.operator", releaseId: "integration-release"
  } };
}

function acceptedCycleResult(fixture: { credentialVersionId: string }): VerifactuTransportResult {
  const cipher = createSecureEnvelopeKeyring({ activeKeyId: "response-test-v1",
    keys: { "response-test-v1": Buffer.alloc(32, 6) }, random: () => Buffer.alloc(12, 5) });
  return { outcome: "ACCEPTED", stableCode: null, aeatCodes: [], requestSha256: "8".repeat(64),
    response: { ciphertext: cipher.encrypt(Buffer.from("plain-soap-secret"), ["cycle-test"]),
      sha256: "9".repeat(64), encryptionKeyId: "response-test-v1" },
    credentialVersionId: fixture.credentialVersionId, endpointKind: "STANDARD" };
}

function cycleDependencies(repository: AeatTestCycleRepository, fixture: { credentialVersionId: string }, requestId: string): {
  repository: AeatTestCycleRepository; transport: VerifactuTransport; newRequestId: () => string;
  now: () => Date; runnerHost: string; applicationVersion: string;
} {
  return { repository, transport: { submit: async () => { throw new Error("NOT_USED"); },
    reconcile: async () => acceptedCycleResult(fixture) }, newRequestId: () => requestId,
    now: () => new Date("2026-07-13T11:00:00.000Z"), runnerHost: "test-runner", applicationVersion: "test-version" };
}

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
  await assertDisposableTestDatabase();
  await prisma.$executeRaw`TRUNCATE TABLE "verifactu_worker_runs", "verifactu_submission_attempts", "verifactu_outbox_messages", "verifactu_fiscal_records", "verifactu_sif_installations", "verifactu_mtls_credential_versions", "verifactu_mtls_credentials" CASCADE`;
  await prisma.$transaction([
    prisma.invoiceVerifactuRecord.deleteMany(),
    prisma.customerRemittanceLine.deleteMany(),

    prisma.customerPaymentReturn.deleteMany(),
    prisma.customerPayment.deleteMany(),
    prisma.accountingJournalLine.deleteMany(),
    prisma.accountingJournalEntry.deleteMany(),
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

function fiscalRecordData(input: {
  companyId: string;
  sifInstallationId: string;
  invoiceId: string;
  idSuffix: string;
  chainPosition: bigint;
  previousRecordId?: string;
  previousHash?: string;
  recordType?: "ALTA" | "ANULACION";
  cancelledRecordId?: string;
}) {
  return {
    companyId: input.companyId,
    sifInstallationId: input.sifInstallationId,
    invoiceId: input.invoiceId,
    recordType: input.recordType ?? "ALTA",
    chainPosition: input.chainPosition,
    previousRecordId: input.previousRecordId,
    cancelledRecordId: input.cancelledRecordId,
    issuerTaxId: "B12345678",
    issuerName: "CriGestion Test SL",
    invoiceSeries: "F",
    invoiceNumber: "F2600001",
    invoiceIssueDate: new Date("2026-07-12T00:00:00.000Z"),
    generatedAt: new Date("2026-07-12T10:00:00.000Z"),
    contractVersion: "VF_V1",
    schemaVersion: "tikeV1.0",
    canonicalizationVersion: "AEAT_HASH_0.1.2",
    previousHash: input.previousHash,
    recordHash: input.idSuffix === "first" ? "b".repeat(64) : input.idSuffix === "second" ? "c".repeat(64) : "f".repeat(64),
    fiscalSnapshot: { fixture: true },
    payloadCiphertext: Buffer.from(`encrypted-${input.idSuffix}`),
    encryptionKeyId: "test-key-v1",
    payloadSha256: input.idSuffix === "first" ? "1".repeat(64) : input.idSuffix === "second" ? "2".repeat(64) : "3".repeat(64),
    preparationKey: `vf-preparation-${input.idSuffix}`
  };
}

function sifInstallationData(companyId: string, installationCode: string) {
  return {
    companyId,
    installationCode,
    environment: "TEST" as const,
    contractVersion: "VF_V1",
    schemaVersion: "tikeV1.0",
    artifactManifestVersion: "AEAT_VERIFACTU_ARTIFACTS_V1",
    artifactManifestSha256: "a".repeat(64),
    producerTaxId: "B12345678",
    producerName: "CriGestion Test SL",
    systemName: "CriGestion",
    systemId: "CG",
    systemVersion: "0.1.0",
    installationNumber: installationCode,
    activatedAt: new Date("2026-07-12T09:00:00.000Z")
  };
}

function issuedInvoiceData(
  companyId: string,
  customer: Awaited<ReturnType<typeof createCustomer>>,
  adminId: string,
  number = "F2600010",
  numberSequence = 10
) {
  return {
    companyId,
    status: "ISSUED" as const,
    verifactuStatus: "PENDING" as const,
    series: "F",
    year: 2026,
    numberSequence,
    number,
    customerId: customer.id,
    customerCodeSnapshot: customer.code,
    customerLegalNameSnapshot: customer.legalName,
    customerTaxIdSnapshot: customer.taxId,
    customerFiscalTreatmentSnapshot: customer.fiscalTreatment,
    customerFiscalAddressSnapshot: { country: "ES" },
    issueDate: new Date("2026-07-12T00:00:00.000Z"),
    operationDate: new Date("2026-07-12T00:00:00.000Z"),
    issuedAt: new Date("2026-07-12T10:00:00.000Z"),
    total: "121.00",
    createdById: adminId,
    issuedById: adminId
  };
}

function preparedAltaCommand(invoiceId: string, sifInstallationId: string, suffix: string) {
  return {
    invoiceId,
    sifInstallationId,
    preparationKey: `vf-preparation-${suffix}`,
    generatedAt: new Date("2026-07-12T10:00:00.000Z"),
    canonicalizationVersion: "AEAT_HASH_0.1.2",
    expectedPreviousRecordId: null,
    expectedPreviousHash: null,
    recordHash: "4".repeat(64),
    payloadCiphertext: Buffer.from(`encrypted-${suffix}`),
    payloadSha256: "5".repeat(64),
    encryptionKeyId: "test-key-v1",
    qrUrl: "https://example.test/qr"
  };
}

async function createWorkerFixture(suffix: string) {
  const admin = await findAdmin();
  const state = await prisma.installation.findFirstOrThrow({ select: { companyId: true } });
  if (!state.companyId) throw new Error("COMPANY_NOT_AVAILABLE");
  const customer = await createCustomer(admin.id);
  const invoice = await prisma.invoice.create({ data: issuedInvoiceData(state.companyId, customer, admin.id) });
  const credential = await prisma.verifactuMtlsCredential.create({
    data: { companyId: state.companyId, ref: `vfcred:worker:${randomUUID()}`, alias: "Worker fixture" }
  });
  const sif = await prisma.verifactuSifInstallation.create({
    data: { ...sifInstallationData(state.companyId, `WORKER-${suffix}`), credentialRef: credential.ref }
  });
  const cipher = createVerifactuPayloadCipher({ keyId: "worker-key", key: Buffer.alloc(32, 4), random: () => Buffer.alloc(12, 5) });
  const plaintext = Buffer.from("<RegistroAlta>fixture</RegistroAlta>", "utf8");
  const payloadSha256 = createHash("sha256").update(plaintext).digest("hex");
  const preparationKey = `vf-worker-${suffix}`;
  const payloadCiphertext = cipher.encrypt(plaintext, {
    companyId: state.companyId,
    sifInstallationId: sif.id,
    invoiceId: invoice.id,
    preparationKey,
    payloadSha256,
    recordType: "ALTA",
    environment: "TEST"
  });
  const committed = await commitPreparedVerifactuAlta({
    invoiceId: invoice.id,
    sifInstallationId: sif.id,
    preparationKey,
    generatedAt: new Date("2026-07-12T10:00:00.000Z"),
    canonicalizationVersion: "AEAT_HASH_0.1.2",
    expectedPreviousRecordId: null,
    expectedPreviousHash: null,
    recordHash: "A".repeat(64),
    payloadCiphertext,
    payloadSha256,
    encryptionKeyId: cipher.keyId,
    qrUrl: "https://example.test/qr"
  }, { id: admin.id });
  if (!committed.ok) throw new Error(committed.error.code);
  return { cipher, companyId: state.companyId, invoiceId: invoice.id, sifInstallationId: sif.id };
}
