import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isValidSpanishTaxId } from "@/modules/customers/application/taxIds";
import type {
  RequestContext,
  SessionUser
} from "@/modules/platform/application/auth";

const defaultLimit = 25;
const maxLimit = 100;

const customerTypeSchema = z.enum(["COMPANY", "SELF_EMPLOYED", "INDIVIDUAL"]);
const customerStatusSchema = z.enum(["ACTIVE", "INACTIVE"]);
const customerFiscalTreatmentSchema = z.enum([
  "DOMESTIC",
  "EU",
  "EXPORT",
  "CANARY_CEUTA_MELILLA"
]);
const customerPaymentMethodSchema = z.enum([
  "BANK_TRANSFER",
  "CASH",
  "DIRECT_DEBIT"
]);
const customerPaymentTermsTypeSchema = z.enum([
  "IMMEDIATE",
  "DAYS",
  "FIXED_DAY_OF_MONTH"
]);
const creditLimitSchema = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, "El limite de credito debe tener hasta dos decimales.")
  .nullable();
const bankIbanSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .transform(normalizeIban)
  .refine(isValidIban, "El IBAN no es valido.");
const sepaMandateSchema = z.object({
  reference: z.string().trim().min(1).max(80),
  signedAt: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha de firma debe tener formato AAAA-MM-DD.")
    .refine(isValidSignedAtDate, "La fecha de firma no es valida.")
}).strict();

export const listCustomersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  cursor: z.string().uuid().optional(),
  status: customerStatusSchema.optional(),
  search: z.string().trim().min(1).max(120).optional()
});

export const createCustomerSchema = z.object({
  type: customerTypeSchema,
  legalName: z.string().trim().min(2).max(200),
  tradeName: z.string().trim().min(1).max(160).optional(),
  taxId: z.string().trim().min(3).max(32),
  fiscalTreatment: customerFiscalTreatmentSchema,
  email: z.string().trim().email().optional(),
  phone: z.string().trim().min(3).max(40).optional(),
  fiscalAddressLine: z.string().trim().min(3).max(240),
  fiscalPostalCode: z.string().trim().min(2).max(20),
  fiscalCity: z.string().trim().min(2).max(120),
  fiscalProvince: z.string().trim().min(1).max(120).optional(),
  fiscalCountry: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toLocaleUpperCase("es-ES")),
  defaultPaymentMethod: customerPaymentMethodSchema.default("BANK_TRANSFER"),
  paymentTermsType: customerPaymentTermsTypeSchema.default("IMMEDIATE"),
  paymentDays: z.number().int().min(1).max(365).nullable().default(null),
  paymentFixedDay: z.number().int().min(1).max(31).nullable().default(null),
  creditLimit: creditLimitSchema.default(null),
  bankIban: bankIbanSchema.optional(),
  sepaMandate: sepaMandateSchema.optional(),
  notes: z.string().trim().min(1).max(1000).optional()
}).strict().superRefine(validateCustomerInput);

export const updateCustomerStatusSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("deactivate")
  }).strict(),
  z.object({
    action: z.literal("reactivate")
  }).strict()
]);

export const updateCustomerSchema = z.object({
  type: customerTypeSchema,
  legalName: z.string().trim().min(2).max(200),
  tradeName: z.string().trim().min(1).max(160).nullable(),
  taxId: z.string().trim().min(3).max(32),
  fiscalTreatment: customerFiscalTreatmentSchema,
  email: z.string().trim().email().nullable(),
  phone: z.string().trim().min(3).max(40).nullable(),
  fiscalAddressLine: z.string().trim().min(3).max(240),
  fiscalPostalCode: z.string().trim().min(2).max(20),
  fiscalCity: z.string().trim().min(2).max(120),
  fiscalProvince: z.string().trim().min(1).max(120).nullable(),
  fiscalCountry: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toLocaleUpperCase("es-ES")),
  defaultPaymentMethod: customerPaymentMethodSchema,
  paymentTermsType: customerPaymentTermsTypeSchema,
  paymentDays: z.number().int().min(1).max(365).nullable(),
  paymentFixedDay: z.number().int().min(1).max(31).nullable(),
  creditLimit: creditLimitSchema,
  bankIban: bankIbanSchema.nullable(),
  sepaMandate: sepaMandateSchema.nullable()
}).strict().superRefine(validateCustomerInput);

