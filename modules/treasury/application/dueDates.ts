import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";
import { normalizeDateOnlyInput } from "@/modules/billing/application/invoices";

const defaultLimit = 25;
const maxLimit = 100;
const maxExportLimit = 1000;

const dateOnlySchema = z.preprocess(
  (value) => (typeof value === "string" ? normalizeDateOnlyInput(value) : value),
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener formato AAAA-MM-DD.")
    .refine(isValidDateOnly, "La fecha no es valida.")
);

export const listCustomerDueDatesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  cursor: z.string().uuid().optional(),
  scope: z
    .enum(["OPEN", "ALL", "PENDING", "PAID", "RETURNED", "UNPAID"])
    .default("OPEN"),
  customerId: z.string().uuid().optional(),
  dueFrom: dateOnlySchema.optional(),
  dueTo: dateOnlySchema.optional(),
  search: z.string().trim().min(1).max(120).optional()
});

export const exportCustomerDueDatesSchema = listCustomerDueDatesSchema
  .omit({ cursor: true, limit: true })
  .extend({
    limit: z.coerce.number().int().min(1).max(maxExportLimit).default(maxExportLimit)
  });

export type ListCustomerDueDatesCommand = z.infer<typeof listCustomerDueDatesSchema>;
export type ExportCustomerDueDatesCommand = z.infer<
  typeof exportCustomerDueDatesSchema
>;

export type CustomerDueDateListItem = {
  id: string;
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceSeries: string;
  invoiceYear: number;
  customer: {
    id: string;
    code: string;
    legalName: string;
  };
  issueDate: string;
  dueDate: string;
  amount: string;
  paidAmount: string;
  returnedAmount: string;
  pendingAmount: string;
  paymentMethod: "BANK_TRANSFER" | "CASH" | "DIRECT_DEBIT";
  status: "PENDING" | "PAID" | "RETURNED" | "UNPAID";
  paymentStatus: "PENDING" | "PARTIALLY_PAID" | "PAID" | "UNPAID";
};

export type CustomerDueDateList = {
  dueDates: CustomerDueDateListItem[];
  summary: {
    count: number;
    totalAmount: string;
    paidAmount: string;
    returnedAmount: string;
    pendingAmount: string;
  };
  nextCursor: string | null;
};

const customerDueDateSelect = {
  id: true,
  dueDate: true,
  amount: true,
  paymentMethod: true,
  status: true,
  invoice: {
    select: {
      id: true,
      number: true,
      series: true,
      year: true,
      issueDate: true,
      paymentStatus: true,
      customerId: true,
      customerCodeSnapshot: true,
      customerLegalNameSnapshot: true
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
  },
  paymentReturns: {
    select: {
      amount: true
    }
  }
} satisfies Prisma.InvoiceDueDateSelect;

type CustomerDueDateRecord = Prisma.InvoiceDueDateGetPayload<{
  select: typeof customerDueDateSelect;
}>;

export async function listCustomerDueDates(
  command: ListCustomerDueDatesCommand,
  actor: SessionUser
): Promise<CustomerDueDateList> {
  const result = await findCustomerDueDates(command);

  await prisma.auditEvent.create({
    data: {
      eventType: "CUSTOMER_DUE_DATES_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        scope: command.scope,
        customerId: command.customerId ?? null,
        dueFrom: command.dueFrom ?? null,
        dueTo: command.dueTo ?? null,
        hasSearch: Boolean(command.search),
        limit: command.limit,
        cursor: command.cursor ?? null,
        resultCount: result.dueDates.length
      }
    }
  });

  return result;
}

export async function exportCustomerDueDatesCsv(
  command: ExportCustomerDueDatesCommand,
  actor: SessionUser
): Promise<{ filename: string; content: string }> {
  const result = await findCustomerDueDates(command);

  await prisma.auditEvent.create({
    data: {
      eventType: "CUSTOMER_DUE_DATES_EXPORTED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        scope: command.scope,
        customerId: command.customerId ?? null,
        dueFrom: command.dueFrom ?? null,
        dueTo: command.dueTo ?? null,
        hasSearch: Boolean(command.search),
        limit: command.limit,
        resultCount: result.dueDates.length
      }
    }
  });

  return {
    filename: `vencimientos-clientes-${formatDateOnly(new Date())}.csv`,
    content: customerDueDatesCsv(result.dueDates)
  };
}

