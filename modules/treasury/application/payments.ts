import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type {
  RequestContext,
  SessionUser
} from "@/modules/platform/application/auth";
import {
  type InvoiceDetail,
  findInvoiceDetailForTreasury,
  mapInvoiceDetailForTreasury,
  normalizeDateOnlyInput
} from "@/modules/billing/application/invoices";

const dateOnlySchema = z.preprocess(
  (value) => (typeof value === "string" ? normalizeDateOnlyInput(value) : value),
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener formato AAAA-MM-DD.")
    .refine(isValidDateOnly, "La fecha no es valida.")
);

const paymentAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, "El importe debe tener hasta dos decimales.")
  .refine((value) => new Prisma.Decimal(value).gt(0), {
    message: "El importe debe ser mayor que cero."
  });

export const registerCustomerPaymentSchema = z.object({
  dueDateId: z.string().uuid(),
  paymentDate: dateOnlySchema,
  amount: paymentAmountSchema,
  reference: z.string().trim().min(1).max(120).nullable().default(null),
  notes: z.string().trim().min(1).max(500).nullable().default(null)
}).strict();

export const registerCustomerPaymentReturnSchema = z.object({
  paymentId: z.string().uuid(),
  returnDate: dateOnlySchema,
  amount: paymentAmountSchema,
  reasonCode: z.string().trim().min(1).max(80).nullable().default(null),
  notes: z.string().trim().min(1).max(500).nullable().default(null)
}).strict();

export const markCustomerDueDateUnpaidSchema = z.object({
  dueDateId: z.string().uuid(),
  unpaidDate: dateOnlySchema,
  reasonCode: z.string().trim().min(1).max(80).nullable().default(null),
  notes: z.string().trim().min(1).max(500).nullable().default(null)
}).strict();

export type RegisterCustomerPaymentCommand = z.infer<
  typeof registerCustomerPaymentSchema
>;
export type RegisterCustomerPaymentReturnCommand = z.infer<
  typeof registerCustomerPaymentReturnSchema
>;
export type MarkCustomerDueDateUnpaidCommand = z.infer<
  typeof markCustomerDueDateUnpaidSchema
>;

type PaymentNotFoundResult = {
  ok: false;
  status: 404;
  error: {
    code: "INVOICE_NOT_FOUND" | "INVOICE_DUE_DATE_NOT_FOUND";
    message: string;
  };
};

type PaymentConflictResult = {
  ok: false;
  status: 409;
  error: {
    code:
      | "INVOICE_NOT_PAYABLE"
      | "INVOICE_DUE_DATE_NOT_PAYABLE"
      | "PAYMENT_AMOUNT_EXCEEDS_PENDING";
    message: string;
  };
};

export type RegisterCustomerPaymentResult =
  | { ok: true; status: 201; value: InvoiceDetail }
  | PaymentNotFoundResult
  | PaymentConflictResult;

type PaymentReturnNotFoundResult = {
  ok: false;
  status: 404;
  error: {
    code: "INVOICE_NOT_FOUND" | "CUSTOMER_PAYMENT_NOT_FOUND";
    message: string;
  };
};

type PaymentReturnConflictResult = {
  ok: false;
  status: 409;
  error: {
    code: "INVOICE_NOT_PAYABLE" | "PAYMENT_RETURN_AMOUNT_EXCEEDS_PAYMENT";
    message: string;
  };
};

export type RegisterCustomerPaymentReturnResult =
  | { ok: true; status: 201; value: InvoiceDetail }
  | PaymentReturnNotFoundResult
  | PaymentReturnConflictResult;

type DueDateUnpaidNotFoundResult = {
  ok: false;
  status: 404;
  error: {
    code: "INVOICE_NOT_FOUND" | "INVOICE_DUE_DATE_NOT_FOUND";
    message: string;
  };
};

type DueDateUnpaidConflictResult = {
  ok: false;
  status: 409;
  error: {
    code: "INVOICE_NOT_PAYABLE" | "INVOICE_DUE_DATE_NOT_UNPAIDABLE";
    message: string;
  };
};

export type MarkCustomerDueDateUnpaidResult =
  | { ok: true; status: 201; value: InvoiceDetail }
  | DueDateUnpaidNotFoundResult
  | DueDateUnpaidConflictResult;

