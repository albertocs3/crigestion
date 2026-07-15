import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";
import { pgcPymesInitialAccounts, pgcPymesPlan } from "./pgcPymes";

export const createAccountingFiscalYearSchema = z
  .object({
    year: z.coerce.number().int().min(2000).max(2100)
  })
  .strict();

export type AccountingFiscalYearDto = {
  id: string;
  year: number;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED";
  planCode: string;
  planVersion: string;
  accountCount: number;
  closedAt: string | null;
};

export type CreateAccountingFiscalYearResult =
  | { ok: true; status: 201; value: AccountingFiscalYearDto }
  | {
      ok: false;
      status: 409;
      error: { code: "ACCOUNTING_ALREADY_INITIALIZED" | "FISCAL_YEAR_ALREADY_EXISTS"; message: string };
    };

export type CloseAccountingFiscalYearResult =
  | { ok: true; status: 200; value: { closed: AccountingFiscalYearDto; next: AccountingFiscalYearDto } }
  | {
      ok: false;
      status: 404 | 409;
      error: {
        code: "FISCAL_YEAR_NOT_FOUND" | "FISCAL_YEAR_NOT_OPEN" | "NEXT_FISCAL_YEAR_ALREADY_EXISTS";
        message: string;
      };
    };

const fiscalYearSelect = {
  id: true,
  year: true,
  startDate: true,
  endDate: true,
  status: true,
  planCode: true,
  planVersion: true,
  closedAt: true,
  _count: { select: { accounts: true } }
} satisfies Prisma.AccountingFiscalYearSelect;

export async function listAccountingFiscalYears(): Promise<AccountingFiscalYearDto[]> {
  const records = await prisma.accountingFiscalYear.findMany({
    orderBy: { year: "desc" },
    select: fiscalYearSelect
  });

  return records.map(mapFiscalYear);
}

