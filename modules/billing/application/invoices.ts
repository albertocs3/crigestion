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
import { commitPreparedVerifactuAltaInTransaction } from "@/modules/billing/application/verifactuPersistence";
import { hashIdempotencyPayload } from "@/modules/platform/application/http";
import { isVerifactuPreparationAllowed } from "@/modules/platform/application/operationalEnvironment";

const defaultLimit = 25;
const maxLimit = 100;

class VerifactuPreparationUnavailableError extends Error {}

const dateOnlySchema = z.preprocess(
  (value) => (typeof value === "string" ? normalizeDateOnlyInput(value) : value),
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener formato AAAA-MM-DD.")
    .refine(isValidDateOnly, "La fecha no es valida.")
);
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
export const replaceInvoiceDueDatesSchema = z.object({
  dueDates: z.array(z.object({
    dueDate: dateOnlySchema,
    amount: moneySchema.refine((value) => new Prisma.Decimal(value).gt(0), "El importe debe ser mayor que cero."),
    paymentMethod: z.enum(["BANK_TRANSFER", "CASH", "DIRECT_DEBIT"])
  }).strict()).min(1).max(24)
}).strict();
export const createInvoiceRectificationSchema = z.object({
  issueDate: dateOnlySchema,
  reason: z
    .enum([
      "DATA_ERROR",
      "AMOUNT_ERROR",
      "RETURN",
      "LATE_DISCOUNT",
      "OPERATION_CANCELLED",
      "UNPAID",
      "OTHER"
    ])
    .default("OTHER"),
  fiscalClassification: z.literal("R4_OTHER").optional(),
  notes: z.string().trim().min(1).max(1000).nullable().default(null)
}).strict();
export const listInvoicesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  cursor: z.string().uuid().optional(),
  status: z.enum(["DRAFT", "ISSUED", "RECTIFIED", "VOIDED"]).optional(),
  paymentStatus: z.enum(["PENDING", "PARTIALLY_PAID", "PAID", "PARTIALLY_SETTLED", "SETTLED", "NOT_APPLICABLE", "UNPAID", "CANCELLED"]).optional(),
  customerId: z.string().uuid().optional(),
  search: z.string().trim().min(1).max(120).optional()
});

export type CreateInvoiceDraftCommand = z.infer<typeof createInvoiceDraftSchema>;
export type AddInvoiceLineCommand = z.infer<typeof addInvoiceLineSchema>;
export type IssueInvoiceCommand = z.infer<typeof issueInvoiceSchema>;
export type ReplaceInvoiceDueDatesCommand = z.infer<typeof replaceInvoiceDueDatesSchema>;
export type CreateInvoiceRectificationCommand = z.infer<
  typeof createInvoiceRectificationSchema
>;
export type ListInvoicesCommand = z.infer<typeof listInvoicesSchema>;

export type VerifactuAltaPreparationInput = {
  idempotencyKey: string;
  correction?: {
    rejectedRecordId: string;
    subsanacion: "S";
    rechazoPrevio: "X";
  };
  invoice: {
    id: string;
    companyId: string;
    documentType: "STANDARD" | "RECTIFICATION";
    rectification?: null | {
      originalInvoiceNumber: string;
      originalIssueDate: string;
    };
    issuerName: string;
    issuerTaxId: string;
    series: string;
    number: string;
    issueDate: string;
    operationDate: string;
    customerCode: string;
    customerLegalName: string;
    customerTaxId: string;
    customerFiscalTreatment: string;
    customerFiscalAddress: Prisma.JsonValue;
    subtotal: string;
    discountTotal: string;
    taxableBase: string;
    taxAmount: string;
    total: string;
    lines: Array<{
      position: number;
      description: string;
      lineTaxableBase: string;
      lineTaxAmount: string;
      lineTotal: string;
    }>;
    taxSummaries: Array<{
      taxRateCode: string;
      taxRate: string;
      taxableBase: string;
      taxAmount: string;
      total: string;
    }>;
  };
  installation: {
    id: string;
    environment: "TEST" | "PRODUCTION";
    contractVersion: string;
    schemaVersion: string;
    artifactManifestVersion: string;
    artifactManifestSha256: string;
    nextPosition: bigint;
    previousRecordId: string | null;
    previousRecordHash: string | null;
    previousInvoiceNumber: string | null;
    previousInvoiceIssueDate: string | null;
    producerTaxId: string;
    producerName: string;
    systemName: string;
    systemId: string;
    systemVersion: string;
    installationNumber: string;
  };
};

export type VerifactuAltaPreparer = (input: VerifactuAltaPreparationInput) =>
  | {
      ok: true;
      value: {
        preparationKey: string;
        generatedAt: Date;
        canonicalizationVersion: string;
        recordHash: string;
        payloadCiphertext: Uint8Array;
        payloadSha256: string;
        encryptionKeyId: string;
        qrUrl: string | null;
      };
    }
  | { ok: false; error: { code: string } };

export type IssueInvoiceDependencies = {
  prepareVerifactuAlta?: VerifactuAltaPreparer;
  verifactuEnabled?: boolean;
  verifactuEnvironment?: "TEST" | "PRODUCTION";
};

type IssueInvoiceRequestContext = Pick<RequestContext, "correlationId"> & {
  idempotencyKey?: string;
  requestHash?: string;
};

export function hashInvoiceRectificationBody(command: CreateInvoiceRectificationCommand): string {
  return hashIdempotencyPayload("invoice-rectification:v2", command);
}

export async function readInvoiceRectificationReplay(key: string, requestHash: string): Promise<CreateInvoiceRectificationResult | null> {
  const stored = await prisma.idempotencyRecord.findUnique({ where: { key } });
  if (!stored) return null;
  if (stored.requestHash !== requestHash) return idempotencyKeyReused();
  const invoiceId = readStoredInvoiceId(stored.responseBody);
  const invoice = invoiceId ? await prisma.invoice.findUnique({ where: { id: invoiceId }, select: invoiceDetailSelect }) : null;
  if (!invoice) return idempotencyReplayInvalid();
  return { ok: true, status: 200, value: mapInvoiceDetail(invoice) };
}

