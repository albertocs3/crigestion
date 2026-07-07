import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  calculateInvoiceLine,
  calculateInvoiceTaxSummaries,
  calculateInvoiceTotals
} from "@/modules/billing/application/calculations";
import type {
  RequestContext,
  SessionUser
} from "@/modules/platform/application/auth";

const defaultLimit = 25;
const maxLimit = 100;

const dateOnlySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener formato AAAA-MM-DD.")
  .refine(isValidDateOnly, "La fecha no es valida.");
const moneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, "El importe debe tener hasta dos decimales.");
const quantitySchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,9}(\.\d{1,3})?$/, "La cantidad debe tener hasta tres decimales.")
  .refine((value) => !new Prisma.Decimal(value).equals(0), {
    message: "La cantidad no puede ser cero."
  });
const percentSchema = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, "El porcentaje debe tener hasta dos decimales.")
  .refine((value) => new Prisma.Decimal(value).lte(100), {
    message: "El porcentaje no puede superar 100."
  });

export const createInvoiceDraftSchema = z.object({
  customerId: z.string().uuid(),
  issueDate: dateOnlySchema,
  operationDate: dateOnlySchema,
  notes: z.string().trim().min(1).max(1000).nullable().default(null)
}).strict();

export const addInvoiceLineSchema = z.object({
  catalogItemId: z.string().uuid().optional(),
  description: z.string().trim().min(1).max(500),
  quantity: quantitySchema,
  unitPrice: moneySchema,
  discountPercent: percentSchema.default("0.00"),
  discountAmount: moneySchema.default("0.00"),
  taxRateId: z.string().uuid()
}).strict();

export const issueInvoiceSchema = z.object({
  issueDate: dateOnlySchema
}).strict();
export const listInvoicesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  cursor: z.string().uuid().optional(),
  status: z.enum(["DRAFT", "ISSUED", "RECTIFIED", "VOIDED"]).optional(),
  paymentStatus: z.enum(["PENDING", "PARTIALLY_PAID", "PAID", "UNPAID"]).optional(),
  customerId: z.string().uuid().optional(),
  search: z.string().trim().min(1).max(120).optional()
});

export type CreateInvoiceDraftCommand = z.infer<typeof createInvoiceDraftSchema>;
export type AddInvoiceLineCommand = z.infer<typeof addInvoiceLineSchema>;
export type IssueInvoiceCommand = z.infer<typeof issueInvoiceSchema>;
export type ListInvoicesCommand = z.infer<typeof listInvoicesSchema>;

export type InvoiceListItem = {
  id: string;
  status: InvoiceDetail["status"];
  number: string | null;
  series: string;
  year: number;
  customer: {
    id: string;
    code: string;
    legalName: string;
  };
  issueDate: string;
  operationDate: string;
  paymentStatus: InvoiceDetail["paymentStatus"];
  verifactuStatus: InvoiceDetail["verifactuStatus"];
  total: string;
  createdAt: string;
  updatedAt: string;
};

export type InvoiceList = {
  invoices: InvoiceListItem[];
  nextCursor: string | null;
};

export type InvoiceDetail = {
  id: string;
  status: "DRAFT" | "ISSUED" | "RECTIFIED" | "VOIDED";
  number: string | null;
  series: string;
  year: number;
  customerId: string;
  customerSnapshot: {
    code: string;
    legalName: string;
    taxId: string;
    fiscalTreatment: "DOMESTIC" | "EU" | "EXPORT" | "CANARY_CEUTA_MELILLA";
    fiscalAddress: unknown;
  };
  issueDate: string;
  operationDate: string;
  paymentStatus: "PENDING" | "PARTIALLY_PAID" | "PAID" | "UNPAID";
  verifactuStatus:
    | "NOT_APPLICABLE"
    | "PENDING"
    | "SENT"
    | "ACCEPTED"
    | "ACCEPTED_WITH_ERRORS"
    | "REJECTED";
  lines: Array<{
    id: string;
    position: number;
    catalogItemId: string | null;
    description: string;
    quantity: string;
    unitPrice: string;
    discountPercent: string;
    discountAmount: string;
    taxRate: {
      id: string;
      code: string;
      name: string;
      rate: string;
    };
    totals: {
      subtotal: string;
      discountTotal: string;
      taxableBase: string;
      taxAmount: string;
      total: string;
    };
  }>;
  taxSummary: Array<{
    taxRateCode: string;
    taxRate: string;
    taxableBase: string;
    taxAmount: string;
    total: string;
  }>;
  dueDates: Array<{
    id: string;
    position: number;
    dueDate: string;
    amount: string;
    paymentMethod: "BANK_TRANSFER" | "CASH" | "DIRECT_DEBIT";
    status: "PENDING" | "PAID" | "RETURNED" | "UNPAID";
  }>;
  totals: {
    subtotal: string;
    discountTotal: string;
    taxableBase: string;
    taxAmount: string;
    total: string;
  };
  createdAt: string;
  updatedAt: string;
};

