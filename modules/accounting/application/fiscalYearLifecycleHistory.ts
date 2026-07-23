import "server-only";

import { prisma } from "@/lib/prisma";

export type FiscalYearLifecycleHistoryItem = {
  closeRequest: {
    id: string;
    fiscalYearId: string;
    year: number;
    successorYear: number | null;
    status: "REQUESTED" | "COMPLETED" | "CANCELLED";
    requestedByName: string;
    requestedAt: string;
    terminalByName: string | null;
    terminalAt: string | null;
    entries: Array<{ id: string; number: string; label: string }>;
  };
  reopenRequests: Array<{
    id: string;
    status: "REQUESTED" | "COMPLETED" | "CANCELLED" | "REJECTED" | "EXPIRED";
    reason: string;
    requestedByName: string;
    requestedAt: string;
    expiresAt: string;
    terminalByName: string | null;
    terminalAt: string | null;
    rejectionReason: string | null;
    reversalEntries: Array<{ id: string; number: string; label: string }>;
  }>;
};

export async function listFiscalYearLifecycleHistory(
  fiscalYearIds: string[]
): Promise<FiscalYearLifecycleHistoryItem[]> {
  if (fiscalYearIds.length === 0) return [];
  const installation = await prisma.installation.findFirstOrThrow({
    where: { status: "INITIALIZED" },
    select: { companyId: true }
  });
  if (!installation.companyId) throw new Error("Initialized installation without company.");
  const records = await prisma.accountingFiscalYearCloseRequest.findMany({
    where: { companyId: installation.companyId, fiscalYearId: { in: fiscalYearIds } },
    orderBy: [{ fiscalYear: { year: "desc" } }, { requestedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      fiscalYearId: true,
      status: true,
      requestedAt: true,
      approvedAt: true,
      cancelledAt: true,
      fiscalYear: { select: { year: true } },
      successorFiscalYear: { select: { year: true } },
      requestedBy: { select: { displayName: true } },
      approvedBy: { select: { displayName: true } },
      cancelledBy: { select: { displayName: true } },
      regularizationEntry: { select: { id: true, number: true } },
      closingEntry: { select: { id: true, number: true } },
      openingEntry: { select: { id: true, number: true } },
      reopenRequests: {
        orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          status: true,
          reason: true,
          requestedAt: true,
          expiresAt: true,
          approvedAt: true,
          cancelledAt: true,
          rejectedAt: true,
          expiredAt: true,
          rejectionReason: true,
          requestedBy: { select: { displayName: true } },
          approvedBy: { select: { displayName: true } },
          cancelledBy: { select: { displayName: true } },
          rejectedBy: { select: { displayName: true } },
          regularizationReversalEntry: { select: { id: true, number: true } },
          closingReversalEntry: { select: { id: true, number: true } },
          openingReversalEntry: { select: { id: true, number: true } }
        }
      }
    }
  });

  return records.map((record) => ({
    closeRequest: {
      id: record.id,
      fiscalYearId: record.fiscalYearId,
      year: record.fiscalYear.year,
      successorYear: record.successorFiscalYear?.year ?? null,
      status: record.status,
      requestedByName: record.requestedBy.displayName,
      requestedAt: record.requestedAt.toISOString(),
      terminalByName: record.approvedBy?.displayName ?? record.cancelledBy?.displayName ?? null,
      terminalAt: record.approvedAt?.toISOString() ?? record.cancelledAt?.toISOString() ?? null,
      entries: compactEntries([
        [record.regularizationEntry, "Regularizacion"],
        [record.closingEntry, "Cierre"],
        [record.openingEntry, "Apertura"]
      ])
    },
    reopenRequests: record.reopenRequests.map((reopen) => ({
      id: reopen.id,
      status: reopen.status,
      reason: reopen.reason,
      requestedByName: reopen.requestedBy.displayName,
      requestedAt: reopen.requestedAt.toISOString(),
      expiresAt: reopen.expiresAt.toISOString(),
      terminalByName: reopen.approvedBy?.displayName
        ?? reopen.cancelledBy?.displayName
        ?? reopen.rejectedBy?.displayName
        ?? (reopen.status === "EXPIRED" ? "Sistema" : null),
      terminalAt: reopen.approvedAt?.toISOString()
        ?? reopen.cancelledAt?.toISOString()
        ?? reopen.rejectedAt?.toISOString()
        ?? reopen.expiredAt?.toISOString()
        ?? null,
      rejectionReason: reopen.rejectionReason,
      reversalEntries: compactEntries([
        [reopen.regularizationReversalEntry, "Contraasiento regularizacion"],
        [reopen.closingReversalEntry, "Contraasiento cierre"],
        [reopen.openingReversalEntry, "Contraasiento apertura"]
      ])
    }))
  }));
}

function compactEntries(
  entries: Array<[{ id: string; number: string } | null, string]>
): Array<{ id: string; number: string; label: string }> {
  return entries.flatMap(([entry, label]) => entry ? [{ ...entry, label }] : []);
}
