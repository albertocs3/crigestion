import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type {
  RequestContext,
  SessionUser
} from "@/modules/platform/application/auth";
import { normalizeDateOnlyInput } from "@/modules/billing/application/invoices";

const dateOnlySchema = z.preprocess(
  (value) => (typeof value === "string" ? normalizeDateOnlyInput(value) : value),
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener formato AAAA-MM-DD.")
    .refine(isValidDateOnly, "La fecha no es valida.")
);

export const createCustomerRemittanceDraftSchema = z.object({
  chargeDate: dateOnlySchema,
  concept: z.string().trim().min(2).max(140),
  dueDateIds: z.array(z.string().uuid()).min(1).max(500)
}).strict();

export const listCustomerRemittancesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().uuid().optional(),
  status: z
    .enum([
      "DRAFT",
      "GENERATED",
      "SENT",
      "PROCESSED",
      "PARTIALLY_RETURNED",
      "CLOSED",
      "CANCELLED"
    ])
    .optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional()
});

export const processCustomerRemittanceSchema = z.object({
  paymentDate: dateOnlySchema
}).strict();

export type CreateCustomerRemittanceDraftCommand = z.infer<
  typeof createCustomerRemittanceDraftSchema
>;
export type ListCustomerRemittancesCommand = z.infer<
  typeof listCustomerRemittancesSchema
>;
export type ProcessCustomerRemittanceCommand = z.infer<
  typeof processCustomerRemittanceSchema
>;

export type CustomerRemittanceDto = {
  id: string;
  year: number;
  sequence: number;
  number: string;
  status:
    | "DRAFT"
    | "GENERATED"
    | "SENT"
    | "PROCESSED"
    | "PARTIALLY_RETURNED"
    | "CLOSED"
    | "CANCELLED";
  chargeDate: string;
  concept: string;
  totalAmount: string;
  lineCount: number;
  lines: CustomerRemittanceLineDto[];
};

export type CustomerRemittanceLineDto = {
  id: string;
  position: number;
  dueDateId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  customer: {
    id: string;
    code: string;
    legalName: string;
  };
  dueDate: string;
  amount: string;
  concept: string;
  mandateReference: string;
};

export type CustomerRemittanceList = {
  remittances: CustomerRemittanceDto[];
  nextCursor: string | null;
};

export type CreateCustomerRemittanceDraftResult =
  | { ok: true; status: 201; value: CustomerRemittanceDto }
  | {
      ok: false;
      status: 409;
      error: {
        code:
          | "REMITTANCE_DUE_DATE_NOT_ELIGIBLE"
          | "REMITTANCE_DUE_DATE_ALREADY_INCLUDED";
        message: string;
      };
    };

export type CancelCustomerRemittanceDraftResult =
  | { ok: true; status: 200; value: CustomerRemittanceDto }
  | {
      ok: false;
      status: 404;
      error: {
        code: "REMITTANCE_NOT_FOUND";
        message: string;
      };
    }
  | {
      ok: false;
      status: 409;
      error: {
        code: "REMITTANCE_NOT_CANCELLABLE";
        message: string;
      };
    };

export type ProcessCustomerRemittanceResult =
  | { ok: true; status: 200; value: CustomerRemittanceDto }
  | {
      ok: false;
      status: 404;
      error: {
        code: "REMITTANCE_NOT_FOUND";
        message: string;
      };
    }
  | {
      ok: false;
      status: 409;
      error: {
        code: "REMITTANCE_NOT_PROCESSABLE";
        message: string;
      };
    };

const remittanceSelect = {
  id: true,
  year: true,
  sequence: true,
  number: true,
  status: true,
  chargeDate: true,
  concept: true,
  totalAmount: true,
  lineCount: true,
  lines: {
    orderBy: { position: "asc" },
    select: {
      id: true,
      position: true,
      dueDateId: true,
      invoiceId: true,
      invoiceNumberSnapshot: true,
      customerId: true,
      customerCodeSnapshot: true,
      customerNameSnapshot: true,
      dueDateSnapshot: true,
      amount: true,
      concept: true,
      mandateReference: true
    }
  }
} satisfies Prisma.CustomerRemittanceSelect;

type CustomerRemittanceRecord = Prisma.CustomerRemittanceGetPayload<{
  select: typeof remittanceSelect;
}>;

type EligibleDueDateRecord = Prisma.InvoiceDueDateGetPayload<{
  select: typeof eligibleDueDateSelect;
}>;