type CustomerNotFoundResult = {
  ok: false;
  status: 404;
  error: {
    code: "CUSTOMER_NOT_FOUND";
    message: string;
  };
};

type CustomerNotActiveResult = {
  ok: false;
  status: 409;
  error: {
    code: "CUSTOMER_NOT_ACTIVE";
    message: string;
  };
};

type InvoiceNotFoundResult = {
  ok: false;
  status: 404;
  error: {
    code: "INVOICE_NOT_FOUND";
    message: string;
  };
};

type InvoiceNotEditableResult = {
  ok: false;
  status: 409;
  error: {
    code: "INVOICE_NOT_EDITABLE";
    message: string;
  };
};

type InvoiceNotIssuableResult = {
  ok: false;
  status: 409;
  error: {
    code: "INVOICE_NOT_ISSUABLE" | "INVOICE_EMPTY" | "INVOICE_CHRONOLOGY_VIOLATION";
    message: string;
  };
};

type CatalogItemNotFoundResult = {
  ok: false;
  status: 422;
  error: {
    code: "CATALOG_ITEM_NOT_FOUND";
    message: string;
  };
};

type CatalogTaxRateNotFoundResult = {
  ok: false;
  status: 422;
  error: {
    code: "CATALOG_TAX_RATE_NOT_FOUND";
    message: string;
  };
};

export type CreateInvoiceDraftResult =
  | { ok: true; status: 201; value: InvoiceDetail }
  | CustomerNotFoundResult
  | CustomerNotActiveResult;

export type AddInvoiceLineResult =
  | { ok: true; status: 201; value: InvoiceDetail }
  | InvoiceNotFoundResult
  | InvoiceNotEditableResult
  | CatalogItemNotFoundResult
  | CatalogTaxRateNotFoundResult;

export type IssueInvoiceResult =
  | { ok: true; status: 200; value: InvoiceDetail }
  | InvoiceNotFoundResult
  | InvoiceNotIssuableResult;

export async function listInvoices(
  command: ListInvoicesCommand,
  actor: SessionUser
): Promise<InvoiceList> {
  const where: Prisma.InvoiceWhereInput = {
    ...(command.status ? { status: command.status } : {}),
    ...(command.paymentStatus ? { paymentStatus: command.paymentStatus } : {}),
    ...(command.customerId ? { customerId: command.customerId } : {}),
    ...(command.search
      ? {
          OR: [
            { number: { contains: command.search, mode: "insensitive" } },
            { customerCodeSnapshot: { contains: command.search, mode: "insensitive" } },
            {
              customerLegalNameSnapshot: {
                contains: command.search,
                mode: "insensitive"
              }
            }
          ]
        }
      : {})
  };
  const invoices = await prisma.invoice.findMany({
    where,
    orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    cursor: command.cursor ? { id: command.cursor } : undefined,
    skip: command.cursor ? 1 : 0,
    take: command.limit + 1,
    select: invoiceListSelect
  });
  const page = invoices.slice(0, command.limit);

  await prisma.auditEvent.create({
    data: {
      eventType: "INVOICES_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        status: command.status ?? null,
        paymentStatus: command.paymentStatus ?? null,
        customerId: command.customerId ?? null,
        hasSearch: Boolean(command.search),
        limit: command.limit,
        cursor: command.cursor ?? null,
        resultCount: page.length
      }
    }
  });

  return {
    invoices: page.map(mapInvoiceListItem),
    nextCursor: invoices.length > command.limit ? page.at(-1)?.id ?? null : null
  };
}

