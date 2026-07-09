import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";
import { normalizeDateOnlyInput } from "@/modules/billing/application/invoices";

const maxLimit = 500;

const dateOnlySchema = z.preprocess(
  (value) => (typeof value === "string" ? normalizeDateOnlyInput(value) : value),
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener formato AAAA-MM-DD.")
    .refine(isValidDateOnly, "La fecha no es valida.")
);

export const getCustomerCollectionForecastSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).default(currentYear),
  customerId: z.string().uuid().optional(),
  search: z.string().trim().min(1).max(120).optional(),
  asOf: dateOnlySchema.default(currentDateOnly),
  limit: z.coerce.number().int().min(1).max(maxLimit).default(maxLimit)
});

export type GetCustomerCollectionForecastCommand = z.infer<
  typeof getCustomerCollectionForecastSchema
>;

export type CustomerCollectionForecastItem = {
  dueDateId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  customer: {
    id: string;
    code: string;
    legalName: string;
  };
  dueDate: string;
  forecastMonth: number;
  status: "PENDING" | "RETURNED" | "UNPAID";
  paymentStatus: "PENDING" | "PARTIALLY_PAID" | "UNPAID";
  amount: string;
  paidAmount: string;
  pendingAmount: string;
  overdue: boolean;
};

export type CustomerCollectionForecastMonth = {
  month: number;
  itemCount: number;
  expectedAmount: string;
  overdueAmount: string;
};

export type CustomerCollectionForecast = {
  year: number;
  asOf: string;
  months: CustomerCollectionForecastMonth[];
  items: CustomerCollectionForecastItem[];
  summary: {
    itemCount: number;
    expectedAmount: string;
    overdueAmount: string;
  };
};

const forecastDueDateSelect = {
  id: true,
  dueDate: true,
  amount: true,
  status: true,
  invoice: {
    select: {
      id: true,
      number: true,
      customerId: true,
      customerCodeSnapshot: true,
      customerLegalNameSnapshot: true,
      paymentStatus: true
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

type ForecastDueDateRecord = Prisma.InvoiceDueDateGetPayload<{
  select: typeof forecastDueDateSelect;
}>;

export async function getCustomerCollectionForecast(
  command: GetCustomerCollectionForecastCommand,
  actor: SessionUser
): Promise<CustomerCollectionForecast> {
  const asOfDate = parseDateOnly(command.asOf);
  const records = await prisma.invoiceDueDate.findMany({
    where: {
      status: { in: ["PENDING", "RETURNED", "UNPAID"] },
      invoice: {
        status: "ISSUED",
        paymentStatus: { in: ["PENDING", "PARTIALLY_PAID", "UNPAID"] },
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
      }
    },
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    take: command.limit,
    select: forecastDueDateSelect
  });
  const items = records
    .map((record) => mapForecastItem(record, command.year, asOfDate))
    .filter((item): item is CustomerCollectionForecastItem => item !== null);
  const months = summarizeForecastMonths(items);
  const summary = months.reduce(
    (totals, month) => ({
      itemCount: totals.itemCount + month.itemCount,
      expectedAmount: totals.expectedAmount.plus(month.expectedAmount),
      overdueAmount: totals.overdueAmount.plus(month.overdueAmount)
    }),
    {
      itemCount: 0,
      expectedAmount: new Prisma.Decimal(0),
      overdueAmount: new Prisma.Decimal(0)
    }
  );

  await prisma.auditEvent.create({
    data: {
      eventType: "CUSTOMER_COLLECTION_FORECAST_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        year: command.year,
        asOf: command.asOf,
        customerId: command.customerId ?? null,
        hasSearch: Boolean(command.search),
        limit: command.limit,
        resultCount: items.length
      }
    }
  });

  return {
    year: command.year,
    asOf: command.asOf,
    months,
    items,
    summary: {
      itemCount: summary.itemCount,
      expectedAmount: summary.expectedAmount.toFixed(2),
      overdueAmount: summary.overdueAmount.toFixed(2)
    }
  };
}

function mapForecastItem(
  record: ForecastDueDateRecord,
  year: number,
  asOfDate: Date
): CustomerCollectionForecastItem | null {
  const paidAmount = record.payments.reduce(
    (total, payment) => total.plus(payment.amount).minus(sumAmounts(payment.returns)),
    new Prisma.Decimal(0)
  );
  const pendingAmount = record.amount.minus(paidAmount);

  if (pendingAmount.lte(0)) {
    return null;
  }

  const overdue = record.dueDate < asOfDate;
  const forecastDate = overdue ? asOfDate : record.dueDate;
  const forecastYear = forecastDate.getUTCFullYear();

  if (forecastYear !== year) {
    return null;
  }

  return {
    dueDateId: record.id,
    invoiceId: record.invoice.id,
    invoiceNumber: record.invoice.number,
    customer: {
      id: record.invoice.customerId,
      code: record.invoice.customerCodeSnapshot,
      legalName: record.invoice.customerLegalNameSnapshot
    },
    dueDate: formatDateOnly(record.dueDate),
    forecastMonth: forecastDate.getUTCMonth() + 1,
    status: record.status as CustomerCollectionForecastItem["status"],
    paymentStatus: record.invoice.paymentStatus as CustomerCollectionForecastItem["paymentStatus"],
    amount: record.amount.toFixed(2),
    paidAmount: paidAmount.toFixed(2),
    pendingAmount: pendingAmount.toFixed(2),
    overdue
  };
}

function summarizeForecastMonths(
  items: CustomerCollectionForecastItem[]
): CustomerCollectionForecastMonth[] {
  return Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const monthItems = items.filter((item) => item.forecastMonth === month);
    const totals = monthItems.reduce(
      (summary, item) => ({
        expectedAmount: summary.expectedAmount.plus(item.pendingAmount),
        overdueAmount: item.overdue
          ? summary.overdueAmount.plus(item.pendingAmount)
          : summary.overdueAmount
      }),
      {
        expectedAmount: new Prisma.Decimal(0),
        overdueAmount: new Prisma.Decimal(0)
      }
    );

    return {
      month,
      itemCount: monthItems.length,
      expectedAmount: totals.expectedAmount.toFixed(2),
      overdueAmount: totals.overdueAmount.toFixed(2)
    };
  });
}

function sumAmounts(items: Array<{ amount: Prisma.Decimal }>): Prisma.Decimal {
  return items.reduce(
    (total, item) => total.plus(item.amount),
    new Prisma.Decimal(0)
  );
}

function currentYear(): number {
  return new Date().getUTCFullYear();
}

function currentDateOnly(): string {
  return formatDateOnly(new Date());
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
