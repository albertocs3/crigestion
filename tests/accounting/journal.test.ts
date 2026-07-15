import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { login } from "@/modules/platform/application/auth";
import {
  createAccountingAccount,
  createManualJournalEntry,
  listJournalEntries
} from "@/modules/accounting/application/journal";
import {
  closeAccountingFiscalYear,
  createInitialAccountingFiscalYear
} from "@/modules/accounting/application/fiscalYears";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";

const adminPassword = "Cambiar-esta-clave-2026";
const baseCommand: InitializeCommand = {
  company: {
    legalName: "CriGestion Test SL",
    taxId: "B12345678",
    email: "admin@example.test"
  },
  administrator: {
    displayName: "Administrador",
    userName: "admin",
    password: adminPassword
  }
};

describe("accounting journal application service", () => {
  beforeEach(async () => {
    await resetPlatformTables();
    await initializeForAccounting();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("creates a PGC PYMES plan and copies its accounts when closing the year", async () => {
    await prisma.accountingFiscalYear.deleteMany();
    const actor = await loginAsAdmin();
    const created = await createInitialAccountingFiscalYear(2026, actor);

    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.code);
    expect(created.value).toMatchObject({ year: 2026, status: "OPEN", planCode: "PGC_PYMES" });
    expect(created.value.accountCount).toBe(790);
    const officialCodes = await prisma.accountingAccount.findMany({
      where: {
        fiscalYearId: created.value.id,
        code: { in: ["100", "200", "300", "400", "500", "600", "700", "7993"] }
      },
      select: { code: true, isPostable: true }
    });
    expect(officialCodes).toHaveLength(8);
    expect(officialCodes.every((account) => !account.isPostable)).toBe(true);

    await createAccountingAccount(
      { code: "572000099", name: "Banco personalizado", type: "ACTIVO", level: 9, isPostable: true },
      actor
    );
    const [bank, revenue] = await Promise.all([
      prisma.accountingAccount.findFirstOrThrow({
        where: { fiscalYearId: created.value.id, code: "572000000" }
      }),
      prisma.accountingAccount.findFirstOrThrow({
        where: { fiscalYearId: created.value.id, code: "705000000" }
      })
    ]);
    const sale = await createManualJournalEntry(
      {
        accountingDate: "2026-07-10",
        concept: "Venta antes del cierre",
        lines: [
          { accountId: bank.id, concept: "Banco", debit: "121.00", credit: "0.00" },
          { accountId: revenue.id, concept: "Servicios", debit: "0.00", credit: "121.00" }
        ]
      },
      actor
    );
    expect(sale.ok).toBe(true);
    const closed = await closeAccountingFiscalYear(created.value.id, actor);

    expect(closed.ok).toBe(true);
    if (!closed.ok) throw new Error(closed.error.code);
    expect(closed.value.closed.status).toBe("CLOSED");
    expect(closed.value.next).toMatchObject({ year: 2027, status: "OPEN" });
    expect(closed.value.next.accountCount).toBe(created.value.accountCount + 1);
    expect(await prisma.accountingFiscalYear.count({
      where: { companyId: (await prisma.installation.findFirstOrThrow()).companyId!, status: "OPEN" }
    })).toBe(1);
    const copied = await prisma.accountingAccount.findFirstOrThrow({
      where: { fiscalYearId: closed.value.next.id, code: "572000099" }
    });
    expect(copied.sourceAccountId).not.toBeNull();
    expect(await prisma.accountingJournalLine.count({ where: { accountId: copied.id } })).toBe(0);
    const automaticEntries = await prisma.accountingJournalEntry.findMany({
      where: { origin: { in: ["REGULARIZATION", "CLOSING", "OPENING"] } },
      orderBy: [{ year: "asc" }, { sequence: "asc" }],
      select: { origin: true, year: true, totalDebit: true, totalCredit: true, lines: true }
    });
    expect(automaticEntries.map((entry) => entry.origin)).toEqual([
      "REGULARIZATION",
      "CLOSING",
      "OPENING"
    ]);
    expect(automaticEntries.every((entry) => entry.totalDebit.equals(entry.totalCredit))).toBe(true);
    expect(automaticEntries[2]).toMatchObject({ origin: "OPENING", year: 2027 });
    expect(automaticEntries[2]?.lines).toHaveLength(2);
  });

  it("creates postable accounts and balanced manual journal entries", async () => {
    const actor = await loginAsAdmin();
    const bank = await createAccountingAccount(
      {
        code: "572000001",
        name: "Banco operativo",
        type: "Activo corriente",
        level: 9,
        isPostable: true
      },
      actor,
      { correlationId: "accounting-account-0001" }
    );
    const revenue = await createAccountingAccount(
      {
        code: "700000001",
        name: "Ventas servicios",
        type: "Ingresos",
        level: 9,
        isPostable: true
      },
      actor
    );

    if (!bank.ok || !revenue.ok) {
      throw new Error("Could not create accounts.");
    }

    const entry = await createManualJournalEntry(
      {
        accountingDate: "2026-07-10",
        concept: "Ingreso manual de prueba",
        lines: [
          {
            accountId: bank.value.id,
            concept: "Banco",
            debit: "121.00",
            credit: "0.00"
          },
          {
            accountId: revenue.value.id,
            concept: "Ingreso",
            debit: "0.00",
            credit: "121.00"
          }
        ]
      },
      actor,
      { correlationId: "journal-entry-0001" }
    );
    const listed = await listJournalEntries({ limit: 25, year: 2026 }, actor);
    const accountAudit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "ACCOUNTING_ACCOUNT_CREATED" },
      orderBy: { createdAt: "asc" }
    });
    const entryAudit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "ACCOUNTING_JOURNAL_ENTRY_CREATED" }
    });

    expect(entry).toMatchObject({
      ok: true,
      status: 201,
      value: {
        year: 2026,
        sequence: 1,
        number: "2026/000001",
        accountingDate: "2026-07-10",
        concept: "Ingreso manual de prueba",
        totalDebit: "121.00",
        totalCredit: "121.00",
        lines: [
          {
            position: 1,
            debit: "121.00",
            credit: "0.00",
            account: {
              code: "572000001"
            }
          },
          {
            position: 2,
            debit: "0.00",
            credit: "121.00",
            account: {
              code: "700000001"
            }
          }
        ]
      }
    });
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]?.number).toBe("2026/000001");
    expect(accountAudit.payload).toMatchObject({
      actorUserId: actor.id,
      code: "572000001",
      isPostable: true,
      correlationId: "accounting-account-0001"
    });
    expect(entryAudit.payload).toMatchObject({
      actorUserId: actor.id,
      number: "2026/000001",
      totalDebit: "121.00",
      totalCredit: "121.00",
      lineCount: 2,
      correlationId: "journal-entry-0001"
    });
    expect(JSON.stringify(entryAudit.payload)).not.toContain("Banco");
  });

  it("rejects non-postable accounts and unbalanced manual entries", async () => {
    const actor = await loginAsAdmin();
    const parentAccount = await createAccountingAccount(
      {
        code: "572",
        name: "Bancos",
        type: "Activo corriente",
        level: 3,
        isPostable: false
      },
      actor
    );
    const invalidPostable = await createAccountingAccount(
      {
        code: "700",
        name: "Ventas",
        type: "Ingresos",
        level: 3,
        isPostable: true
      },
      actor
    );

    if (!parentAccount.ok) {
      throw new Error("Could not create parent account.");
    }

    const unbalanced = await createManualJournalEntry(
      {
        accountingDate: "2026-07-10",
        concept: "Asiento descuadrado",
        lines: [
          {
            accountId: parentAccount.value.id,
            concept: "Debe",
            debit: "100.00",
            credit: "0.00"
          },
          {
            accountId: parentAccount.value.id,
            concept: "Haber",
            debit: "0.00",
            credit: "90.00"
          }
        ]
      },
      actor
    );

    expect(invalidPostable).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "ACCOUNT_NOT_POSTABLE_CODE",
        message: "Solo las subcuentas de nueve digitos pueden ser imputables."
      }
    });
    expect(unbalanced).toEqual({
      ok: false,
      status: 409,
      error: {
        code: "JOURNAL_ENTRY_NOT_BALANCED",
        message: "El asiento debe estar cuadrado y tener lineas de debe y haber."
      }
    });
  });
});