export async function getInvoiceDetail(
  invoiceId: string,
  actor: SessionUser
): Promise<InvoiceDetail | null> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: invoiceDetailSelect
  });

  if (!invoice) {
    return null;
  }

  await prisma.auditEvent.create({
    data: {
      eventType: "INVOICE_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        invoiceId,
        status: invoice.status,
        number: invoice.number
      }
    }
  });

  return mapInvoiceDetail(invoice);
}

export async function createInvoiceDraft(
  command: CreateInvoiceDraftCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CreateInvoiceDraftResult> {
  const result = await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findUnique({
      where: { id: command.customerId },
      select: invoiceCustomerSelect
    });

    if (!customer) {
      return { kind: "customer-not-found" as const };
    }

    if (customer.status !== "ACTIVE") {
      return { kind: "customer-not-active" as const };
    }

    const issueDate = parseDateOnly(command.issueDate);
    const invoice = await tx.invoice.create({
      data: {
        year: issueDate.getUTCFullYear(),
        customerId: customer.id,
        customerCodeSnapshot: customer.code,
        customerLegalNameSnapshot: customer.legalName,
        customerTaxIdSnapshot: customer.taxId,
        customerFiscalTreatmentSnapshot: customer.fiscalTreatment,
        customerFiscalAddressSnapshot: fiscalAddressSnapshot(customer),
        issueDate,
        operationDate: parseDateOnly(command.operationDate),
        notes: command.notes,
        createdById: actor.id
      },
      select: { id: true }
    });

    await tx.invoiceDueDate.create({
      data: {
        invoiceId: invoice.id,
        position: 1,
        dueDate: calculateDueDate(issueDate, customer),
        amount: "0.00",
        paymentMethod: customer.defaultPaymentMethod
      }
    });

    await tx.auditEvent.create({
      data: {
        eventType: "INVOICE_DRAFT_CREATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          invoiceId: invoice.id,
          customerId: customer.id,
          customerCode: customer.code,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return {
      kind: "created" as const,
      invoice: await findInvoiceDetail(tx, invoice.id)
    };
  });

  if (result.kind === "customer-not-found") {
    return customerNotFound();
  }

  if (result.kind === "customer-not-active") {
    return customerNotActive();
  }

  return {
    ok: true,
    status: 201,
    value: mapInvoiceDetail(result.invoice)
  };
}

export async function addInvoiceLine(
  invoiceId: string,
  command: AddInvoiceLineCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<AddInvoiceLineResult> {
  const result = await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        status: true
      }
    });

    if (!invoice) {
      return { kind: "invoice-not-found" as const };
    }

    if (invoice.status !== "DRAFT") {
      return { kind: "invoice-not-editable" as const };
    }

    const taxRate = await tx.catalogTaxRate.findFirst({
      where: {
        id: command.taxRateId,
        status: "ACTIVE"
      },
      select: {
        id: true,
        code: true,
        name: true,
        rate: true
      }
    });

    if (!taxRate) {
      return { kind: "tax-rate-not-found" as const };
    }

    const catalogItem = command.catalogItemId
      ? await tx.catalogItem.findFirst({
          where: {
            id: command.catalogItemId,
            status: "ACTIVE"
          },
          select: {
            id: true,
            code: true,
            kind: true
          }
        })
      : null;

    if (command.catalogItemId && !catalogItem) {
      return { kind: "catalog-item-not-found" as const };
    }

    const position = await nextInvoiceLinePosition(tx, invoiceId);
    const calculation = calculateInvoiceLine({
      quantity: command.quantity,
      unitPrice: command.unitPrice,
      discountPercent: command.discountPercent,
      discountAmount: command.discountAmount,
      taxRate: taxRate.rate
    });
    const line = await tx.invoiceLine.create({
      data: {
        invoiceId,
        position,
        catalogItemId: catalogItem?.id ?? null,
        catalogItemCodeSnapshot: catalogItem?.code ?? null,
        catalogItemKindSnapshot: catalogItem?.kind ?? null,
        description: command.description,
        quantity: command.quantity,
        unitPrice: command.unitPrice,
        discountPercent: command.discountPercent,
        discountAmount: command.discountAmount,
        taxRateId: taxRate.id,
        taxRateCodeSnapshot: taxRate.code,
        taxRateNameSnapshot: taxRate.name,
        taxRateSnapshot: taxRate.rate,
        ...calculation
      },
      select: {
        id: true,
        position: true
      }
    });

    await recalculateInvoice(tx, invoiceId);

    await tx.auditEvent.create({
      data: {
        eventType: "INVOICE_LINE_CREATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          invoiceId,
          lineId: line.id,
          position: line.position,
          hasCatalogItem: Boolean(catalogItem),
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return {
      kind: "created" as const,
      invoice: await findInvoiceDetail(tx, invoiceId)
    };
  });

  if (result.kind === "invoice-not-found") {
    return invoiceNotFound();
  }

  if (result.kind === "invoice-not-editable") {
    return invoiceNotEditable();
  }

  if (result.kind === "catalog-item-not-found") {
    return catalogItemNotFound();
  }

  if (result.kind === "tax-rate-not-found") {
    return catalogTaxRateNotFound();
  }

  return {
    ok: true,
    status: 201,
    value: mapInvoiceDetail(result.invoice)
  };
}

export async function issueInvoice(
  invoiceId: string,
  command: IssueInvoiceCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<IssueInvoiceResult> {
  const result = await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        status: true,
        series: true,
        year: true,
        issueDate: true,
        total: true,
        customerId: true,
        _count: {
          select: {
            lines: true
          }
        }
      }
    });

    if (!invoice) {
      return { kind: "invoice-not-found" as const };
    }

    if (invoice.status !== "DRAFT") {
      return { kind: "invoice-not-issuable" as const };
    }

    if (invoice._count.lines === 0) {
      return { kind: "invoice-empty" as const };
    }

    const issueDate = parseDateOnly(command.issueDate);
    const chronologyViolation = await hasChronologyViolation(
      tx,
      invoice.series,
      issueDate
    );

    if (chronologyViolation) {
      return { kind: "chronology-violation" as const };
    }

    const sequence = await reserveInvoiceNumber(tx, invoice.series, issueDate);
    const number = formatInvoiceNumber(invoice.series, sequence.year, sequence.value);

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: "ISSUED",
        verifactuStatus: "PENDING",
        year: sequence.year,
        numberSequence: sequence.value,
        number,
        issueDate,
        issuedAt: new Date(),
        issuedById: actor.id,
        updatedById: actor.id
      }
    });

    await tx.invoiceVerifactuRecord.create({
      data: {
        invoiceId,
        status: "PENDING"
      }
    });

    await tx.auditEvent.create({
      data: {
        eventType: "INVOICE_ISSUED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          invoiceId,
          number,
          customerId: invoice.customerId,
          total: invoice.total.toFixed(2),
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return {
      kind: "issued" as const,
      invoice: await findInvoiceDetail(tx, invoiceId)
    };
  });

  if (result.kind === "invoice-not-found") {
    return invoiceNotFound();
  }

  if (result.kind === "invoice-not-issuable") {
    return invoiceNotIssuable();
  }

  if (result.kind === "invoice-empty") {
    return invoiceEmpty();
  }

  if (result.kind === "chronology-violation") {
    return invoiceChronologyViolation();
  }

  return {
    ok: true,
    status: 200,
    value: mapInvoiceDetail(result.invoice)
  };
}