export type ListCustomersCommand = z.infer<typeof listCustomersSchema>;
export type CreateCustomerCommand = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerStatusCommand = z.infer<typeof updateCustomerStatusSchema>;
export type UpdateCustomerCommand = z.infer<typeof updateCustomerSchema>;

export type CustomerListItem = {
  id: string;
  code: string;
  type: "COMPANY" | "SELF_EMPLOYED" | "INDIVIDUAL";
  status: "ACTIVE" | "INACTIVE";
  legalName: string;
  tradeName: string | null;
  taxId: string;
  fiscalTreatment: "DOMESTIC" | "EU" | "EXPORT" | "CANARY_CEUTA_MELILLA";
  email: string | null;
  phone: string | null;
  fiscalAddress: {
    line: string;
    postalCode: string;
    city: string;
    province: string | null;
    country: string;
  };
  commercialTerms: {
    defaultPaymentMethod: "BANK_TRANSFER" | "CASH" | "DIRECT_DEBIT";
    paymentTermsType: "IMMEDIATE" | "DAYS" | "FIXED_DAY_OF_MONTH";
    paymentDays: number | null;
    paymentFixedDay: number | null;
    creditLimit: string | null;
  };
  bankAccount: {
    iban: string | null;
    sepaMandate: {
      id: string;
      reference: string;
      status: "ACTIVE" | "REVOKED" | "INVALIDATED";
      signedAt: string;
      revokedAt: string | null;
    } | null;
  };
  createdAt: string;
  updatedAt: string;
};

export type CustomerList = {
  customers: CustomerListItem[];
  nextCursor: string | null;
};

export type CustomerDetail = CustomerListItem & {
  stores: Array<{
    id: string;
    code: string;
    name: string;
    status: "ACTIVE" | "INACTIVE";
    isPrimary: boolean;
    city: string;
    country: string;
  }>;
  storeCounts: {
    active: number;
    inactive: number;
  };
};

type CustomerTaxIdAlreadyUsedResult = {
  ok: false;
  status: 409;
  error: {
    code: "CUSTOMER_TAX_ID_ALREADY_USED";
    message: string;
  };
};

type CustomerSepaMandateReferenceAlreadyUsedResult = {
  ok: false;
  status: 409;
  error: {
    code: "CUSTOMER_SEPA_MANDATE_REFERENCE_ALREADY_USED";
    message: string;
  };
};

type CustomerTaxIdLockedByIssuedInvoicesResult = {
  ok: false;
  status: 409;
  error: {
    code: "CUSTOMER_TAX_ID_LOCKED_BY_ISSUED_INVOICES";
    message: string;
  };
};

export type CreateCustomerResult =
  | { ok: true; status: 201; value: CustomerListItem }
  | CustomerTaxIdAlreadyUsedResult
  | CustomerSepaMandateReferenceAlreadyUsedResult;

export type UpdateCustomerStatusResult =
  | { ok: true; status: 200; value: CustomerListItem }
  | {
      ok: false;
      status: 404 | 409;
      error: {
        code: "CUSTOMER_NOT_FOUND" | "CUSTOMER_STATUS_ALREADY_SET";
        message: string;
      };
    };

export type UpdateCustomerResult =
  | { ok: true; status: 200; value: CustomerListItem }
  | CustomerTaxIdAlreadyUsedResult
  | CustomerSepaMandateReferenceAlreadyUsedResult
  | CustomerTaxIdLockedByIssuedInvoicesResult
  | {
      ok: false;
      status: 404;
      error: {
        code: "CUSTOMER_NOT_FOUND";
        message: string;
      };
    };