export async function registerCustomerPayment(
  invoiceId: string,
  command: RegisterCustomerPaymentCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<RegisterCustomerPaymentResult> {
  const result = await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        total: true,
        customerId: true,
        number: true
      }
    });

    if (!invoice) {
      return { kind: "invoice-not-found" as const };
    }

    if (invoice.status !== "ISSUED") {
      return { kind: "invoice-not-payable" as const };
    }

    const dueDate = await tx.invoiceDueDate.findFirst({
      where: {
        id: command.dueDateId,
        invoiceId
      },
      select: {
        id: true,
        amount: true,
        status: true
      }
    });

    if (!dueDate) {
      return { kind: "due-date-not-found" as const };
    }

    if (
      dueDate.status === "PAID" ||
      dueDate.status === "RETURNED" ||
      dueDate.status === "UNPAID"
    ) {
      return { kind: "due-date-not-payable" as const };
    }

    const existingPaid = await sumNetPaymentsForDueDate(tx, dueDate.id);
    const paymentAmount = new Prisma.Decimal(command.amount);
    const pendingAmount = dueDate.amount.minus(existingPaid);

    if (paymentAmount.gt(pendingAmount)) {
      return { kind: "amount-exceeds-pending" as const };
    }

    const payment = await tx.customerPayment.create({
      data: {
        invoiceId,
        dueDateId: dueDate.id,
        source: "MANUAL",
        paymentDate: parseDateOnly(command.paymentDate),
        amount: paymentAmount,
        reference: command.reference,
        notes: command.notes,
        createdById: actor.id
      },
      select: { id: true }
    });
    const dueDatePaid = existingPaid.plus(paymentAmount);
    const dueDateStatus = dueDatePaid.equals(dueDate.amount) ? "PAID" : "PENDING";

    await tx.invoiceDueDate.update({
      where: { id: dueDate.id },
      data: { status: dueDateStatus }
    });

    const invoicePaid = await sumNetPaymentsForInvoice(tx, invoiceId);
    const paymentStatus = invoicePaymentStatus(invoicePaid, invoice.total);

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        paymentStatus,
        updatedById: actor.id
      }
    });

    await tx.auditEvent.create({
      data: {
        eventType: "CUSTOMER_PAYMENT_REGISTERED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          paymentId: payment.id,
          invoiceId,
          dueDateId: dueDate.id,
          customerId: invoice.customerId,
          number: invoice.number,
          amount: paymentAmount.toFixed(2),
          paymentDate: command.paymentDate,
          resultingPaymentStatus: paymentStatus,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return {
      kind: "paid" as const,
      invoice: await findInvoiceDetailForTreasury(tx, invoiceId)
    };
  });

  if (result.kind === "invoice-not-found") {
    return {
      ok: false,
      status: 404,
      error: {
        code: "INVOICE_NOT_FOUND",
        message: "La factura no existe."
      }
    };
  }

  if (result.kind === "due-date-not-found") {
    return {
      ok: false,
      status: 404,
      error: {
        code: "INVOICE_DUE_DATE_NOT_FOUND",
        message: "El vencimiento no existe para la factura."
      }
    };
  }

  if (result.kind === "invoice-not-payable") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "INVOICE_NOT_PAYABLE",
        message: "Solo se pueden registrar cobros en facturas emitidas."
      }
    };
  }

  if (result.kind === "due-date-not-payable") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "INVOICE_DUE_DATE_NOT_PAYABLE",
        message: "El vencimiento no admite nuevos cobros."
      }
    };
  }

  if (result.kind === "amount-exceeds-pending") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "PAYMENT_AMOUNT_EXCEEDS_PENDING",
        message: "El importe supera el saldo pendiente del vencimiento."
      }
    };
  }

  return {
    ok: true,
    status: 201,
    value: mapInvoiceDetailForTreasury(result.invoice)
  };
}