const invoiceCustomerSelect = {
  id: true,
  code: true,
  status: true,
  legalName: true,
  taxId: true,
  fiscalTreatment: true,
  fiscalAddressLine: true,
  fiscalPostalCode: true,
  fiscalCity: true,
  fiscalProvince: true,
  fiscalCountry: true,
  defaultPaymentMethod: true,
  paymentTermsType: true,
  paymentDays: true,
  paymentFixedDay: true
} satisfies Prisma.CustomerSelect;

const invoiceDetailSelect = {
  id: true,
  status: true,
  number: true,
  series: true,
  year: true,
  customerId: true,
  customerCodeSnapshot: true,
  customerLegalNameSnapshot: true,
  customerTaxIdSnapshot: true,
  customerFiscalTreatmentSnapshot: true,
  customerFiscalAddressSnapshot: true,
  issueDate: true,
  operationDate: true,
  paymentStatus: true,
  verifactuStatus: true,
  subtotal: true,
  discountTotal: true,
  taxableBase: true,
  taxAmount: true,
  total: true,
  lines: {
    orderBy: { position: "asc" },
    select: {
      id: true,
      position: true,
      catalogItemId: true,
      description: true,
      quantity: true,
      unitPrice: true,
      discountPercent: true,
      discountAmount: true,
      taxRateId: true,
      taxRateCodeSnapshot: true,
      taxRateNameSnapshot: true,
      taxRateSnapshot: true,
      lineSubtotal: true,
      lineDiscountTotal: true,
      lineTaxableBase: true,
      lineTaxAmount: true,
      lineTotal: true
    }
  },
  taxSummaries: {
    orderBy: [{ taxRateCode: "asc" }, { taxRate: "asc" }],
    select: {
      taxRateCode: true,
      taxRate: true,
      taxableBase: true,
      taxAmount: true,
      total: true
    }
  },
  dueDates: {
    orderBy: { position: "asc" },
    select: {
      id: true,
      position: true,
      dueDate: true,
      amount: true,
      paymentMethod: true,
      status: true
    }
  },
  createdAt: true,
  updatedAt: true
} satisfies Prisma.InvoiceSelect;

