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
    return await readVerifiedIdentity(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function resetVitestCrossTestDependencies(): Promise<void> {
  const parsed = assertVitestDatabaseUrl(process.env);
  const client = new Client({ connectionString: parsed.toString() });

  try {
    await client.connect();
    await readVerifiedIdentity(client);
    // Customer contacts are append-only and newer than many file-local reset lists.
    // Truncating this root also clears dependent Support rows without disabling guards.
    await client.query("TRUNCATE TABLE public.customer_contacts RESTART IDENTITY CASCADE");
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function readVerifiedIdentity(client: Client): Promise<VerifiedVitestDatabase> {
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
}
