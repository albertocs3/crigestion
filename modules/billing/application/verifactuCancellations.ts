import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { commitPreparedVerifactuAnulacionInTransaction } from "@/modules/billing/application/verifactuPersistence";
import type { VerifactuAnulacionPreparer } from "@/modules/billing/infrastructure/verifactu/aeatAnulacionPreparer";
import type { SessionUser } from "@/modules/platform/application/auth";

export const requestVerifactuCancellationSchema = z.object({
  reasonCode: z.enum(["ISSUED_BY_MISTAKE", "DUPLICATE_INVOICE", "WRONG_FISCAL_IDENTITY"])
}).strict();

const responseSchema = z.object({
  invoiceId: z.string().uuid(),
  cancelledRecordId: z.string().uuid(),
  cancellationRecordId: z.string().uuid(),
  chainPosition: z.string().regex(/^\d+$/),
  status: z.literal("PENDING")
}).strict();

type CancellationResponse = z.infer<typeof responseSchema>;
type CancellationErrorCode =
  | "VERIFACTU_CANCELLATION_NOT_AVAILABLE"
  | "VERIFACTU_CANCELLATION_PREPARATION_UNAVAILABLE"
  | "VERIFACTU_CANCELLATION_CONFLICT"
  | "IDEMPOTENCY_KEY_REUSED";

export async function requestVerifactuCancellation(input: {
  invoiceId: string;
  reasonCode: z.infer<typeof requestVerifactuCancellationSchema>["reasonCode"];
  actor: SessionUser;
  correlationId?: string;
  idempotencyKey: string;
  requestHash: string;
  prepare: VerifactuAnulacionPreparer;
}): Promise<
  | { ok: true; status: 202; value: CancellationResponse }
  | { ok: false; status: 404 | 409 | 503; error: { code: CancellationErrorCode; message: string } }
