import { prisma } from "@/lib/prisma";
import { assertVitestDatabaseUrl, vitestDatabaseIdentity } from "@/lib/vitestDatabaseSafety";

const disposableDatabaseName = "crigestion_ci_test";

export function isDisposableTestDatabaseName(databaseName: string): boolean {
  return databaseName === disposableDatabaseName;
}

export async function assertDisposableTestDatabase(): Promise<void> {
  let declaredDatabase: string;
  try {
    declaredDatabase = decodeURIComponent(assertVitestDatabaseUrl(process.env).pathname.slice(1));
  } catch {
    throw new Error("TEST_DATABASE_RESET_NOT_ALLOWED");
  }
  if (!isDisposableTestDatabaseName(declaredDatabase)) {
    throw new Error("TEST_DATABASE_RESET_NOT_ALLOWED");
  }
  const rows = await prisma.$queryRaw<Array<{ applicationName: string; databaseName: string; databaseUser: string }>>`
    SELECT current_database() AS "databaseName", current_user AS "databaseUser",
           current_setting('application_name') AS "applicationName"
  `;
  const identity = rows[0];
  if (
    identity?.databaseName !== declaredDatabase ||
    identity.databaseUser !== vitestDatabaseIdentity.databaseUser ||
    identity.applicationName !== vitestDatabaseIdentity.applicationName
  ) {
    throw new Error("TEST_DATABASE_RESET_NOT_ALLOWED");
  }
}