export async function registerCustomerPaymentReturn(
  invoiceId: string,
  command: RegisterCustomerPaymentReturnCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<RegisterCustomerPaymentReturnResult> {
  const result = await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        status: true,
        total: true,
        customerId: true,
        number: true
      }
    });

    if (!invoice) {
      return { kind: "invoice-not-found" as const };
    }

    if (invoice.status !== "ISSUED") {
      return { kind: "invoice-not-payable" as const };
    }

    const payment = await tx.customerPayment.findFirst({
      where: {
        id: command.paymentId,
        invoiceId
      },
      select: {
        id: true,
        dueDateId: true,
        source: true,
        amount: true,
        dueDate: {
          select: {
            id: true,
            amount: true
          }
        }
      }
    });

    if (!payment) {
      return { kind: "payment-not-found" as const };
    }

    const alreadyReturned = await sumReturnsForPayment(tx, payment.id);
    const returnAmount = new Prisma.Decimal(command.amount);
    const remainingReturnable = payment.amount.minus(alreadyReturned);

    if (returnAmount.gt(remainingReturnable)) {
      return { kind: "return-exceeds-payment" as const };
    }

    const paymentReturn = await tx.customerPaymentReturn.create({
      data: {
        paymentId: payment.id,
        invoiceId,
        dueDateId: payment.dueDateId,
        returnDate: parseDateOnly(command.returnDate),
        amount: returnAmount,
        reasonCode: command.reasonCode,
        notes: command.notes,
        createdById: actor.id
      },
      select: { id: true }
    });

    const dueDatePaid = await sumNetPaymentsForDueDate(tx, payment.dueDateId);
    const dueDateStatus = dueDatePaymentStatus(dueDatePaid, payment.dueDate.amount);

    await tx.invoiceDueDate.update({
      where: { id: payment.dueDateId },
      data: { status: dueDateStatus }
    });

    const invoicePaid = await sumNetPaymentsForInvoice(tx, invoiceId);
    const paymentStatus = invoicePaymentStatus(invoicePaid, invoice.total);

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        paymentStatus,
        updatedById: actor.id
      }
    });

    const remittanceReturn = await markRemittancePartiallyReturnedForPayment(
      tx,
      payment,
      actor.id
    );

    await tx.auditEvent.create({
      data: {
        eventType: "CUSTOMER_PAYMENT_RETURNED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          paymentReturnId: paymentReturn.id,
          paymentId: payment.id,
          invoiceId,
          dueDateId: payment.dueDateId,
          customerId: invoice.customerId,
          number: invoice.number,
          amount: returnAmount.toFixed(2),
          returnDate: command.returnDate,
          resultingPaymentStatus: paymentStatus,
          ...(remittanceReturn
            ? {
                remittanceId: remittanceReturn.remittanceId,
                remittanceNumber: remittanceReturn.number,
                previousRemittanceStatus: remittanceReturn.previousStatus
              }
            : {}),
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    if (remittanceReturn?.changed) {
      await tx.auditEvent.create({
        data: {
          eventType: "CUSTOMER_REMITTANCE_PARTIALLY_RETURNED",
          actorType: "USER",
          payload: {
            actorUserId: actor.id,
            remittanceId: remittanceReturn.remittanceId,
            number: remittanceReturn.number,
            previousStatus: remittanceReturn.previousStatus,
            paymentReturnId: paymentReturn.id,
            paymentId: payment.id,
            dueDateId: payment.dueDateId,
            amount: returnAmount.toFixed(2),
            returnDate: command.returnDate,
            ...(context.correlationId ? { correlationId: context.correlationId } : {})
          }
        }
      });
    }

    return {
      kind: "returned" as const,
      invoice: await findInvoiceDetailForTreasury(tx, invoiceId)
    };
  });

  if (result.kind === "invoice-not-found") {
    return {
      ok: false,
      status: 404,
      error: {
        code: "INVOICE_NOT_FOUND",
        message: "La factura no existe."
      }
    };
  }

  if (result.kind === "payment-not-found") {
    return {
      ok: false,
      status: 404,
      error: {
        code: "CUSTOMER_PAYMENT_NOT_FOUND",
        message: "El cobro no existe para la factura."
      }
    };
  }

  if (result.kind === "invoice-not-payable") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "INVOICE_NOT_PAYABLE",
        message: "Solo se pueden registrar devoluciones en facturas emitidas."
      }
    };
  }

  if (result.kind === "return-exceeds-payment") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "PAYMENT_RETURN_AMOUNT_EXCEEDS_PAYMENT",
        message: "La devolucion supera el importe no devuelto del cobro."
      }
    };
  }

  return {
    ok: true,
    status: 201,
    value: mapInvoiceDetailForTreasury(result.invoice)
  };
}

