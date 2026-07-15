import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { hashIdempotencyPayload } from "@/modules/platform/application/http";

const confirmation = "VOID_AFTER_ACCEPTED_VERIFACTU_CANCELLATION";

export const invoiceTechnicalVoidingSchema = z.object({
  voidDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidDateOnly, "La fecha no es valida."),
  reasonCode: z.literal("ISSUED_BY_MISTAKE"),
  confirmation: z.literal(confirmation)
}).strict();

export type InvoiceTechnicalVoidingCommand = z.infer<typeof invoiceTechnicalVoidingSchema>;

const responseSchema = z.object({
  invoiceId: z.string().uuid(),
  status: z.literal("VOIDED"),
  paymentStatus: z.literal("CANCELLED"),
  cancellationRecordId: z.string().uuid(),
  reversalEntry: z.object({ id: z.string().uuid(), number: z.string() })
}).strict();

type InvoiceTechnicalVoidingResponse = z.infer<typeof responseSchema>;
type VoidingError = {
  ok: false;
  status: 404 | 409;
  error: { code: string; message: string };
};
type VoidingResult =
  | { ok: true; status: 200 | 201; value: InvoiceTechnicalVoidingResponse }
  | VoidingError;

export function hashInvoiceTechnicalVoidingBody(command: InvoiceTechnicalVoidingCommand): string {
  return hashIdempotencyPayload("invoice-technical-voiding:v1", command);
}

export async function readInvoiceTechnicalVoidingReplay(key: string, requestHash: string): Promise<VoidingResult | null> {
  return readReplay(key, requestHash);
}