async function findCustomerDueDates(
  command: ListCustomerDueDatesCommand | ExportCustomerDueDatesCommand
): Promise<CustomerDueDateList> {
  const where: Prisma.InvoiceDueDateWhereInput = {
    invoice: {
      status: "ISSUED",
      ...(command.customerId ? { customerId: command.customerId } : {}),
      ...(command.search
        ? {
            OR: [
              { number: { contains: command.search, mode: "insensitive" } },
              {
                customerCodeSnapshot: {
                  contains: command.search,
                  mode: "insensitive"
                }
              },
              {
                customerLegalNameSnapshot: {
                  contains: command.search,
                  mode: "insensitive"
                }
              }
            ]
          }
        : {})
    },
    ...(command.scope === "OPEN"
      ? { status: { not: "PAID" } }
      : command.scope === "ALL"
        ? {}
        : { status: command.scope }),
    ...(command.dueFrom || command.dueTo
      ? {
          dueDate: {
            ...(command.dueFrom ? { gte: parseDateOnly(command.dueFrom) } : {}),
            ...(command.dueTo ? { lte: parseDateOnly(command.dueTo) } : {})
          }
        }
      : {})
  };
  const records = await prisma.invoiceDueDate.findMany({
    where,
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    cursor: "cursor" in command && command.cursor ? { id: command.cursor } : undefined,
    skip: "cursor" in command && command.cursor ? 1 : 0,
    take: command.limit + 1,
    select: customerDueDateSelect
  });
  const page = records.slice(0, command.limit);
  const dueDates = page.map(mapCustomerDueDate);
  const summary = summarizeDueDates(dueDates);

  return {
    dueDates,
    summary,
    nextCursor: records.length > command.limit ? page.at(-1)?.id ?? null : null
  };
}

function customerDueDatesCsv(dueDates: CustomerDueDateListItem[]): string {
  const header = [
    "vencimiento",
    "fecha_emision",
    "factura",
    "serie",
    "ejercicio",
    "cliente_codigo",
    "cliente_nombre",
    "metodo",
    "estado_vencimiento",
    "estado_factura",
    "importe",
    "cobrado_neto",
    "devuelto",
    "pendiente"
  ];
  const rows = dueDates.map((dueDate) => [
    dueDate.dueDate,
    dueDate.issueDate,
    dueDate.invoiceNumber ?? "",
    dueDate.invoiceSeries,
    dueDate.invoiceYear.toString(),
    dueDate.customer.code,
    dueDate.customer.legalName,
    dueDate.paymentMethod,
    dueDate.status,
    dueDate.paymentStatus,
    dueDate.amount,
    dueDate.paidAmount,
    dueDate.returnedAmount,
    dueDate.pendingAmount
  ]);

  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function csvCell(value: string): string {
  const safeValue = spreadsheetSafeText(value);

  return `"${safeValue.replace(/"/g, '""')}"`;
}

function spreadsheetSafeText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function mapCustomerDueDate(record: CustomerDueDateRecord): CustomerDueDateListItem {
  const paidAmount = record.payments.reduce(
    (total, payment) => total.plus(payment.amount).minus(sumAmounts(payment.returns)),
    new Prisma.Decimal(0)
  );
  const returnedAmount = sumAmounts(record.paymentReturns);
  const pendingAmount = record.amount.minus(paidAmount);

  return {
    id: record.id,
    invoiceId: record.invoice.id,
    invoiceNumber: record.invoice.number,
    invoiceSeries: record.invoice.series,
    invoiceYear: record.invoice.year,
    customer: {
      id: record.invoice.customerId,
      code: record.invoice.customerCodeSnapshot,
      legalName: record.invoice.customerLegalNameSnapshot
    },
    issueDate: formatDateOnly(record.invoice.issueDate),
    dueDate: formatDateOnly(record.dueDate),
    amount: record.amount.toFixed(2),
    paidAmount: paidAmount.toFixed(2),
    returnedAmount: returnedAmount.toFixed(2),
    pendingAmount: pendingAmount.toFixed(2),
    paymentMethod: record.paymentMethod,
    status: record.status,
    paymentStatus: record.invoice.paymentStatus
  };
}

function summarizeDueDates(dueDates: CustomerDueDateListItem[]): CustomerDueDateList["summary"] {
  const summary = dueDates.reduce(
    (totals, dueDate) => ({
      totalAmount: totals.totalAmount.plus(dueDate.amount),
      paidAmount: totals.paidAmount.plus(dueDate.paidAmount),
      returnedAmount: totals.returnedAmount.plus(dueDate.returnedAmount),
      pendingAmount: totals.pendingAmount.plus(dueDate.pendingAmount)
    }),
    {
      totalAmount: new Prisma.Decimal(0),
      paidAmount: new Prisma.Decimal(0),
      returnedAmount: new Prisma.Decimal(0),
      pendingAmount: new Prisma.Decimal(0)
    }
  );

  return {
    count: dueDates.length,
    totalAmount: summary.totalAmount.toFixed(2),
    paidAmount: summary.paidAmount.toFixed(2),
    returnedAmount: summary.returnedAmount.toFixed(2),
    pendingAmount: summary.pendingAmount.toFixed(2)
  };
}

function sumAmounts(items: Array<{ amount: Prisma.Decimal }>): Prisma.Decimal {
  return items.reduce(
    (total, item) => total.plus(item.amount),
    new Prisma.Decimal(0)
  );
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
