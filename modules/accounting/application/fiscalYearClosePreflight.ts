import "server-only";

import { Prisma } from "@prisma/client";

export type AccountingFiscalYearClosePreflightReport = {
  journalEntryCount: number;
  unbalancedEntryCount: number;
  headerLineMismatchCount: number;
  invalidEntryShapeCount: number;
  invalidLineCount: number;
  crossFiscalYearLineCount: number;
  draftInvoiceCount: number;
  invoiceWithoutEntryCount: number;
  unresolvedVerifactuInvoiceCount: number;
  draftPurchaseCount: number;
  purchaseWithoutEntryCount: number;
  pendingCustomerRefundCount: number;
  pendingSupplierRefundCount: number;
  unsupportedAccountBalanceCount: number;
  resultAccountReady: boolean;
  ready: boolean;
};

type FiscalYearForPreflight = {
  id: string;
  companyId: string;
  startDate: Date;
  endDate: Date;
};

type JournalIntegrityRow = {
  journalEntryCount: bigint;
  unbalancedEntryCount: bigint;
  headerLineMismatchCount: bigint;
  invalidEntryShapeCount: bigint;
  invalidLineCount: bigint;
  crossFiscalYearLineCount: bigint;
  unsupportedAccountBalanceCount: bigint;
  resultAccountRequired: boolean;
};