export async function listCustomers(
  command: ListCustomersCommand,
  actor: SessionUser
): Promise<CustomerList> {
  const where: Prisma.CustomerWhereInput = {
    ...(command.status ? { status: command.status } : {}),
    ...(command.search
      ? {
          OR: [
            { code: { contains: command.search, mode: "insensitive" } },
            { legalName: { contains: command.search, mode: "insensitive" } },
            { tradeName: { contains: command.search, mode: "insensitive" } },
            { taxId: { contains: command.search, mode: "insensitive" } }
          ]
        }
      : {})
  };
  const customers = await prisma.customer.findMany({
    where,
    orderBy: [{ legalName: "asc" }, { id: "asc" }],
    cursor: command.cursor ? { id: command.cursor } : undefined,
    skip: command.cursor ? 1 : 0,
    take: command.limit + 1,
    select: customerListSelect
  });
  const page = customers.slice(0, command.limit);

  await prisma.auditEvent.create({
    data: {
      eventType: "CUSTOMERS_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        status: command.status ?? null,
        hasSearch: Boolean(command.search),
        limit: command.limit,
        cursor: command.cursor ?? null,
        resultCount: page.length
      }
    }
  });

  return {
    customers: page.map(mapCustomerListItem),
    nextCursor: customers.length > command.limit ? page.at(-1)?.id ?? null : null
  };
}

export async function getCustomerDetail(
  customerId: string,
  actor: SessionUser
): Promise<CustomerDetail | null> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      ...customerListSelect,
      stores: {
        orderBy: [{ isPrimary: "desc" }, { name: "asc" }, { id: "asc" }],
        select: {
          id: true,
          code: true,
          name: true,
          status: true,
          isPrimary: true,
          city: true,
          country: true
        }
      },
      _count: {
        select: {
          stores: true
        }
      }
    }
  });

  if (!customer) {
    return null;
  }

  await prisma.auditEvent.create({
    data: {
      eventType: "CUSTOMER_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        customerId,
        customerCode: customer.code,
        storeCount: customer._count.stores
      }
    }
  });

  return {
    ...mapCustomerListItem(customer),
    stores: customer.stores,
    storeCounts: {
      active: customer.stores.filter((store) => store.status === "ACTIVE").length,
      inactive: customer.stores.filter((store) => store.status === "INACTIVE").length
    }
  };
}

