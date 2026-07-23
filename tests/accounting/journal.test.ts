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
  approveAccountingFiscalYearCloseRequest,
  createInitialAccountingFiscalYear,
  hashAccountingFiscalYearCloseApproval
} from "@/modules/accounting/application/fiscalYears";
import {
  cancelFiscalYearCloseRequest,
  hashFiscalYearCloseCancellation,
  hashFiscalYearCloseRequest,
  requestFiscalYearClose
} from "@/modules/accounting/application/fiscalYearCloseRequests";
import {
  approveFiscalYearReopening,
  hashFiscalYearReopenApproval,
  hashFiscalYearReopenRejection,
  hashFiscalYearReopenRequest,
  listFiscalYearReopenRequests,
  rejectFiscalYearReopening,
  requestFiscalYearReopening
} from "@/modules/accounting/application/fiscalYearReopenRequests";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";
import { createCustomer } from "@/modules/customers/application/customers";
import { createInvoiceDraft } from "@/modules/billing/application/invoices";
import { listFiscalYearLifecycleHistory } from "@/modules/accounting/application/fiscalYearLifecycleHistory";

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
    closeRequestCache.clear();
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
      error: { code: "FISCAL_YEAR_CLOSE_REQUEST_NOT_FOUND", message: "La solicitud de cierre no existe." }
    });
    expect(await prisma.accountingFiscalYear.findUniqueOrThrow({
      where: { id: foreignYear.id },
      select: { status: true }
    })).toEqual({ status: "OPEN" });
  });

  it("requires another person to approve and replays both workflow steps", async () => {
    const requester = await loginAsAdmin();
    const fiscalYear = await prisma.accountingFiscalYear.findFirstOrThrow({ where: { year: 2026 } });
    const requestContext = {
      idempotencyKey: `test-close-request:${randomUUID()}`,
      requestHash: hashFiscalYearCloseRequest(fiscalYear.id),
      correlationId: "close-request-0001"
    };
    const requested = await requestFiscalYearClose(fiscalYear.id, requester, requestContext);
    expect(requested).toMatchObject({ ok: true, status: 201, value: { status: "REQUESTED", requestedById: requester.id } });
    expect(await requestFiscalYearClose(fiscalYear.id, requester, requestContext)).toEqual(requested);
    if (!requested.ok) throw new Error(requested.error.code);
    const approver = await createActorLike(requester, "close-approver");
    await expect(prisma.accountingFiscalYearCloseRequest.update({
      where: { id: requested.value.id },
      data: { status: "COMPLETED", approvedById: approver.id, approvedAt: new Date() }
    })).rejects.toThrow("ACCOUNTING_CLOSE_REQUEST_COMPLETION_EVIDENCE_INVALID");
    await expect(prisma.accountingFiscalYearCloseRequest.update({
      where: { id: requested.value.id },
      data: { status: "COMPLETED", approvedById: requester.id, approvedAt: new Date() }
    })).rejects.toThrow();

    const selfApproval = await approveAccountingFiscalYearCloseRequest(requested.value.id, requester, {
      idempotencyKey: `test-close-self:${randomUUID()}`,
      requestHash: hashAccountingFiscalYearCloseApproval(requested.value.id)
    });
    expect(selfApproval).toMatchObject({ ok: false, error: { code: "FISCAL_YEAR_CLOSE_SELF_APPROVAL_FORBIDDEN" } });
    const approvalContext = {
      idempotencyKey: `test-close-approve:${randomUUID()}`,
      requestHash: hashAccountingFiscalYearCloseApproval(requested.value.id),
      correlationId: "close-approval-0001"
    };
    const approved = await approveAccountingFiscalYearCloseRequest(requested.value.id, approver, approvalContext);
    expect(approved).toMatchObject({ ok: true, value: { closed: { status: "CLOSED" }, next: { year: 2027, status: "OPEN" } } });
    expect(await approveAccountingFiscalYearCloseRequest(requested.value.id, approver, approvalContext)).toEqual(approved);
    expect(await prisma.accountingFiscalYearCloseRequest.findUniqueOrThrow({ where: { id: requested.value.id }, select: { status: true, approvedById: true } })).toEqual({ status: "COMPLETED", approvedById: approver.id });
    await expect(prisma.accountingFiscalYearCloseRequest.update({
      where: { id: requested.value.id },
      data: { approvedAt: new Date(Date.now() + 1_000) }
    })).rejects.toThrow("ACCOUNTING_CLOSE_REQUEST_TERMINAL_EVIDENCE_IMMUTABLE");
    expect(await prisma.auditEvent.count({ where: { eventType: "ACCOUNTING_FISCAL_YEAR_CLOSE_APPROVAL_DENIED" } })).toBe(1);
  });

  it("allows only the requester to cancel and releases the active-request guard", async () => {
    const requester = await loginAsAdmin();
    const fiscalYear = await prisma.accountingFiscalYear.findFirstOrThrow({ where: { year: 2026 } });
    const first = await requestFiscalYearClose(fiscalYear.id, requester, {
      idempotencyKey: `test-close-request:${randomUUID()}`,
      requestHash: hashFiscalYearCloseRequest(fiscalYear.id)
    });
    if (!first.ok) throw new Error(first.error.code);
    const duplicate = await requestFiscalYearClose(fiscalYear.id, requester, {
      idempotencyKey: `test-close-request:${randomUUID()}`,
      requestHash: hashFiscalYearCloseRequest(fiscalYear.id)
    });
    expect(duplicate).toMatchObject({ ok: false, error: { code: "FISCAL_YEAR_CLOSE_ACTIVE_REQUEST_EXISTS" } });
    const other = await createActorLike(requester, "close-canceller");
    await expect(prisma.accountingFiscalYearCloseRequest.update({
      where: { id: first.value.id },
      data: { status: "CANCELLED", cancelledById: other.id, cancelledAt: new Date() }
    })).rejects.toThrow("ACCOUNTING_CLOSE_REQUEST_CANCELLER_MUST_BE_REQUESTER");
    const denied = await cancelFiscalYearCloseRequest(first.value.id, other, {
      idempotencyKey: `test-close-cancel-denied:${randomUUID()}`,
      requestHash: hashFiscalYearCloseCancellation(first.value.id)
    });
    expect(denied).toMatchObject({ ok: false, error: { code: "FISCAL_YEAR_CLOSE_REQUEST_NOT_CANCELLABLE" } });
    const cancelled = await cancelFiscalYearCloseRequest(first.value.id, requester, {
      idempotencyKey: `test-close-cancel:${randomUUID()}`,
      requestHash: hashFiscalYearCloseCancellation(first.value.id)
    });
    expect(cancelled).toMatchObject({ ok: true, value: { status: "CANCELLED", cancelledById: requester.id } });
    await expect(prisma.accountingFiscalYearCloseRequest.update({
      where: { id: first.value.id },
      data: { cancelledAt: new Date(Date.now() + 1_000) }
    })).rejects.toThrow("ACCOUNTING_CLOSE_REQUEST_TERMINAL_EVIDENCE_IMMUTABLE");
    const replacement = await requestFiscalYearClose(fiscalYear.id, requester, {
      idempotencyKey: `test-close-request:${randomUUID()}`,
      requestHash: hashFiscalYearCloseRequest(fiscalYear.id)
    });
    expect(replacement).toMatchObject({ ok: true, status: 201, value: { status: "REQUESTED" } });
  });

  it("reopens a completed close with maker-checker contraentries and safely reuses the successor", async () => {
    const requester = await loginAsAdmin();
    const closeApprover = await createActorLike(requester, "close-approver");
    const reopenApprover = await createActorLike(requester, "reopen-approver");
    const fiscalYear = await prisma.accountingFiscalYear.findFirstOrThrow({ where: { year: 2026 } });
    const bankResult = await createAccountingAccount(
      { code: "572000000", name: "Banco", type: "ACTIVO", level: 9, isPostable: true }, requester
    );
    const revenueResult = await createAccountingAccount(
      { code: "705000000", name: "Servicios", type: "INGRESO", level: 9, isPostable: true }, requester
    );
    const resultAccount = await createAccountingAccount(
      { code: "129000000", name: "Resultado del ejercicio", type: "PATRIMONIO", level: 9, isPostable: true }, requester
    );
    if (!bankResult.ok || !revenueResult.ok || !resultAccount.ok) throw new Error("Could not create close accounts.");
    const bank = bankResult.value;
    const revenue = revenueResult.value;
    const sale = await createManualJournalEntry({
      accountingDate: "2026-07-10",
      concept: "Operacion previa a reapertura",
      lines: [
        { accountId: bank.id, concept: "Banco", debit: "121.00", credit: "0.00" },
        { accountId: revenue.id, concept: "Servicios", debit: "0.00", credit: "121.00" }
      ]
    }, requester);
    expect(sale.ok).toBe(true);

    const closeRequested = await requestFiscalYearClose(fiscalYear.id, requester, {
      idempotencyKey: `test-close-request:${randomUUID()}`,
      requestHash: hashFiscalYearCloseRequest(fiscalYear.id)
    });
    if (!closeRequested.ok) throw new Error(closeRequested.error.code);
    const firstClose = await approveAccountingFiscalYearCloseRequest(closeRequested.value.id, closeApprover, {
      idempotencyKey: `test-close-approve:${randomUUID()}`,
      requestHash: hashAccountingFiscalYearCloseApproval(closeRequested.value.id)
    });
    if (!firstClose.ok) throw new Error(firstClose.error.code);
    await expect(prisma.accountingFiscalYear.update({
      where: { id: firstClose.value.next.id }, data: { status: "REVERSED" }
    })).rejects.toThrow("ACCOUNTING_FISCAL_YEAR_REOPEN_TRANSITION_EVIDENCE_MISSING");

    const reopenCommand = { reasonCode: "OMITTED_TRANSACTION" as const, reason: "Falta registrar una operacion UAT del ejercicio." };
    const bankAccount = await prisma.bankAccount.create({
      data: { companyId: fiscalYear.companyId, name: "Banco sucesor", iban: "ES9121000418450200051332", createdById: requester.id }
    });
    const bankMovement = await prisma.bankMovement.create({
      data: { bankAccountId: bankAccount.id, bookingDate: new Date("2027-01-02T00:00:00.000Z"), amount: "10.00", createdById: requester.id }
    });
    const blockedByBanking = await requestFiscalYearReopening(closeRequested.value.id, reopenCommand, requester, {
      idempotencyKey: `test-reopen-bank-block:${randomUUID()}`,
      requestHash: hashFiscalYearReopenRequest(closeRequested.value.id, reopenCommand)
    });
    expect(blockedByBanking).toMatchObject({
      ok: false,
      error: { code: "FISCAL_YEAR_REOPEN_PRECONDITIONS_FAILED", preflight: { successorBusinessActivityCount: 1 } }
    });
    await prisma.bankMovement.delete({ where: { id: bankMovement.id } });
    await prisma.bankAccount.delete({ where: { id: bankAccount.id } });
    const reopenRequested = await requestFiscalYearReopening(closeRequested.value.id, reopenCommand, requester, {
      idempotencyKey: `test-reopen-request:${randomUUID()}`,
      requestHash: hashFiscalYearReopenRequest(closeRequested.value.id, reopenCommand)
    });
    expect(reopenRequested).toMatchObject({ ok: true, status: 201, value: { status: "REQUESTED" } });
    if (!reopenRequested.ok) throw new Error(reopenRequested.error.code);
    const selfApproval = await approveFiscalYearReopening(reopenRequested.value.id, requester, {
      idempotencyKey: `test-reopen-self:${randomUUID()}`,
      requestHash: hashFiscalYearReopenApproval(reopenRequested.value.id)
    });
    expect(selfApproval).toMatchObject({ ok: false, error: { code: "FISCAL_YEAR_REOPEN_SELF_APPROVAL_FORBIDDEN" } });

    const rejectionCommand = { reason: "La evidencia aportada no justifica reabrir el ejercicio." };
    await expect(prisma.accountingFiscalYearReopenRequest.update({
      where: { id: reopenRequested.value.id },
      data: {
        status: "REJECTED",
        rejectedById: requester.id,
        rejectedAt: new Date(),
        rejectionReason: rejectionCommand.reason
      }
    })).rejects.toThrow("ACCOUNTING_REOPEN_REQUEST_REJECTER_MUST_BE_CHECKER");
    await expect(prisma.accountingFiscalYearReopenRequest.update({
      where: { id: reopenRequested.value.id },
      data: { status: "EXPIRED", expiredAt: new Date() }
    })).rejects.toThrow("ACCOUNTING_REOPEN_REQUEST_EXPIRY_PREMATURE");
    const selfRejection = await rejectFiscalYearReopening(reopenRequested.value.id, rejectionCommand, requester, {
      idempotencyKey: `test-reopen-self-reject:${randomUUID()}`,
      requestHash: hashFiscalYearReopenRejection(reopenRequested.value.id, rejectionCommand)
    });
    expect(selfRejection).toMatchObject({ ok: false, error: { code: "FISCAL_YEAR_REOPEN_SELF_REJECTION_FORBIDDEN" } });
    const rejectionContext = {
      idempotencyKey: `test-reopen-reject:${randomUUID()}`,
      requestHash: hashFiscalYearReopenRejection(reopenRequested.value.id, rejectionCommand)
    };
    const rejected = await rejectFiscalYearReopening(reopenRequested.value.id, rejectionCommand, reopenApprover, rejectionContext);
    expect(rejected).toMatchObject({ ok: true, value: { status: "REJECTED", rejectionReason: rejectionCommand.reason } });
    expect(await rejectFiscalYearReopening(reopenRequested.value.id, rejectionCommand, reopenApprover, rejectionContext)).toEqual(rejected);
    await expect(prisma.accountingFiscalYearReopenRequest.update({
      where: { id: reopenRequested.value.id },
      data: { rejectionReason: "Alteracion no permitida de la decision terminal." }
    })).rejects.toThrow("ACCOUNTING_REOPEN_REQUEST_TERMINAL_EVIDENCE_IMMUTABLE");

    const expiringRequest = await requestFiscalYearReopening(closeRequested.value.id, reopenCommand, requester, {
      idempotencyKey: `test-reopen-after-rejection:${randomUUID()}`,
      requestHash: hashFiscalYearReopenRequest(closeRequested.value.id, reopenCommand)
    });
    if (!expiringRequest.ok) throw new Error(expiringRequest.error.code);
    const future = new Date(new Date(expiringRequest.value.expiresAt).getTime() + 1_000);
    const expiredHistory = await listFiscalYearReopenRequests([closeRequested.value.id], future);
    expect(expiredHistory.find((request) => request.id === expiringRequest.value.id)).toMatchObject({
      status: "EXPIRED",
      expiredAt: future.toISOString()
    });
    const expiredApproval = await approveFiscalYearReopening(expiringRequest.value.id, reopenApprover, {
      idempotencyKey: `test-reopen-expired-approve:${randomUUID()}`,
      requestHash: hashFiscalYearReopenApproval(expiringRequest.value.id)
    });
    expect(expiredApproval).toMatchObject({ ok: false, error: { code: "FISCAL_YEAR_REOPEN_REQUEST_EXPIRED" } });

    const finalReopenRequested = await requestFiscalYearReopening(closeRequested.value.id, reopenCommand, requester, {
      idempotencyKey: `test-reopen-after-expiry:${randomUUID()}`,
      requestHash: hashFiscalYearReopenRequest(closeRequested.value.id, reopenCommand)
    });
    if (!finalReopenRequested.ok) throw new Error(finalReopenRequested.error.code);

    const approvalContext = {
      idempotencyKey: `test-reopen-approve:${randomUUID()}`,
      requestHash: hashFiscalYearReopenApproval(finalReopenRequested.value.id)
    };
    const reopened = await approveFiscalYearReopening(finalReopenRequested.value.id, reopenApprover, approvalContext);
    expect(reopened).toMatchObject({
      ok: true,
      value: {
        status: "COMPLETED",
        fiscalYearId: fiscalYear.id,
        successorFiscalYearId: firstClose.value.next.id
      }
    });
    expect(await approveFiscalYearReopening(finalReopenRequested.value.id, reopenApprover, approvalContext)).toEqual(reopened);
    expect(await prisma.auditEvent.count({ where: { eventType: "ACCOUNTING_FISCAL_YEAR_REOPEN_REJECTED" } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { eventType: "ACCOUNTING_FISCAL_YEAR_REOPEN_EXPIRED", actorType: "SYSTEM" } })).toBe(1);
    const lifecycleHistory = await listFiscalYearLifecycleHistory([fiscalYear.id]);
    expect(lifecycleHistory[0]).toMatchObject({
      closeRequest: { id: closeRequested.value.id, status: "COMPLETED" },
      reopenRequests: expect.arrayContaining([
        expect.objectContaining({ status: "COMPLETED", reversalEntries: expect.any(Array) }),
        expect.objectContaining({ status: "REJECTED", rejectionReason: rejectionCommand.reason }),
        expect.objectContaining({ status: "EXPIRED", terminalByName: "Sistema" })
      ])
    });
    expect(await prisma.accountingFiscalYear.findMany({
      where: { id: { in: [fiscalYear.id, firstClose.value.next.id] } },
      orderBy: { year: "asc" },
      select: { id: true, status: true, closedAt: true, closedById: true }
    })).toEqual([
      { id: fiscalYear.id, status: "OPEN", closedAt: null, closedById: null },
      { id: firstClose.value.next.id, status: "REVERSED", closedAt: null, closedById: null }
    ]);
    expect(await prisma.accountingFiscalYearCloseRequest.findUniqueOrThrow({
      where: { id: closeRequested.value.id }, select: { status: true }
    })).toEqual({ status: "COMPLETED" });
    const reversals = await prisma.accountingJournalEntry.findMany({
      where: { origin: "FISCAL_YEAR_CLOSE_REVERSAL" },
      select: { reversesEntryId: true, totalDebit: true, totalCredit: true, reversesEntry: { select: { totalDebit: true, totalCredit: true } } }
    });
    expect(reversals).toHaveLength(3);
    for (const reversal of reversals) {
      expect(reversal.reversesEntryId).not.toBeNull();
      expect(reversal.totalDebit.equals(reversal.reversesEntry!.totalCredit)).toBe(true);
      expect(reversal.totalCredit.equals(reversal.reversesEntry!.totalDebit)).toBe(true);
    }
    const protectedReversal = await prisma.accountingJournalEntry.findFirstOrThrow({
      where: { origin: "FISCAL_YEAR_CLOSE_REVERSAL" },
      select: { id: true, lines: { take: 1, select: { id: true } } }
    });
    await expect(prisma.accountingJournalEntry.update({
      where: { id: protectedReversal.id }, data: { concept: "Alteracion no permitida" }
    })).rejects.toThrow("ACCOUNTING_CLOSE_EVIDENCE_ENTRY_IMMUTABLE");
    await expect(prisma.accountingJournalLine.update({
      where: { id: protectedReversal.lines[0]!.id }, data: { concept: "Alteracion no permitida" }
    })).rejects.toThrow("ACCOUNTING_CLOSE_EVIDENCE_LINES_IMMUTABLE");

    const secondCloseRequested = await requestFiscalYearClose(fiscalYear.id, requester, {
      idempotencyKey: `test-second-close-request:${randomUUID()}`,
      requestHash: hashFiscalYearCloseRequest(fiscalYear.id)
    });
    if (!secondCloseRequested.ok) throw new Error(secondCloseRequested.error.code);
    const secondClose = await approveAccountingFiscalYearCloseRequest(secondCloseRequested.value.id, closeApprover, {
      idempotencyKey: `test-second-close-approve:${randomUUID()}`,
      requestHash: hashAccountingFiscalYearCloseApproval(secondCloseRequested.value.id)
    });
    expect(secondClose).toMatchObject({ ok: true, value: { next: { id: firstClose.value.next.id, status: "OPEN" } } });
    expect(await prisma.accountingJournalEntry.count({
      where: { fiscalYearId: firstClose.value.next.id, origin: "OPENING" }
    })).toBe(2);
    if (!secondClose.ok) throw new Error(secondClose.error.code);
    const secondReopenCommand = { reasonCode: "ACCOUNTING_CORRECTION" as const, reason: "Segunda reapertura para validar la repeticion segura del ciclo." };
    const secondReopenRequested = await requestFiscalYearReopening(secondCloseRequested.value.id, secondReopenCommand, requester, {
      idempotencyKey: `test-second-reopen-request:${randomUUID()}`,
      requestHash: hashFiscalYearReopenRequest(secondCloseRequested.value.id, secondReopenCommand)
    });
    if (!secondReopenRequested.ok) throw new Error(secondReopenRequested.error.code);
    const secondReopened = await approveFiscalYearReopening(secondReopenRequested.value.id, reopenApprover, {
      idempotencyKey: `test-second-reopen-approve:${randomUUID()}`,
      requestHash: hashFiscalYearReopenApproval(secondReopenRequested.value.id)
    });
    expect(secondReopened).toMatchObject({ ok: true, value: { status: "COMPLETED" } });
    expect(await prisma.accountingFiscalYear.findMany({
      where: { id: { in: [fiscalYear.id, firstClose.value.next.id] } }, orderBy: { year: "asc" }, select: { status: true }
    })).toEqual([{ status: "OPEN" }, { status: "REVERSED" }]);
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
          code: "FISCAL_YEAR_CLOSE_REQUEST_NOT_PENDING",
          message: "La solicitud de cierre ya no esta pendiente."
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

const closeRequestCache = new Map<string, Promise<string>>();

function hashAccountingFiscalYearClose(fiscalYearId: string): string {
  return `legacy-close-test:${fiscalYearId}`;
}

async function closeAccountingFiscalYear(
  fiscalYearId: string,
  actor: Awaited<ReturnType<typeof loginAsAdmin>>,
  context: { idempotencyKey: string; requestHash: string; correlationId?: string }
) {
  let pending = closeRequestCache.get(fiscalYearId);
  if (!pending) {
    pending = createPendingCloseRequest(fiscalYearId, actor.id);
    closeRequestCache.set(fiscalYearId, pending);
  }
  const closeRequestId = await pending;
  return approveAccountingFiscalYearCloseRequest(closeRequestId, actor, {
    ...context,
    requestHash: context.requestHash === "0".repeat(64)
      ? context.requestHash
      : hashAccountingFiscalYearCloseApproval(closeRequestId)
  });
}

async function createPendingCloseRequest(fiscalYearId: string, approverId: string): Promise<string> {
  const fiscalYear = await prisma.accountingFiscalYear.findUniqueOrThrow({
    where: { id: fiscalYearId },
    select: { companyId: true }
  });
  const role = await prisma.role.findFirstOrThrow();
  const requester = await prisma.user.create({
    data: {
      displayName: "Solicitante cierre",
      userName: `close-requester-${randomUUID()}`,
      normalizedUserName: `close-requester-${randomUUID()}`,
      passwordHash: "test-only",
      roleId: role.id
    },
    select: { id: true }
  });
  if (requester.id === approverId) throw new Error("Test requester must differ from approver.");
  return (await prisma.accountingFiscalYearCloseRequest.create({
    data: {
      companyId: fiscalYear.companyId,
      fiscalYearId,
      requestedById: requester.id,
      preflightSnapshot: emptyClosePreflight
    },
    select: { id: true }
  })).id;
}

async function createActorLike(
  actor: Awaited<ReturnType<typeof loginAsAdmin>>,
  prefix: string
): Promise<Awaited<ReturnType<typeof loginAsAdmin>>> {
  const role = await prisma.role.findFirstOrThrow();
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: {
      displayName: "Usuario de prueba cierre",
      userName: `${prefix}-${suffix}`,
      normalizedUserName: `${prefix}-${suffix}`,
      passwordHash: "test-only",
      roleId: role.id
    },
    select: { id: true, userName: true, displayName: true }
  });
  return { ...actor, ...user };
}

const emptyClosePreflight = {
  ready: true,
  journalEntryCount: 0,
  unbalancedEntryCount: 0,
  headerLineMismatchCount: 0,
  invalidEntryShapeCount: 0,
  invalidLineCount: 0,
  crossFiscalYearLineCount: 0,
  draftInvoiceCount: 0,
  invoiceWithoutEntryCount: 0,
  unresolvedVerifactuInvoiceCount: 0,
  draftPurchaseCount: 0,
  purchaseWithoutEntryCount: 0,
  pendingCustomerRefundCount: 0,
  pendingSupplierRefundCount: 0,
  unsupportedAccountBalanceCount: 0,
  resultAccountReady: true
};

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
    prisma.accountingFiscalYearReopenRequest.deleteMany(),
    prisma.accountingFiscalYearCloseRequest.deleteMany(),
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
