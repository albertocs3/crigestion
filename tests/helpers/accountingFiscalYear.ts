import { prisma } from "@/lib/prisma";

export async function createTestAccountingFiscalYear(year = 2026): Promise<void> {
  const installation = await prisma.installation.findFirstOrThrow();
  await prisma.accountingFiscalYear.create({
    data: {
      companyId: installation.companyId!,
      year,
      startDate: new Date(`${year}-01-01T00:00:00.000Z`),
      endDate: new Date(`${year}-12-31T00:00:00.000Z`),
      planCode: "PGC_PYMES",
      planVersion: "2021.1",
      createdById: installation.initialAdministratorId!
    }
  });
}