export async function createCustomer(
  command: CreateCustomerCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CreateCustomerResult> {
  const normalizedTaxId = normalizeTaxId(command.taxId);
  const bankIban = command.bankIban ? normalizeIban(command.bankIban) : undefined;
  const sepaMandate = command.sepaMandate
    ? {
        reference: command.sepaMandate.reference,
        referenceNormalized: normalizeSepaMandateReference(command.sepaMandate.reference),
        signedAt: parseSignedAtDate(command.sepaMandate.signedAt)
      }
    : null;

  try {
    const customer = await prisma.$transaction(async (tx) => {
      const code = await nextCustomerCode(tx);
      const createdCustomer = await tx.customer.create({
        data: {
          code,
          type: command.type,
          status: "ACTIVE",
          legalName: command.legalName,
          tradeName: command.tradeName,
          taxId: command.taxId,
          normalizedTaxId,
          fiscalTreatment: command.fiscalTreatment,
          email: command.email,
          phone: command.phone,
          fiscalAddressLine: command.fiscalAddressLine,
          fiscalPostalCode: command.fiscalPostalCode,
          fiscalCity: command.fiscalCity,
          fiscalProvince: command.fiscalProvince,
          fiscalCountry: command.fiscalCountry,
          defaultPaymentMethod: command.defaultPaymentMethod,
          paymentTermsType: command.paymentTermsType,
          paymentDays: command.paymentDays,
          paymentFixedDay: command.paymentFixedDay,
          creditLimit: command.creditLimit,
          bankIban,
          notes: command.notes,
          createdById: actor.id
        },
        select: {
          id: true,
          code: true,
          type: true,
          fiscalTreatment: true
        }
      });

      if (sepaMandate) {
        const createdMandate = await tx.customerSepaMandate.create({
          data: {
            customerId: createdCustomer.id,
            reference: sepaMandate.reference,
            referenceNormalized: sepaMandate.referenceNormalized,
            status: "ACTIVE",
            signedAt: sepaMandate.signedAt,
            createdById: actor.id
          },
          select: {
            id: true,
            reference: true,
            status: true
          }
        });

        await tx.auditEvent.create({
          data: {
            eventType: "CUSTOMER_SEPA_MANDATE_CREATED",
            actorType: "USER",
            payload: {
              actorUserId: actor.id,
              customerId: createdCustomer.id,
              customerCode: createdCustomer.code,
              mandateId: createdMandate.id,
              reference: createdMandate.reference,
              status: createdMandate.status,
              ...(context.correlationId ? { correlationId: context.correlationId } : {})
            }
          }
        });
      }

      await tx.auditEvent.create({
        data: {
          eventType: "CUSTOMER_CREATED",
          actorType: "USER",
          payload: {
            actorUserId: actor.id,
            customerId: createdCustomer.id,
            customerCode: createdCustomer.code,
            type: createdCustomer.type,
            fiscalTreatment: createdCustomer.fiscalTreatment,
            ...(context.correlationId ? { correlationId: context.correlationId } : {})
          }
        }
      });

      return tx.customer.findUniqueOrThrow({
        where: { id: createdCustomer.id },
        select: customerListSelect
      });
    });

    return {
      ok: true,
      status: 201,
      value: mapCustomerListItem(customer)
    };
  } catch (error) {
    if (isUniqueConstraintError(error, "normalizedTaxId")) {
      return customerTaxIdAlreadyUsed();
    }

    if (isUniqueConstraintError(error, "referenceNormalized")) {
      return customerSepaMandateReferenceAlreadyUsed();
    }

    throw error;
  }
}

export async function updateCustomerStatus(
  customerId: string,
  command: UpdateCustomerStatusCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<UpdateCustomerStatusResult> {
  const nextStatus = command.action === "deactivate" ? "INACTIVE" : "ACTIVE";
  const eventType =
    command.action === "deactivate" ? "CUSTOMER_DEACTIVATED" : "CUSTOMER_REACTIVATED";

  const result = await prisma.$transaction(async (tx) => {
    const existingCustomer = await tx.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        status: true,
        code: true
      }
    });

    if (!existingCustomer) {
      return { kind: "not-found" as const };
    }

    if (existingCustomer.status === nextStatus) {
      return { kind: "already-set" as const };
    }

    const updatedCustomer = await tx.customer.update({
      where: { id: customerId },
      data: {
        status: nextStatus,
        updatedById: actor.id
      },
      select: customerListSelect
    });

    await tx.auditEvent.create({
      data: {
        eventType,
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          customerId,
          customerCode: existingCustomer.code,
          previousStatus: existingCustomer.status,
          newStatus: nextStatus,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { kind: "updated" as const, customer: updatedCustomer };
  });

  if (result.kind === "not-found") {
    return {
      ok: false,
      status: 404,
      error: {
        code: "CUSTOMER_NOT_FOUND",
        message: "El cliente no existe."
      }
    };
  }

  if (result.kind === "already-set") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "CUSTOMER_STATUS_ALREADY_SET",
        message: "El cliente ya esta en ese estado."
      }
    };
  }

  return {
    ok: true,
    status: 200,
    value: mapCustomerListItem(result.customer)
  };
}

