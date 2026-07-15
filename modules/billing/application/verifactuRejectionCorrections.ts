import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { VerifactuAltaPreparer } from "@/modules/billing/application/invoices";
import { commitPreparedVerifactuRejectionCorrectionInTransaction } from "@/modules/billing/application/verifactuPersistence";
import { isValidSpanishTaxId, normalizeSpanishTaxId } from "@/modules/customers/application/taxIds";
import type { SessionUser } from "@/modules/platform/application/auth";

export const createVerifactuRejectionCorrectionSchema = z.object({
  expectedRejectedAttemptId: z.string().uuid(),
  recipientName: z.string().trim().min(1).max(120),
  recipientTaxId: z.string().transform(normalizeSpanishTaxId).refine(isValidSpanishTaxId, "El NIF del destinatario no es valido."),
  reasonCode: z.enum(["RECIPIENT_IDENTIFICATION_CORRECTED", "TECHNICAL_DATA_CORRECTED"]),
  rectificationNotRequired: z.literal(true)
}).strict();

const responseSchema = z.object({
  invoiceId: z.string().uuid(),
  rejectedRecordId: z.string().uuid(),
  correctionRecordId: z.string().uuid(),
  chainPosition: z.string().regex(/^\d+$/),
  status: z.literal("PENDING")
}).strict();

type CorrectionResponse = z.infer<typeof responseSchema>;
type CorrectionErrorCode =
  | "VERIFACTU_REJECTION_CORRECTION_NOT_AVAILABLE"
  | "VERIFACTU_REJECTION_CORRECTION_CONFLICT"
  | "VERIFACTU_REJECTION_CORRECTION_PREPARATION_UNAVAILABLE"
  | "IDEMPOTENCY_KEY_REUSED";

export async function createVerifactuRejectionCorrection(input: {
  rejectedRecordId: string;
  command: z.infer<typeof createVerifactuRejectionCorrectionSchema>;
  actor: SessionUser;
  correlationId?: string;
  idempotencyKey: string;
  requestHash: string;
  prepare: VerifactuAltaPreparer;
}): Promise<
  | { ok: true; status: 202; value: CorrectionResponse }
  | { ok: false; status: 404 | 409 | 503; error: { code: CorrectionErrorCode; message: string } }