const invoiceListSelect = {
  id: true,
  status: true,
  number: true,
  series: true,
  year: true,
  customerId: true,
  customerCodeSnapshot: true,
  customerLegalNameSnapshot: true,
  issueDate: true,
  operationDate: true,
  paymentStatus: true,
  verifactuStatus: true,
  total: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.InvoiceSelect;

async function findInvoiceDetail(
  tx: Prisma.TransactionClient,
  invoiceId: string
): Promise<InvoiceDetailRecord> {
  return tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: invoiceDetailSelect
  });
}

type InvoiceDetailRecord = Prisma.InvoiceGetPayload<{
  select: typeof invoiceDetailSelect;
}>;
type InvoiceListRecord = Prisma.InvoiceGetPayload<{
  select: typeof invoiceListSelect;
}>;

async function recalculateInvoice(
  tx: Prisma.TransactionClient,
  invoiceId: string
): Promise<void> {
  const lines = await tx.invoiceLine.findMany({
    where: { invoiceId },
    orderBy: { position: "asc" },
    select: {
      taxRateCodeSnapshot: true,
      taxRateSnapshot: true,
      lineSubtotal: true,
      lineDiscountTotal: true,
      lineTaxableBase: true,
      lineTaxAmount: true,
      lineTotal: true
    }
  });
  const calculatedLines = lines.map((line) => ({
    taxRateCode: line.taxRateCodeSnapshot,
    taxRate: line.taxRateSnapshot,
    lineSubtotal: line.lineSubtotal,
    lineDiscountTotal: line.lineDiscountTotal,
    lineTaxableBase: line.lineTaxableBase,
    lineTaxAmount: line.lineTaxAmount,
    lineTotal: line.lineTotal
  }));
  const totals = calculateInvoiceTotals(calculatedLines);
  const taxSummaries = calculateInvoiceTaxSummaries(calculatedLines);

  await tx.invoiceTaxSummary.deleteMany({ where: { invoiceId } });

  if (taxSummaries.length > 0) {
    await tx.invoiceTaxSummary.createMany({
      data: taxSummaries.map((summary) => ({
        invoiceId,
        taxRateCode: summary.taxRateCode,
        taxRate: summary.taxRate,
        taxableBase: summary.taxableBase,
        taxAmount: summary.taxAmount,
        total: summary.total
      }))
    });
  }

  await tx.invoice.update({
    where: { id: invoiceId },
    data: totals
  });
  await tx.invoiceDueDate.updateMany({
    where: {
      invoiceId,
      position: 1
    },
    data: {
      amount: totals.total
    }
  });
}

async function nextInvoiceLinePosition(
  tx: Prisma.TransactionClient,
  invoiceId: string
): Promise<number> {
  const lastLine = await tx.invoiceLine.findFirst({
    where: { invoiceId },
    orderBy: { position: "desc" },
    select: { position: true }
  });

  return (lastLine?.position ?? 0) + 1;
}