export async function markCustomerDueDateUnpaid(
  invoiceId: string,
  command: MarkCustomerDueDateUnpaidCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<MarkCustomerDueDateUnpaidResult> {
  const result = await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        status: true,
        customerId: true,
        number: true
      }
    });

    if (!invoice) {
      return { kind: "invoice-not-found" as const };
    }

    if (invoice.status !== "ISSUED") {
      return { kind: "invoice-not-payable" as const };
    }

    const dueDate = await tx.invoiceDueDate.findFirst({
      where: {
        id: command.dueDateId,
        invoiceId
      },
      select: {
        id: true,
        amount: true,
        status: true
      }
    });

    if (!dueDate) {
      return { kind: "due-date-not-found" as const };
    }

    if (dueDate.status !== "PENDING") {
      return { kind: "due-date-not-unpaidable" as const };
    }

    const paidAmount = await sumNetPaymentsForDueDate(tx, dueDate.id);

    if (paidAmount.gte(dueDate.amount)) {
      return { kind: "due-date-not-unpaidable" as const };
    }

    await tx.invoiceDueDate.update({
      where: { id: dueDate.id },
      data: { status: "UNPAID" }
    });

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        paymentStatus: "UNPAID",
        updatedById: actor.id
      }
    });

    await tx.auditEvent.create({
      data: {
        eventType: "CUSTOMER_DUE_DATE_MARKED_UNPAID",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          invoiceId,
          dueDateId: dueDate.id,
          customerId: invoice.customerId,
          number: invoice.number,
          unpaidDate: command.unpaidDate,
          reasonCode: command.reasonCode,
          pendingAmount: dueDate.amount.minus(paidAmount).toFixed(2),
          resultingPaymentStatus: "UNPAID",
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return {
      kind: "marked-unpaid" as const,
      invoice: await findInvoiceDetailForTreasury(tx, invoiceId)
    };
  });

  if (result.kind === "invoice-not-found") {
    return {
      ok: false,
      status: 404,
      error: {
        code: "INVOICE_NOT_FOUND",
        message: "La factura no existe."
      }
    };
  }

  if (result.kind === "due-date-not-found") {
    return {
      ok: false,
      status: 404,
      error: {
        code: "INVOICE_DUE_DATE_NOT_FOUND",
        message: "El vencimiento no existe para la factura."
      }
    };
  }

  if (result.kind === "invoice-not-payable") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "INVOICE_NOT_PAYABLE",
        message: "Solo se pueden registrar impagos en facturas emitidas."
      }
    };
  }

  if (result.kind === "due-date-not-unpaidable") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "INVOICE_DUE_DATE_NOT_UNPAIDABLE",
        message: "El vencimiento no admite registro de impago."
      }
    };
  }

  return {
    ok: true,
    status: 201,
    value: mapInvoiceDetailForTreasury(result.invoice)
  };
}

async function markRemittancePartiallyReturnedForPayment(
  tx: Prisma.TransactionClient,
  payment: {
    dueDateId: string;
    source: "MANUAL" | "SEPA_REMITTANCE";
  },
  actorUserId: string
): Promise<{
  remittanceId: string;
  number: string;
  previousStatus:
    | "PROCESSED"
    | "PARTIALLY_PROCESSED"
    | "PARTIALLY_RETURNED"
    | "CLOSED";
  changed: boolean;
} | null> {
  if (payment.source !== "SEPA_REMITTANCE") {
    return null;
  }

  const line = await tx.customerRemittanceLine.findFirst({
    where: {
      dueDateId: payment.dueDateId,
      status: "ACTIVE",
      remittance: {
        status: {
          in: ["PROCESSED", "PARTIALLY_PROCESSED", "PARTIALLY_RETURNED", "CLOSED"]
        }
      }
    },
    select: {
      remittance: {
        select: {
          id: true,
          number: true,
          status: true
        }
      }
    }
  });

  if (!line) {
    return null;
  }

  const previousStatus = line.remittance.status;

  if (!isReturnedRemittanceStatus(previousStatus)) {
    return null;
  }

  if (previousStatus !== "PARTIALLY_RETURNED") {
    await tx.customerRemittance.update({
      where: { id: line.remittance.id },
      data: {
        status: "PARTIALLY_RETURNED",
        updatedById: actorUserId
      }
    });
  }

  return {
    remittanceId: line.remittance.id,
    number: line.remittance.number,
    previousStatus,
    changed: previousStatus !== "PARTIALLY_RETURNED"
  };
}

function isReturnedRemittanceStatus(
  status: string
): status is "PROCESSED" | "PARTIALLY_PROCESSED" | "PARTIALLY_RETURNED" | "CLOSED" {
  return (
    status === "PROCESSED" ||
    status === "PARTIALLY_PROCESSED" ||
    status === "PARTIALLY_RETURNED" ||
    status === "CLOSED"
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
    (total, payment) => total.plus(payment.amount).minus(sumReturnAmounts(payment.returns)),
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
    (total, payment) => total.plus(payment.amount).minus(sumReturnAmounts(payment.returns)),
    new Prisma.Decimal(0)
  );
}

async function sumReturnsForPayment(
  tx: Prisma.TransactionClient,
  paymentId: string
): Promise<Prisma.Decimal> {
  const aggregate = await tx.customerPaymentReturn.aggregate({
    where: { paymentId },
    _sum: { amount: true }
  });

  return aggregate._sum.amount ?? new Prisma.Decimal(0);
}

function sumReturnAmounts(
  returns: Array<{ amount: Prisma.Decimal }>
): Prisma.Decimal {
  return returns.reduce(
    (total, paymentReturn) => total.plus(paymentReturn.amount),
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

function dueDatePaymentStatus(
  paidAmount: Prisma.Decimal,
  dueDateAmount: Prisma.Decimal
): "PENDING" | "PAID" | "RETURNED" {
  if (paidAmount.equals(0)) {
    return "RETURNED";
  }

  return paidAmount.equals(dueDateAmount) ? "PAID" : "PENDING";
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