const eligibleDueDateSelect = {
  id: true,
  dueDate: true,
  amount: true,
  paymentMethod: true,
  status: true,
  invoice: {
    select: {
      id: true,
      status: true,
      number: true,
      customerId: true,
      customerCodeSnapshot: true,
      customerLegalNameSnapshot: true,
      customer: {
        select: {
          id: true,
          status: true,
          bankIban: true,
          sepaMandates: {
            where: { status: "ACTIVE" },
            orderBy: { signedAt: "desc" },
            take: 1,
            select: {
              id: true,
              reference: true
            }
          }
        }
      }
    }
  },
  payments: {
    select: {
      amount: true,
      returns: {
        select: {
          amount: true
        }
      }
    }
  }
} satisfies Prisma.InvoiceDueDateSelect;

export async function createCustomerRemittanceDraft(
  command: CreateCustomerRemittanceDraftCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CreateCustomerRemittanceDraftResult> {
  const dueDateIds = [...new Set(command.dueDateIds)];
  const result = await prisma.$transaction(async (tx) => {
    const activeLineCount = await tx.customerRemittanceLine.count({
      where: {
        dueDateId: { in: dueDateIds },
        status: "ACTIVE"
      }
    });

    if (activeLineCount > 0) {
      return { kind: "already-included" as const };
    }

    const dueDates = await tx.invoiceDueDate.findMany({
      where: { id: { in: dueDateIds } },
      select: eligibleDueDateSelect
    });

    if (dueDates.length !== dueDateIds.length || dueDates.some(notEligible)) {
      return { kind: "not-eligible" as const };
    }

    const orderedDueDates = dueDateIds.map((id) => {
      const dueDate = dueDates.find((item) => item.id === id);

      if (!dueDate) {
        throw new Error("Selected due date vanished while creating remittance.");
      }

      return dueDate;
    });
    const chargeDate = parseDateOnly(command.chargeDate);
    const year = chargeDate.getUTCFullYear();
    const lastRemittance = await tx.customerRemittance.findFirst({
      where: { year },
      orderBy: { sequence: "desc" },
      select: { sequence: true }
    });
    const sequence = (lastRemittance?.sequence ?? 0) + 1;
    const number = `RC${year}/${sequence.toString().padStart(6, "0")}`;
    const totalAmount = orderedDueDates.reduce(
      (total, dueDate) => total.plus(pendingAmount(dueDate)),
      new Prisma.Decimal(0)
    );
    const remittance = await tx.customerRemittance.create({
      data: {
        year,
        sequence,
        number,
        status: "DRAFT",
        chargeDate,
        concept: command.concept,
        totalAmount,
        lineCount: orderedDueDates.length,
        createdById: actor.id,
        lines: {
          create: orderedDueDates.map((dueDate, index) => {
            const mandate = dueDate.invoice.customer.sepaMandates[0];

            if (!mandate) {
              throw new Error("Eligible due date without active mandate.");
            }

            return {
              invoiceId: dueDate.invoice.id,
              dueDateId: dueDate.id,
              customerId: dueDate.invoice.customerId,
              position: index + 1,
              status: "ACTIVE",
              mandateId: mandate.id,
              mandateReference: mandate.reference,
              customerCodeSnapshot: dueDate.invoice.customerCodeSnapshot,
              customerNameSnapshot: dueDate.invoice.customerLegalNameSnapshot,
              invoiceNumberSnapshot: dueDate.invoice.number,
              dueDateSnapshot: dueDate.dueDate,
              amount: pendingAmount(dueDate),
              concept: lineConcept(command.concept, dueDate)
            };
          })
        }
      },
      select: remittanceSelect
    });

    await tx.auditEvent.create({
      data: {
        eventType: "CUSTOMER_REMITTANCE_DRAFT_CREATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          remittanceId: remittance.id,
          number: remittance.number,
          chargeDate: command.chargeDate,
          lineCount: remittance.lineCount,
          totalAmount: remittance.totalAmount.toFixed(2),
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { kind: "created" as const, remittance };
  });

  if (result.kind === "already-included") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "REMITTANCE_DUE_DATE_ALREADY_INCLUDED",
        message: "Algun vencimiento ya pertenece a una remesa activa."
      }
    };
  }

  if (result.kind === "not-eligible") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "REMITTANCE_DUE_DATE_NOT_ELIGIBLE",
        message: "Solo se pueden remesar vencimientos domiciliados pendientes con mandato activo."
      }
    };
  }

  return { ok: true, status: 201, value: mapRemittance(result.remittance) };
}

export async function listCustomerRemittances(
  command: ListCustomerRemittancesCommand,
  actor: SessionUser
): Promise<CustomerRemittanceList> {
  const records = await prisma.customerRemittance.findMany({
    where: {
      ...(command.status ? { status: command.status } : {}),
      ...(command.year ? { year: command.year } : {})
    },
    orderBy: [{ chargeDate: "desc" }, { sequence: "desc" }],
    cursor: command.cursor ? { id: command.cursor } : undefined,
    skip: command.cursor ? 1 : 0,
    take: command.limit + 1,
    select: remittanceSelect
  });
  const page = records.slice(0, command.limit);

  await prisma.auditEvent.create({
    data: {
      eventType: "CUSTOMER_REMITTANCES_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        status: command.status ?? null,
        year: command.year ?? null,
        limit: command.limit,
        cursor: command.cursor ?? null,
        resultCount: page.length
      }
    }
  });

  return {
    remittances: page.map(mapRemittance),
    nextCursor: records.length > command.limit ? page.at(-1)?.id ?? null : null
  };
}