async function hasChronologyViolation(
  tx: Prisma.TransactionClient,
  series: string,
  issueDate: Date
): Promise<boolean> {
  const latest = await tx.invoice.findFirst({
    where: {
      series,
      status: {
        not: "DRAFT"
      }
    },
    orderBy: [{ issueDate: "desc" }, { numberSequence: "desc" }],
    select: { issueDate: true }
  });

  return Boolean(latest && issueDate < latest.issueDate);
}

async function reserveInvoiceNumber(
  tx: Prisma.TransactionClient,
  series: string,
  issueDate: Date
): Promise<{ year: number; value: number }> {
  const year = issueDate.getUTCFullYear();

  await tx.$executeRaw`
    INSERT INTO "invoice_number_sequences" ("series", "year", "nextNumber", "updatedAt")
    VALUES (${series}, ${year}, 1, NOW())
    ON CONFLICT ("series", "year") DO NOTHING
  `;

  const rows = await tx.$queryRaw<Array<{ nextNumber: number }>>`
    SELECT "nextNumber"
    FROM "invoice_number_sequences"
    WHERE "series" = ${series} AND "year" = ${year}
    FOR UPDATE
  `;
  const value = rows[0]?.nextNumber;

  if (!value) {
    throw new Error("INVOICE_NUMBER_SEQUENCE_UNAVAILABLE");
  }

  await tx.invoiceNumberSequence.update({
    where: {
      series_year: {
        series,
        year
      }
    },
    data: {
      nextNumber: value + 1
    }
  });

  return { year, value };
}

function mapInvoiceDetail(invoice: InvoiceDetailRecord): InvoiceDetail {
  return {
    id: invoice.id,
    status: invoice.status,
    number: invoice.number,
    series: invoice.series,
    year: invoice.year,
    customerId: invoice.customerId,
    customerSnapshot: {
      code: invoice.customerCodeSnapshot,
      legalName: invoice.customerLegalNameSnapshot,
      taxId: invoice.customerTaxIdSnapshot,
      fiscalTreatment: invoice.customerFiscalTreatmentSnapshot,
      fiscalAddress: invoice.customerFiscalAddressSnapshot
    },
    issueDate: formatDateOnly(invoice.issueDate),
    operationDate: formatDateOnly(invoice.operationDate),
    paymentStatus: invoice.paymentStatus,
    verifactuStatus: invoice.verifactuStatus,
    lines: invoice.lines.map((line) => ({
      id: line.id,
      position: line.position,
      catalogItemId: line.catalogItemId,
      description: line.description,
      quantity: line.quantity.toFixed(3),
      unitPrice: line.unitPrice.toFixed(2),
      discountPercent: line.discountPercent.toFixed(2),
      discountAmount: line.discountAmount.toFixed(2),
      taxRate: {
        id: line.taxRateId,
        code: line.taxRateCodeSnapshot,
        name: line.taxRateNameSnapshot,
        rate: line.taxRateSnapshot.toFixed(2)
      },
      totals: {
        subtotal: line.lineSubtotal.toFixed(2),
        discountTotal: line.lineDiscountTotal.toFixed(2),
        taxableBase: line.lineTaxableBase.toFixed(2),
        taxAmount: line.lineTaxAmount.toFixed(2),
        total: line.lineTotal.toFixed(2)
      }
    })),
    taxSummary: invoice.taxSummaries.map((summary) => ({
      taxRateCode: summary.taxRateCode,
      taxRate: summary.taxRate.toFixed(2),
      taxableBase: summary.taxableBase.toFixed(2),
      taxAmount: summary.taxAmount.toFixed(2),
      total: summary.total.toFixed(2)
    })),
    dueDates: invoice.dueDates.map((dueDate) => ({
      id: dueDate.id,
      position: dueDate.position,
      dueDate: formatDateOnly(dueDate.dueDate),
      amount: dueDate.amount.toFixed(2),
      paymentMethod: dueDate.paymentMethod,
      status: dueDate.status
    })),
    totals: {
      subtotal: invoice.subtotal.toFixed(2),
      discountTotal: invoice.discountTotal.toFixed(2),
      taxableBase: invoice.taxableBase.toFixed(2),
      taxAmount: invoice.taxAmount.toFixed(2),
      total: invoice.total.toFixed(2)
    },
    createdAt: invoice.createdAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString()
  };
}