> {
  const replay = await readIdempotentResponse(input.idempotencyKey, input.requestHash);
  if (replay) return replay;

  const singleton = await prisma.installation.findUnique({ where: { singletonKey: 1 }, select: { companyId: true } });
  if (!singleton?.companyId) return failure(404, "VERIFACTU_CANCELLATION_NOT_AVAILABLE", "No existe un ALTA elegible para anular.");
  const target = await prisma.verifactuFiscalRecord.findFirst({
    where: {
      invoiceId: input.invoiceId,
      companyId: singleton.companyId,
      recordType: "ALTA",
      invoice: { status: "ISSUED" },
      cancellation: null,
      attempts: { some: { outcome: { in: ["ACCEPTED", "ACCEPTED_WITH_ERRORS"] } } },
      sifInstallation: { status: "ACTIVE" }
    },
    select: {
      id: true, companyId: true, invoiceId: true, issuerTaxId: true, issuerName: true, invoiceNumber: true,
      invoiceIssueDate: true, recordHash: true,
      outboxMessages: { select: { status: true } },
      attempts: { orderBy: [{ completedAt: "desc" }, { id: "desc" }], take: 1, select: { outcome: true } },
      sifInstallation: { select: {
        id: true, environment: true, contractVersion: true, schemaVersion: true,
        artifactManifestVersion: true, artifactManifestSha256: true, lastRecordId: true, lastRecordHash: true,
        producerTaxId: true, producerName: true, systemName: true, systemId: true, systemVersion: true, installationNumber: true
      } }
    }
  });
  if (!target
    || !target.attempts[0]
    || !["ACCEPTED", "ACCEPTED_WITH_ERRORS"].includes(target.attempts[0].outcome)
    || target.outboxMessages.some((message) => message.status !== "PROCESSED")) {
    return failure(404, "VERIFACTU_CANCELLATION_NOT_AVAILABLE", "No existe un ALTA aceptado y estable que pueda anularse.");
  }
  const previous = target.sifInstallation.lastRecordId
    ? await prisma.verifactuFiscalRecord.findUnique({
        where: { id: target.sifInstallation.lastRecordId },
        select: { invoiceNumber: true, invoiceIssueDate: true }
      })
    : null;
  if (target.sifInstallation.lastRecordId && !previous) {
    return failure(409, "VERIFACTU_CANCELLATION_CONFLICT", "La cabeza de la cadena VeriFactu no es coherente.");
  }
  const prepared = input.prepare({
    idempotencyKey: input.idempotencyKey,
    target: {
      id: target.id,
      companyId: target.companyId,
      invoiceId: target.invoiceId,
      issuerTaxId: target.issuerTaxId,
      issuerName: target.issuerName,
      invoiceNumber: target.invoiceNumber,
      invoiceIssueDate: formatDateOnly(target.invoiceIssueDate),
      recordHash: target.recordHash
    },
    installation: {
      ...target.sifInstallation,
      previousRecordId: target.sifInstallation.lastRecordId,
      previousRecordHash: target.sifInstallation.lastRecordHash,
      previousInvoiceNumber: previous?.invoiceNumber ?? null,
      previousInvoiceIssueDate: previous ? formatDateOnly(previous.invoiceIssueDate) : null
    }
  });
  if (!prepared.ok) {
    return failure(503, "VERIFACTU_CANCELLATION_PREPARATION_UNAVAILABLE", "No se pudo preparar la anulacion VeriFactu.");
  }

  try {
    const value = await prisma.$transaction(async (tx) => {
      const replayInTransaction = await tx.idempotencyRecord.findUnique({ where: { key: input.idempotencyKey } });
      if (replayInTransaction) {
        if (replayInTransaction.requestHash !== input.requestHash) throw new Error("IDEMPOTENCY_KEY_REUSED");
        return responseSchema.parse(replayInTransaction.responseBody);
      }
      const committed = await commitPreparedVerifactuAnulacionInTransaction(tx, {
        invoiceId: target.invoiceId,
        sifInstallationId: target.sifInstallation.id,
        cancelledRecordId: target.id,
        reasonCode: input.reasonCode,
        preparationKey: prepared.value.preparationKey,
        generatedAt: prepared.value.generatedAt,
        canonicalizationVersion: prepared.value.canonicalizationVersion,
        expectedPreviousRecordId: target.sifInstallation.lastRecordId,
        expectedPreviousHash: target.sifInstallation.lastRecordHash,
        recordHash: prepared.value.recordHash,
        payloadCiphertext: prepared.value.payloadCiphertext,
        payloadSha256: prepared.value.payloadSha256,
        encryptionKeyId: prepared.value.encryptionKeyId
      }, input.actor, { correlationId: input.correlationId });
      if (!committed.ok) throw new Error(committed.error.code);
      const response: CancellationResponse = {
        invoiceId: target.invoiceId,
        cancelledRecordId: target.id,
        cancellationRecordId: committed.record.id,
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
      return failure(409, "VERIFACTU_CANCELLATION_CONFLICT", "La cadena o el ALTA cambiaron durante la anulacion.");
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) {
      const concurrentReplay = await readIdempotentResponse(input.idempotencyKey, input.requestHash);
      if (concurrentReplay?.ok) return concurrentReplay;
      return failure(409, "VERIFACTU_CANCELLATION_CONFLICT", "Otra operacion modifico la cadena VeriFactu.");
    }
    throw error;
  }
}

export function hashVerifactuCancellationBody(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function readVerifactuCancellationReplay(key: string, requestHash: string) {
  return readIdempotentResponse(key, requestHash);
}

async function readIdempotentResponse(key: string, requestHash: string) {
  const existing = await prisma.idempotencyRecord.findUnique({ where: { key } });
  if (!existing) return null;
  if (existing.requestHash !== requestHash) return failure(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
  return { ok: true as const, status: 202 as const, value: responseSchema.parse(existing.responseBody) };
}

function failure(status: 404 | 409 | 503, code: CancellationErrorCode, message: string) {
  return { ok: false as const, status, error: { code, message } };
}

function formatDateOnly(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}