export async function buildAccountingFiscalYearClosePreflight(
  tx: Prisma.TransactionClient,
  fiscalYear: FiscalYearForPreflight
): Promise<AccountingFiscalYearClosePreflightReport> {
  const [journal] = await tx.$queryRaw<JournalIntegrityRow[]>(Prisma.sql`
    WITH line_totals AS (
      SELECT
        entry."id" AS "entryId",
        COUNT(line."id") AS "lineCount",
        COUNT(*) FILTER (WHERE line."debit" > 0) AS "debitLineCount",
        COUNT(*) FILTER (WHERE line."credit" > 0) AS "creditLineCount",
        COALESCE(SUM(line."debit"), 0) AS "lineDebit",
        COALESCE(SUM(line."credit"), 0) AS "lineCredit"
      FROM "accounting_journal_entries" entry
      LEFT JOIN "accounting_journal_lines" line ON line."entryId" = entry."id"
      WHERE entry."fiscalYearId" = ${fiscalYear.id}::uuid
        AND entry."status" = 'POSTED'
      GROUP BY entry."id"
    ), account_balances AS (
      SELECT account."code", COALESCE(SUM(line."debit" - line."credit"), 0) AS balance
      FROM "accounting_accounts" account
      JOIN "accounting_journal_lines" line ON line."accountId" = account."id"
      JOIN "accounting_journal_entries" entry ON entry."id" = line."entryId"
      WHERE account."fiscalYearId" = ${fiscalYear.id}::uuid
        AND entry."status" = 'POSTED'
      GROUP BY account."id", account."code"
    )
    SELECT
      (SELECT COUNT(*) FROM "accounting_journal_entries" entry
        WHERE entry."fiscalYearId" = ${fiscalYear.id}::uuid AND entry."status" = 'POSTED') AS "journalEntryCount",
      (SELECT COUNT(*) FROM "accounting_journal_entries" entry
        WHERE entry."fiscalYearId" = ${fiscalYear.id}::uuid AND entry."status" = 'POSTED'
          AND entry."totalDebit" <> entry."totalCredit") AS "unbalancedEntryCount",
      (SELECT COUNT(*) FROM "accounting_journal_entries" entry
        JOIN line_totals totals ON totals."entryId" = entry."id"
        WHERE entry."totalDebit" <> totals."lineDebit" OR entry."totalCredit" <> totals."lineCredit") AS "headerLineMismatchCount",
      (SELECT COUNT(*) FROM line_totals totals
        WHERE totals."lineCount" < 2 OR totals."debitLineCount" = 0 OR totals."creditLineCount" = 0) AS "invalidEntryShapeCount",
      (SELECT COUNT(*) FROM "accounting_journal_lines" line
        JOIN "accounting_journal_entries" entry ON entry."id" = line."entryId"
        WHERE entry."fiscalYearId" = ${fiscalYear.id}::uuid AND entry."status" = 'POSTED'
          AND ((line."debit" = 0 AND line."credit" = 0) OR (line."debit" > 0 AND line."credit" > 0)
            OR line."debit" < 0 OR line."credit" < 0)) AS "invalidLineCount",
      (SELECT COUNT(*) FROM "accounting_journal_lines" line
        JOIN "accounting_journal_entries" entry ON entry."id" = line."entryId"
        JOIN "accounting_accounts" account ON account."id" = line."accountId"
        WHERE entry."fiscalYearId" = ${fiscalYear.id}::uuid AND entry."status" = 'POSTED'
          AND account."fiscalYearId" <> entry."fiscalYearId") AS "crossFiscalYearLineCount",
      (SELECT COUNT(*) FROM account_balances WHERE "code" ~ '^[089]' AND balance <> 0) AS "unsupportedAccountBalanceCount",
      EXISTS (SELECT 1 FROM account_balances WHERE "code" ~ '^[67]' AND balance <> 0) AS "resultAccountRequired"
  `);

  if (!journal) throw new Error("ACCOUNTING_CLOSE_PREFLIGHT_FAILED");

  const [
    draftInvoiceCount,
    invoiceWithoutEntryCount,
    unresolvedVerifactuInvoiceCount,
    draftPurchaseCount,
    purchaseWithoutEntryCount,
    pendingCustomerRefundCount,
    pendingSupplierRefundCount,
    resultAccount
  ] = await Promise.all([
    tx.invoice.count({
      where: {
        companyId: fiscalYear.companyId,
        issueDate: { gte: fiscalYear.startDate, lte: fiscalYear.endDate },
        status: "DRAFT"
      }
    }),
    tx.invoice.count({
      where: {
        companyId: fiscalYear.companyId,
        issueDate: { gte: fiscalYear.startDate, lte: fiscalYear.endDate },
        status: { in: ["ISSUED", "RECTIFIED", "VOIDED"] },
        accountingEntry: { is: null }
      }
    }),
    tx.invoice.count({
      where: {
        companyId: fiscalYear.companyId,
        issueDate: { gte: fiscalYear.startDate, lte: fiscalYear.endDate },
        status: { in: ["ISSUED", "RECTIFIED"] },
        verifactuStatus: { in: ["PENDING", "SENT", "REJECTED"] }
      }
    }),
    tx.purchaseInvoice.count({
      where: {
        companyId: fiscalYear.companyId,
        accountingDate: { gte: fiscalYear.startDate, lte: fiscalYear.endDate },
        status: "DRAFT"
      }
    }),
    tx.purchaseInvoice.count({
      where: {
        companyId: fiscalYear.companyId,
        accountingDate: { gte: fiscalYear.startDate, lte: fiscalYear.endDate },
        status: { in: ["REGISTERED", "RECTIFIED"] },
        accountingEntry: { is: null }
      }
    }),
    tx.customerCreditRefund.count({
      where: {
        companyId: fiscalYear.companyId,
        requestedDate: { gte: fiscalYear.startDate, lte: fiscalYear.endDate },
        status: { in: ["REQUESTED", "APPROVED"] }
      }
    }),
    tx.supplierCreditRefund.count({
      where: {
        companyId: fiscalYear.companyId,
        requestedDate: { gte: fiscalYear.startDate, lte: fiscalYear.endDate },
        status: { in: ["REQUESTED", "APPROVED"] }
      }
    }),
    journal.resultAccountRequired
      ? tx.accountingAccount.findFirst({
          where: {
            fiscalYearId: fiscalYear.id,
            code: "129000000",
            status: "ACTIVE",
            isPostable: true
          },
          select: { id: true }
        })
      : Promise.resolve({ id: "not-required" })
  ]);

  const report = {
    journalEntryCount: Number(journal.journalEntryCount),
    unbalancedEntryCount: Number(journal.unbalancedEntryCount),
    headerLineMismatchCount: Number(journal.headerLineMismatchCount),
    invalidEntryShapeCount: Number(journal.invalidEntryShapeCount),
    invalidLineCount: Number(journal.invalidLineCount),
    crossFiscalYearLineCount: Number(journal.crossFiscalYearLineCount),
    draftInvoiceCount,
    invoiceWithoutEntryCount,
    unresolvedVerifactuInvoiceCount,
    draftPurchaseCount,
    purchaseWithoutEntryCount,
    pendingCustomerRefundCount,
    pendingSupplierRefundCount,
    unsupportedAccountBalanceCount: Number(journal.unsupportedAccountBalanceCount),
    resultAccountReady: resultAccount !== null
  };

  return {
    ...report,
    ready: Object.entries(report).every(([key, value]) =>
      key === "journalEntryCount" ? true : typeof value === "boolean" ? value : value === 0
    )
  };
}