export type InvoiceListItem = {
  id: string;
  documentType: InvoiceDetail["documentType"];
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
  documentType: "STANDARD" | "RECTIFICATION";
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
  rectificationReason: string | null;
  rectifiesInvoice: {
    id: string;
    number: string | null;
  } | null;
  rectificationInvoices: Array<{
    id: string;
    number: string | null;
  }>;
  accountingEntry: {
    id: string;
    number: string;
  } | null;
  voidingAccountingEntry: {
    id: string;
    number: string;
  } | null;
  paymentStatus: "PENDING" | "PARTIALLY_PAID" | "PAID" | "PARTIALLY_SETTLED" | "SETTLED" | "NOT_APPLICABLE" | "UNPAID" | "CANCELLED";
  verifactuStatus:
    | "NOT_APPLICABLE"
    | "PENDING"
    | "SENT"
    | "ACCEPTED"
    | "ACCEPTED_WITH_ERRORS"
    | "REJECTED"
    | "CANCELLED";
  verifactuTrace: null | {
    recordType: "ALTA" | "ANULACION";
    cancellationReasonCode: "ISSUED_BY_MISTAKE" | "DUPLICATE_INVOICE" | "WRONG_FISCAL_IDENTITY" | null;
    chainPosition: string;
    generatedAt: string;
    installationCode: string;
    environment: "TEST" | "PRODUCTION";
    operationalStatus: "PENDING" | "PROCESSING" | "RECONCILIATION_REQUIRED" | "ACTION_REQUIRED" | "COMPLETED";
    queue: null | { id: string; operation: "SUBMIT" | "RECONCILE"; status: "PENDING" | "CLAIMED" | "PROCESSED" | "DEAD"; attemptCount: number; maxAttempts: number; nextAttemptAt: string; lastErrorCode: string | null };
    latestAttempt: null | { kind: "SUBMIT" | "RECONCILE"; outcome: "ACCEPTED" | "ACCEPTED_WITH_ERRORS" | "REJECTED" | "RETRYABLE_FAILURE" | "UNKNOWN"; completedAt: string; stableErrorCode: string | null };
  };
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
    paidAmount: string;
    creditAppliedAmount: string;
    pendingAmount: string;
    paymentMethod: "BANK_TRANSFER" | "CASH" | "DIRECT_DEBIT";
    status: "PENDING" | "PAID" | "SETTLED" | "RETURNED" | "UNPAID" | "CANCELLED";
    remittance: {
      id: string;
      number: string;
      status: string;
    } | null;
  }>;
  payments: Array<{
    id: string;
    dueDateId: string;
    source: "MANUAL" | "SEPA_REMITTANCE";
    paymentDate: string;
    amount: string;
    returnedAmount: string;
    netAmount: string;
    reference: string | null;
    createdAt: string;
    accountingEntry: {
      id: string;
      number: string;
    } | null;
  }>;
  paymentReturns: Array<{
    id: string;
    paymentId: string;
    dueDateId: string;
    returnDate: string;
    amount: string;
    reasonCode: string | null;
    createdAt: string;
    accountingEntry: {
      id: string;
      number: string;
    } | null;
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
    code: "INVOICE_NOT_ISSUABLE" | "INVOICE_EMPTY" | "INVOICE_CHRONOLOGY_VIOLATION" | "INVOICE_DUE_DATES_TOTAL_MISMATCH" | "INVOICE_DUE_DATE_BEFORE_ISSUE_DATE" | "INVOICE_ACCOUNTING_FISCAL_YEAR_NOT_OPEN" | "INVOICE_ACCOUNTING_ACCOUNT_NOT_AVAILABLE" | "INVOICE_ACCOUNTING_ENTRY_UNBALANCED";
    message: string;
  };
};