export async function createInitialAccountingFiscalYear(
  year: number,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CreateAccountingFiscalYearResult> {
  const result = await prisma.$transaction(async (tx) => {
    const installation = await tx.installation.findFirstOrThrow({
      where: { status: "INITIALIZED" },
      select: { companyId: true }
    });

    if (!installation.companyId) {
      throw new Error("Initialized installation without company.");
    }

    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "companies" WHERE "id" = ${installation.companyId}::uuid FOR UPDATE`
    );
    const existingCount = await tx.accountingFiscalYear.count({
      where: { companyId: installation.companyId }
    });

    if (existingCount > 0) {
      return { kind: "already-initialized" as const };
    }

    try {
      const fiscalYear = await tx.accountingFiscalYear.create({
        data: {
          companyId: installation.companyId,
          year,
          startDate: new Date(`${year}-01-01T00:00:00.000Z`),
          endDate: new Date(`${year}-12-31T00:00:00.000Z`),
          planCode: pgcPymesPlan.code,
          planVersion: pgcPymesPlan.version,
          createdById: actor.id,
          accounts: {
            create: pgcPymesInitialAccounts.map((account) => ({
              code: account.code,
              name: account.name,
              type: account.type,
              level: account.code.length,
              isPostable: account.isPostable ?? false,
              createdById: actor.id
            }))
          }
        },
        select: fiscalYearSelect
      });

      await tx.auditEvent.create({
        data: {
          eventType: "ACCOUNTING_FISCAL_YEAR_CREATED",
          actorType: "USER",
          payload: {
            actorUserId: actor.id,
            fiscalYearId: fiscalYear.id,
            year,
            planCode: pgcPymesPlan.code,
            planVersion: pgcPymesPlan.version,
            accountCount: fiscalYear._count.accounts,
            ...(context.correlationId ? { correlationId: context.correlationId } : {})
          }
        }
      });

      return { kind: "created" as const, fiscalYear };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return { kind: "year-exists" as const };
      }

      throw error;
    }
  });

  if (result.kind === "already-initialized") {
    return {
      ok: false,
      status: 409,
      error: { code: "ACCOUNTING_ALREADY_INITIALIZED", message: "La contabilidad ya tiene ejercicios." }
    };
  }

  if (result.kind === "year-exists") {
    return {
      ok: false,
      status: 409,
      error: { code: "FISCAL_YEAR_ALREADY_EXISTS", message: "El ejercicio ya existe." }
    };
  }

  return { ok: true, status: 201, value: mapFiscalYear(result.fiscalYear) };
}

export async function closeAccountingFiscalYear(
  fiscalYearId: string,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<CloseAccountingFiscalYearResult> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "accounting_fiscal_years" WHERE "id" = ${fiscalYearId}::uuid FOR UPDATE`
    );
    const source = await tx.accountingFiscalYear.findUnique({
      where: { id: fiscalYearId },
      include: { accounts: { orderBy: { code: "asc" } } }
    });

    if (!source) return { kind: "not-found" as const };
    if (source.status !== "OPEN") return { kind: "not-open" as const };

    const nextYear = source.year + 1;
    const existingNext = await tx.accountingFiscalYear.findFirst({
      where: { companyId: source.companyId, year: nextYear },
      select: { id: true }
    });
    if (existingNext) return { kind: "next-exists" as const };

    const groupedBalances = await tx.accountingJournalLine.groupBy({
      by: ["accountId"],
      where: {
        entry: { fiscalYearId: source.id, status: "POSTED" }
      },
      _sum: { debit: true, credit: true }
    });
    const balances = new Map(
      groupedBalances.map((balance) => [
        balance.accountId,
        (balance._sum.debit ?? new Prisma.Decimal(0)).minus(
          balance._sum.credit ?? new Prisma.Decimal(0)
        )
      ])
    );
    const resultAccount = source.accounts.find((account) => account.code === "129000000");
    const resultLines = source.accounts
      .filter((account) => /^[67]/.test(account.code) && account.isPostable)
      .flatMap((account) => {
        const balance = balances.get(account.id) ?? new Prisma.Decimal(0);
        if (balance.isZero()) return [];
        return [closingLine(account.id, account.name, balance)];
      });
    const resultBalance = resultLines.reduce(
      (total, line) => total.plus(line.debit).minus(line.credit),
      new Prisma.Decimal(0)
    );

    if (resultLines.length > 0) {
      if (!resultAccount || !resultAccount.isPostable) {
        throw new Error("Missing postable 129000000 result account.");
      }
      resultLines.push({
        accountId: resultAccount.id,
        concept: "Resultado del ejercicio",
        debit: resultBalance.isNegative() ? resultBalance.abs() : new Prisma.Decimal(0),
        credit: resultBalance.isPositive() ? resultBalance : new Prisma.Decimal(0)
      });
      balances.set(
        resultAccount.id,
        (balances.get(resultAccount.id) ?? new Prisma.Decimal(0)).minus(resultBalance)
      );
      await createAutomaticEntry(tx, {
        fiscalYearId: source.id,
        year: source.year,
        accountingDate: source.endDate,
        concept: `Regularizacion ejercicio ${source.year}`,
        origin: "REGULARIZATION",
        actorId: actor.id,
        lines: resultLines
      });
    }

    const patrimonialAccounts = source.accounts.filter(
      (account) => /^[1-5]/.test(account.code) && account.isPostable
    );
    const closingLines = patrimonialAccounts.flatMap((account) => {
      const balance = balances.get(account.id) ?? new Prisma.Decimal(0);
      if (balance.isZero()) return [];
      return [closingLine(account.id, account.name, balance)];
    });

    if (closingLines.length > 0) {
      await createAutomaticEntry(tx, {
        fiscalYearId: source.id,
        year: source.year,
        accountingDate: source.endDate,
        concept: `Cierre ejercicio ${source.year}`,
        origin: "CLOSING",
        actorId: actor.id,
        lines: closingLines
      });
    }

    const now = new Date();
    const closed = await tx.accountingFiscalYear.update({
      where: { id: source.id },
      data: { status: "CLOSED", closedAt: now, closedById: actor.id },
      select: fiscalYearSelect
    });
    const next = await tx.accountingFiscalYear.create({
      data: {
        companyId: source.companyId,
        year: nextYear,
        startDate: new Date(`${nextYear}-01-01T00:00:00.000Z`),
        endDate: new Date(`${nextYear}-12-31T00:00:00.000Z`),
        planCode: source.planCode,
        planVersion: source.planVersion,
        sourceFiscalYearId: source.id,
        createdById: actor.id,
        accounts: {
          create: source.accounts.map((account) => ({
            sourceAccountId: account.id,
            code: account.code,
            name: account.name,
            status: account.status,
            type: account.type,
            level: account.level,
            isPostable: account.isPostable,
            createdById: actor.id
          }))
        }
      },
      select: fiscalYearSelect
    });
    const copiedAccounts = await tx.accountingAccount.findMany({
      where: { fiscalYearId: next.id, sourceAccountId: { not: null } },
      select: { id: true, sourceAccountId: true }
    });
    const copiedAccountBySource = new Map(
      copiedAccounts.map((account) => [account.sourceAccountId!, account.id])
    );
    const openingLines = patrimonialAccounts.flatMap((account) => {
      const balance = balances.get(account.id) ?? new Prisma.Decimal(0);
      const copiedAccountId = copiedAccountBySource.get(account.id);
      if (balance.isZero() || !copiedAccountId) return [];
      return [{
        accountId: copiedAccountId,
        concept: account.name,
        debit: balance.isPositive() ? balance : new Prisma.Decimal(0),
        credit: balance.isNegative() ? balance.abs() : new Prisma.Decimal(0)
      }];
    });

    if (openingLines.length > 0) {
      await createAutomaticEntry(tx, {
        fiscalYearId: next.id,
        year: nextYear,
        accountingDate: new Date(`${nextYear}-01-01T00:00:00.000Z`),
        concept: `Apertura ejercicio ${nextYear}`,
        origin: "OPENING",
        actorId: actor.id,
        lines: openingLines
      });
    }
    await tx.auditEvent.create({
      data: {
        eventType: "ACCOUNTING_FISCAL_YEAR_CLOSED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          fiscalYearId: source.id,
          year: source.year,
          nextFiscalYearId: next.id,
          nextYear,
          copiedAccountCount: next._count.accounts,
          regularizationLineCount: resultLines.length,
          closingLineCount: closingLines.length,
          openingLineCount: openingLines.length,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { kind: "closed" as const, closed, next };
  });

  if (result.kind === "not-found") return failure(404, "FISCAL_YEAR_NOT_FOUND", "El ejercicio no existe.");
  if (result.kind === "not-open") return failure(409, "FISCAL_YEAR_NOT_OPEN", "Solo se puede cerrar un ejercicio abierto.");
  if (result.kind === "next-exists") return failure(409, "NEXT_FISCAL_YEAR_ALREADY_EXISTS", "El ejercicio siguiente ya existe; no se han sobrescrito sus cuentas.");

  return { ok: true, status: 200, value: { closed: mapFiscalYear(result.closed), next: mapFiscalYear(result.next) } };
}

type AutomaticEntryLine = {
  accountId: string;
  concept: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
};

function closingLine(
  accountId: string,
  concept: string,
  balance: Prisma.Decimal
): AutomaticEntryLine {
  return {
    accountId,
    concept,
    debit: balance.isNegative() ? balance.abs() : new Prisma.Decimal(0),
    credit: balance.isPositive() ? balance : new Prisma.Decimal(0)
  };
}

async function createAutomaticEntry(
  tx: Prisma.TransactionClient,
  command: {
    fiscalYearId: string;
    year: number;
    accountingDate: Date;
    concept: string;
    origin: "REGULARIZATION" | "CLOSING" | "OPENING";
    actorId: string;
    lines: AutomaticEntryLine[];
  }
): Promise<void> {
  const totalDebit = command.lines.reduce(
    (total, line) => total.plus(line.debit),
    new Prisma.Decimal(0)
  );
  const totalCredit = command.lines.reduce(
    (total, line) => total.plus(line.credit),
    new Prisma.Decimal(0)
  );
  if (!totalDebit.equals(totalCredit)) {
    throw new Error(`Unbalanced automatic ${command.origin} entry.`);
  }
  const lastEntry = await tx.accountingJournalEntry.findFirst({
    where: { fiscalYearId: command.fiscalYearId },
    orderBy: { sequence: "desc" },
    select: { sequence: true }
  });
  const sequence = (lastEntry?.sequence ?? 0) + 1;
  await tx.accountingJournalEntry.create({
    data: {
      fiscalYearId: command.fiscalYearId,
      year: command.year,
      sequence,
      number: `${command.year}/${sequence.toString().padStart(6, "0")}`,
      accountingDate: command.accountingDate,
      concept: command.concept,
      origin: command.origin,
      totalDebit,
      totalCredit,
      createdById: command.actorId,
      lines: {
        create: command.lines.map((line, index) => ({
          accountId: line.accountId,
          position: index + 1,
          concept: line.concept,
          debit: line.debit,
          credit: line.credit
        }))
      }
    }
  });
}

function mapFiscalYear(record: Prisma.AccountingFiscalYearGetPayload<{ select: typeof fiscalYearSelect }>): AccountingFiscalYearDto {
  return {
    id: record.id,
    year: record.year,
    startDate: record.startDate.toISOString().slice(0, 10),
    endDate: record.endDate.toISOString().slice(0, 10),
    status: record.status,
    planCode: record.planCode,
    planVersion: record.planVersion,
    accountCount: record._count.accounts,
    closedAt: record.closedAt?.toISOString() ?? null
  };
}

function failure(status: 404 | 409, code: "FISCAL_YEAR_NOT_FOUND" | "FISCAL_YEAR_NOT_OPEN" | "NEXT_FISCAL_YEAR_ALREADY_EXISTS", message: string): CloseAccountingFiscalYearResult {
  return { ok: false, status, error: { code, message } };
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