export async function cancelCustomerRemittanceDraft(
  remittanceId: string,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CancelCustomerRemittanceDraftResult> {
  const result = await prisma.$transaction(async (tx) => {
    const remittance = await tx.customerRemittance.findUnique({
      where: { id: remittanceId },
      select: {
        id: true,
        number: true,
        status: true,
        lineCount: true
      }
    });

    if (!remittance) {
      return { kind: "not-found" as const };
    }

    if (remittance.status !== "DRAFT") {
      return { kind: "not-cancellable" as const };
    }

    await tx.customerRemittanceLine.updateMany({
      where: {
        remittanceId,
        status: "ACTIVE"
      },
      data: {
        status: "CANCELLED"
      }
    });

    const cancelled = await tx.customerRemittance.update({
      where: { id: remittanceId },
      data: {
        status: "CANCELLED",
        updatedById: actor.id
      },
      select: remittanceSelect
    });

    await tx.auditEvent.create({
      data: {
        eventType: "CUSTOMER_REMITTANCE_DRAFT_CANCELLED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          remittanceId,
          number: remittance.number,
          lineCount: remittance.lineCount,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { kind: "cancelled" as const, remittance: cancelled };
  });

  if (result.kind === "not-found") {
    return {
      ok: false,
      status: 404,
      error: {
        code: "REMITTANCE_NOT_FOUND",
        message: "La remesa no existe."
      }
    };
  }

  if (result.kind === "not-cancellable") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "REMITTANCE_NOT_CANCELLABLE",
        message: "Solo se pueden cancelar remesas en borrador."
      }
    };
  }

  return { ok: true, status: 200, value: mapRemittance(result.remittance) };
}

export async function processCustomerRemittance(
  remittanceId: string,
  command: ProcessCustomerRemittanceCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<ProcessCustomerRemittanceResult> {
  const result = await prisma.$transaction(async (tx) => {
    const remittance = await tx.customerRemittance.findUnique({
      where: { id: remittanceId },
      select: {
        id: true,
        number: true,
        status: true,
        totalAmount: true,
        lineCount: true,
        lines: {
          where: { status: "ACTIVE" },
          orderBy: { position: "asc" },
          select: {
            id: true,
            invoiceId: true,
            dueDateId: true,
            customerId: true,
            amount: true,
            dueDate: {
              select: {
                id: true,
                amount: true,
                status: true,
                invoice: {
                  select: {
                    id: true,
                    status: true,
                    total: true
                  }
                }
              }
            }
          }
        }
      }
    });

    if (!remittance) {
      return { kind: "not-found" as const };
    }

    if (remittance.status !== "DRAFT" || remittance.lines.length === 0) {
      return { kind: "not-processable" as const };
    }

    for (const line of remittance.lines) {
      if (
        line.dueDate.status !== "PENDING" ||
        line.dueDate.invoice.status !== "ISSUED"
      ) {
        return { kind: "not-processable" as const };
      }

      const paidAmount = await sumNetPaymentsForDueDate(tx, line.dueDateId);
      const pending = line.dueDate.amount.minus(paidAmount);

      if (line.amount.gt(pending)) {
        return { kind: "not-processable" as const };
      }
    }

    const paymentDate = parseDateOnly(command.paymentDate);

    for (const line of remittance.lines) {
      await tx.customerPayment.create({
        data: {
          invoiceId: line.invoiceId,
          dueDateId: line.dueDateId,
          source: "SEPA_REMITTANCE",
          paymentDate,
          amount: line.amount,
          reference: remittance.number,
          notes: null,
          createdById: actor.id
        }
      });

      const dueDatePaid = await sumNetPaymentsForDueDate(tx, line.dueDateId);
      const dueDateStatus = dueDatePaid.equals(line.dueDate.amount)
        ? "PAID"
        : "PENDING";

      await tx.invoiceDueDate.update({
        where: { id: line.dueDateId },
        data: { status: dueDateStatus }
      });
    }

    const invoiceIds = [...new Set(remittance.lines.map((line) => line.invoiceId))];

    for (const invoiceId of invoiceIds) {
      const invoice = await tx.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        select: { total: true }
      });
      const invoicePaid = await sumNetPaymentsForInvoice(tx, invoiceId);

      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          paymentStatus: invoicePaymentStatus(invoicePaid, invoice.total),
          updatedById: actor.id
        }
      });
    }

    const processed = await tx.customerRemittance.update({
      where: { id: remittanceId },
      data: {
        status: "PROCESSED",
        updatedById: actor.id
      },
      select: remittanceSelect
    });

    await tx.auditEvent.create({
      data: {
        eventType: "CUSTOMER_REMITTANCE_PROCESSED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          remittanceId,
          number: remittance.number,
          paymentDate: command.paymentDate,
          lineCount: remittance.lineCount,
          totalAmount: remittance.totalAmount.toFixed(2),
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { kind: "processed" as const, remittance: processed };
  });

  if (result.kind === "not-found") {
    return {
      ok: false,
      status: 404,
      error: {
        code: "REMITTANCE_NOT_FOUND",
        message: "La remesa no existe."
      }
    };
  }

  if (result.kind === "not-processable") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "REMITTANCE_NOT_PROCESSABLE",
        message: "La remesa no se puede procesar con sus vencimientos actuales."
      }
    };
  }

  return { ok: true, status: 200, value: mapRemittance(result.remittance) };
}