type InvoiceVerifactuUnavailableResult = {
  ok: false;
  status: 503;
  error: {
    code: "INVOICE_VERIFACTU_PREPARATION_UNAVAILABLE";
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

export type ReplaceInvoiceDueDatesResult =
  | { ok: true; status: 200; value: InvoiceDetail }
  | InvoiceNotFoundResult
  | InvoiceNotEditableResult
  | InvoiceNotIssuableResult;

export type IssueInvoiceResult =
  | { ok: true; status: 200; value: InvoiceDetail }
  | InvoiceNotFoundResult
  | InvoiceNotIssuableResult
  | InvoiceVerifactuUnavailableResult;

type InvoiceNotRectifiableResult = {
  ok: false;
  status: 409;
  error: {
    code:
      | "INVOICE_NOT_RECTIFIABLE"
      | "INVOICE_ALREADY_RECTIFIED"
      | "INVOICE_RECTIFICATION_CHRONOLOGY_VIOLATION"
      | "INVOICE_RECTIFICATION_FINANCIAL_ACTIVITY"
      | "INVOICE_RECTIFICATION_VERIFACTU_UNAVAILABLE"
      | "IDEMPOTENCY_KEY_REUSED"
      | "IDEMPOTENCY_REPLAY_INVALID";
    message: string;
  };
};

export type CreateInvoiceRectificationResult =
  | { ok: true; status: 200 | 201; value: InvoiceDetail }
  | InvoiceNotFoundResult
  | InvoiceNotRectifiableResult
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

  const latestFiscalRecord = invoice.verifactuFiscalRecords[0] ?? null;
  let cancellationReasonCode = latestFiscalRecord ? readCancellationReason(latestFiscalRecord.fiscalSnapshot) : null;
  if (latestFiscalRecord?.recordType === "ANULACION" && !cancellationReasonCode) {
    cancellationReasonCode = (await prisma.$queryRaw<Array<{ reasonCode: string | null }>>`
      SELECT "payload"->>'reasonCode' AS "reasonCode"
      FROM "audit_events"
      WHERE "eventType" = 'VERIFACTU_CANCELLATION_PREPARED'
        AND "payload"->>'fiscalRecordId' = ${latestFiscalRecord.id}
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 1
    `)[0]?.reasonCode ?? null;
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

  return mapInvoiceDetailForTreasury(invoice, cancellationReasonCode);
}

export async function createInvoiceDraft(
  command: CreateInvoiceDraftCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CreateInvoiceDraftResult> {
  const result = await prisma.$transaction(async (tx) => {
    const installation = await tx.installation.findFirst({
      where: { companyId: { not: null } },
      select: { companyId: true }
    });
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
        companyId: installation?.companyId,
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

export async function replaceInvoiceDueDates(
  invoiceId: string,
  command: ReplaceInvoiceDueDatesCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<ReplaceInvoiceDueDatesResult> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "invoices" WHERE "id" = ${invoiceId}::uuid FOR UPDATE`
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "invoice_due_dates" WHERE "invoiceId" = ${invoiceId}::uuid ORDER BY "id" FOR UPDATE`
    );
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, documentType: true, status: true, issueDate: true, total: true }
    });
    if (!invoice) return { kind: "not-found" as const };
    if (invoice.status !== "DRAFT" || invoice.documentType !== "STANDARD") {
      return { kind: "not-editable" as const };
    }
    const total = command.dueDates.reduce(
      (sum, dueDate) => sum.plus(dueDate.amount),
      new Prisma.Decimal(0)
    );
    if (!total.equals(invoice.total)) return { kind: "total-mismatch" as const };
    if (command.dueDates.some((dueDate) => parseDateOnly(dueDate.dueDate) < invoice.issueDate)) {
      return { kind: "before-issue" as const };
    }
    await tx.invoiceDueDate.deleteMany({ where: { invoiceId } });
    await tx.invoiceDueDate.createMany({
      data: command.dueDates.map((dueDate, index) => ({
        invoiceId,
        position: index + 1,
        dueDate: parseDateOnly(dueDate.dueDate),
        amount: dueDate.amount,
        paymentMethod: dueDate.paymentMethod
      }))
    });
    await tx.auditEvent.create({
      data: {
        eventType: "INVOICE_DUE_DATES_UPDATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          invoiceId,
          dueDateCount: command.dueDates.length,
          total: total.toFixed(2),
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });
    return { kind: "updated" as const, invoice: await findInvoiceDetail(tx, invoiceId) };
  });
  if (result.kind === "not-found") return invoiceNotFound();
  if (result.kind === "not-editable") return invoiceNotEditable();
  if (result.kind === "total-mismatch") return invoiceDueDatesTotalMismatch();
  if (result.kind === "before-issue") return invoiceDueDateBeforeIssueDate();
  return { ok: true, status: 200, value: mapInvoiceDetail(result.invoice) };
}

export async function issueInvoice(
  invoiceId: string,
  command: IssueInvoiceCommand,
  actor: SessionUser,
  context: IssueInvoiceRequestContext = {},
  dependencies: IssueInvoiceDependencies = {}
): Promise<IssueInvoiceResult> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "invoices" WHERE "id" = ${invoiceId}::uuid FOR UPDATE`
    );
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        companyId: true,
        documentType: true,
        company: { select: { legalName: true, taxId: true } },
        status: true,
        paymentStatus: true,
        verifactuStatus: true,
        series: true,
        year: true,
        issueDate: true,
        total: true,
        taxAmount: true,
        customerId: true,
        customerCodeSnapshot: true,
        customerLegalNameSnapshot: true,
        customerTaxIdSnapshot: true,
        customerFiscalTreatmentSnapshot: true,
        customerFiscalAddressSnapshot: true,
        operationDate: true,
        subtotal: true,
        discountTotal: true,
        taxableBase: true,
        lines: {
          select: {
            position: true,
            catalogItemKindSnapshot: true,
            catalogItemCodeSnapshot: true,
            description: true,
            quantity: true,
            unitPrice: true,
            discountPercent: true,
            discountAmount: true,
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
          select: { taxRateCode: true, taxRate: true, taxableBase: true, taxAmount: true, total: true }
        },
        dueDates: { select: { dueDate: true, amount: true } },
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
    const dueDateTotal = invoice.dueDates.reduce(
      (total, dueDate) => total.plus(dueDate.amount),
      new Prisma.Decimal(0)
    );
    if (invoice.dueDates.length === 0 || !dueDateTotal.equals(invoice.total)) {
      return { kind: "due-dates-total-mismatch" as const };
    }
    if (invoice.dueDates.some((dueDate) => dueDate.dueDate < issueDate)) {
      return { kind: "due-date-before-issue" as const };
    }
    const chronologyViolation = await hasChronologyViolation(
      tx,
      invoice.series,
      issueDate
    );

    if (chronologyViolation) {
      return { kind: "chronology-violation" as const };
    }

    const installation = await tx.installation.findFirst({
      where: { companyId: { not: null } },
      select: { companyId: true }
    });
    const fiscalYears = installation?.companyId
      ? await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT "id" FROM "accounting_fiscal_years" WHERE "companyId" = ${installation.companyId}::uuid AND "status" = 'OPEN' AND "startDate" <= ${issueDate} AND "endDate" >= ${issueDate} FOR UPDATE`
        )
      : [];
    const fiscalYear = fiscalYears[0];
    if (!fiscalYear) {
      return { kind: "accounting-fiscal-year-not-open" as const };
    }

    if (!/^\d{1,6}$/.test(invoice.customerCodeSnapshot)) {
      return { kind: "accounting-account-not-available" as const };
    }
    const customerAccountCode = `430${invoice.customerCodeSnapshot.padStart(6, "0")}`;
    const productBase = invoice.lines.reduce(
      (total, line) => line.catalogItemKindSnapshot === "PRODUCT" ? total.plus(line.lineTaxableBase) : total,
      new Prisma.Decimal(0)
    );
    const serviceBase = invoice.lines.reduce(
      (total, line) => line.catalogItemKindSnapshot !== "PRODUCT" ? total.plus(line.lineTaxableBase) : total,
      new Prisma.Decimal(0)
    );
    const requiredCodes = [
      customerAccountCode,
      ...(productBase.isZero() ? [] : ["700000000"]),
      ...(serviceBase.isZero() ? [] : ["705000000"]),
      ...(invoice.taxAmount.isZero() ? [] : ["477000000"])
    ];
    const accounts = await tx.accountingAccount.findMany({
      where: {
        fiscalYearId: fiscalYear.id,
        code: { in: requiredCodes },
        status: "ACTIVE",
        isPostable: true
      },
      select: { id: true, code: true }
    });
    if (accounts.length !== requiredCodes.length) {
      return { kind: "accounting-account-not-available" as const };
    }
    const accountByCode = new Map(accounts.map((account) => [account.code, account.id]));
    const totalCredit = productBase.plus(serviceBase).plus(invoice.taxAmount);
    if (!invoice.total.equals(totalCredit)) {
      return { kind: "accounting-entry-unbalanced" as const };
    }

    const sequence = await reserveInvoiceNumber(tx, invoice.series, issueDate);
    const number = formatInvoiceNumber(invoice.series, sequence.year, sequence.value);

    const lastEntry = await tx.accountingJournalEntry.findFirst({
      where: { fiscalYearId: fiscalYear.id },
      orderBy: { sequence: "desc" },
      select: { sequence: true }
    });
    const journalSequence = (lastEntry?.sequence ?? 0) + 1;
    const journalNumber = `${issueDate.getUTCFullYear()}/${journalSequence.toString().padStart(6, "0")}`;
    const journalConcept = `Factura ${number} - ${invoice.customerLegalNameSnapshot}`.slice(0, 240);
    const creditLines = [
      ...(productBase.isZero() ? [] : [{ code: "700000000", amount: productBase }]),
      ...(serviceBase.isZero() ? [] : [{ code: "705000000", amount: serviceBase }]),
      ...(invoice.taxAmount.isZero() ? [] : [{ code: "477000000", amount: invoice.taxAmount }])
    ];
    const accountingEntry = await tx.accountingJournalEntry.create({
      data: {
        fiscalYearId: fiscalYear.id,
        invoiceId,
        year: issueDate.getUTCFullYear(),
        sequence: journalSequence,
        number: journalNumber,
        accountingDate: issueDate,
        concept: journalConcept,
        origin: "INVOICE",
        totalDebit: invoice.total,
        totalCredit,
        createdById: actor.id,
        lines: {
          create: [
            {
              accountId: accountByCode.get(customerAccountCode)!,
              position: 1,
              concept: journalConcept,
              debit: invoice.total,
              credit: new Prisma.Decimal(0)
            },
            ...creditLines.map((line, index) => ({
              accountId: accountByCode.get(line.code)!,
              position: index + 2,
              concept: journalConcept,
              debit: new Prisma.Decimal(0),
              credit: line.amount
            }))
          ]
        }
      },
      select: { id: true, number: true }
    });

    const verifactuEnabled = dependencies.verifactuEnabled ?? readVerifactuEnabled();
    const verifactuEnvironment = dependencies.verifactuEnvironment ?? readVerifactuEnvironment();

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: "ISSUED",
        verifactuStatus: verifactuEnabled ? "PENDING" : "NOT_APPLICABLE",
        year: sequence.year,
        numberSequence: sequence.value,
        number,
        issueDate,
        issuedAt: new Date(),
        issuedById: actor.id,
        updatedById: actor.id
      }
    });

    if (verifactuEnabled && !verifactuEnvironment) throw new VerifactuPreparationUnavailableError();
    const activeSif = verifactuEnabled && invoice.companyId
      ? (await tx.$queryRaw<Array<{
          id: string;
          contractVersion: string;
          schemaVersion: string;
          artifactManifestVersion: string;
          artifactManifestSha256: string;
          environment: "TEST" | "PRODUCTION";
          nextPosition: bigint;
          lastRecordId: string | null;
          lastRecordHash: string | null;
          previousInvoiceNumber: string | null;
          previousInvoiceIssueDate: Date | null;
          producerTaxId: string;
          producerName: string;
          systemName: string;
          systemId: string;
          systemVersion: string;
          installationNumber: string;
        }>>(Prisma.sql`
          SELECT installation."id", installation."contractVersion", installation."schemaVersion", installation."artifactManifestVersion",
            installation."artifactManifestSha256", installation."environment", installation."nextPosition", installation."lastRecordId", installation."lastRecordHash",
            installation."producerTaxId", installation."producerName", installation."systemName", installation."systemId", installation."systemVersion", installation."installationNumber",
            previous."invoiceNumber" AS "previousInvoiceNumber", previous."invoiceIssueDate" AS "previousInvoiceIssueDate"
          FROM "verifactu_sif_installations" installation
          LEFT JOIN "verifactu_fiscal_records" previous ON previous."id" = installation."lastRecordId"
          WHERE installation."companyId" = ${invoice.companyId}::uuid
            AND installation."environment" = CAST(${verifactuEnvironment} AS "VerifactuEnvironment")
            AND installation."status" = 'ACTIVE'
          FOR UPDATE OF installation
        `))[0]
      : undefined;

    if (verifactuEnabled) {
      if (!activeSif) throw new VerifactuPreparationUnavailableError();
      if (!dependencies.prepareVerifactuAlta || !invoice.companyId || !context.idempotencyKey) {
        throw new VerifactuPreparationUnavailableError();
      }
      const prepared = dependencies.prepareVerifactuAlta({
        idempotencyKey: context.idempotencyKey,
        invoice: {
          id: invoice.id,
          companyId: invoice.companyId,
          documentType: invoice.documentType,
          rectification: null,
          issuerName: invoice.company!.legalName,
          issuerTaxId: invoice.company!.taxId,
          series: invoice.series,
          number,
          issueDate: formatDateOnly(issueDate),
          operationDate: formatDateOnly(invoice.operationDate),
          customerCode: invoice.customerCodeSnapshot,
          customerLegalName: invoice.customerLegalNameSnapshot,
          customerTaxId: invoice.customerTaxIdSnapshot,
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
          id: activeSif.id,
          environment: activeSif.environment,
          contractVersion: activeSif.contractVersion,
          schemaVersion: activeSif.schemaVersion,
          artifactManifestVersion: activeSif.artifactManifestVersion,
          artifactManifestSha256: activeSif.artifactManifestSha256,
          nextPosition: activeSif.nextPosition,
          previousRecordId: activeSif.lastRecordId,
          previousRecordHash: activeSif.lastRecordHash,
          previousInvoiceNumber: activeSif.previousInvoiceNumber,
          previousInvoiceIssueDate: activeSif.previousInvoiceIssueDate ? formatDateOnly(activeSif.previousInvoiceIssueDate) : null,
          producerTaxId: activeSif.producerTaxId,
          producerName: activeSif.producerName,
          systemName: activeSif.systemName,
          systemId: activeSif.systemId,
          systemVersion: activeSif.systemVersion,
          installationNumber: activeSif.installationNumber
        }
      });
      if (!prepared.ok) throw new VerifactuPreparationUnavailableError();
      const committed = await commitPreparedVerifactuAltaInTransaction(tx, {
        invoiceId,
        sifInstallationId: activeSif.id,
        preparationKey: prepared.value.preparationKey,
        generatedAt: prepared.value.generatedAt,
        canonicalizationVersion: prepared.value.canonicalizationVersion,
        expectedPreviousRecordId: activeSif.lastRecordId,
        expectedPreviousHash: activeSif.lastRecordHash,
        recordHash: prepared.value.recordHash,
        payloadCiphertext: prepared.value.payloadCiphertext,
        payloadSha256: prepared.value.payloadSha256,
        encryptionKeyId: prepared.value.encryptionKeyId,
        qrUrl: prepared.value.qrUrl
      }, actor, context);
      if (!committed.ok) throw new VerifactuPreparationUnavailableError();
    } else {
      await tx.invoiceVerifactuRecord.create({ data: { invoiceId, status: "PENDING" } });
    }

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
          accountingJournalEntryId: accountingEntry.id,
          accountingJournalEntryNumber: accountingEntry.number,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return {
      kind: "issued" as const,
      invoice: await findInvoiceDetail(tx, invoiceId)
    };
  }).catch((error: unknown) => {
    if (error instanceof VerifactuPreparationUnavailableError) {
      return { kind: "verifactu-preparation-unavailable" as const };
    }
    throw error;
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
  if (result.kind === "due-dates-total-mismatch") {
    return invoiceDueDatesTotalMismatch();
  }
  if (result.kind === "due-date-before-issue") {
    return invoiceDueDateBeforeIssueDate();
  }
  if (result.kind === "accounting-fiscal-year-not-open") {
    return invoiceAccountingFiscalYearNotOpen();
  }
  if (result.kind === "accounting-account-not-available") {
    return invoiceAccountingAccountNotAvailable();
  }
  if (result.kind === "accounting-entry-unbalanced") {
    return invoiceAccountingEntryUnbalanced();
  }
  if (result.kind === "verifactu-preparation-unavailable") {
    return invoiceVerifactuPreparationUnavailable();
  }

  return {
    ok: true,
    status: 200,
    value: mapInvoiceDetail(result.invoice)
  };
}

export async function createInvoiceRectification(
  invoiceId: string,
  command: CreateInvoiceRectificationCommand,
  actor: SessionUser,
  context: IssueInvoiceRequestContext = {},
  dependencies: IssueInvoiceDependencies = {}
): Promise<CreateInvoiceRectificationResult> {
  if (context.idempotencyKey && context.requestHash) {
    const replay = await readInvoiceRectificationReplay(context.idempotencyKey, context.requestHash);
    if (replay) return replay;
  }
  const result = await prisma.$transaction(async (tx) => {
    if (context.idempotencyKey && context.requestHash) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.idempotencyKey}, 0))`;
      const stored = await tx.idempotencyRecord.findUnique({ where: { key: context.idempotencyKey } });
      if (stored) {
        if (stored.requestHash !== context.requestHash) return { kind: "idempotency-key-reused" as const };
        const storedInvoiceId = readStoredInvoiceId(stored.responseBody);
        if (!storedInvoiceId) return { kind: "idempotency-replay-invalid" as const };
        const storedInvoice = await tx.invoice.findUnique({ where: { id: storedInvoiceId }, select: invoiceDetailSelect });
        if (!storedInvoice) return { kind: "idempotency-replay-invalid" as const };
        return { kind: "replayed" as const, invoice: mapInvoiceDetail(storedInvoice) };
      }
    }
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "invoices" WHERE "id" = ${invoiceId}::uuid FOR UPDATE`
    );
    const original = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        companyId: true,
        company: { select: { legalName: true, taxId: true } },
        documentType: true,
        status: true,
        paymentStatus: true,
        verifactuStatus: true,
        series: true,
        year: true,
        number: true,
        customerId: true,
        customerCodeSnapshot: true,
        customerLegalNameSnapshot: true,
        customerTaxIdSnapshot: true,
        customerFiscalTreatmentSnapshot: true,
        customerFiscalAddressSnapshot: true,
        issueDate: true,
        operationDate: true,
        subtotal: true,
        discountTotal: true,
        taxableBase: true,
        taxAmount: true,
        total: true,
        lines: {
          orderBy: { position: "asc" },
          select: {
            position: true,
            catalogItemId: true,
            catalogItemCodeSnapshot: true,
            catalogItemKindSnapshot: true,
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
            position: true,
            dueDate: true,
            amount: true,
            paymentMethod: true,
            status: true,
            payments: {
              select: {
                amount: true,
                returns: { select: { amount: true } }
              }
            },
            paymentReturns: { select: { amount: true } },
            remittanceLines: { where: { status: "ACTIVE" }, select: { id: true }, take: 1 }
          }
        },
        rectificationInvoices: {
          select: { id: true }
        },
        verifactuFiscalRecords: {
          orderBy: [{ chainPosition: "desc" }, { createdAt: "desc" }],
          take: 1,
          select: {
            recordType: true,
            issuerTaxId: true,
            invoiceNumber: true,
            invoiceIssueDate: true,
            sifInstallation: { select: { environment: true } },
            attempts: { orderBy: { attemptNumber: "desc" }, take: 1, select: { outcome: true } },
            outboxMessages: { select: { status: true } }
          }
        }
      }
    });

    if (!original) {
      return { kind: "invoice-not-found" as const };
    }

    if (original.documentType !== "STANDARD" || original.status !== "ISSUED") {
      return { kind: "invoice-not-rectifiable" as const };
    }

    if (original.rectificationInvoices.length > 0) {
      return { kind: "invoice-already-rectified" as const };
    }
    if (!original.companyId) {
      return { kind: "rectification-verifactu-unavailable" as const };
    }

    const cleanUnpaid = original.paymentStatus === "PENDING" && original.dueDates.every((dueDate) =>
      dueDate.status === "PENDING"
      && dueDate.payments.length === 0
      && dueDate.paymentReturns.length === 0
      && dueDate.remittanceLines.length === 0
    );
    const netPaidAmount = original.dueDates.reduce(
      (invoiceTotal, dueDate) => invoiceTotal.plus(dueDate.payments.reduce(
        (dueTotal, payment) => dueTotal.plus(payment.amount).minus(
          payment.returns.reduce((returnTotal, paymentReturn) => returnTotal.plus(paymentReturn.amount), new Prisma.Decimal(0))
        ),
        new Prisma.Decimal(0)
      )),
      new Prisma.Decimal(0)
    );
    const cleanPaid = original.paymentStatus === "PAID"
      && original.dueDates.every((dueDate) =>
        dueDate.status === "PAID"
        && dueDate.paymentReturns.length === 0
        && dueDate.remittanceLines.length === 0
      )
      && netPaidAmount.equals(original.total);
    if (!cleanUnpaid && !cleanPaid) {
      return { kind: "rectification-financial-activity" as const };
    }

    const verifactuEnabled = dependencies.verifactuEnabled ?? readVerifactuEnabled();
    const verifactuEnvironment = dependencies.verifactuEnvironment ?? readVerifactuEnvironment();
    if (verifactuEnabled && (!verifactuEnvironment || !context.idempotencyKey || !dependencies.prepareVerifactuAlta)) {
      return { kind: "rectification-verifactu-unavailable" as const };
    }
    if (verifactuEnabled && original.verifactuStatus !== "ACCEPTED" && original.verifactuStatus !== "ACCEPTED_WITH_ERRORS") {
      return { kind: "rectification-verifactu-unavailable" as const };
    }
    if (verifactuEnabled && (command.reason === "UNPAID" || command.fiscalClassification !== "R4_OTHER")) {
      return { kind: "rectification-verifactu-unavailable" as const };
    }
    const originalFiscalAlta = original.verifactuFiscalRecords[0];
    const originalFiscalOutcome = originalFiscalAlta?.attempts[0]?.outcome;
    if (verifactuEnabled && (
      !originalFiscalAlta
      || originalFiscalAlta.recordType !== "ALTA"
      || (originalFiscalOutcome !== "ACCEPTED" && originalFiscalOutcome !== "ACCEPTED_WITH_ERRORS")
      || originalFiscalAlta.outboxMessages.length === 0
      || originalFiscalAlta.outboxMessages.some((message) => message.status !== "PROCESSED")
      || originalFiscalAlta.sifInstallation.environment !== verifactuEnvironment
      || originalFiscalAlta.issuerTaxId !== original.company?.taxId
    )) {
      return { kind: "rectification-verifactu-unavailable" as const };
    }
    if (!verifactuEnabled && original.verifactuStatus !== "NOT_APPLICABLE") {
      return { kind: "rectification-verifactu-unavailable" as const };
    }

    const activeSif = verifactuEnabled && original.companyId && verifactuEnvironment
      ? (await tx.$queryRaw<Array<{
          id: string; contractVersion: string; schemaVersion: string; artifactManifestVersion: string;
          artifactManifestSha256: string; environment: "TEST" | "PRODUCTION"; nextPosition: bigint;
          lastRecordId: string | null; lastRecordHash: string | null; previousInvoiceNumber: string | null;
          previousInvoiceIssueDate: Date | null; producerTaxId: string; producerName: string; systemName: string;
          systemId: string; systemVersion: string; installationNumber: string;
        }>>(Prisma.sql`
          SELECT installation."id", installation."contractVersion", installation."schemaVersion", installation."artifactManifestVersion",
            installation."artifactManifestSha256", installation."environment", installation."nextPosition", installation."lastRecordId", installation."lastRecordHash",
            installation."producerTaxId", installation."producerName", installation."systemName", installation."systemId", installation."systemVersion", installation."installationNumber",
            previous."invoiceNumber" AS "previousInvoiceNumber", previous."invoiceIssueDate" AS "previousInvoiceIssueDate"
          FROM "verifactu_sif_installations" installation
          LEFT JOIN "verifactu_fiscal_records" previous ON previous."id" = installation."lastRecordId"
          WHERE installation."companyId" = ${original.companyId}::uuid
            AND installation."environment" = CAST(${verifactuEnvironment} AS "VerifactuEnvironment")
            AND installation."status" = 'ACTIVE'
          FOR UPDATE OF installation
        `))[0]
      : undefined;
    if (verifactuEnabled && !activeSif) return { kind: "rectification-verifactu-unavailable" as const };

    const issueDate = parseDateOnly(command.issueDate);
    const chronologyViolation = await hasChronologyViolation(tx, "R", issueDate);

    if (chronologyViolation) {
      return { kind: "chronology-violation" as const };
    }

    const installation = await tx.installation.findFirst({
      where: { companyId: { not: null } },
      select: { companyId: true }
    });
    const fiscalYears = installation?.companyId
      ? await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT "id" FROM "accounting_fiscal_years" WHERE "companyId" = ${installation.companyId}::uuid AND "status" = 'OPEN' AND "startDate" <= ${issueDate} AND "endDate" >= ${issueDate} FOR UPDATE`
        )
      : [];
    const fiscalYear = fiscalYears[0];
    if (!fiscalYear) {
      return { kind: "accounting-fiscal-year-not-open" as const };
    }
    if (!/^\d{1,6}$/.test(original.customerCodeSnapshot)) {
      return { kind: "accounting-account-not-available" as const };
    }
    const customerAccountCode = `430${original.customerCodeSnapshot.padStart(6, "0")}`;
    const productBase = original.lines.reduce(
      (total, line) => line.catalogItemKindSnapshot === "PRODUCT" ? total.plus(line.lineTaxableBase) : total,
      new Prisma.Decimal(0)
    );
    const serviceBase = original.lines.reduce(
      (total, line) => line.catalogItemKindSnapshot !== "PRODUCT" ? total.plus(line.lineTaxableBase) : total,
      new Prisma.Decimal(0)
    );
    const requiredCodes = [
      customerAccountCode,
      ...(productBase.isZero() ? [] : ["700000000"]),
      ...(serviceBase.isZero() ? [] : ["705000000"]),
      ...(original.taxAmount.isZero() ? [] : ["477000000"])
    ];
    const accounts = await tx.accountingAccount.findMany({
      where: { fiscalYearId: fiscalYear.id, code: { in: requiredCodes }, status: "ACTIVE", isPostable: true },
      select: { id: true, code: true }
    });
    if (accounts.length !== requiredCodes.length) {
      return { kind: "accounting-account-not-available" as const };
    }
    const totalDebit = productBase.plus(serviceBase).plus(original.taxAmount);
    if (!original.total.equals(totalDebit)) {
      return { kind: "accounting-entry-unbalanced" as const };
    }
    const accountByCode = new Map(accounts.map((account) => [account.code, account.id]));

    const sequence = await reserveInvoiceNumber(tx, "R", issueDate);
    const number = formatInvoiceNumber("R", sequence.year, sequence.value);
    const lastEntry = await tx.accountingJournalEntry.findFirst({
      where: { fiscalYearId: fiscalYear.id },
      orderBy: { sequence: "desc" },
      select: { sequence: true }
    });
    const journalSequence = (lastEntry?.sequence ?? 0) + 1;
    const journalNumber = `${issueDate.getUTCFullYear()}/${journalSequence.toString().padStart(6, "0")}`;
    const rectification = await tx.invoice.create({
      data: {
        companyId: original.companyId,
        documentType: "RECTIFICATION",
        origin: "MANUAL",
        status: "ISSUED",
        paymentStatus: "NOT_APPLICABLE",
        verifactuStatus: verifactuEnabled ? "PENDING" : "NOT_APPLICABLE",
        series: "R",
        year: sequence.year,
        numberSequence: sequence.value,
        number,
        customerId: original.customerId,
        customerCodeSnapshot: original.customerCodeSnapshot,
        customerLegalNameSnapshot: original.customerLegalNameSnapshot,
        customerTaxIdSnapshot: original.customerTaxIdSnapshot,
        customerFiscalTreatmentSnapshot: original.customerFiscalTreatmentSnapshot,
        customerFiscalAddressSnapshot:
          original.customerFiscalAddressSnapshot as Prisma.InputJsonValue,
        issueDate,
        operationDate: original.operationDate,
        issuedAt: new Date(),
        subtotal: original.subtotal.neg(),
        discountTotal: original.discountTotal.neg(),
        taxableBase: original.taxableBase.neg(),
        taxAmount: original.taxAmount.neg(),
        total: original.total.neg(),
        notes: command.notes,
        rectificationReason: command.reason,
        rectifiesInvoiceId: original.id,
        createdById: actor.id,
        updatedById: actor.id,
        issuedById: actor.id
      },
      select: { id: true }
    });

    if (original.lines.length > 0) {
      await tx.invoiceLine.createMany({
        data: original.lines.map((line) => ({
          invoiceId: rectification.id,
          position: line.position,
          catalogItemId: line.catalogItemId,
          catalogItemCodeSnapshot: line.catalogItemCodeSnapshot,
          catalogItemKindSnapshot: line.catalogItemKindSnapshot,
          description: line.description,
          quantity: line.quantity.neg(),
          unitPrice: line.unitPrice,
          discountPercent: line.discountPercent,
          discountAmount: line.discountAmount,
          taxRateId: line.taxRateId,
          taxRateCodeSnapshot: line.taxRateCodeSnapshot,
          taxRateNameSnapshot: line.taxRateNameSnapshot,
          taxRateSnapshot: line.taxRateSnapshot,
          lineSubtotal: line.lineSubtotal.neg(),
          lineDiscountTotal: line.lineDiscountTotal.neg(),
          lineTaxableBase: line.lineTaxableBase.neg(),
          lineTaxAmount: line.lineTaxAmount.neg(),
          lineTotal: line.lineTotal.neg()
        }))
      });
    }

    if (original.taxSummaries.length > 0) {
      await tx.invoiceTaxSummary.createMany({
        data: original.taxSummaries.map((summary) => ({
          invoiceId: rectification.id,
          taxRateCode: summary.taxRateCode,
          taxRate: summary.taxRate,
          taxableBase: summary.taxableBase.neg(),
          taxAmount: summary.taxAmount.neg(),
          total: summary.total.neg()
        }))
      });
    }

    const journalConcept = `Rectificativa ${number} de ${original.number ?? original.id}`.slice(0, 240);
    const debitLines = [
      ...(productBase.isZero() ? [] : [{ code: "700000000", amount: productBase }]),
      ...(serviceBase.isZero() ? [] : [{ code: "705000000", amount: serviceBase }]),
      ...(original.taxAmount.isZero() ? [] : [{ code: "477000000", amount: original.taxAmount }])
    ];
    const accountingEntry = await tx.accountingJournalEntry.create({
      data: {
        fiscalYearId: fiscalYear.id,
        invoiceId: rectification.id,
        year: issueDate.getUTCFullYear(),
        sequence: journalSequence,
        number: journalNumber,
        accountingDate: issueDate,
        concept: journalConcept,
        origin: "INVOICE",
        totalDebit,
        totalCredit: original.total,
        createdById: actor.id,
        lines: {
          create: [
            ...debitLines.map((line, index) => ({
              accountId: accountByCode.get(line.code)!,
              position: index + 1,
              concept: journalConcept,
              debit: line.amount,
              credit: new Prisma.Decimal(0)
            })),
            {
              accountId: accountByCode.get(customerAccountCode)!,
              position: debitLines.length + 1,
              concept: journalConcept,
              debit: new Prisma.Decimal(0),
              credit: original.total
            }
          ]
        }
      },
      select: { id: true, number: true }
    });

    if (verifactuEnabled) {
      if (!activeSif || !original.company || !original.number || !dependencies.prepareVerifactuAlta || !context.idempotencyKey) {
        throw new VerifactuPreparationUnavailableError();
      }
      const prepared = dependencies.prepareVerifactuAlta({
        idempotencyKey: context.idempotencyKey,
        invoice: {
          id: rectification.id,
          companyId: original.companyId!,
          documentType: "RECTIFICATION",
          rectification: {
            originalInvoiceNumber: originalFiscalAlta!.invoiceNumber,
            originalIssueDate: formatDateOnly(originalFiscalAlta!.invoiceIssueDate)
          },
          issuerName: original.company.legalName,
          issuerTaxId: originalFiscalAlta!.issuerTaxId,
          series: "R",
          number,
          issueDate: formatDateOnly(issueDate),
          operationDate: formatDateOnly(original.operationDate),
          customerCode: original.customerCodeSnapshot,
          customerLegalName: original.customerLegalNameSnapshot,
          customerTaxId: original.customerTaxIdSnapshot,
          customerFiscalTreatment: original.customerFiscalTreatmentSnapshot,
          customerFiscalAddress: original.customerFiscalAddressSnapshot,
          subtotal: original.subtotal.neg().toFixed(2),
          discountTotal: original.discountTotal.neg().toFixed(2),
          taxableBase: original.taxableBase.neg().toFixed(2),
          taxAmount: original.taxAmount.neg().toFixed(2),
          total: original.total.neg().toFixed(2),
          lines: original.lines.map((line) => ({
            position: line.position,
            description: line.description,
            lineTaxableBase: line.lineTaxableBase.neg().toFixed(2),
            lineTaxAmount: line.lineTaxAmount.neg().toFixed(2),
            lineTotal: line.lineTotal.neg().toFixed(2)
          })),
          taxSummaries: original.taxSummaries.map((summary) => ({
            taxRateCode: summary.taxRateCode,
            taxRate: summary.taxRate.toFixed(2),
            taxableBase: summary.taxableBase.neg().toFixed(2),
            taxAmount: summary.taxAmount.neg().toFixed(2),
            total: summary.total.neg().toFixed(2)
          }))
        },
        installation: {
          id: activeSif.id,
          environment: activeSif.environment,
          contractVersion: activeSif.contractVersion,
          schemaVersion: activeSif.schemaVersion,
          artifactManifestVersion: activeSif.artifactManifestVersion,
          artifactManifestSha256: activeSif.artifactManifestSha256,
          nextPosition: activeSif.nextPosition,
          previousRecordId: activeSif.lastRecordId,
          previousRecordHash: activeSif.lastRecordHash,
          previousInvoiceNumber: activeSif.previousInvoiceNumber,
          previousInvoiceIssueDate: activeSif.previousInvoiceIssueDate ? formatDateOnly(activeSif.previousInvoiceIssueDate) : null,
          producerTaxId: activeSif.producerTaxId,
          producerName: activeSif.producerName,
          systemName: activeSif.systemName,
          systemId: activeSif.systemId,
          systemVersion: activeSif.systemVersion,
          installationNumber: activeSif.installationNumber
        }
      });
      if (!prepared.ok) throw new VerifactuPreparationUnavailableError();
      const committed = await commitPreparedVerifactuAltaInTransaction(tx, {
        invoiceId: rectification.id,
        sifInstallationId: activeSif.id,
        preparationKey: prepared.value.preparationKey,
        generatedAt: prepared.value.generatedAt,
        canonicalizationVersion: prepared.value.canonicalizationVersion,
        expectedPreviousRecordId: activeSif.lastRecordId,
        expectedPreviousHash: activeSif.lastRecordHash,
        recordHash: prepared.value.recordHash,
        payloadCiphertext: prepared.value.payloadCiphertext,
        payloadSha256: prepared.value.payloadSha256,
        encryptionKeyId: prepared.value.encryptionKeyId,
        qrUrl: prepared.value.qrUrl
      }, actor, context);
      if (!committed.ok) throw new VerifactuPreparationUnavailableError();
    } else {
      await tx.invoiceVerifactuRecord.create({ data: { invoiceId: rectification.id, status: "PENDING" } });
    }

    const customerCredit = cleanPaid
      ? await tx.customerCredit.create({
          data: {
            companyId: original.companyId,
            customerId: original.customerId,
            sourceRectificationInvoiceId: rectification.id,
            originalAmount: original.total,
            createdById: actor.id
          },
          select: { id: true }
        })
      : null;

    await tx.invoice.update({
      where: { id: original.id },
      data: {
        status: "RECTIFIED",
        paymentStatus: cleanUnpaid ? "CANCELLED" : "PAID",
        updatedById: actor.id
      }
    });
    if (cleanUnpaid) {
      await tx.invoiceDueDate.updateMany({
        where: { invoiceId: original.id, status: "PENDING" },
        data: { status: "CANCELLED" }
      });
    }

    await tx.auditEvent.create({
      data: {
        eventType: "INVOICE_RECTIFICATION_CREATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          invoiceId: rectification.id,
          rectifiesInvoiceId: original.id,
          originalNumber: original.number,
          number,
          customerId: original.customerId,
          total: original.total.neg().toFixed(2),
          reason: command.reason,
          issueDate: command.issueDate,
          accountingJournalEntryId: accountingEntry.id,
          accountingJournalEntryNumber: accountingEntry.number,
          customerCreditId: customerCredit?.id ?? null,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    if (context.idempotencyKey && context.requestHash) {
      await tx.idempotencyRecord.create({
        data: {
          key: context.idempotencyKey,
          requestHash: context.requestHash,
          responseStatus: 201,
          responseBody: { invoiceId: rectification.id }
        }
      });
    }

    return {
      kind: "created" as const,
      invoice: await findInvoiceDetail(tx, rectification.id)
    };
  }).catch((error: unknown) => {
    if (error instanceof VerifactuPreparationUnavailableError) {
      return { kind: "rectification-verifactu-unavailable" as const };
    }
    throw error;
  });

  if (result.kind === "invoice-not-found") {
    return invoiceNotFound();
  }
  if (result.kind === "idempotency-key-reused") return idempotencyKeyReused();
  if (result.kind === "idempotency-replay-invalid") return idempotencyReplayInvalid();
  if (result.kind === "replayed") return { ok: true, status: 200, value: result.invoice };

  if (result.kind === "invoice-not-rectifiable") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "INVOICE_NOT_RECTIFIABLE",
        message: "Solo se pueden rectificar facturas ordinarias emitidas."
      }
    };
  }

  if (result.kind === "invoice-already-rectified") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "INVOICE_ALREADY_RECTIFIED",
        message: "La factura ya tiene una rectificativa asociada."
      }
    };
  }

  if (result.kind === "chronology-violation") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "INVOICE_RECTIFICATION_CHRONOLOGY_VIOLATION",
        message: "La fecha de emision rompe el orden cronologico de la serie rectificativa."
      }
    };
  }
  if (result.kind === "rectification-financial-activity") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "INVOICE_RECTIFICATION_FINANCIAL_ACTIVITY",
        message: "La factura tiene actividad financiera. La rectificacion permanece bloqueada hasta disponer de creditos y reembolsos."
      }
    };
  }
  if (result.kind === "rectification-verifactu-unavailable") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "INVOICE_RECTIFICATION_VERIFACTU_UNAVAILABLE",
        message: "La rectificativa VeriFactu permanece bloqueada hasta que pueda generar y encolar su ALTA real."
      }
    };
  }
  if (result.kind === "accounting-fiscal-year-not-open") {
    return invoiceAccountingFiscalYearNotOpen();
  }
  if (result.kind === "accounting-account-not-available") {
    return invoiceAccountingAccountNotAvailable();
  }
  if (result.kind === "accounting-entry-unbalanced") {
    return invoiceAccountingEntryUnbalanced();
  }

  return {
    ok: true,
    status: 201,
    value: mapInvoiceDetail(result.invoice)
  };
}

function readStoredInvoiceId(body: Prisma.JsonValue): string | null {
  if (!body || Array.isArray(body) || typeof body !== "object") return null;
  return typeof body.invoiceId === "string" ? body.invoiceId : null;
}

function idempotencyKeyReused(): CreateInvoiceRectificationResult {
  return { ok: false, status: 409, error: { code: "IDEMPOTENCY_KEY_REUSED", message: "La clave de idempotencia ya se uso con otra peticion." } };
}

function idempotencyReplayInvalid(): CreateInvoiceRectificationResult {
  return { ok: false, status: 409, error: { code: "IDEMPOTENCY_REPLAY_INVALID", message: "La respuesta idempotente almacenada no es valida." } };
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
  documentType: true,
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
  rectificationReason: true,
  rectifiesInvoice: {
    select: {
      id: true,
      number: true
    }
  },
  rectificationInvoices: {
    orderBy: [{ issueDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      number: true
    }
  },
  accountingEntry: {
    select: {
      id: true,
      number: true
    }
  },
  voidingAccountingEntry: {
    select: {
      id: true,
      number: true
    }
  },
  paymentStatus: true,
  verifactuStatus: true,
  verifactuFiscalRecords: {
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 1,
    select: {
      id: true, recordType: true, chainPosition: true, generatedAt: true, fiscalSnapshot: true,
      sifInstallation: { select: { installationCode: true, environment: true } },
      outboxMessages: { orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 2, select: { id: true, operation: true, status: true, attemptCount: true, maxAttempts: true, nextAttemptAt: true, lastErrorCode: true } },
      attempts: { orderBy: [{ attemptNumber: "desc" }], take: 1, select: { kind: true, outcome: true, completedAt: true, stableErrorCode: true } }
    }
  },
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
      status: true,
      remittanceLines: {
        where: { status: "ACTIVE" },
        take: 1,
        select: {
          remittance: {
            select: {
              id: true,
              number: true,
              status: true
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
      },
      creditApplications: { select: { amount: true } }
    }
  },
  payments: {
    orderBy: [{ paymentDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      dueDateId: true,
      source: true,
      paymentDate: true,
      amount: true,
      reference: true,
      createdAt: true,
      accountingEntry: {
        select: {
          id: true,
          number: true
        }
      },
      returns: {
        select: {
          amount: true
        }
      }
    }
  },
  paymentReturns: {
    orderBy: [{ returnDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      paymentId: true,
      dueDateId: true,
      returnDate: true,
      amount: true,
      reasonCode: true,
      createdAt: true,
      accountingEntry: {
        select: {
          id: true,
          number: true
        }
      }
    }
  },
  createdAt: true,
  updatedAt: true
} satisfies Prisma.InvoiceSelect;

const invoiceListSelect = {
  id: true,
  documentType: true,
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

export async function findInvoiceDetailForTreasury(
  tx: Prisma.TransactionClient,
  invoiceId: string
): Promise<InvoiceDetailRecord> {
  return tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: invoiceDetailSelect
  });
}

const findInvoiceDetail = findInvoiceDetailForTreasury;

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
  const dueDateCount = await tx.invoiceDueDate.count({ where: { invoiceId } });
  if (dueDateCount === 1) {
    await tx.invoiceDueDate.updateMany({
      where: { invoiceId, position: 1 },
      data: { amount: totals.total }
    });
  }
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

export function mapInvoiceDetailForTreasury(invoice: InvoiceDetailRecord, cancellationReasonOverride: string | null = null): InvoiceDetail {
  return {
    id: invoice.id,
    documentType: invoice.documentType,
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
    rectificationReason: invoice.rectificationReason,
    rectifiesInvoice: invoice.rectifiesInvoice
      ? {
          id: invoice.rectifiesInvoice.id,
          number: invoice.rectifiesInvoice.number
        }
      : null,
    rectificationInvoices: invoice.rectificationInvoices.map((rectification) => ({
      id: rectification.id,
      number: rectification.number
    })),
    accountingEntry: invoice.accountingEntry,
    voidingAccountingEntry: invoice.voidingAccountingEntry,
    paymentStatus: invoice.paymentStatus,
    verifactuStatus: invoice.verifactuStatus,
    verifactuTrace: mapVerifactuTrace(invoice.verifactuFiscalRecords[0] ?? null, cancellationReasonOverride),
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
    dueDates: invoice.dueDates.map((dueDate) => {
      const paidAmount = dueDate.payments.reduce(
        (total, payment) => total.plus(netPaymentAmount(payment)),
        new Prisma.Decimal(0)
      );
      const creditAppliedAmount = dueDate.creditApplications.reduce(
        (total, application) => total.plus(application.amount),
        new Prisma.Decimal(0)
      );
      const pendingAmount = dueDate.status === "CANCELLED"
        ? new Prisma.Decimal(0)
        : Prisma.Decimal.max(new Prisma.Decimal(0), dueDate.amount.minus(paidAmount).minus(creditAppliedAmount));

      return {
        id: dueDate.id,
        position: dueDate.position,
        dueDate: formatDateOnly(dueDate.dueDate),
        amount: dueDate.amount.toFixed(2),
        paidAmount: paidAmount.toFixed(2),
        creditAppliedAmount: creditAppliedAmount.toFixed(2),
        pendingAmount: pendingAmount.toFixed(2),
        paymentMethod: dueDate.paymentMethod,
        status: dueDate.status,
        remittance: dueDate.remittanceLines[0]?.remittance ?? null
      };
    }),
    payments: invoice.payments.map((payment) => {
      const returnedAmount = sumReturnAmounts(payment.returns);
      const netAmount = payment.amount.minus(returnedAmount);

      return {
        id: payment.id,
        dueDateId: payment.dueDateId,
        source: payment.source,
        paymentDate: formatDateOnly(payment.paymentDate),
        amount: payment.amount.toFixed(2),
        returnedAmount: returnedAmount.toFixed(2),
        netAmount: netAmount.toFixed(2),
        reference: payment.reference,
        createdAt: payment.createdAt.toISOString(),
        accountingEntry: payment.accountingEntry
      };
    }),
    paymentReturns: invoice.paymentReturns.map((paymentReturn) => ({
      id: paymentReturn.id,
      paymentId: paymentReturn.paymentId,
      dueDateId: paymentReturn.dueDateId,
      returnDate: formatDateOnly(paymentReturn.returnDate),
      amount: paymentReturn.amount.toFixed(2),
      reasonCode: paymentReturn.reasonCode,
      createdAt: paymentReturn.createdAt.toISOString(),
      accountingEntry: paymentReturn.accountingEntry
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

const mapInvoiceDetail = mapInvoiceDetailForTreasury;

function mapVerifactuTrace(record: InvoiceDetailRecord["verifactuFiscalRecords"][number] | null, cancellationReasonOverride: string | null = null): InvoiceDetail["verifactuTrace"] {
  if (!record) return null;
  const queue = [...record.outboxMessages].sort((left, right) => queuePriority(right) - queuePriority(left))[0] ?? null;
  const attempt = record.attempts[0] ?? null;
  const operationalStatus = queue?.status === "DEAD" ? "ACTION_REQUIRED"
    : queue?.operation === "RECONCILE" && (queue.status === "PENDING" || queue.status === "CLAIMED") ? "RECONCILIATION_REQUIRED"
      : queue?.status === "CLAIMED" ? "PROCESSING"
        : queue?.status === "PENDING" ? "PENDING"
          : "COMPLETED";
  return {
    recordType: record.recordType,
    cancellationReasonCode: normalizeCancellationReason(cancellationReasonOverride ?? readCancellationReason(record.fiscalSnapshot)),
    chainPosition: record.chainPosition.toString(), generatedAt: record.generatedAt.toISOString(),
    installationCode: record.sifInstallation.installationCode, environment: record.sifInstallation.environment, operationalStatus,
    queue: queue ? { id: queue.id, operation: queue.operation, status: queue.status, attemptCount: queue.attemptCount, maxAttempts: queue.maxAttempts, nextAttemptAt: queue.nextAttemptAt.toISOString(), lastErrorCode: queue.lastErrorCode } : null,
    latestAttempt: attempt ? { kind: attempt.kind, outcome: attempt.outcome, completedAt: attempt.completedAt.toISOString(), stableErrorCode: attempt.stableErrorCode } : null
  };
}

function readCancellationReason(snapshot: Prisma.JsonValue): string | null {
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") return null;
  return typeof snapshot.reasonCode === "string" ? snapshot.reasonCode : null;
}

function normalizeCancellationReason(value: string | null): "ISSUED_BY_MISTAKE" | "DUPLICATE_INVOICE" | "WRONG_FISCAL_IDENTITY" | null {
  return value === "ISSUED_BY_MISTAKE" || value === "DUPLICATE_INVOICE" || value === "WRONG_FISCAL_IDENTITY" ? value : null;
}

function queuePriority(message: InvoiceDetailRecord["verifactuFiscalRecords"][number]["outboxMessages"][number]): number {
  if (message.status === "DEAD") return 5;
  if (message.operation === "RECONCILE" && (message.status === "PENDING" || message.status === "CLAIMED")) return 4;
  if (message.status === "CLAIMED") return 3;
  if (message.status === "PENDING") return 2;
  return 1;
}

function mapInvoiceListItem(invoice: InvoiceListRecord): InvoiceListItem {
  return {
    id: invoice.id,
    documentType: invoice.documentType,
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

function netPaymentAmount(payment: {
  amount: Prisma.Decimal;
  returns: Array<{ amount: Prisma.Decimal }>;
}): Prisma.Decimal {
  return payment.amount.minus(sumReturnAmounts(payment.returns));
}

function sumReturnAmounts(
  returns: Array<{ amount: Prisma.Decimal }>
): Prisma.Decimal {
  return returns.reduce(
    (total, paymentReturn) => total.plus(paymentReturn.amount),
    new Prisma.Decimal(0)
  );
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

export function normalizeDateOnlyInput(value: string): string {
  const text = value.trim().replace(/[\u200e\u200f]/g, "");

  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    return text.slice(0, 10);
  }

  const spanishDate = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(text);

  if (!spanishDate) {
    return text;
  }

  const [, day, month, year] = spanishDate;

  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
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

function invoiceAccountingFiscalYearNotOpen(): InvoiceNotIssuableResult {
  return { ok: false, status: 409, error: { code: "INVOICE_ACCOUNTING_FISCAL_YEAR_NOT_OPEN", message: "No hay un ejercicio contable abierto para la fecha de emision." } };
}

function invoiceAccountingAccountNotAvailable(): InvoiceNotIssuableResult {
  return { ok: false, status: 409, error: { code: "INVOICE_ACCOUNTING_ACCOUNT_NOT_AVAILABLE", message: "Falta alguna cuenta contable activa e imputable necesaria para emitir la factura." } };
}

function invoiceAccountingEntryUnbalanced(): InvoiceNotIssuableResult {
  return { ok: false, status: 409, error: { code: "INVOICE_ACCOUNTING_ENTRY_UNBALANCED", message: "El asiento de la factura no esta cuadrado." } };
}

function invoiceVerifactuPreparationUnavailable(): InvoiceVerifactuUnavailableResult {
  return {
    ok: false,
    status: 503,
    error: {
      code: "INVOICE_VERIFACTU_PREPARATION_UNAVAILABLE",
      message: "No se pudo preparar el registro VeriFactu; la factura no se ha emitido."
    }
  };
}

function readVerifactuEnvironment(): "TEST" | "PRODUCTION" | null {
  if (!isVerifactuPreparationAllowed(process.env)) return null;
  const value = process.env.VERIFACTU_ENVIRONMENT?.trim().toLowerCase();
  if (value === "production") return "PRODUCTION";
  if (value === "test" && process.env.APP_ENV !== "production") return "TEST";
  return null;
}

function readVerifactuEnabled(): boolean {
  const value = process.env.VERIFACTU_ENABLED?.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false" || (!value && process.env.APP_ENV !== "production")) return false;
  if (process.env.APP_ENV === "production") throw new VerifactuPreparationUnavailableError();
  return false;
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

function invoiceDueDatesTotalMismatch(): InvoiceNotIssuableResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "INVOICE_DUE_DATES_TOTAL_MISMATCH",
      message: "La suma de los vencimientos debe coincidir exactamente con el total de la factura."
    }
  };
}

function invoiceDueDateBeforeIssueDate(): InvoiceNotIssuableResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "INVOICE_DUE_DATE_BEFORE_ISSUE_DATE",
      message: "Ningun vencimiento puede ser anterior a la fecha de emision."
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