function mapInvoiceListItem(invoice: InvoiceListRecord): InvoiceListItem {
  return {
    id: invoice.id,
    status: invoice.status,
    number: invoice.number,
    series: invoice.series,
    year: invoice.year,
    customer: {
      id: invoice.customerId,
      code: invoice.customerCodeSnapshot,
      legalName: invoice.customerLegalNameSnapshot
    },
    issueDate: formatDateOnly(invoice.issueDate),
    operationDate: formatDateOnly(invoice.operationDate),
    paymentStatus: invoice.paymentStatus,
    verifactuStatus: invoice.verifactuStatus,
    total: invoice.total.toFixed(2),
    createdAt: invoice.createdAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString()
  };
}

function fiscalAddressSnapshot(customer: {
  fiscalAddressLine: string;
  fiscalPostalCode: string;
  fiscalCity: string;
  fiscalProvince: string | null;
  fiscalCountry: string;
}): Prisma.InputJsonObject {
  return {
    line1: customer.fiscalAddressLine,
    postalCode: customer.fiscalPostalCode,
    city: customer.fiscalCity,
    province: customer.fiscalProvince,
    country: customer.fiscalCountry
  };
}

function calculateDueDate(
  issueDate: Date,
  customer: {
    paymentTermsType: "IMMEDIATE" | "DAYS" | "FIXED_DAY_OF_MONTH";
    paymentDays: number | null;
    paymentFixedDay: number | null;
  }
): Date {
  if (customer.paymentTermsType === "DAYS") {
    return addUtcDays(issueDate, customer.paymentDays ?? 0);
  }

  if (customer.paymentTermsType === "FIXED_DAY_OF_MONTH") {
    return fixedDayDueDate(issueDate, customer.paymentFixedDay ?? 1);
  }

  return issueDate;
}

function fixedDayDueDate(issueDate: Date, day: number): Date {
  const year = issueDate.getUTCFullYear();
  const month = issueDate.getUTCMonth();
  const targetMonth = issueDate.getUTCDate() <= day ? month : month + 1;
  const lastDay = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();

  return new Date(Date.UTC(year, targetMonth, Math.min(day, lastDay)));
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + days
  ));
}

function formatInvoiceNumber(series: string, year: number, sequence: number): string {
  return `${series}${year.toString().slice(-2)}${sequence.toString().padStart(5, "0")}`;
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

function customerNotFound(): CustomerNotFoundResult {
  return {
    ok: false,
    status: 404,
    error: {
      code: "CUSTOMER_NOT_FOUND",
      message: "El cliente no existe."
    }
  };
}

function customerNotActive(): CustomerNotActiveResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CUSTOMER_NOT_ACTIVE",
      message: "El cliente no esta activo."
    }
  };
}

function invoiceNotFound(): InvoiceNotFoundResult {
  return {
    ok: false,
    status: 404,
    error: {
      code: "INVOICE_NOT_FOUND",
      message: "La factura no existe."
    }
  };
}

function invoiceNotEditable(): InvoiceNotEditableResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "INVOICE_NOT_EDITABLE",
      message: "La factura no esta en borrador."
    }
  };
}

function invoiceNotIssuable(): InvoiceNotIssuableResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "INVOICE_NOT_ISSUABLE",
      message: "La factura no se puede emitir."
    }
  };
}

function invoiceEmpty(): InvoiceNotIssuableResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "INVOICE_EMPTY",
      message: "La factura no tiene lineas."
    }
  };
}

function invoiceChronologyViolation(): InvoiceNotIssuableResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "INVOICE_CHRONOLOGY_VIOLATION",
      message: "La fecha de emision rompe el orden cronologico de la serie."
    }
  };
}

function catalogItemNotFound(): CatalogItemNotFoundResult {
  return {
    ok: false,
    status: 422,
    error: {
      code: "CATALOG_ITEM_NOT_FOUND",
      message: "El elemento de catalogo no existe o no esta activo."
    }
  };
}

function catalogTaxRateNotFound(): CatalogTaxRateNotFoundResult {
  return {
    ok: false,
    status: 422,
    error: {
      code: "CATALOG_TAX_RATE_NOT_FOUND",
      message: "El tipo de IVA no existe o no esta activo."
    }
  };
}