export async function updateCustomer(
  customerId: string,
  command: UpdateCustomerCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<UpdateCustomerResult> {
  const normalizedTaxId = normalizeTaxId(command.taxId);
  const bankIban = command.bankIban ? normalizeIban(command.bankIban) : null;
  const nextSepaMandate = command.sepaMandate
    ? {
        reference: command.sepaMandate.reference,
        referenceNormalized: normalizeSepaMandateReference(command.sepaMandate.reference),
        signedAt: parseSignedAtDate(command.sepaMandate.signedAt)
      }
    : null;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existingCustomer = await tx.customer.findUnique({
        where: { id: customerId },
        select: {
          id: true,
          code: true,
          type: true,
          legalName: true,
          tradeName: true,
          taxId: true,
          normalizedTaxId: true,
          fiscalTreatment: true,
          email: true,
          phone: true,
          fiscalAddressLine: true,
          fiscalPostalCode: true,
          fiscalCity: true,
          fiscalProvince: true,
          fiscalCountry: true,
          defaultPaymentMethod: true,
          paymentTermsType: true,
          paymentDays: true,
          paymentFixedDay: true,
          creditLimit: true,
          bankIban: true,
          sepaMandates: {
            where: { status: "ACTIVE" },
            take: 1,
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              reference: true,
              referenceNormalized: true,
              signedAt: true
            }
          }
        }
      });

      if (!existingCustomer) {
        return { kind: "not-found" as const };
      }

      const taxIdChanged =
        existingCustomer.taxId !== command.taxId ||
        existingCustomer.normalizedTaxId !== normalizedTaxId;
      const taxIdLocked =
        taxIdChanged && (await hasIssuedInvoicesForCustomer(tx, customerId));

      if (taxIdLocked) {
        return { kind: "tax-id-locked" as const };
      }

      const changedFields = changedCustomerFields(existingCustomer, {
        ...command,
        normalizedTaxId,
        bankIban
      });
      const existingSepaMandate = existingCustomer.sepaMandates[0] ?? null;
      const bankIbanChanged = existingCustomer.bankIban !== bankIban;
      const sepaMandateChanged = hasSepaMandateChanged(
        existingSepaMandate,
        nextSepaMandate
      );
      const shouldReplaceSepaMandate = bankIbanChanged || sepaMandateChanged;
      const auditedChangedFields = shouldReplaceSepaMandate
        ? [...changedFields, "sepaMandate"]
        : changedFields;

      if (shouldReplaceSepaMandate) {
        const revokedAt = new Date();

        await tx.customerSepaMandate.updateMany({
          where: {
            customerId,
            status: "ACTIVE"
          },
          data: {
            status: bankIbanChanged ? "INVALIDATED" : "REVOKED",
            revokedAt,
            revokedById: actor.id
          }
        });

        if (existingSepaMandate) {
          await tx.auditEvent.create({
            data: {
              eventType: bankIbanChanged
                ? "CUSTOMER_SEPA_MANDATE_INVALIDATED"
                : "CUSTOMER_SEPA_MANDATE_REVOKED",
              actorType: "USER",
              payload: {
                actorUserId: actor.id,
                customerId,
                customerCode: existingCustomer.code,
                mandateId: existingSepaMandate.id,
                reference: existingSepaMandate.reference,
                reason: bankIbanChanged ? "BANK_IBAN_CHANGED" : "MANDATE_REPLACED",
                ...(context.correlationId ? { correlationId: context.correlationId } : {})
              }
            }
          });
        }
      }

      const updatedCustomer = await tx.customer.update({
        where: { id: customerId },
        data: {
          type: command.type,
          legalName: command.legalName,
          tradeName: command.tradeName,
          taxId: command.taxId,
          normalizedTaxId,
          fiscalTreatment: command.fiscalTreatment,
          email: command.email,
          phone: command.phone,
          fiscalAddressLine: command.fiscalAddressLine,
          fiscalPostalCode: command.fiscalPostalCode,
          fiscalCity: command.fiscalCity,
          fiscalProvince: command.fiscalProvince,
          fiscalCountry: command.fiscalCountry,
          defaultPaymentMethod: command.defaultPaymentMethod,
          paymentTermsType: command.paymentTermsType,
          paymentDays: command.paymentDays,
          paymentFixedDay: command.paymentFixedDay,
          creditLimit: command.creditLimit,
          bankIban,
          updatedById: actor.id
        },
        select: customerListSelect
      });

      if (nextSepaMandate && shouldReplaceSepaMandate) {
        const createdMandate = await tx.customerSepaMandate.create({
          data: {
            customerId,
            reference: nextSepaMandate.reference,
            referenceNormalized: nextSepaMandate.referenceNormalized,
            status: "ACTIVE",
            signedAt: nextSepaMandate.signedAt,
            createdById: actor.id
          },
          select: {
            id: true,
            reference: true,
            status: true
          }
        });

        await tx.auditEvent.create({
          data: {
            eventType: "CUSTOMER_SEPA_MANDATE_CREATED",
            actorType: "USER",
            payload: {
              actorUserId: actor.id,
              customerId,
              customerCode: existingCustomer.code,
              mandateId: createdMandate.id,
              reference: createdMandate.reference,
              status: createdMandate.status,
              ...(context.correlationId ? { correlationId: context.correlationId } : {})
            }
          }
        });
      }

      await tx.auditEvent.create({
        data: {
          eventType: "CUSTOMER_UPDATED",
          actorType: "USER",
          payload: {
            actorUserId: actor.id,
            customerId,
            customerCode: existingCustomer.code,
            changedFields: auditedChangedFields,
            ...(context.correlationId ? { correlationId: context.correlationId } : {})
          }
        }
      });

      const freshCustomer = shouldReplaceSepaMandate
        ? await tx.customer.findUniqueOrThrow({
            where: { id: customerId },
            select: customerListSelect
          })
        : updatedCustomer;

      return { kind: "updated" as const, customer: freshCustomer };
    });

    if (result.kind === "not-found") {
      return {
        ok: false,
        status: 404,
        error: {
          code: "CUSTOMER_NOT_FOUND",
          message: "El cliente no existe."
        }
      };
    }

    if (result.kind === "tax-id-locked") {
      return customerTaxIdLockedByIssuedInvoices();
    }

    return {
      ok: true,
      status: 200,
      value: mapCustomerListItem(result.customer)
    };
  } catch (error) {
    if (isUniqueConstraintError(error, "normalizedTaxId")) {
      return customerTaxIdAlreadyUsed();
    }

    if (isUniqueConstraintError(error, "referenceNormalized")) {
      return customerSepaMandateReferenceAlreadyUsed();
    }

    throw error;
  }
}

