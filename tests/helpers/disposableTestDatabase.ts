import { prisma } from "@/lib/prisma";
import {
  assertE2eDatabaseUrl,
  e2eDatabaseIdentity
} from "@/lib/e2eDatabaseSafety";
import { assertVitestDatabaseUrl, vitestDatabaseIdentity } from "@/lib/vitestDatabaseSafety";

const disposableDatabaseNames = new Set<string>([
  vitestDatabaseIdentity.databaseName,
  e2eDatabaseIdentity.databaseName
]);

export function isDisposableTestDatabaseName(databaseName: string): boolean {
  return disposableDatabaseNames.has(databaseName);
}

export async function assertDisposableTestDatabase(): Promise<void> {
  let expectedIdentity: {
    applicationName: string;
    databaseName: string;
    databaseUser: string;
  };
  try {
    assertVitestDatabaseUrl(process.env);
    expectedIdentity = vitestDatabaseIdentity;
  } catch {
    try {
      assertE2eDatabaseUrl(process.env);
      expectedIdentity = e2eDatabaseIdentity;
    } catch {
      throw new Error("TEST_DATABASE_RESET_NOT_ALLOWED");
    }
  }
  if (!isDisposableTestDatabaseName(expectedIdentity.databaseName)) {
    throw new Error("TEST_DATABASE_RESET_NOT_ALLOWED");
  }
  const rows = await prisma.$queryRaw<Array<{ applicationName: string; databaseName: string; databaseUser: string }>>`
    SELECT current_database() AS "databaseName", current_user AS "databaseUser",
           current_setting('application_name') AS "applicationName"
  `;
  const identity = rows[0];
  if (
    identity?.databaseName !== expectedIdentity.databaseName ||
    identity.databaseUser !== expectedIdentity.databaseUser ||
    identity.applicationName !== expectedIdentity.applicationName
  ) {
    throw new Error("TEST_DATABASE_RESET_NOT_ALLOWED");
  }
}
