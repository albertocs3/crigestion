import { PrismaClient } from "@prisma/client";
import { assertVitestDatabaseUrl } from "@/lib/vitestDatabaseSafety";

if (process.env.VITEST === "true") {
  assertVitestDatabaseUrl(process.env);
}

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["error", "warn"],
    transactionOptions: {
      maxWait: 10_000
    }
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
