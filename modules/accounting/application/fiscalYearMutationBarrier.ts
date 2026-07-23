import "server-only";

import { Prisma } from "@prisma/client";

export async function lockOpenFiscalYearForDatedMutation(
  tx: Prisma.TransactionClient,
  companyId: string,
  date: Date
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "accounting_fiscal_years"
    WHERE "companyId" = ${companyId}::uuid
      AND "status" = 'OPEN'
      AND "startDate" <= ${date}
      AND "endDate" >= ${date}
    FOR KEY SHARE
  `);

  return rows.length === 1;
}
