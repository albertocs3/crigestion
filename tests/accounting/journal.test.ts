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
  createInitialAccountingFiscalYear,
  hashAccountingFiscalYearClose
} from "@/modules/accounting/application/fiscalYears";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";
import { createCustomer } from "@/modules/customers/application/customers";
import { createInvoiceDraft } from "@/modules/billing/application/invoices";

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
    const closeContext = {
      idempotencyKey: `test-accounting-close:${randomUUID()}`,
      requestHash: hashAccountingFiscalYearClose(created.value.id)
    };
    const closed = await closeAccountingFiscalYear(created.value.id, actor, closeContext);

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

    await prisma.accountingAccount.create({
      data: {
        fiscalYearId: closed.value.next.id,
        code: "572000098",
        name: "Cuenta creada despues del cierre",
        type: "ACTIVO",
        level: 9,
        isPostable: true,
        createdById: actor.id
      }
    });
    const replay = await closeAccountingFiscalYear(created.value.id, actor, closeContext);
    expect(replay).toEqual(closed);
    expect((await prisma.accountingFiscalYear.findUniqueOrThrow({
      where: { id: closed.value.next.id }, select: { _count: { select: { accounts: true } } }
    }))._count.accounts).toBe(closed.value.next.accountCount + 1);
    expect(await prisma.accountingJournalEntry.count({
      where: { origin: { in: ["REGULARIZATION", "CLOSING", "OPENING"] } }
    })).toBe(3);
    expect(await prisma.auditEvent.count({
      where: { eventType: "ACCOUNTING_FISCAL_YEAR_CLOSED" }
    })).toBe(1);
    const closeAudit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "ACCOUNTING_FISCAL_YEAR_CLOSED" },
      select: { payload: true }
    });
    expect(closeAudit.payload).toMatchObject({
      actorUserId: actor.id,
      fiscalYearId: created.value.id,
      nextFiscalYearId: closed.value.next.id,
      preflight: { ready: true, journalEntryCount: 1 },
      automaticEntries: {
        regularization: { number: "2026/000002" },
        closing: { number: "2026/000003" },
        opening: { number: "2027/000001" }
      }
    });
    expect(JSON.stringify(closeAudit.payload)).not.toContain("Venta antes del cierre");

    const conflict = await closeAccountingFiscalYear(created.value.id, actor, {
      ...closeContext,
      requestHash: "0".repeat(64)
    });
    expect(conflict).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "IDEMPOTENCY_KEY_REUSED" }
    });
  });

  it("does not close a fiscal year owned by another company", async () => {
    const actor = await loginAsAdmin();
    const foreignCompany = await prisma.company.create({
      data: {
        legalName: "Empresa ajena",
        taxId: "B87654321",
        email: "foreign@example.test"
      }
    });
    const foreignYear = await prisma.accountingFiscalYear.create({
      data: {
        companyId: foreignCompany.id,
        year: 2026,
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        endDate: new Date("2026-12-31T00:00:00.000Z"),
        planCode: "PGC_PYMES",
        planVersion: "2021.1",
        createdById: actor.id
      }
    });

    const result = await closeAccountingFiscalYear(foreignYear.id, actor, {
      idempotencyKey: `test-foreign-close:${randomUUID()}`,
      requestHash: hashAccountingFiscalYearClose(foreignYear.id)
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: { code: "FISCAL_YEAR_NOT_FOUND", message: "El ejercicio no existe." }
    });
    expect(await prisma.accountingFiscalYear.findUniqueOrThrow({
      where: { id: foreignYear.id },
      select: { status: true }
    })).toEqual({ status: "OPEN" });
  });

  it("blocks closing when the preflight finds unsupported balances", async () => {
    const actor = await loginAsAdmin();
    const fiscalYear = await prisma.accountingFiscalYear.findFirstOrThrow({
      where: { year: 2026 }
    });
    const [bank, unsupported] = await Promise.all([
      createAccountingAccount(
        { code: "572000001", name: "Banco UAT", type: "ACTIVO", level: 9, isPostable: true },
        actor
      ),
      createAccountingAccount(
        { code: "099000000", name: "Cuenta no soportada", type: "OTROS", level: 9, isPostable: true },
        actor
      )
    ]);
    if (!bank.ok || !unsupported.ok) throw new Error("Could not create preflight accounts.");
    const entry = await createManualJournalEntry(
      {
        accountingDate: "2026-07-10",
        concept: "Saldo grupo 0",
        lines: [
          { accountId: bank.value.id, concept: "Banco", debit: "10.00", credit: "0.00" },
          { accountId: unsupported.value.id, concept: "Grupo 0", debit: "0.00", credit: "10.00" }
        ]
      },
      actor
    );
    expect(entry.ok).toBe(true);

    const result = await closeAccountingFiscalYear(fiscalYear.id, actor, {
      idempotencyKey: `test-preflight-close:${randomUUID()}`,
      requestHash: hashAccountingFiscalYearClose(fiscalYear.id),
      correlationId: "accounting-close-preflight-0001"
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: {
        code: "FISCAL_YEAR_CLOSE_PRECONDITIONS_FAILED",
        preflight: { ready: false, unsupportedAccountBalanceCount: 1 }
      }
    });
    expect(await prisma.accountingFiscalYear.findUniqueOrThrow({
      where: { id: fiscalYear.id }, select: { status: true }
    })).toEqual({ status: "OPEN" });
    expect(await prisma.accountingFiscalYear.count({ where: { year: 2027 } })).toBe(0);
    expect(await prisma.accountingJournalEntry.count({
      where: { origin: { in: ["REGULARIZATION", "CLOSING", "OPENING"] } }
    })).toBe(0);
    expect(await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "ACCOUNTING_FISCAL_YEAR_CLOSE_BLOCKED" },
      select: { payload: true }
    })).toMatchObject({
      payload: {
        actorUserId: actor.id,
        fiscalYearId: fiscalYear.id,
        correlationId: "accounting-close-preflight-0001",
        preflight: { unsupportedAccountBalanceCount: 1, ready: false }
      }
    });
  });

  it("serializes concurrent close requests without duplicate years or entries", async () => {
    const actor = await loginAsAdmin();
    const fiscalYear = await prisma.accountingFiscalYear.findFirstOrThrow({
      where: { year: 2026 }
    });
    const contexts = [randomUUID(), randomUUID()].map((key) => ({
      idempotencyKey: `test-concurrent-close:${key}`,
      requestHash: hashAccountingFiscalYearClose(fiscalYear.id)
    }));

    const results = await Promise.all(
      contexts.map((context) => closeAccountingFiscalYear(fiscalYear.id, actor, context))
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      {
        ok: false,
        status: 409,
        error: {
          code: "FISCAL_YEAR_NOT_OPEN",
          message: "Solo se puede cerrar un ejercicio abierto."
        }
      }
    ]);
    expect(await prisma.accountingFiscalYear.count({ where: { year: 2027 } })).toBe(1);
    expect(await prisma.auditEvent.count({
      where: { eventType: "ACCOUNTING_FISCAL_YEAR_CLOSED" }
    })).toBe(1);
  });

  it("rolls back without automatic entries when the next fiscal year already exists", async () => {
    const actor = await loginAsAdmin();
    const installation = await prisma.installation.findFirstOrThrow();
    const fiscalYear = await prisma.accountingFiscalYear.findFirstOrThrow({
      where: { year: 2026 }
    });
    await prisma.accountingFiscalYear.create({
      data: {
        companyId: installation.companyId!,
        year: 2027,
        startDate: new Date("2027-01-01T00:00:00.000Z"),
        endDate: new Date("2027-12-31T00:00:00.000Z"),
        status: "CLOSED",
        closedAt: new Date("2028-01-01T00:00:00.000Z"),
        closedById: actor.id,
        planCode: "PGC_PYMES",
        planVersion: "2021.1",
        createdById: actor.id
      }
    });

    const result = await closeAccountingFiscalYear(fiscalYear.id, actor, {
      idempotencyKey: `test-next-exists:${randomUUID()}`,
      requestHash: hashAccountingFiscalYearClose(fiscalYear.id)
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "NEXT_FISCAL_YEAR_ALREADY_EXISTS" }
    });
    expect(await prisma.accountingFiscalYear.findUniqueOrThrow({
      where: { id: fiscalYear.id }, select: { status: true }
    })).toEqual({ status: "OPEN" });
    expect(await prisma.accountingJournalEntry.count({
      where: { origin: { in: ["REGULARIZATION", "CLOSING", "OPENING"] } }
    })).toBe(0);
  });

  it("serializes closing against creation of a dated invoice draft", async () => {
    const actor = await loginAsAdmin();
    const fiscalYear = await prisma.accountingFiscalYear.findFirstOrThrow({
      where: { year: 2026 }
    });
    const customer = await createCustomer({
      type: "COMPANY",
      legalName: "Cliente carrera cierre SL",
      taxId: "B12345674",
      fiscalTreatment: "DOMESTIC",
      email: "cierre@example.test",
      fiscalAddressLine: "Calle Prueba 1",
      fiscalPostalCode: "28001",
      fiscalCity: "Madrid",
      fiscalProvince: "Madrid",
      fiscalCountry: "ES",
      defaultPaymentMethod: "BANK_TRANSFER",
      paymentTermsType: "IMMEDIATE",
      paymentDays: null,
      paymentFixedDay: null,
      creditLimit: null,
    }, actor);
    if (!customer.ok) throw new Error(customer.error.code);

    const [draft, close] = await Promise.all([
      createInvoiceDraft({
        customerId: customer.value.id,
        issueDate: "2026-12-31",
        operationDate: "2026-12-31",
        notes: null
      }, actor),
      closeAccountingFiscalYear(fiscalYear.id, actor, {
        idempotencyKey: `test-draft-race:${randomUUID()}`,
        requestHash: hashAccountingFiscalYearClose(fiscalYear.id)
      })
    ]);

    expect(draft.ok && close.ok).toBe(false);
    if (draft.ok) {
      expect(close).toMatchObject({
        ok: false,
        error: {
          code: "FISCAL_YEAR_CLOSE_PRECONDITIONS_FAILED",
          preflight: { draftInvoiceCount: 1 }
        }
      });
    } else {
      expect(draft.error.code).toBe("INVOICE_ACCOUNTING_FISCAL_YEAR_NOT_OPEN");
      expect(close.ok).toBe(true);
    }
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
    prisma.invoiceDueDate.deleteMany(),
    prisma.invoice.deleteMany(),
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

    prisma.customer.deleteMany(),

    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
