import { Client } from "pg";
import {
  assertVitestDatabaseUrl,
  vitestDatabaseIdentity
} from "@/lib/vitestDatabaseSafety";

type VerifiedVitestDatabase = {
  applicationName: string;
  databaseName: string;
  databaseUser: string;
};

export async function verifyVitestDatabaseEnvironment(): Promise<VerifiedVitestDatabase> {
  const parsed = assertVitestDatabaseUrl(process.env);
  const client = new Client({ connectionString: parsed.toString() });

  try {
    await client.connect();
    const result = await client.query<{
      application_name: string;
      database_name: string;
      database_user: string;
    }>(
      `SELECT current_database() AS database_name,
              current_user AS database_user,
              current_setting('application_name') AS application_name`
    );
    const identity = result.rows[0];
    if (
      identity?.database_name !== vitestDatabaseIdentity.databaseName ||
      identity.database_user !== vitestDatabaseIdentity.databaseUser ||
      identity.application_name !== vitestDatabaseIdentity.applicationName
    ) {
      throw new Error("VITEST_DATABASE_RESET_NOT_ALLOWED");
    }

    return {
      applicationName: identity.application_name,
      databaseName: identity.database_name,
      databaseUser: identity.database_user
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}
