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

export type RegisterCustomerPaymentCommand = z.infer<
  typeof registerCustomerPaymentSchema
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

    if (dueDate.status === "PAID" || dueDate.status === "RETURNED") {
      return { kind: "due-date-not-payable" as const };
    }

    const existingPaid = await sumPaymentsForDueDate(tx, dueDate.id);
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

    const invoicePaid = await sumPaymentsForInvoice(tx, invoiceId);
    const paymentStatus = invoicePaid.equals(0)
      ? "PENDING"
      : invoicePaid.equals(invoice.total)
        ? "PAID"
        : "PARTIALLY_PAID";

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

async function sumPaymentsForDueDate(
  tx: Prisma.TransactionClient,
  dueDateId: string
): Promise<Prisma.Decimal> {
  const aggregate = await tx.customerPayment.aggregate({
    where: { dueDateId },
    _sum: { amount: true }
  });

  return aggregate._sum.amount ?? new Prisma.Decimal(0);
}

async function sumPaymentsForInvoice(
  tx: Prisma.TransactionClient,
  invoiceId: string
): Promise<Prisma.Decimal> {
  const aggregate = await tx.customerPayment.aggregate({
    where: { invoiceId },
    _sum: { amount: true }
  });

  return aggregate._sum.amount ?? new Prisma.Decimal(0);
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