> {
  const replay = await readReplay(input.idempotencyKey, input.requestHash);
  if (replay) return replay;
  const singleton = await prisma.installation.findUnique({ where: { singletonKey: 1 }, select: { companyId: true } });
  if (!singleton?.companyId) return failure(404, "VERIFACTU_REJECTION_CORRECTION_NOT_AVAILABLE", "El rechazo no admite subsanacion.");

  const target = await prisma.verifactuFiscalRecord.findFirst({
    where: {
      id: input.rejectedRecordId,
      companyId: singleton.companyId,
      recordType: "ALTA",
      correctedRecordId: null,
      correction: null,
      sifInstallation: { status: "ACTIVE" }
    },
    select: {
      id: true,
      invoiceId: true,
      outboxMessages: { where: { operation: "SUBMIT" }, take: 1, select: { status: true } },
      attempts: {
        orderBy: [{ attemptNumber: "desc" }],
        take: 1,
        select: { id: true, outcome: true }
      },
      invoice: {
        select: {
          id: true, companyId: true, documentType: true, status: true, series: true, number: true,
          issueDate: true, operationDate: true, customerCodeSnapshot: true,
          customerLegalNameSnapshot: true, customerTaxIdSnapshot: true,
          customerFiscalTreatmentSnapshot: true, customerFiscalAddressSnapshot: true,
          subtotal: true, discountTotal: true, taxableBase: true, taxAmount: true, total: true,
          company: { select: { legalName: true, taxId: true } },
          lines: { orderBy: { position: "asc" }, select: {
            position: true, description: true, lineTaxableBase: true, lineTaxAmount: true, lineTotal: true
          } },
          taxSummaries: { orderBy: { taxRateCode: "asc" }, select: {
            taxRateCode: true, taxRate: true, taxableBase: true, taxAmount: true, total: true
          } },
          rectifiesInvoice: { select: { number: true, issueDate: true } }
        }
      },
      sifInstallation: { select: {
        id: true, environment: true, contractVersion: true, schemaVersion: true,
        artifactManifestVersion: true, artifactManifestSha256: true, lastRecordId: true, lastRecordHash: true,
        producerTaxId: true, producerName: true, systemName: true, systemId: true,
        systemVersion: true, installationNumber: true
      } }
    }
  });
  const latestAttempt = target?.attempts[0];
  if (!target || target.invoice.status !== "ISSUED"
    || !target.invoice.companyId || !target.invoice.company || !target.invoice.number
    || target.invoice.customerFiscalTreatmentSnapshot !== "DOMESTIC"
    || (target.invoice.documentType === "STANDARD" && target.invoice.rectifiesInvoice !== null)
    || (target.invoice.documentType === "RECTIFICATION" && !target.invoice.rectifiesInvoice?.number)
    || latestAttempt?.outcome !== "REJECTED" || target.outboxMessages[0]?.status !== "PROCESSED") {
    return failure(404, "VERIFACTU_REJECTION_CORRECTION_NOT_AVAILABLE", "No existe un ALTA rechazado y estable que pueda subsanarse.");
  }
  if (latestAttempt.id !== input.command.expectedRejectedAttemptId) {
    return failure(409, "VERIFACTU_REJECTION_CORRECTION_CONFLICT", "El rechazo cambio mientras se preparaba la subsanacion.");
  }
  const previous = target.sifInstallation.lastRecordId
    ? await prisma.verifactuFiscalRecord.findUnique({
        where: { id: target.sifInstallation.lastRecordId },
        select: { invoiceNumber: true, invoiceIssueDate: true }
      })
    : null;
  if (target.sifInstallation.lastRecordId && !previous) {
    return failure(409, "VERIFACTU_REJECTION_CORRECTION_CONFLICT", "La cabeza de la cadena VeriFactu no es coherente.");
  }

  const invoice = target.invoice;
  const company = invoice.company!;
  const companyId = invoice.companyId!;
  const invoiceNumber = invoice.number!;
  const rectifiedInvoice = invoice.documentType === "RECTIFICATION" ? invoice.rectifiesInvoice : null;
  const prepared = input.prepare({
    idempotencyKey: input.idempotencyKey,
    correction: { rejectedRecordId: target.id, subsanacion: "S", rechazoPrevio: "X" },
    invoice: {
      id: invoice.id,
      companyId,
      documentType: invoice.documentType,
      rectification: rectifiedInvoice?.number ? {
        originalInvoiceNumber: rectifiedInvoice.number,
        originalIssueDate: formatDateOnly(rectifiedInvoice.issueDate)
      } : null,
      issuerName: company.legalName,
      issuerTaxId: company.taxId,
      series: invoice.series,
      number: invoiceNumber,
      issueDate: formatDateOnly(invoice.issueDate),
      operationDate: formatDateOnly(invoice.operationDate),
      customerCode: invoice.customerCodeSnapshot,
      customerLegalName: input.command.recipientName,
      customerTaxId: input.command.recipientTaxId,
      customerFiscalTreatment: invoice.customerFiscalTreatmentSnapshot,
      customerFiscalAddress: invoice.customerFiscalAddressSnapshot,
      subtotal: invoice.subtotal.toFixed(2),
      discountTotal: invoice.discountTotal.toFixed(2),
      taxableBase: invoice.taxableBase.toFixed(2),
      taxAmount: invoice.taxAmount.toFixed(2),
      total: invoice.total.toFixed(2),
      lines: invoice.lines.map((line) => ({
        position: line.position,
        description: line.description,
        lineTaxableBase: line.lineTaxableBase.toFixed(2),
        lineTaxAmount: line.lineTaxAmount.toFixed(2),
        lineTotal: line.lineTotal.toFixed(2)
      })),
      taxSummaries: invoice.taxSummaries.map((summary) => ({
        taxRateCode: summary.taxRateCode,
        taxRate: summary.taxRate.toFixed(2),
        taxableBase: summary.taxableBase.toFixed(2),
        taxAmount: summary.taxAmount.toFixed(2),
        total: summary.total.toFixed(2)
      }))
    },
    installation: {
      ...target.sifInstallation,
      nextPosition: 0n,
      previousRecordId: target.sifInstallation.lastRecordId,
      previousRecordHash: target.sifInstallation.lastRecordHash,
      previousInvoiceNumber: previous?.invoiceNumber ?? null,
      previousInvoiceIssueDate: previous ? formatDateOnly(previous.invoiceIssueDate) : null
    }
  });
  if (!prepared.ok) {
    return failure(503, "VERIFACTU_REJECTION_CORRECTION_PREPARATION_UNAVAILABLE", "No se pudo preparar la subsanacion VeriFactu.");
  }

  try {
    const value = await prisma.$transaction(async (tx) => {
      const replayInTransaction = await tx.idempotencyRecord.findUnique({ where: { key: input.idempotencyKey } });
      if (replayInTransaction) {
        if (replayInTransaction.requestHash !== input.requestHash) throw new Error("IDEMPOTENCY_KEY_REUSED");
        return responseSchema.parse(replayInTransaction.responseBody);
      }
      const committed = await commitPreparedVerifactuRejectionCorrectionInTransaction(tx, {
        invoiceId: invoice.id,
        sifInstallationId: target.sifInstallation.id,
        correctedRecordId: target.id,
        reasonCode: input.command.reasonCode,
        preparationKey: prepared.value.preparationKey,
        generatedAt: prepared.value.generatedAt,
        canonicalizationVersion: prepared.value.canonicalizationVersion,
        expectedPreviousRecordId: target.sifInstallation.lastRecordId,
        expectedPreviousHash: target.sifInstallation.lastRecordHash,
        recordHash: prepared.value.recordHash,
        payloadCiphertext: prepared.value.payloadCiphertext,
        payloadSha256: prepared.value.payloadSha256,
        encryptionKeyId: prepared.value.encryptionKeyId,
        qrUrl: prepared.value.qrUrl
      }, input.actor, { correlationId: input.correlationId });
      if (!committed.ok) throw new Error(committed.error.code);
      const response: CorrectionResponse = {
        invoiceId: invoice.id,
        rejectedRecordId: target.id,
        correctionRecordId: committed.record.id,
        chainPosition: committed.record.chainPosition.toString(),
        status: "PENDING"
      };
      await tx.idempotencyRecord.create({ data: {
        key: input.idempotencyKey,
        requestHash: input.requestHash,
        responseStatus: 202,
        responseBody: response
      } });
      return response;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { ok: true, status: 202, value };
  } catch (error) {
    if (error instanceof Error && error.message === "IDEMPOTENCY_KEY_REUSED") {
      return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
    }
    if (error instanceof Error && ["VERIFACTU_CHAIN_ADVANCED", "VERIFACTU_INVOICE_NOT_AVAILABLE", "VERIFACTU_PREPARATION_KEY_REUSED"].includes(error.message)) {
      return failure(409, "VERIFACTU_REJECTION_CORRECTION_CONFLICT", "La cadena o el rechazo cambiaron durante la subsanacion.");
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) {
      const concurrentReplay = await readReplay(input.idempotencyKey, input.requestHash);
      if (concurrentReplay?.ok) return concurrentReplay;
      return failure(409, "VERIFACTU_REJECTION_CORRECTION_CONFLICT", "Otra operacion modifico la cadena VeriFactu.");
    }
    throw error;
  }
}

export function hashVerifactuRejectionCorrectionBody(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readReplay(key: string, requestHash: string) {
  const existing = await prisma.idempotencyRecord.findUnique({ where: { key } });
  if (!existing) return null;
  if (existing.requestHash !== requestHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
  return { ok: true as const, status: 202 as const, value: responseSchema.parse(existing.responseBody) };
}

function failure(status: 404 | 409 | 503, code: CorrectionErrorCode, message: string) {
  return { ok: false as const, status, error: { code, message } };
}

function formatDateOnly(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}
