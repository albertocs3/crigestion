import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AeatTestCycleAuditIdentity,
  AeatTestCycleRepository
} from "@/modules/billing/application/verifyVerifactuAeatTestCycle";

export function createPrismaAeatTestCycleRepository(db: PrismaClient): AeatTestCycleRepository {
  return {
    async assertExpectedDatabase(expected) {
      const rows = await db.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS "name"`;
      if (rows[0]?.name !== expected) throw new Error("VERIFACTU_AEAT_TEST_CYCLE_DATABASE_MISMATCH");
    },
    async loadEvidence(invoiceId) {
      const invoice = await db.invoice.findUnique({
        where: { id: invoiceId },
        select: {
          id: true, number: true, verifactuStatus: true,
          verifactuFiscalRecords: {
            orderBy: [{ chainPosition: "asc" }, { id: "asc" }],
            select: {
              id: true, recordType: true, chainPosition: true, previousRecordId: true, cancelledRecordId: true,
              companyId: true, sifInstallationId: true, invoiceId: true, preparationKey: true, issuerName: true,
              issuerTaxId: true, invoiceNumber: true, invoiceIssueDate: true,
              outboxMessages: { where: { operation: "SUBMIT" }, select: { status: true } },
              attempts: { where: { kind: "SUBMIT" }, orderBy: { attemptNumber: "desc" }, take: 1,
                select: { outcome: true, stableErrorCode: true, aeatCodes: true } },
              sifInstallation: { select: { companyId: true, environment: true, status: true, credentialRef: true } }
            }
          }
        }
      });
      if (!invoice) return null;
      const installation = invoice.verifactuFiscalRecords[0]?.sifInstallation;
      if (!installation) return null;
      return {
        invoiceId: invoice.id, invoiceNumber: invoice.number, verifactuStatus: invoice.verifactuStatus,
        installation,
        records: invoice.verifactuFiscalRecords.map((record) => ({
          id: record.id, recordType: record.recordType, chainPosition: record.chainPosition,
          previousRecordId: record.previousRecordId, cancelledRecordId: record.cancelledRecordId,
          companyId: record.companyId, sifInstallationId: record.sifInstallationId, invoiceId: record.invoiceId,
          preparationKey: record.preparationKey, issuerName: record.issuerName, issuerTaxId: record.issuerTaxId,
          invoiceNumber: record.invoiceNumber, invoiceIssueDate: record.invoiceIssueDate,
          outboxStatuses: record.outboxMessages.map((message) => message.status), latestAttempt: record.attempts[0]
        }))
      };
    },
    createAudit(eventType, identity, extra = {}) {
      return createAudit(db, eventType, identity, extra);
    },
    async persistResult(input) {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw<Array<{ locked: number }>>`
          SELECT 1 AS "locked"
          FROM (SELECT pg_advisory_xact_lock(hashtextextended(${input.cancellationId}, 0))) AS acquired
        `;
        const aggregate = await tx.verifactuSubmissionAttempt.aggregate({
          where: { fiscalRecordId: input.cancellationId }, _max: { attemptNumber: true }
        });
        await tx.verifactuSubmissionAttempt.create({ data: {
          fiscalRecordId: input.cancellationId, attemptNumber: (aggregate._max.attemptNumber ?? 0) + 1,
          kind: "RECONCILE", idempotencyKey: input.requestId, startedAt: input.startedAt,
          completedAt: input.completedAt, outcome: input.result.outcome,
          requestSha256: input.result.requestSha256 ?? "",
          responseCiphertext: input.result.response ? Buffer.from(input.result.response.ciphertext) : null,
          responseSha256: input.result.response?.sha256, encryptionKeyId: input.result.response?.encryptionKeyId,
          stableErrorCode: input.result.stableCode, aeatCodes: input.result.aeatCodes,
          credentialVersionId: input.result.credentialVersionId
        } });
        await tx.auditEvent.create({ data: {
          eventType: input.cleanQuery ? "VERIFACTU_AEAT_TEST_CYCLE_COMPLETED" : "VERIFACTU_AEAT_TEST_CYCLE_FAILED",
          actorType: "SYSTEM",
          payload: { ...input.identity, outcome: input.result.outcome, stableCode: input.result.stableCode,
            requestSha256: input.result.requestSha256 ?? null, responseSha256: input.result.response?.sha256 ?? null,
            mtlsVersionId: input.result.credentialVersionId ?? null, endpointKind: input.result.endpointKind ?? null,
            environment: "TEST" }
        } });
      });
    }
  };
}

async function createAudit(db: PrismaClient, eventType: string, identity: AeatTestCycleAuditIdentity,
  extra: Record<string, string | null>): Promise<void> {
  await db.auditEvent.create({ data: { eventType, actorType: "SYSTEM",
    payload: { ...identity, ...extra } as Prisma.InputJsonObject } });
}
