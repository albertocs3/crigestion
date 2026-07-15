import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";

const sha256Pattern = /^[0-9a-f]{64}$/;
const aeatRecordHashPattern = /^[0-9A-F]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CommitPreparedVerifactuAltaCommand = {
  invoiceId: string;
  sifInstallationId: string;
  preparationKey: string;
  generatedAt: Date;
  canonicalizationVersion: string;
  expectedPreviousRecordId: string | null;
  expectedPreviousHash: string | null;
  recordHash: string;
  payloadCiphertext: Uint8Array;
  payloadSha256: string;
  encryptionKeyId: string;
  qrUrl: string | null;
};

export type CommitPreparedVerifactuAnulacionCommand = Omit<CommitPreparedVerifactuAltaCommand, "qrUrl"> & {
  cancelledRecordId: string;
  reasonCode: "ISSUED_BY_MISTAKE" | "DUPLICATE_INVOICE" | "WRONG_FISCAL_IDENTITY";
};

export type CommitPreparedVerifactuRejectionCorrectionCommand = CommitPreparedVerifactuAltaCommand & {
  correctedRecordId: string;
  reasonCode: "RECIPIENT_IDENTIFICATION_CORRECTED" | "TECHNICAL_DATA_CORRECTED";
};

type CommitPreparedVerifactuAltaErrorCode =
  | "VERIFACTU_PREPARED_RECORD_INVALID"
  | "VERIFACTU_INSTALLATION_NOT_AVAILABLE"
  | "VERIFACTU_INVOICE_NOT_AVAILABLE"
  | "VERIFACTU_CHAIN_ADVANCED"
  | "VERIFACTU_PREPARATION_KEY_REUSED";

export type CommitPreparedVerifactuAltaResult =
  | {
      ok: true;
      replayed: boolean;
      record: { id: string; chainPosition: bigint; recordHash: string };
    }
  | {
      ok: false;
      error: {
        code: CommitPreparedVerifactuAltaErrorCode;
        message: string;
      };
    };

export type CommitPreparedVerifactuAnulacionResult = CommitPreparedVerifactuAltaResult;
export type CommitPreparedVerifactuRejectionCorrectionResult = CommitPreparedVerifactuAltaResult;

type LockedInstallation = {
  id: string;
  companyId: string;
  status: "ACTIVE" | "RETIRED";
  contractVersion: string;
  schemaVersion: string;
  nextPosition: bigint;
  lastRecordId: string | null;
  lastRecordHash: string | null;
};