function mapRemittance(record: CustomerRemittanceRecord): CustomerRemittanceDto {
  return {
    id: record.id,
    year: record.year,
    sequence: record.sequence,
    number: record.number,
    status: record.status,
    chargeDate: formatDateOnly(record.chargeDate),
    concept: record.concept,
    totalAmount: record.totalAmount.toFixed(2),
    lineCount: record.lineCount,
    lines: record.lines.map((line) => ({
      id: line.id,
      position: line.position,
      dueDateId: line.dueDateId,
      invoiceId: line.invoiceId,
      invoiceNumber: line.invoiceNumberSnapshot,
      customer: {
        id: line.customerId,
        code: line.customerCodeSnapshot,
        legalName: line.customerNameSnapshot
      },
      dueDate: formatDateOnly(line.dueDateSnapshot),
      amount: line.amount.toFixed(2),
      concept: line.concept,
      mandateReference: line.mandateReference
    }))
  };
}

function notEligible(dueDate: EligibleDueDateRecord): boolean {
  return (
    dueDate.status !== "PENDING" ||
    dueDate.paymentMethod !== "DIRECT_DEBIT" ||
    dueDate.invoice.status !== "ISSUED" ||
    dueDate.invoice.customer.status !== "ACTIVE" ||
    !dueDate.invoice.customer.bankIban ||
    dueDate.invoice.customer.sepaMandates.length === 0 ||
    !pendingAmount(dueDate).gt(0)
  );
}

function pendingAmount(dueDate: EligibleDueDateRecord): Prisma.Decimal {
  const paidAmount = dueDate.payments.reduce(
    (total, payment) => total.plus(payment.amount).minus(sumAmounts(payment.returns)),
    new Prisma.Decimal(0)
  );

  return dueDate.amount.minus(paidAmount);
}

function sumAmounts(items: Array<{ amount: Prisma.Decimal }>): Prisma.Decimal {
  return items.reduce(
    (total, item) => total.plus(item.amount),
    new Prisma.Decimal(0)
  );
}

async function sumNetPaymentsForDueDate(
  tx: Prisma.TransactionClient,
  dueDateId: string
): Promise<Prisma.Decimal> {
  const payments = await tx.customerPayment.findMany({
    where: { dueDateId },
    select: {
      amount: true,
      returns: {
        select: {
          amount: true
        }
      }
    }
  });

  return payments.reduce(
    (total, payment) => total.plus(payment.amount).minus(sumAmounts(payment.returns)),
    new Prisma.Decimal(0)
  );
}

async function sumNetPaymentsForInvoice(
  tx: Prisma.TransactionClient,
  invoiceId: string
): Promise<Prisma.Decimal> {
  const payments = await tx.customerPayment.findMany({
    where: { invoiceId },
    select: {
      amount: true,
      returns: {
        select: {
          amount: true
        }
      }
    }
  });

  return payments.reduce(
    (total, payment) => total.plus(payment.amount).minus(sumAmounts(payment.returns)),
    new Prisma.Decimal(0)
  );
}

function invoicePaymentStatus(
  paidAmount: Prisma.Decimal,
  invoiceTotal: Prisma.Decimal
): "PENDING" | "PARTIALLY_PAID" | "PAID" {
  if (paidAmount.equals(0)) {
    return "PENDING";
  }

  return paidAmount.equals(invoiceTotal) ? "PAID" : "PARTIALLY_PAID";
}

function lineConcept(
  remittanceConcept: string,
  dueDate: EligibleDueDateRecord
): string {
  const invoiceNumber = dueDate.invoice.number ?? "sin numero";

  return `${remittanceConcept} ${invoiceNumber}`.slice(0, 140);
}

function isValidDateOnly(value: string): boolean {
  const date = parseDateOnly(value);

  return !Number.isNaN(date.getTime()) && formatDateOnly(date) === value;
}

function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