async function hasIssuedInvoicesForCustomer(
  tx: Prisma.TransactionClient,
  customerId: string
): Promise<boolean> {
  const issuedInvoiceCount = await tx.invoice.count({
    where: {
      customerId,
      status: {
        not: "DRAFT"
      }
    }
  });

  return issuedInvoiceCount > 0;
}

export function normalizeTaxId(value: string): string {
  return value
    .trim()
    .replace(/[\s.-]/g, "")
    .toLocaleUpperCase("es-ES");
}

export function normalizeIban(value: string): string {
  return value.replace(/\s/g, "").toLocaleUpperCase("es-ES");
}

export function normalizeSepaMandateReference(value: string): string {
  return value.trim().replace(/\s+/g, "").toLocaleUpperCase("es-ES");
}

export function isValidIban(value: string): boolean {
  const normalized = normalizeIban(value);

  if (!/^[A-Z]{2}[0-9A-Z]{13,32}$/.test(normalized)) {
    return false;
  }

  const rearranged = `${normalized.slice(4)}${normalized.slice(0, 4)}`;
  let remainder = 0;

  for (const character of rearranged) {
    const numericValue = /[A-Z]/.test(character)
      ? (character.charCodeAt(0) - 55).toString()
      : character;

    for (const digit of numericValue) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }

  return remainder === 1;
}

function isValidSignedAtDate(value: string): boolean {
  const date = parseSignedAtDate(value);

  return !Number.isNaN(date.getTime()) && formatDateOnly(date) === value;
}

function parseSignedAtDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function hasSepaMandateChanged(
  previous: {
    referenceNormalized: string;
    signedAt: Date;
  } | null,
  next: {
    referenceNormalized: string;
    signedAt: Date;
  } | null
): boolean {
  if (!previous || !next) {
    return previous !== next;
  }

  return (
    previous.referenceNormalized !== next.referenceNormalized ||
    formatDateOnly(previous.signedAt) !== formatDateOnly(next.signedAt)
  );
}