export async function commitPreparedVerifactuAlta(
  command: CommitPreparedVerifactuAltaCommand,
  actor: Pick<SessionUser, "id">,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CommitPreparedVerifactuAltaResult> {
  const invalid = validatePreparedCommand(command);
  if (invalid) return invalid;

  return prisma.$transaction((tx) => commitPreparedVerifactuAltaInTransaction(tx, command, actor, context));
}

export async function commitPreparedVerifactuAltaInTransaction(
  tx: Prisma.TransactionClient,
  command: CommitPreparedVerifactuAltaCommand,
  actor: Pick<SessionUser, "id">,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CommitPreparedVerifactuAltaResult> {
  const invalid = validatePreparedCommand(command);
  if (invalid) return invalid;

    const installations = await tx.$queryRaw<LockedInstallation[]>(Prisma.sql`
      SELECT
        "id", "companyId", "status", "contractVersion", "schemaVersion",
        "nextPosition", "lastRecordId", "lastRecordHash"
      FROM "verifactu_sif_installations"
      WHERE "id" = ${command.sifInstallationId}::uuid
      FOR UPDATE
    `);
    const installation = installations[0];
    if (!installation) return failure("VERIFACTU_INSTALLATION_NOT_AVAILABLE", "La instalacion SIF no existe.");

    const existing = await tx.verifactuFiscalRecord.findUnique({
      where: { preparationKey: command.preparationKey },
      select: {
        id: true,
        invoiceId: true,
        sifInstallationId: true,
        chainPosition: true,
        recordHash: true,
        payloadSha256: true
      }
    });
    if (existing) {
      if (
        existing.invoiceId !== command.invoiceId
        || existing.sifInstallationId !== command.sifInstallationId
        || existing.recordHash !== command.recordHash
        || existing.payloadSha256 !== command.payloadSha256
      ) {
        return failure("VERIFACTU_PREPARATION_KEY_REUSED", "La clave de preparacion ya se uso con otro contenido.");
      }
      return { ok: true as const, replayed: true, record: pickRecord(existing) };
    }

    if (installation.status !== "ACTIVE") {
      return failure("VERIFACTU_INSTALLATION_NOT_AVAILABLE", "La instalacion SIF no esta activa.");
    }
    if (
      installation.lastRecordId !== command.expectedPreviousRecordId
      || installation.lastRecordHash !== command.expectedPreviousHash
    ) {
      return failure("VERIFACTU_CHAIN_ADVANCED", "La cadena VeriFactu avanzo; el registro debe prepararse de nuevo.");
    }

    const invoice = await tx.invoice.findUnique({
      where: { id: command.invoiceId },
      select: { id: true, companyId: true, status: true, series: true, number: true, issueDate: true, company: { select: { legalName: true, taxId: true } } }
    });
    if (!invoice || !invoice.company || invoice.status !== "ISSUED" || !invoice.number || invoice.companyId !== installation.companyId) {
      return failure("VERIFACTU_INVOICE_NOT_AVAILABLE", "La factura no esta emitida o no pertenece a la empresa del SIF.");
    }

    const record = await tx.verifactuFiscalRecord.create({
      data: {
        companyId: installation.companyId,
        sifInstallationId: installation.id,
        invoiceId: invoice.id,
        recordType: "ALTA",
        chainPosition: installation.nextPosition,
        previousRecordId: installation.lastRecordId,
        issuerTaxId: invoice.company.taxId,
        issuerName: invoice.company.legalName,
        invoiceSeries: invoice.series,
        invoiceNumber: invoice.number,
        invoiceIssueDate: invoice.issueDate,
        generatedAt: command.generatedAt,
        contractVersion: installation.contractVersion,
        schemaVersion: installation.schemaVersion,
        canonicalizationVersion: command.canonicalizationVersion,
        previousHash: installation.lastRecordHash,
        recordHash: command.recordHash,
        fiscalSnapshot: {
          recordType: "ALTA",
          invoiceId: invoice.id,
          contractVersion: installation.contractVersion,
          schemaVersion: installation.schemaVersion,
          payloadSha256: command.payloadSha256
        },
        payloadCiphertext: Buffer.from(command.payloadCiphertext),
        encryptionKeyId: command.encryptionKeyId,
        payloadSha256: command.payloadSha256,
        qrUrl: command.qrUrl,
        preparationKey: command.preparationKey
      },
      select: { id: true, chainPosition: true, recordHash: true }
    });

    await tx.verifactuOutboxMessage.create({
      data: {
        fiscalRecordId: record.id,
        operation: "SUBMIT",
        idempotencyKey: `vf-submit:${record.id}`,
        bodySha256: command.payloadSha256,
        nextAttemptAt: command.generatedAt
      }
    });
    await tx.verifactuSifInstallation.update({
      where: { id: installation.id },
      data: {
        nextPosition: installation.nextPosition + 1n,
        lastRecordId: record.id,
        lastRecordHash: record.recordHash
      }
    });
    await tx.auditEvent.create({
      data: {
        eventType: "VERIFACTU_RECORD_PREPARED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          invoiceId: invoice.id,
          fiscalRecordId: record.id,
          sifInstallationId: installation.id,
          chainPosition: record.chainPosition.toString(),
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { ok: true as const, replayed: false, record };
}

export async function commitPreparedVerifactuAnulacion(
  command: CommitPreparedVerifactuAnulacionCommand,
  actor: Pick<SessionUser, "id">,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CommitPreparedVerifactuAnulacionResult> {
  const invalid = validatePreparedAnulacionCommand(command);
  if (invalid) return invalid;
  return prisma.$transaction((tx) => commitPreparedVerifactuAnulacionInTransaction(tx, command, actor, context));
}

export async function commitPreparedVerifactuRejectionCorrectionInTransaction(
  tx: Prisma.TransactionClient,
  command: CommitPreparedVerifactuRejectionCorrectionCommand,
  actor: Pick<SessionUser, "id">,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CommitPreparedVerifactuRejectionCorrectionResult> {
  const invalid = validatePreparedCommand(command);
  if (invalid || !uuidPattern.test(command.correctedRecordId)) {
    return failure("VERIFACTU_PREPARED_RECORD_INVALID", "El registro VeriFactu preparado no es valido.");
  }

  const installations = await tx.$queryRaw<LockedInstallation[]>(Prisma.sql`
    SELECT "id", "companyId", "status", "contractVersion", "schemaVersion",
      "nextPosition", "lastRecordId", "lastRecordHash"
    FROM "verifactu_sif_installations"
    WHERE "id" = ${command.sifInstallationId}::uuid
    FOR UPDATE
  `);
  const installation = installations[0];
  if (!installation || installation.status !== "ACTIVE") {
    return failure("VERIFACTU_INSTALLATION_NOT_AVAILABLE", "La instalacion SIF no esta activa.");
  }

  const existing = await tx.verifactuFiscalRecord.findUnique({
    where: { preparationKey: command.preparationKey },
    select: {
      id: true, invoiceId: true, sifInstallationId: true, correctedRecordId: true,
      chainPosition: true, recordHash: true, payloadSha256: true
    }
  });
  if (existing) {
    if (existing.invoiceId !== command.invoiceId
      || existing.sifInstallationId !== command.sifInstallationId
      || existing.correctedRecordId !== command.correctedRecordId
      || existing.recordHash !== command.recordHash
      || existing.payloadSha256 !== command.payloadSha256) {
      return failure("VERIFACTU_PREPARATION_KEY_REUSED", "La clave de preparacion ya se uso con otro contenido.");
    }
    return { ok: true, replayed: true, record: pickRecord(existing) };
  }
  if (installation.lastRecordId !== command.expectedPreviousRecordId
    || installation.lastRecordHash !== command.expectedPreviousHash) {
    return failure("VERIFACTU_CHAIN_ADVANCED", "La cadena VeriFactu avanzo; el registro debe prepararse de nuevo.");
  }

  const target = await tx.verifactuFiscalRecord.findFirst({
    where: {
      id: command.correctedRecordId,
      companyId: installation.companyId,
      sifInstallationId: installation.id,
      invoiceId: command.invoiceId,
      recordType: "ALTA",
      correctedRecordId: null,
      correction: null
    },
    select: {
      id: true, companyId: true, sifInstallationId: true, invoiceId: true,
      issuerTaxId: true, issuerName: true, invoiceSeries: true, invoiceNumber: true,
      invoiceIssueDate: true,
      attempts: { orderBy: [{ attemptNumber: "desc" }], take: 1, select: { outcome: true } },
      outboxMessages: { where: { operation: "SUBMIT" }, take: 1, select: { status: true } }
    }
  });
  if (!target || target.attempts[0]?.outcome !== "REJECTED" || target.outboxMessages[0]?.status !== "PROCESSED") {
    return failure("VERIFACTU_INVOICE_NOT_AVAILABLE", "El ALTA no tiene un rechazo terminal elegible para subsanar.");
  }

  const record = await tx.verifactuFiscalRecord.create({
    data: {
      companyId: target.companyId,
      sifInstallationId: target.sifInstallationId,
      invoiceId: target.invoiceId,
      recordType: "ALTA",
      chainPosition: installation.nextPosition,
      previousRecordId: installation.lastRecordId,
      correctedRecordId: target.id,
      issuerTaxId: target.issuerTaxId,
      issuerName: target.issuerName,
      invoiceSeries: target.invoiceSeries,
      invoiceNumber: target.invoiceNumber,
      invoiceIssueDate: target.invoiceIssueDate,
      generatedAt: command.generatedAt,
      contractVersion: installation.contractVersion,
      schemaVersion: installation.schemaVersion,
      canonicalizationVersion: command.canonicalizationVersion,
      previousHash: installation.lastRecordHash,
      recordHash: command.recordHash,
      fiscalSnapshot: {
        recordType: "ALTA",
        correctionKind: "REJECTION",
        correctedRecordId: target.id,
        subsanacion: "S",
        rechazoPrevio: "X",
        reasonCode: command.reasonCode,
        contractVersion: installation.contractVersion,
        schemaVersion: installation.schemaVersion,
        payloadSha256: command.payloadSha256
      },
      payloadCiphertext: Buffer.from(command.payloadCiphertext),
      encryptionKeyId: command.encryptionKeyId,
      payloadSha256: command.payloadSha256,
      qrUrl: command.qrUrl,
      preparationKey: command.preparationKey
    },
    select: { id: true, chainPosition: true, recordHash: true }
  });
  await tx.verifactuOutboxMessage.create({
    data: {
      fiscalRecordId: record.id,
      operation: "SUBMIT",
      idempotencyKey: `vf-submit:${record.id}`,
      bodySha256: command.payloadSha256,
      nextAttemptAt: command.generatedAt
    }
  });
  await tx.verifactuSifInstallation.update({
    where: { id: installation.id },
    data: { nextPosition: installation.nextPosition + 1n, lastRecordId: record.id, lastRecordHash: record.recordHash }
  });
  await tx.invoice.update({ where: { id: target.invoiceId }, data: { verifactuStatus: "PENDING" } });
  await tx.auditEvent.create({
    data: {
      eventType: "VERIFACTU_REJECTION_CORRECTION_PREPARED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        invoiceId: target.invoiceId,
        rejectedRecordId: target.id,
        fiscalRecordId: record.id,
        sifInstallationId: installation.id,
        chainPosition: record.chainPosition.toString(),
        reasonCode: command.reasonCode,
        ...(context.correlationId ? { correlationId: context.correlationId } : {})
      }
    }
  });
  return { ok: true, replayed: false, record };
}

export async function commitPreparedVerifactuAnulacionInTransaction(
  tx: Prisma.TransactionClient,
  command: CommitPreparedVerifactuAnulacionCommand,
  actor: Pick<SessionUser, "id">,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CommitPreparedVerifactuAnulacionResult> {
  const invalid = validatePreparedAnulacionCommand(command);
  if (invalid) return invalid;

  const installations = await tx.$queryRaw<LockedInstallation[]>(Prisma.sql`
    SELECT
      "id", "companyId", "status", "contractVersion", "schemaVersion",
      "nextPosition", "lastRecordId", "lastRecordHash"
    FROM "verifactu_sif_installations"
    WHERE "id" = ${command.sifInstallationId}::uuid
    FOR UPDATE
  `);
  const installation = installations[0];
  if (!installation) return failure("VERIFACTU_INSTALLATION_NOT_AVAILABLE", "La instalacion SIF no existe.");

  const existing = await tx.verifactuFiscalRecord.findUnique({
    where: { preparationKey: command.preparationKey },
    select: {
      id: true, invoiceId: true, sifInstallationId: true, recordType: true, cancelledRecordId: true,
      chainPosition: true, recordHash: true, payloadSha256: true
    }
  });
  if (existing) {
    if (existing.recordType !== "ANULACION"
      || existing.cancelledRecordId !== command.cancelledRecordId
      || existing.invoiceId !== command.invoiceId
      || existing.sifInstallationId !== command.sifInstallationId
      || existing.recordHash !== command.recordHash
      || existing.payloadSha256 !== command.payloadSha256) {
      return failure("VERIFACTU_PREPARATION_KEY_REUSED", "La clave de preparacion ya se uso con otro contenido.");
    }
    return { ok: true, replayed: true, record: pickRecord(existing) };
  }
  if (installation.status !== "ACTIVE") {
    return failure("VERIFACTU_INSTALLATION_NOT_AVAILABLE", "La instalacion SIF no esta activa.");
  }
  if (installation.lastRecordId !== command.expectedPreviousRecordId || installation.lastRecordHash !== command.expectedPreviousHash) {
    return failure("VERIFACTU_CHAIN_ADVANCED", "La cadena VeriFactu avanzo; el registro debe prepararse de nuevo.");
  }

  const target = await tx.verifactuFiscalRecord.findFirst({
    where: {
      id: command.cancelledRecordId,
      invoiceId: command.invoiceId,
      sifInstallationId: installation.id,
      companyId: installation.companyId,
      recordType: "ALTA"
    },
    select: {
      id: true, companyId: true, sifInstallationId: true, invoiceId: true, issuerTaxId: true, issuerName: true,
      invoiceSeries: true, invoiceNumber: true, invoiceIssueDate: true, recordHash: true,
      cancellation: { select: { id: true } },
      attempts: {
        where: { outcome: { in: ["ACCEPTED", "ACCEPTED_WITH_ERRORS"] } },
        take: 1,
        select: { id: true }
      }
    }
  });
  if (!target || target.attempts.length === 0) {
    return failure("VERIFACTU_INVOICE_NOT_AVAILABLE", "El ALTA no existe, no pertenece a la instalacion o no fue aceptado por AEAT.");
  }
  if (target.cancellation) {
    return failure("VERIFACTU_INVOICE_NOT_AVAILABLE", "El ALTA ya tiene un registro de anulacion.");
  }

  const record = await tx.verifactuFiscalRecord.create({
    data: {
      companyId: target.companyId,
      sifInstallationId: target.sifInstallationId,
      invoiceId: target.invoiceId,
      recordType: "ANULACION",
      chainPosition: installation.nextPosition,
      previousRecordId: installation.lastRecordId,
      cancelledRecordId: target.id,
      issuerTaxId: target.issuerTaxId,
      issuerName: target.issuerName,
      invoiceSeries: target.invoiceSeries,
      invoiceNumber: target.invoiceNumber,
      invoiceIssueDate: target.invoiceIssueDate,
      generatedAt: command.generatedAt,
      contractVersion: installation.contractVersion,
      schemaVersion: installation.schemaVersion,
      canonicalizationVersion: command.canonicalizationVersion,
      previousHash: installation.lastRecordHash,
      recordHash: command.recordHash,
      fiscalSnapshot: {
        recordType: "ANULACION",
        reasonCode: command.reasonCode,
        cancelledRecordId: target.id,
        cancelledRecordHash: target.recordHash,
        contractVersion: installation.contractVersion,
        schemaVersion: installation.schemaVersion,
        payloadSha256: command.payloadSha256
      },
      payloadCiphertext: Buffer.from(command.payloadCiphertext),
      encryptionKeyId: command.encryptionKeyId,
      payloadSha256: command.payloadSha256,
      qrUrl: null,
      preparationKey: command.preparationKey
    },
    select: { id: true, chainPosition: true, recordHash: true }
  });
  await tx.verifactuOutboxMessage.create({
    data: {
      fiscalRecordId: record.id,
      operation: "SUBMIT",
      idempotencyKey: `vf-submit:${record.id}`,
      bodySha256: command.payloadSha256,
      nextAttemptAt: command.generatedAt
    }
  });
  await tx.verifactuSifInstallation.update({
    where: { id: installation.id },
    data: { nextPosition: installation.nextPosition + 1n, lastRecordId: record.id, lastRecordHash: record.recordHash }
  });
  await tx.invoice.update({ where: { id: target.invoiceId }, data: { verifactuStatus: "PENDING" } });
  await tx.auditEvent.create({
    data: {
      eventType: "VERIFACTU_CANCELLATION_PREPARED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        invoiceId: target.invoiceId,
        cancelledRecordId: target.id,
        fiscalRecordId: record.id,
        sifInstallationId: installation.id,
        chainPosition: record.chainPosition.toString(),
        reasonCode: command.reasonCode,
        ...(context.correlationId ? { correlationId: context.correlationId } : {})
      }
    }
  });
  return { ok: true, replayed: false, record };
}

function validatePreparedCommand(command: CommitPreparedVerifactuAltaCommand): CommitPreparedVerifactuAltaResult | null {
  const valid = command.preparationKey.length > 0
    && command.preparationKey.length <= 160
    && command.canonicalizationVersion.length > 0
    && command.canonicalizationVersion.length <= 32
    && command.encryptionKeyId.length > 0
    && command.encryptionKeyId.length <= 120
    && command.payloadCiphertext.byteLength > 0
    && uuidPattern.test(command.invoiceId)
    && uuidPattern.test(command.sifInstallationId)
    && (command.expectedPreviousRecordId === null || uuidPattern.test(command.expectedPreviousRecordId))
    && !Number.isNaN(command.generatedAt.getTime())
    && (command.qrUrl === null || command.qrUrl.length <= 2048)
    && aeatRecordHashPattern.test(command.recordHash)
    && sha256Pattern.test(command.payloadSha256)
    && (command.expectedPreviousHash === null || aeatRecordHashPattern.test(command.expectedPreviousHash));
  return valid ? null : failure("VERIFACTU_PREPARED_RECORD_INVALID", "El registro VeriFactu preparado no es valido.");
}

function validatePreparedAnulacionCommand(command: CommitPreparedVerifactuAnulacionCommand): CommitPreparedVerifactuAnulacionResult | null {
  const base = validatePreparedCommand({ ...command, qrUrl: null });
  return base || !uuidPattern.test(command.cancelledRecordId)
    ? failure("VERIFACTU_PREPARED_RECORD_INVALID", "El registro VeriFactu preparado no es valido.")
    : null;
}

function pickRecord(record: { id: string; chainPosition: bigint; recordHash: string }) {
  return { id: record.id, chainPosition: record.chainPosition, recordHash: record.recordHash };
}

function failure(code: CommitPreparedVerifactuAltaErrorCode, message: string): CommitPreparedVerifactuAltaResult {
  return { ok: false, error: { code, message } };
}
