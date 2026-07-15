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
      | "PAYMENT_AMOUNT_EXCEEDS_PENDING"
      | "PAYMENT_ACCOUNTING_FISCAL_YEAR_NOT_OPEN"
      | "PAYMENT_ACCOUNTING_ACCOUNT_NOT_AVAILABLE";
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
    code:
      | "INVOICE_NOT_PAYABLE"
      | "PAYMENT_RETURN_AMOUNT_EXCEEDS_PAYMENT"
      | "PAYMENT_RETURN_DATE_BEFORE_PAYMENT"
      | "PAYMENT_RETURN_ACCOUNTING_FISCAL_YEAR_NOT_OPEN"
      | "PAYMENT_RETURN_ACCOUNTING_ACCOUNT_NOT_AVAILABLE"
      | "PAYMENT_RETURN_RECONCILIATION_CONFLICT";
    message: string;
  };
};

export type RegisterCustomerPaymentReturnResult =
  | { ok: true; status: 201; value: InvoiceDetail }
  | { ok: false; status: 409; error: { code: "IDEMPOTENCY_KEY_REUSED"; message: string } }
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

export class CustomerPaymentAccountingUnavailableError extends Error {
  constructor(
    readonly reason: "FISCAL_YEAR_NOT_OPEN" | "ACCOUNT_NOT_AVAILABLE"
  ) {
    super(
      reason === "FISCAL_YEAR_NOT_OPEN"
        ? "No hay un unico ejercicio contable abierto para registrar el cobro."
        : "No hay cuentas contables disponibles para registrar el cobro."
    );
    this.name = "CustomerPaymentAccountingUnavailableError";
  }
}

type PaymentReturnMutationContext = Pick<RequestContext, "correlationId"> & {
  idempotencyKey?: string;
  requestHash?: string;
};

export type CreateAccountedCustomerPaymentInput = {
  invoiceId: string;
  invoiceNumber: string | null;
  customerCode: string;
  customerName: string;
  dueDateId: string;
  paymentMethod: "BANK_TRANSFER" | "CASH" | "DIRECT_DEBIT";
  source: "MANUAL" | "SEPA_REMITTANCE";
  paymentDate: Date;
  amount: Prisma.Decimal;
  reference: string | null;
  notes: string | null;
  actorId: string;
};