async function loginAsAdmin() {
  const result = await login({
    userName: "admin",
    password: adminPassword
  });

  if (!result.ok) {
    throw new Error(result.error.code);
  }

  return result.value.user;
}

async function initializeForAccounting(): Promise<void> {
  const rawBody = JSON.stringify(baseCommand);
  const result = await initializePlatform(
    baseCommand,
    randomUUID(),
    hashRequestBody(rawBody)
  );

  if (!result.ok) {
    throw new Error(result.error.code);
  }

  await createOpenFiscalYear();
}

async function createOpenFiscalYear(): Promise<void> {
  const installation = await prisma.installation.findFirstOrThrow();
  await prisma.accountingFiscalYear.create({
    data: {
      companyId: installation.companyId!, year: 2026,
      startDate: new Date("2026-01-01T00:00:00.000Z"), endDate: new Date("2026-12-31T00:00:00.000Z"),
      planCode: "PGC_PYMES", planVersion: "2021.1", createdById: installation.initialAdministratorId!
    }
  });
}

async function resetPlatformTables(): Promise<void> {
  await prisma.$transaction([
    prisma.accountingJournalLine.deleteMany(),
    prisma.accountingJournalEntry.deleteMany(),
    prisma.accountingAccount.deleteMany(),
    prisma.accountingFiscalYear.deleteMany(),
    prisma.platformMaintenanceState.deleteMany(),
    prisma.idempotencyRecord.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.installation.deleteMany(),
    prisma.reservedUserName.deleteMany(),
    prisma.session.deleteMany(),
    prisma.rateLimitBucket.deleteMany(),
    prisma.loginAttempt.deleteMany(),
    prisma.customerRemittanceLine.deleteMany(),

    prisma.customerRemittance.deleteMany(),

    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