export async function finalizeInvoiceTechnicalVoiding(input: {
  invoiceId: string;
  command: InvoiceTechnicalVoidingCommand;
  actor: SessionUser;
  idempotencyKey: string;
  requestHash: string;
  correlationId?: RequestContext["correlationId"];
}): Promise<VoidingResult> {
  const replay = await readReplay(input.idempotencyKey, input.requestHash);
  if (replay) {
    if (!replay.ok) await auditDenied(input, replay.error.code);
    return replay;
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey}, 0))`;
    const replayInTransaction = await readReplayInTransaction(tx, input.idempotencyKey, input.requestHash);
    if (replayInTransaction) return replayInTransaction;

    await tx.$queryRaw`SELECT "id" FROM "invoices" WHERE "id" = ${input.invoiceId}::uuid FOR UPDATE`;
    const invoice = await tx.invoice.findUnique({
      where: { id: input.invoiceId },
      select: {
        id: true,
        number: true,
        documentType: true,
        status: true,
        paymentStatus: true,
        verifactuStatus: true,
        issueDate: true,
        accountingEntry: {
          select: {
            id: true,
            number: true,
            origin: true,
            status: true,
            fiscalYearId: true,
            totalDebit: true,
            totalCredit: true,
            fiscalYear: { select: { status: true, startDate: true, endDate: true } },
            lines: { orderBy: { position: "asc" }, select: { accountId: true, concept: true, debit: true, credit: true } }
          }
        },
        voidingAccountingEntry: { select: { id: true } },
        rectificationInvoices: { select: { id: true }, take: 1 },
        dueDates: {
          select: {
            id: true,
            status: true,
            payments: { select: { id: true }, take: 1 },
            paymentReturns: { select: { id: true }, take: 1 },
            remittanceLines: { select: { id: true }, take: 1 }
          }
        },
        payments: { select: { id: true }, take: 1 },
        paymentReturns: { select: { id: true }, take: 1 },
        verifactuFiscalRecords: {
          orderBy: [{ chainPosition: "desc" }, { createdAt: "desc" }],
          take: 1,
          select: {
            id: true,
            recordType: true,
            cancelledRecordId: true,
            fiscalSnapshot: true,
            attempts: { orderBy: { attemptNumber: "desc" }, take: 1, select: { outcome: true } },
            outboxMessages: { select: { status: true } }
          }
        }
      }
    });

    if (!invoice) return error(404, "INVOICE_NOT_FOUND", "La factura no existe.");
    if (invoice.status === "VOIDED" || invoice.voidingAccountingEntry) {
      return error(409, "INVOICE_TECHNICAL_VOIDING_ALREADY_FINALIZED", "La anulacion tecnica ya esta finalizada.");
    }
    if (invoice.documentType !== "STANDARD" || invoice.status !== "ISSUED" || invoice.verifactuStatus !== "CANCELLED") {
      return error(409, "INVOICE_TECHNICAL_VOIDING_NOT_ALLOWED", "Solo se puede finalizar una factura ordinaria emitida cuya anulacion AEAT este aceptada.");
    }
    if (invoice.rectificationInvoices.length > 0) {
      return error(409, "INVOICE_TECHNICAL_VOIDING_HAS_RECTIFICATION", "La factura ya tiene una rectificativa asociada.");
    }

    const cancellation = invoice.verifactuFiscalRecords[0];
    const accepted = cancellation?.attempts[0]?.outcome;
    if (
      !cancellation ||
      cancellation.recordType !== "ANULACION" ||
      !cancellation.cancelledRecordId ||
      (accepted !== "ACCEPTED" && accepted !== "ACCEPTED_WITH_ERRORS") ||
      cancellation.outboxMessages.length === 0 ||
      cancellation.outboxMessages.some((message) => message.status !== "PROCESSED")
    ) {
      return error(409, "INVOICE_TECHNICAL_VOIDING_EVIDENCE_INVALID", "La evidencia terminal de la anulacion AEAT no es valida.");
    }
    const cancellationReason = readCancellationReason(cancellation.fiscalSnapshot)
      ?? (await tx.$queryRaw<Array<{ reasonCode: string | null }>>`
        SELECT "payload"->>'reasonCode' AS "reasonCode"
        FROM "audit_events"
        WHERE "eventType" = 'VERIFACTU_CANCELLATION_PREPARED'
          AND "payload"->>'fiscalRecordId' = ${cancellation.id}
        ORDER BY "createdAt" DESC, "id" DESC
        LIMIT 1
      `)[0]?.reasonCode;
    if (cancellationReason !== "ISSUED_BY_MISTAKE") {
      return error(409, "INVOICE_TECHNICAL_VOIDING_REASON_NOT_ALLOWED", "El motivo fiscal de la anulacion exige una regularizacion distinta de la anulacion tecnica.");
    }
    const cancelledAlta = await tx.verifactuFiscalRecord.findUnique({
      where: { id: cancellation.cancelledRecordId },
      select: { invoiceId: true, recordType: true }
    });
    if (cancelledAlta?.invoiceId !== invoice.id || cancelledAlta.recordType !== "ALTA") {
      return error(409, "INVOICE_TECHNICAL_VOIDING_EVIDENCE_INVALID", "La anulacion AEAT no referencia el alta de esta factura.");
    }

    const hasFinancialActivity = invoice.payments.length > 0 || invoice.paymentReturns.length > 0 ||
      invoice.dueDates.some((dueDate) => dueDate.payments.length > 0 || dueDate.paymentReturns.length > 0 || dueDate.remittanceLines.length > 0);
    if (hasFinancialActivity) {
      return error(409, "INVOICE_TECHNICAL_VOIDING_FINANCIAL_ACTIVITY", "La factura tiene cobros, devoluciones o remesas y debe regularizarse mediante rectificativa.");
    }
    if (invoice.dueDates.some((dueDate) => dueDate.status !== "PENDING")) {
      return error(409, "INVOICE_TECHNICAL_VOIDING_DUE_DATE_STATE", "Los vencimientos ya tienen actividad y no pueden cancelarse tecnicamente.");
    }

    const originalEntry = invoice.accountingEntry;
    if (!originalEntry || originalEntry.origin !== "INVOICE" || originalEntry.status !== "POSTED" || originalEntry.lines.length === 0 ||
      !originalEntry.totalDebit.equals(originalEntry.totalCredit)) {
      return error(409, "INVOICE_TECHNICAL_VOIDING_ACCOUNTING_INVALID", "El asiento original no permite crear un contraasiento seguro.");
    }
    const voidDate = new Date(`${input.command.voidDate}T00:00:00.000Z`);
    if (Number.isNaN(voidDate.getTime()) || voidDate < invoice.issueDate || originalEntry.fiscalYear.status !== "OPEN" ||
      voidDate < originalEntry.fiscalYear.startDate || voidDate > originalEntry.fiscalYear.endDate) {
      return error(409, "INVOICE_TECHNICAL_VOIDING_FISCAL_YEAR_NOT_OPEN", "La fecha debe pertenecer al ejercicio abierto de la factura y no ser anterior a su emision.");
    }

    await tx.$queryRaw`SELECT "id" FROM "accounting_fiscal_years" WHERE "id" = ${originalEntry.fiscalYearId}::uuid FOR UPDATE`;
    const lastEntry = await tx.accountingJournalEntry.findFirst({
      where: { fiscalYearId: originalEntry.fiscalYearId },
      orderBy: { sequence: "desc" },
      select: { sequence: true }
    });
    const sequence = (lastEntry?.sequence ?? 0) + 1;
    const number = `${voidDate.getUTCFullYear()}/${sequence.toString().padStart(6, "0")}`;
    const concept = `Contraasiento anulacion tecnica ${invoice.number ?? invoice.id}`.slice(0, 240);
    const reversal = await tx.accountingJournalEntry.create({
      data: {
        fiscalYearId: originalEntry.fiscalYearId,
        voidsInvoiceId: invoice.id,
        reversesEntryId: originalEntry.id,
        year: voidDate.getUTCFullYear(),
        sequence,
        number,
        accountingDate: voidDate,
        concept,
        origin: "INVOICE_VOIDING",
        totalDebit: originalEntry.totalCredit,
        totalCredit: originalEntry.totalDebit,
        createdById: input.actor.id,
        lines: {
          create: originalEntry.lines.map((line, index) => ({
            accountId: line.accountId,
            position: index + 1,
            concept,
            debit: line.credit,
            credit: line.debit
          }))
        }
      },
      select: { id: true, number: true }
    });

    await tx.invoiceDueDate.updateMany({ where: { invoiceId: invoice.id }, data: { status: "CANCELLED" } });
    await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: "VOIDED", paymentStatus: "CANCELLED", updatedById: input.actor.id }
    });

    const response: InvoiceTechnicalVoidingResponse = {
      invoiceId: invoice.id,
      status: "VOIDED",
      paymentStatus: "CANCELLED",
      cancellationRecordId: cancellation.id,
      reversalEntry: reversal
    };
    await tx.auditEvent.create({
      data: {
        eventType: "INVOICE_TECHNICAL_VOIDING_FINALIZED",
        actorType: "USER",
        payload: {
          actorUserId: input.actor.id,
          invoiceId: invoice.id,
          originalAccountingEntryId: originalEntry.id,
          reversalAccountingEntryId: reversal.id,
          cancellationRecordId: cancellation.id,
          reasonCode: input.command.reasonCode,
          ...(input.correlationId ? { correlationId: input.correlationId } : {})
        }
      }
    });
    await tx.idempotencyRecord.create({
      data: {
        key: input.idempotencyKey,
        requestHash: input.requestHash,
        responseStatus: 201,
        responseBody: response
      }
    });
    return { ok: true, status: 201, value: response } as const;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (!result.ok) await auditDenied(input, result.error.code);
    return result;
  } catch (caught) {
    if (caught instanceof Prisma.PrismaClientKnownRequestError && (caught.code === "P2034" || caught.code === "P2002")) {
      const conflict = error(409, "INVOICE_TECHNICAL_VOIDING_CONFLICT", "La factura cambio durante la regularizacion. Revise su estado y reintente.");
      await auditDenied(input, conflict.error.code);
      return conflict;
    }
    throw caught;
  }
}

async function readReplay(key: string, requestHash: string): Promise<VoidingResult | null> {
  const record = await prisma.idempotencyRecord.findUnique({ where: { key } });
  if (!record) return null;
  return replayResult(record.requestHash, requestHash, record.responseBody);
}

async function readReplayInTransaction(tx: Prisma.TransactionClient, key: string, requestHash: string): Promise<VoidingResult | null> {
  const record = await tx.idempotencyRecord.findUnique({ where: { key } });
  if (!record) return null;
  return replayResult(record.requestHash, requestHash, record.responseBody);
}

function replayResult(storedHash: string, requestHash: string, body: Prisma.JsonValue): VoidingResult {
  if (storedHash !== requestHash) return error(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se uso con otra peticion.");
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) return error(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es valida.");
  return { ok: true, status: 200, value: parsed.data };
}

function error(status: 404 | 409, code: string, message: string): VoidingError {
  return { ok: false, status, error: { code, message } };
}

async function auditDenied(input: {
  invoiceId: string;
  actor: SessionUser;
  correlationId?: RequestContext["correlationId"];
}, stableCode: string): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      eventType: "INVOICE_TECHNICAL_VOIDING_DENIED",
      actorType: "USER",
      payload: {
        actorUserId: input.actor.id,
        invoiceId: input.invoiceId,
        stableCode,
        ...(input.correlationId ? { correlationId: input.correlationId } : {})
      }
    }
  });
}

function isValidDateOnly(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function readCancellationReason(snapshot: Prisma.JsonValue): string | null {
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") return null;
  return typeof snapshot.reasonCode === "string" ? snapshot.reasonCode : null;
}