function changedCustomerFields(
  previous: {
    type: CustomerListItem["type"];
    legalName: string;
    tradeName: string | null;
    taxId: string;
    normalizedTaxId: string;
    fiscalTreatment: CustomerListItem["fiscalTreatment"];
    email: string | null;
    phone: string | null;
    fiscalAddressLine: string;
    fiscalPostalCode: string;
    fiscalCity: string;
    fiscalProvince: string | null;
    fiscalCountry: string;
    defaultPaymentMethod: CustomerListItem["commercialTerms"]["defaultPaymentMethod"];
    paymentTermsType: CustomerListItem["commercialTerms"]["paymentTermsType"];
    paymentDays: number | null;
    paymentFixedDay: number | null;
    creditLimit: Prisma.Decimal | null;
    bankIban: string | null;
  },
  next: UpdateCustomerCommand & { normalizedTaxId: string }
): string[] {
  return [
    previous.type !== next.type ? "type" : null,
    previous.legalName !== next.legalName ? "legalName" : null,
    previous.tradeName !== next.tradeName ? "tradeName" : null,
    previous.taxId !== next.taxId || previous.normalizedTaxId !== next.normalizedTaxId
      ? "taxId"
      : null,
    previous.fiscalTreatment !== next.fiscalTreatment ? "fiscalTreatment" : null,
    previous.email !== next.email ? "email" : null,
    previous.phone !== next.phone ? "phone" : null,
    previous.fiscalAddressLine !== next.fiscalAddressLine ? "fiscalAddressLine" : null,
    previous.fiscalPostalCode !== next.fiscalPostalCode ? "fiscalPostalCode" : null,
    previous.fiscalCity !== next.fiscalCity ? "fiscalCity" : null,
    previous.fiscalProvince !== next.fiscalProvince ? "fiscalProvince" : null,
    previous.fiscalCountry !== next.fiscalCountry ? "fiscalCountry" : null,
    previous.defaultPaymentMethod !== next.defaultPaymentMethod
      ? "defaultPaymentMethod"
      : null,
    previous.paymentTermsType !== next.paymentTermsType ? "paymentTermsType" : null,
    previous.paymentDays !== next.paymentDays ? "paymentDays" : null,
    previous.paymentFixedDay !== next.paymentFixedDay ? "paymentFixedDay" : null,
    decimalString(previous.creditLimit) !== next.creditLimit ? "creditLimit" : null,
    previous.bankIban !== next.bankIban ? "bankIban" : null
  ].filter((field): field is string => Boolean(field));
}

const customerListSelect = {
  id: true,
  code: true,
  type: true,
  status: true,
  legalName: true,
  tradeName: true,
  taxId: true,
  fiscalTreatment: true,
  email: true,
  phone: true,
  fiscalAddressLine: true,
  fiscalPostalCode: true,
  fiscalCity: true,
  fiscalProvince: true,
  fiscalCountry: true,
  defaultPaymentMethod: true,
  paymentTermsType: true,
  paymentDays: true,
  paymentFixedDay: true,
  creditLimit: true,
  bankIban: true,
  sepaMandates: {
    where: { status: "ACTIVE" },
    take: 1,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      reference: true,
      status: true,
      signedAt: true,
      revokedAt: true
    }
  },
  createdAt: true,
  updatedAt: true
} satisfies Prisma.CustomerSelect;

function mapCustomerListItem(customer: {
  id: string;
  code: string;
  type: CustomerListItem["type"];
  status: CustomerListItem["status"];
  legalName: string;
  tradeName: string | null;
  taxId: string;
  fiscalTreatment: CustomerListItem["fiscalTreatment"];
  email: string | null;
  phone: string | null;
  fiscalAddressLine: string;
  fiscalPostalCode: string;
  fiscalCity: string;
  fiscalProvince: string | null;
  fiscalCountry: string;
  defaultPaymentMethod: CustomerListItem["commercialTerms"]["defaultPaymentMethod"];
  paymentTermsType: CustomerListItem["commercialTerms"]["paymentTermsType"];
  paymentDays: number | null;
  paymentFixedDay: number | null;
  creditLimit: Prisma.Decimal | null;
  bankIban: string | null;
  sepaMandates: Array<{
    id: string;
    reference: string;
    status: "ACTIVE" | "REVOKED" | "INVALIDATED";
    signedAt: Date;
    revokedAt: Date | null;
  }>;
  createdAt: Date;
  updatedAt: Date;
}): CustomerListItem {
  return {
    id: customer.id,
    code: customer.code,
    type: customer.type,
    status: customer.status,
    legalName: customer.legalName,
    tradeName: customer.tradeName,
    taxId: customer.taxId,
    fiscalTreatment: customer.fiscalTreatment,
    email: customer.email,
    phone: customer.phone,
    fiscalAddress: {
      line: customer.fiscalAddressLine,
      postalCode: customer.fiscalPostalCode,
      city: customer.fiscalCity,
      province: customer.fiscalProvince,
      country: customer.fiscalCountry
    },
    commercialTerms: {
      defaultPaymentMethod: customer.defaultPaymentMethod,
      paymentTermsType: customer.paymentTermsType,
      paymentDays: customer.paymentDays,
      paymentFixedDay: customer.paymentFixedDay,
      creditLimit: decimalString(customer.creditLimit)
    },
    bankAccount: {
      iban: customer.bankIban,
      sepaMandate: customer.sepaMandates[0]
        ? {
            id: customer.sepaMandates[0].id,
            reference: customer.sepaMandates[0].reference,
            status: customer.sepaMandates[0].status,
            signedAt: formatDateOnly(customer.sepaMandates[0].signedAt),
            revokedAt: customer.sepaMandates[0].revokedAt?.toISOString() ?? null
          }
        : null
    },
    createdAt: customer.createdAt.toISOString(),
    updatedAt: customer.updatedAt.toISOString()
  };
}