export async function createAccountedCustomerPayment(
  tx: Prisma.TransactionClient,
  input: CreateAccountedCustomerPaymentInput
): Promise<{ paymentId: string; accountingEntryId: string; accountingEntryNumber: string }> {
  const installation = await tx.installation.findFirst({
    where: { companyId: { not: null } },
    select: { companyId: true }
  });
  const fiscalYears = installation?.companyId
    ? await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT "id" FROM "accounting_fiscal_years" WHERE "companyId" = ${installation.companyId}::uuid AND "status" = 'OPEN' AND "startDate" <= ${input.paymentDate} AND "endDate" >= ${input.paymentDate} FOR UPDATE`
      )
    : [];
  const fiscalYear = fiscalYears.length === 1 ? fiscalYears[0] : undefined;

  if (!fiscalYear) {
    throw new CustomerPaymentAccountingUnavailableError("FISCAL_YEAR_NOT_OPEN");
  }
  if (!/^\d{1,6}$/.test(input.customerCode)) {
    throw new CustomerPaymentAccountingUnavailableError("ACCOUNT_NOT_AVAILABLE");
  }

  const customerAccountCode = `430${input.customerCode.padStart(6, "0")}`;
  const treasuryAccountCode = input.paymentMethod === "CASH" ? "570000000" : "572000000";
  const accounts = await tx.accountingAccount.findMany({
    where: {
      fiscalYearId: fiscalYear.id,
      code: { in: [customerAccountCode, treasuryAccountCode] },
      status: "ACTIVE",
      isPostable: true
    },
    select: { id: true, code: true }
  });

  if (accounts.length !== 2) {
    throw new CustomerPaymentAccountingUnavailableError("ACCOUNT_NOT_AVAILABLE");
  }

  const accountByCode = new Map(accounts.map((account) => [account.code, account.id]));
  const payment = await tx.customerPayment.create({
    data: {
      invoiceId: input.invoiceId,
      dueDateId: input.dueDateId,
      source: input.source,
      paymentDate: input.paymentDate,
      amount: input.amount,
      reference: input.reference,
      notes: input.notes,
      createdById: input.actorId
    },
    select: { id: true }
  });
  const lastEntry = await tx.accountingJournalEntry.findFirst({
    where: { fiscalYearId: fiscalYear.id },
    orderBy: { sequence: "desc" },
    select: { sequence: true }
  });
  const sequence = (lastEntry?.sequence ?? 0) + 1;
  const year = input.paymentDate.getUTCFullYear();
  const concept = `Cobro factura ${input.invoiceNumber ?? input.invoiceId} - ${input.customerName}`.slice(0, 240);
  const entry = await tx.accountingJournalEntry.create({
    data: {
      fiscalYearId: fiscalYear.id,
      customerPaymentId: payment.id,
      year,
      sequence,
      number: `${year}/${sequence.toString().padStart(6, "0")}`,
      accountingDate: input.paymentDate,
      concept,
      origin: "CUSTOMER_PAYMENT",
      totalDebit: input.amount,
      totalCredit: input.amount,
      createdById: input.actorId,
      lines: {
        create: [
          { accountId: accountByCode.get(treasuryAccountCode)!, position: 1, concept, debit: input.amount, credit: new Prisma.Decimal(0) },
          { accountId: accountByCode.get(customerAccountCode)!, position: 2, concept, debit: new Prisma.Decimal(0), credit: input.amount }
        ]
      }
    },
    select: { id: true, number: true }
  });

  return {
    paymentId: payment.id,
    accountingEntryId: entry.id,
    accountingEntryNumber: entry.number
  };
}

export async function registerCustomerPayment(
  invoiceId: string,
  command: RegisterCustomerPaymentCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<RegisterCustomerPaymentResult> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "invoices" WHERE "id" = ${invoiceId}::uuid FOR UPDATE`
    );
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        total: true,
        customerId: true,
        customerCodeSnapshot: true,
        customerLegalNameSnapshot: true,
        number: true
      }
    });

    if (!invoice) {
      return { kind: "invoice-not-found" as const };
    }

    if (invoice.status !== "ISSUED") {
      return { kind: "invoice-not-payable" as const };
    }

    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "invoice_due_dates" WHERE "id" = ${command.dueDateId}::uuid AND "invoiceId" = ${invoiceId}::uuid FOR UPDATE`
    );

    const dueDate = await tx.invoiceDueDate.findFirst({
      where: {
        id: command.dueDateId,
        invoiceId
      },
      select: {
        id: true,
        amount: true,
        status: true,
        paymentMethod: true
      }
    });

    if (!dueDate) {
      return { kind: "due-date-not-found" as const };
    }

    if (dueDate.status !== "PENDING") {
      return { kind: "due-date-not-payable" as const };
    }

    const existingPaid = await sumNetPaymentsForDueDate(tx, dueDate.id);
    const existingCredit = await sumCreditApplicationsForDueDate(tx, dueDate.id);
    const paymentAmount = new Prisma.Decimal(command.amount);
    const pendingAmount = dueDate.amount.minus(existingPaid).minus(existingCredit);

    if (paymentAmount.gt(pendingAmount)) {
      return { kind: "amount-exceeds-pending" as const };
    }

    const paymentDate = parseDateOnly(command.paymentDate);
    const installation = await tx.installation.findFirst({
      where: { companyId: { not: null } },
      select: { companyId: true }
    });
    const fiscalYears = installation?.companyId
      ? await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT "id" FROM "accounting_fiscal_years" WHERE "companyId" = ${installation.companyId}::uuid AND "status" = 'OPEN' AND "startDate" <= ${paymentDate} AND "endDate" >= ${paymentDate} FOR UPDATE`
        )
      : [];
    const fiscalYear = fiscalYears.length === 1 ? fiscalYears[0] : undefined;
    if (!fiscalYear) {
      return { kind: "accounting-fiscal-year-not-open" as const };
    }
    if (!/^\d{1,6}$/.test(invoice.customerCodeSnapshot)) {
      return { kind: "accounting-account-not-available" as const };
    }
    const customerAccountCode = `430${invoice.customerCodeSnapshot.padStart(6, "0")}`;
    const treasuryAccountCode = dueDate.paymentMethod === "CASH" ? "570000000" : "572000000";
    const accounts = await tx.accountingAccount.findMany({
      where: {
        fiscalYearId: fiscalYear.id,
        code: { in: [customerAccountCode, treasuryAccountCode] },
        status: "ACTIVE",
        isPostable: true
      },
      select: { id: true, code: true }
    });
    if (accounts.length !== 2) {
      return { kind: "accounting-account-not-available" as const };
    }
    const accountByCode = new Map(accounts.map((account) => [account.code, account.id]));

    const payment = await tx.customerPayment.create({
      data: {
        invoiceId,
        dueDateId: dueDate.id,
        source: "MANUAL",
        paymentDate,
        amount: paymentAmount,
        reference: command.reference,
        notes: command.notes,
        createdById: actor.id
      },
      select: { id: true }
    });
    const lastEntry = await tx.accountingJournalEntry.findFirst({
      where: { fiscalYearId: fiscalYear.id },
      orderBy: { sequence: "desc" },
      select: { sequence: true }
    });
    const journalSequence = (lastEntry?.sequence ?? 0) + 1;
    const journalNumber = `${paymentDate.getUTCFullYear()}/${journalSequence.toString().padStart(6, "0")}`;
    const journalConcept = `Cobro factura ${invoice.number ?? invoice.id} - ${invoice.customerLegalNameSnapshot}`.slice(0, 240);
    const accountingEntry = await tx.accountingJournalEntry.create({
      data: {
        fiscalYearId: fiscalYear.id,
        customerPaymentId: payment.id,
        year: paymentDate.getUTCFullYear(),
        sequence: journalSequence,
        number: journalNumber,
        accountingDate: paymentDate,
        concept: journalConcept,
        origin: "CUSTOMER_PAYMENT",
        totalDebit: paymentAmount,
        totalCredit: paymentAmount,
        createdById: actor.id,
        lines: {
          create: [
            { accountId: accountByCode.get(treasuryAccountCode)!, position: 1, concept: journalConcept, debit: paymentAmount, credit: new Prisma.Decimal(0) },
            { accountId: accountByCode.get(customerAccountCode)!, position: 2, concept: journalConcept, debit: new Prisma.Decimal(0), credit: paymentAmount }
          ]
        }
      },
      select: { id: true, number: true }
    });
    const dueDatePaid = existingPaid.plus(paymentAmount);
    const dueDateStatus = dueDatePaid.plus(existingCredit).equals(dueDate.amount)
      ? existingCredit.gt(0) ? "SETTLED" : "PAID"
      : "PENDING";

    await tx.invoiceDueDate.update({
      where: { id: dueDate.id },
      data: { status: dueDateStatus }
    });

    const invoicePaid = await sumNetPaymentsForInvoice(tx, invoiceId);
    const invoiceCredit = await sumCreditApplicationsForInvoice(tx, invoiceId);
    const paymentStatus = invoicePaymentStatus(invoicePaid, invoice.total, invoiceCredit);

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
          accountingJournalEntryId: accountingEntry.id,
          accountingJournalEntryNumber: accountingEntry.number,
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
  if (result.kind === "accounting-fiscal-year-not-open") {
    return { ok: false, status: 409, error: { code: "PAYMENT_ACCOUNTING_FISCAL_YEAR_NOT_OPEN", message: "No hay un ejercicio contable abierto para la fecha del cobro." } };
  }
  if (result.kind === "accounting-account-not-available") {
    return { ok: false, status: 409, error: { code: "PAYMENT_ACCOUNTING_ACCOUNT_NOT_AVAILABLE", message: "Falta alguna cuenta contable activa e imputable necesaria para registrar el cobro." } };
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
  context: PaymentReturnMutationContext = {}
): Promise<RegisterCustomerPaymentReturnResult> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "invoices" WHERE "id" = ${invoiceId}::uuid FOR UPDATE`
    );
    const idempotentRecord = context.idempotencyKey
      ? await tx.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } })
      : null;

    if (idempotentRecord) {
      if (idempotentRecord.requestHash !== context.requestHash) {
        return { kind: "idempotency-reused" as const };
      }

      return {
        kind: "replayed" as const,
        value: idempotentRecord.responseBody as unknown as InvoiceDetail
      };
    }
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        status: true,
        total: true,
        customerId: true,
        number: true,
        customerCodeSnapshot: true,
        customerLegalNameSnapshot: true
      }
    });

    if (!invoice) {
      return { kind: "invoice-not-found" as const };
    }

    if (invoice.status !== "ISSUED") {
      return { kind: "invoice-not-payable" as const };
    }

    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "customer_payments" WHERE "id" = ${command.paymentId}::uuid AND "invoiceId" = ${invoiceId}::uuid FOR UPDATE`
    );
    const payment = await tx.customerPayment.findFirst({
      where: {
        id: command.paymentId,
        invoiceId
      },
      select: {
        id: true,
        dueDateId: true,
        source: true,
        paymentDate: true,
        amount: true,
        accountingEntry: {
          select: {
            lines: {
              where: { debit: { gt: 0 } },
              select: { account: { select: { code: true } } }
            }
          }
        },
        reconciliationApplications: {
          where: { reconciliation: { status: "ACTIVE" } },
          select: { amount: true }
        },
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

    const reconciledAmount = payment.reconciliationApplications.reduce(
      (total, application) => total.plus(application.amount),
      new Prisma.Decimal(0)
    );
    if (payment.amount.minus(alreadyReturned).minus(returnAmount).lt(reconciledAmount)) {
      return { kind: "return-reconciliation-conflict" as const };
    }

    const returnDate = parseDateOnly(command.returnDate);
    if (returnDate < payment.paymentDate) {
      return { kind: "return-date-before-payment" as const };
    }
    const installation = await tx.installation.findFirst({
      where: { companyId: { not: null } },
      select: { companyId: true }
    });
    const fiscalYears = installation?.companyId
      ? await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT "id" FROM "accounting_fiscal_years" WHERE "companyId" = ${installation.companyId}::uuid AND "status" = 'OPEN' AND "startDate" <= ${returnDate} AND "endDate" >= ${returnDate} FOR UPDATE`
        )
      : [];
    const fiscalYear = fiscalYears.length === 1 ? fiscalYears[0] : undefined;

    if (!fiscalYear) {
      return { kind: "accounting-fiscal-year-not-open" as const };
    }
    if (!/^\d{1,6}$/.test(invoice.customerCodeSnapshot)) {
      return { kind: "accounting-account-not-available" as const };
    }

    const customerAccountCode = `430${invoice.customerCodeSnapshot.padStart(6, "0")}`;
    const treasuryAccountCode = payment.accountingEntry?.lines
      .map((line) => line.account.code)
      .find((code) => code === "570000000" || code === "572000000");

    if (!treasuryAccountCode) {
      return { kind: "accounting-account-not-available" as const };
    }
    const accounts = await tx.accountingAccount.findMany({
      where: {
        fiscalYearId: fiscalYear.id,
        code: { in: [customerAccountCode, treasuryAccountCode] },
        status: "ACTIVE",
        isPostable: true
      },
      select: { id: true, code: true }
    });

    if (accounts.length !== 2) {
      return { kind: "accounting-account-not-available" as const };
    }

    const accountByCode = new Map(accounts.map((account) => [account.code, account.id]));

    const paymentReturn = await tx.customerPaymentReturn.create({
      data: {
        paymentId: payment.id,
        invoiceId,
        dueDateId: payment.dueDateId,
        returnDate,
        amount: returnAmount,
        reasonCode: command.reasonCode,
        notes: command.notes,
        createdById: actor.id
      },
      select: { id: true }
    });
    const lastEntry = await tx.accountingJournalEntry.findFirst({
      where: { fiscalYearId: fiscalYear.id },
      orderBy: { sequence: "desc" },
      select: { sequence: true }
    });
    const sequence = (lastEntry?.sequence ?? 0) + 1;
    const year = returnDate.getUTCFullYear();
    const concept = `Devolucion cobro factura ${invoice.number ?? invoice.id} - ${invoice.customerLegalNameSnapshot}`.slice(0, 240);
    const accountingEntry = await tx.accountingJournalEntry.create({
      data: {
        fiscalYearId: fiscalYear.id,
        customerPaymentReturnId: paymentReturn.id,
        year,
        sequence,
        number: `${year}/${sequence.toString().padStart(6, "0")}`,
        accountingDate: returnDate,
        concept,
        origin: "CUSTOMER_PAYMENT_RETURN",
        totalDebit: returnAmount,
        totalCredit: returnAmount,
        createdById: actor.id,
        lines: {
          create: [
            { accountId: accountByCode.get(customerAccountCode)!, position: 1, concept, debit: returnAmount, credit: new Prisma.Decimal(0) },
            { accountId: accountByCode.get(treasuryAccountCode)!, position: 2, concept, debit: new Prisma.Decimal(0), credit: returnAmount }
          ]
        }
      },
      select: { id: true, number: true }
    });

    const dueDatePaid = await sumNetPaymentsForDueDate(tx, payment.dueDateId);
    const dueDateCredit = await sumCreditApplicationsForDueDate(tx, payment.dueDateId);
    const dueDateStatus = dueDatePaymentStatus(dueDatePaid, payment.dueDate.amount, dueDateCredit);

    await tx.invoiceDueDate.update({
      where: { id: payment.dueDateId },
      data: { status: dueDateStatus }
    });

    const invoicePaid = await sumNetPaymentsForInvoice(tx, invoiceId);
    const invoiceCredit = await sumCreditApplicationsForInvoice(tx, invoiceId);
    const paymentStatus = invoicePaymentStatus(invoicePaid, invoice.total, invoiceCredit);

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
          accountingJournalEntryId: accountingEntry.id,
          accountingJournalEntryNumber: accountingEntry.number,
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

    const value = mapInvoiceDetailForTreasury(
      await findInvoiceDetailForTreasury(tx, invoiceId)
    );

    if (context.idempotencyKey && context.requestHash) {
      await tx.idempotencyRecord.create({
        data: {
          key: context.idempotencyKey,
          requestHash: context.requestHash,
          responseStatus: 201,
          responseBody: value as unknown as Prisma.InputJsonValue
        }
      });
    }

    return { kind: "returned" as const, value };
  });

  if (result.kind === "idempotency-reused") {
    return { ok: false, status: 409, error: { code: "IDEMPOTENCY_KEY_REUSED", message: "La clave de idempotencia ya se uso con otra peticion." } };
  }
  if (result.kind === "replayed") {
    return { ok: true, status: 201, value: result.value };
  }

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
  if (result.kind === "return-date-before-payment") {
    return { ok: false, status: 409, error: { code: "PAYMENT_RETURN_DATE_BEFORE_PAYMENT", message: "La fecha de devolucion no puede ser anterior a la fecha del cobro." } };
  }
  if (result.kind === "return-reconciliation-conflict") {
    return { ok: false, status: 409, error: { code: "PAYMENT_RETURN_RECONCILIATION_CONFLICT", message: "La devolucion dejaria el cobro por debajo del importe conciliado. Deshaga primero la conciliacion bancaria." } };
  }
  if (result.kind === "accounting-fiscal-year-not-open") {
    return { ok: false, status: 409, error: { code: "PAYMENT_RETURN_ACCOUNTING_FISCAL_YEAR_NOT_OPEN", message: "No hay un ejercicio contable abierto para la fecha de devolucion." } };
  }
  if (result.kind === "accounting-account-not-available") {
    return { ok: false, status: 409, error: { code: "PAYMENT_RETURN_ACCOUNTING_ACCOUNT_NOT_AVAILABLE", message: "Falta alguna cuenta contable activa e imputable necesaria para registrar la devolucion." } };
  }

  return {
    ok: true,
    status: 201,
    value: result.value
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
    const creditAmount = await sumCreditApplicationsForDueDate(tx, dueDate.id);

    if (paidAmount.plus(creditAmount).gte(dueDate.amount)) {
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
          pendingAmount: dueDate.amount.minus(paidAmount).minus(creditAmount).toFixed(2),
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

async function sumCreditApplicationsForDueDate(
  tx: Prisma.TransactionClient,
  dueDateId: string
): Promise<Prisma.Decimal> {
  const aggregate = await tx.customerCreditApplication.aggregate({
    where: { targetDueDateId: dueDateId },
    _sum: { amount: true }
  });
  return aggregate._sum.amount ?? new Prisma.Decimal(0);
}

async function sumCreditApplicationsForInvoice(
  tx: Prisma.TransactionClient,
  invoiceId: string
): Promise<Prisma.Decimal> {
  const aggregate = await tx.customerCreditApplication.aggregate({
    where: { targetInvoiceId: invoiceId },
    _sum: { amount: true }
  });
  return aggregate._sum.amount ?? new Prisma.Decimal(0);
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
  invoiceTotal: Prisma.Decimal,
  creditAmount = new Prisma.Decimal(0)
): "PENDING" | "PARTIALLY_PAID" | "PAID" | "PARTIALLY_SETTLED" | "SETTLED" {
  if (paidAmount.equals(0) && creditAmount.equals(0)) {
    return "PENDING";
  }
  if (paidAmount.plus(creditAmount).equals(invoiceTotal)) {
    return creditAmount.gt(0) ? "SETTLED" : "PAID";
  }
  return creditAmount.gt(0) ? "PARTIALLY_SETTLED" : "PARTIALLY_PAID";
}

function dueDatePaymentStatus(
  paidAmount: Prisma.Decimal,
  dueDateAmount: Prisma.Decimal,
  creditAmount = new Prisma.Decimal(0)
): "PENDING" | "PAID" | "SETTLED" | "RETURNED" {
  if (paidAmount.equals(0) && creditAmount.equals(0)) {
    return "RETURNED";
  }
  return paidAmount.plus(creditAmount).equals(dueDateAmount)
    ? creditAmount.gt(0) ? "SETTLED" : "PAID"
    : "PENDING";
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
