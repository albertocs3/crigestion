import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { normalizeDateOnlyInput } from "@/modules/billing/application/invoices";

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
  .regex(/^\d{1,12}(\.\d{1,2})?$/, "El importe debe tener hasta dos decimales.")
  .default("0.00");

export const createAccountingAccountSchema = z.object({
  code: z.string().trim().regex(/^\d{1,9}$/, "La cuenta debe contener hasta nueve digitos."),
  name: z.string().trim().min(2).max(180),
  type: z.string().trim().min(2).max(80),
  level: z.coerce.number().int().min(1).max(9),
  isPostable: z.boolean().default(true)
}).strict();

export const createManualJournalEntrySchema = z.object({
  accountingDate: dateOnlySchema,
  concept: z.string().trim().min(2).max(240),
  lines: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        concept: z.string().trim().min(1).max(240),
        debit: moneySchema,
        credit: moneySchema
      }).strict()
    )
    .min(2)
    .max(200)
}).strict();

export const listJournalEntriesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().uuid().optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional()
});

export const listAccountingAccountsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  search: z.string().trim().min(1).max(120).optional()
});

export type CreateAccountingAccountCommand = z.infer<typeof createAccountingAccountSchema>;
export type CreateManualJournalEntryCommand = z.infer<typeof createManualJournalEntrySchema>;
export type ListJournalEntriesCommand = z.infer<typeof listJournalEntriesSchema>;
export type ListAccountingAccountsCommand = z.infer<typeof listAccountingAccountsSchema>;

export type AccountingAccountDto = {
  id: string;
  code: string;
  name: string;
  status: "ACTIVE" | "INACTIVE";
  type: string;
  level: number;
  isPostable: boolean;
};

export type JournalEntryDto = {
  id: string;
  year: number;
  sequence: number;
  number: string;
  accountingDate: string;
  concept: string;
  origin: "MANUAL";
  status: "POSTED" | "VOIDED";
  totalDebit: string;
  totalCredit: string;
  lines: Array<{
    id: string;
    position: number;
    concept: string;
    debit: string;
    credit: string;
    account: {
      id: string;
      code: string;
      name: string;
    };
  }>;
};

export type JournalEntryList = {
  entries: JournalEntryDto[];
  nextCursor: string | null;
};

export type AccountingAccountList = {
  accounts: AccountingAccountDto[];
  nextCursor: string | null;
};

export type CreateAccountingAccountResult =
  | { ok: true; status: 201; value: AccountingAccountDto }
  | {
      ok: false;
      status: 409;
      error: {
        code: "ACCOUNT_CODE_ALREADY_EXISTS" | "ACCOUNT_NOT_POSTABLE_CODE";
        message: string;
      };
    };

export type CreateManualJournalEntryResult =
  | { ok: true; status: 201; value: JournalEntryDto }
  | {
      ok: false;
      status: 409;
      error: {
        code: "JOURNAL_ENTRY_NOT_BALANCED" | "ACCOUNT_NOT_POSTABLE";
        message: string;
      };
    };

const journalEntrySelect = {
  id: true,
  year: true,
  sequence: true,
  number: true,
  accountingDate: true,
  concept: true,
  origin: true,
  status: true,
  totalDebit: true,
  totalCredit: true,
  lines: {
    orderBy: { position: "asc" },
    select: {
      id: true,
      position: true,
      concept: true,
      debit: true,
      credit: true,
      account: {
        select: {
          id: true,
          code: true,
          name: true
        }
      }
    }
  }
} satisfies Prisma.AccountingJournalEntrySelect;

type JournalEntryRecord = Prisma.AccountingJournalEntryGetPayload<{
  select: typeof journalEntrySelect;
}>;