function validatePaymentTerms(
  value: {
    paymentTermsType: "IMMEDIATE" | "DAYS" | "FIXED_DAY_OF_MONTH";
    paymentDays: number | null;
    paymentFixedDay: number | null;
  },
  context: z.RefinementCtx
): void {
  if (value.paymentTermsType === "IMMEDIATE") {
    if (value.paymentDays !== null || value.paymentFixedDay !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paymentTermsType"],
        message: "El pago al contado no admite dias de vencimiento."
      });
    }
    return;
  }

  if (value.paymentTermsType === "DAYS") {
    if (value.paymentDays === null || value.paymentFixedDay !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paymentDays"],
        message: "El vencimiento a dias requiere indicar dias y no dia fijo."
      });
    }
    return;
  }

  if (value.paymentFixedDay === null || value.paymentDays !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["paymentFixedDay"],
      message: "El vencimiento a dia fijo requiere dia fijo y no dias."
    });
  }
}

function validateCustomerInput(
  value: {
    taxId: string;
    fiscalCountry: string;
    defaultPaymentMethod: "BANK_TRANSFER" | "CASH" | "DIRECT_DEBIT";
    paymentTermsType: "IMMEDIATE" | "DAYS" | "FIXED_DAY_OF_MONTH";
    paymentDays: number | null;
    paymentFixedDay: number | null;
    bankIban?: string | null;
    sepaMandate?: { reference: string; signedAt: string } | null;
  },
  context: z.RefinementCtx
): void {
  validatePaymentTerms(value, context);

  if (value.fiscalCountry === "ES" && !isValidSpanishTaxId(value.taxId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["taxId"],
      message: "El NIF, NIE o CIF no es valido."
    });
  }

  if (value.defaultPaymentMethod === "DIRECT_DEBIT") {
    if (!value.bankIban) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bankIban"],
        message: "La domiciliacion requiere informar el IBAN."
      });
    }

    if (!value.sepaMandate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sepaMandate"],
        message: "La domiciliacion requiere un mandato SEPA firmado."
      });
    }
  }
}

function decimalString(value: Prisma.Decimal | null): string | null {
  return value?.toFixed(2) ?? null;
}

async function nextCustomerCode(tx: Prisma.TransactionClient): Promise<string> {
  const result = await tx.$queryRaw<Array<{ value: bigint }>>`
    SELECT nextval('customer_code_seq') AS value
  `;
  const value = result[0]?.value;

  if (value === undefined) {
    throw new Error("CUSTOMER_CODE_SEQUENCE_UNAVAILABLE");
  }

  return value.toString();
}

function customerTaxIdAlreadyUsed(): CustomerTaxIdAlreadyUsedResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CUSTOMER_TAX_ID_ALREADY_USED",
      message: "El identificador fiscal ya esta asignado a otro cliente."
    }
  };
}

function customerSepaMandateReferenceAlreadyUsed(): CustomerSepaMandateReferenceAlreadyUsedResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CUSTOMER_SEPA_MANDATE_REFERENCE_ALREADY_USED",
      message: "La referencia del mandato SEPA ya esta asignada."
    }
  };
}

function customerTaxIdLockedByIssuedInvoices(): CustomerTaxIdLockedByIssuedInvoicesResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "CUSTOMER_TAX_ID_LOCKED_BY_ISSUED_INVOICES",
      message: "El NIF del cliente no puede cambiarse cuando existen facturas emitidas."
    }
  };
}

function isUniqueConstraintError(error: unknown, field: string): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }

  const target = error.meta?.target;

  if (Array.isArray(target)) {
    return target.includes(field);
  }

  return (
    typeof target === "string" &&
    target.toLocaleLowerCase("es-ES").includes(field.toLocaleLowerCase("es-ES"))
  );
}