export async function createAccountingAccount(
  command: CreateAccountingAccountCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CreateAccountingAccountResult> {
  if (command.isPostable && !/^\d{9}$/.test(command.code)) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "ACCOUNT_NOT_POSTABLE_CODE",
        message: "Solo las subcuentas de nueve digitos pueden ser imputables."
      }
    };
  }

  try {
    const account = await prisma.accountingAccount.create({
      data: {
        code: command.code,
        name: command.name,
        type: command.type,
        level: command.level,
        isPostable: command.isPostable,
        createdById: actor.id
      }
    });

    await prisma.auditEvent.create({
      data: {
        eventType: "ACCOUNTING_ACCOUNT_CREATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          accountId: account.id,
          code: account.code,
          isPostable: account.isPostable,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { ok: true, status: 201, value: mapAccount(account) };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return {
        ok: false,
        status: 409,
        error: {
          code: "ACCOUNT_CODE_ALREADY_EXISTS",
          message: "Ya existe una cuenta con ese codigo."
        }
      };
    }

    throw error;
  }
}

export async function createManualJournalEntry(
  command: CreateManualJournalEntryCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CreateManualJournalEntryResult> {
  const normalizedLines = command.lines.map((line, index) => ({
    ...line,
    position: index + 1,
    debit: new Prisma.Decimal(line.debit),
    credit: new Prisma.Decimal(line.credit)
  }));
  const hasDebit = normalizedLines.some((line) => line.debit.gt(0));
  const hasCredit = normalizedLines.some((line) => line.credit.gt(0));
  const invalidSide = normalizedLines.some(
    (line) => line.debit.equals(line.credit) || (line.debit.gt(0) && line.credit.gt(0))
  );
  const totalDebit = normalizedLines.reduce(
    (total, line) => total.plus(line.debit),
    new Prisma.Decimal(0)
  );
  const totalCredit = normalizedLines.reduce(
    (total, line) => total.plus(line.credit),
    new Prisma.Decimal(0)
  );

  if (!hasDebit || !hasCredit || invalidSide || !totalDebit.equals(totalCredit)) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "JOURNAL_ENTRY_NOT_BALANCED",
        message: "El asiento debe estar cuadrado y tener lineas de debe y haber."
      }
    };
  }

  const result = await prisma.$transaction(async (tx) => {
    const accountIds = [...new Set(normalizedLines.map((line) => line.accountId))];
    const accounts = await tx.accountingAccount.findMany({
      where: {
        id: { in: accountIds },
        status: "ACTIVE",
        isPostable: true
      },
      select: { id: true }
    });

    if (accounts.length !== accountIds.length) {
      return { kind: "account-not-postable" as const };
    }

    const accountingDate = parseDateOnly(command.accountingDate);
    const year = accountingDate.getUTCFullYear();
    const lastEntry = await tx.accountingJournalEntry.findFirst({
      where: { year },
      orderBy: { sequence: "desc" },
      select: { sequence: true }
    });
    const sequence = (lastEntry?.sequence ?? 0) + 1;
    const number = `${year}/${sequence.toString().padStart(6, "0")}`;
    const entry = await tx.accountingJournalEntry.create({
      data: {
        year,
        sequence,
        number,
        accountingDate,
        concept: command.concept,
        origin: "MANUAL",
        totalDebit,
        totalCredit,
        createdById: actor.id,
        lines: {
          create: normalizedLines.map((line) => ({
            accountId: line.accountId,
            position: line.position,
            concept: line.concept,
            debit: line.debit,
            credit: line.credit
          }))
        }
      },
      select: journalEntrySelect
    });

    await tx.auditEvent.create({
      data: {
        eventType: "ACCOUNTING_JOURNAL_ENTRY_CREATED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          journalEntryId: entry.id,
          number: entry.number,
          year,
          totalDebit: totalDebit.toFixed(2),
          totalCredit: totalCredit.toFixed(2),
          lineCount: normalizedLines.length,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { kind: "created" as const, entry };
  });

  if (result.kind === "account-not-postable") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "ACCOUNT_NOT_POSTABLE",
        message: "Todas las lineas deben usar cuentas imputables activas."
      }
    };
  }

  return { ok: true, status: 201, value: mapJournalEntry(result.entry) };
}

export async function listJournalEntries(
  command: ListJournalEntriesCommand,
  actor: SessionUser
): Promise<JournalEntryList> {
  const records = await prisma.accountingJournalEntry.findMany({
    where: {
      ...(command.year ? { year: command.year } : {}),
      status: "POSTED"
    },
    orderBy: [{ accountingDate: "desc" }, { sequence: "desc" }],
    cursor: command.cursor ? { id: command.cursor } : undefined,
    skip: command.cursor ? 1 : 0,
    take: command.limit + 1,
    select: journalEntrySelect
  });
  const page = records.slice(0, command.limit);

  await prisma.auditEvent.create({
    data: {
      eventType: "ACCOUNTING_JOURNAL_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        year: command.year ?? null,
        limit: command.limit,
        cursor: command.cursor ?? null,
        resultCount: page.length
      }
    }
  });

  return {
    entries: page.map(mapJournalEntry),
    nextCursor: records.length > command.limit ? page.at(-1)?.id ?? null : null
  };
}

export async function listAccountingAccounts(
  command: ListAccountingAccountsCommand,
  actor: SessionUser
): Promise<AccountingAccountList> {
  const records = await prisma.accountingAccount.findMany({
    where: {
      ...(command.status ? { status: command.status } : {}),
      ...(command.search
        ? {
            OR: [
              { code: { contains: command.search, mode: "insensitive" } },
              { name: { contains: command.search, mode: "insensitive" } }
            ]
          }
        : {})
    },
    orderBy: [{ code: "asc" }, { id: "asc" }],
    cursor: command.cursor ? { id: command.cursor } : undefined,
    skip: command.cursor ? 1 : 0,
    take: command.limit + 1
  });
  const page = records.slice(0, command.limit);

  await prisma.auditEvent.create({
    data: {
      eventType: "ACCOUNTING_ACCOUNTS_VIEWED",
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
    accounts: page.map(mapAccount),
    nextCursor: records.length > command.limit ? page.at(-1)?.id ?? null : null
  };
}

function mapAccount(account: {
  id: string;
  code: string;
  name: string;
  status: "ACTIVE" | "INACTIVE";
  type: string;
  level: number;
  isPostable: boolean;
}): AccountingAccountDto {
  return {
    id: account.id,
    code: account.code,
    name: account.name,
    status: account.status,
    type: account.type,
    level: account.level,
    isPostable: account.isPostable
  };
}

function mapJournalEntry(entry: JournalEntryRecord): JournalEntryDto {
  return {
    id: entry.id,
    year: entry.year,
    sequence: entry.sequence,
    number: entry.number,
    accountingDate: formatDateOnly(entry.accountingDate),
    concept: entry.concept,
    origin: entry.origin,
    status: entry.status,
    totalDebit: entry.totalDebit.toFixed(2),
    totalCredit: entry.totalCredit.toFixed(2),
    lines: entry.lines.map((line) => ({
      id: line.id,
      position: line.position,
      concept: line.concept,
      debit: line.debit.toFixed(2),
      credit: line.credit.toFixed(2),
      account: line.account
    }))
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
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
