import { spawn } from "node:child_process";
import { Client } from "pg";
import {
  assertStagingMigratorEnvironment,
  stagingMigratorDatabaseRole,
  stagingRuntimeDatabaseRole
} from "../modules/platform/application/stagingEnvironment";

const migrationLockId = 2_026_071_502;

async function main(): Promise<void> {
  if (
    process.env.APP_ENV !== "staging" ||
    process.env.CRIGESTION_MIGRATION_CONFIRM_STAGING !== "CRIGESTION_STAGING_MIGRATION_AUTHORIZED"
  ) {
    throw new Error("STAGING_MIGRATION_CONFIRMATION_REQUIRED");
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("STAGING_MIGRATION_DATABASE_URL_MISSING");
  assertStagingMigratorEnvironment(process.env);

  const client = new Client({
    connectionString,
    application_name: "crigestion-staging-migration-preflight"
  });
  await client.connect();
  try {
    const identity = await client.query<{
      databaseName: string;
      databaseRole: string;
      serverAddress: string | null;
      serverPort: number | null;
    }>(
      `SELECT current_database() AS "databaseName", current_user AS "databaseRole",
        inet_server_addr()::text AS "serverAddress", inet_server_port() AS "serverPort"`
    );
    assertStagingMigratorEnvironment(process.env, identity.rows[0]);

    const roles = await client.query<{
      roleName: string;
      elevated: boolean;
    }>(
      `SELECT rolname AS "roleName",
        rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls AS "elevated"
      FROM pg_roles WHERE rolname = ANY($1::text[])`,
      [[stagingRuntimeDatabaseRole, stagingMigratorDatabaseRole]]
    );
    if (
      roles.rows.length !== 2 ||
      roles.rows.some((role) => role.elevated) ||
      roles.rows.every((role) => role.roleName !== stagingRuntimeDatabaseRole) ||
      roles.rows.every((role) => role.roleName !== stagingMigratorDatabaseRole)
    ) {
      throw new Error("STAGING_MIGRATION_RUNTIME_ROLE_UNSAFE");
    }

    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS "acquired"',
      [migrationLockId]
    );
    if (!lock.rows[0]?.acquired) throw new Error("STAGING_MIGRATION_ALREADY_RUNNING");

    await runPrismaMigrateDeploy();
    await hardenRuntimePrivileges(client, stagingRuntimeDatabaseRole);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function hardenRuntimePrivileges(client: Client, runtimeRole: string): Promise<void> {
  const roleIdentifier = quoteIdentifier(runtimeRole);
  await client.query("BEGIN");
  try {
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await client.query(`REVOKE CREATE ON SCHEMA public FROM ${roleIdentifier}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${roleIdentifier}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleIdentifier}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${roleIdentifier}`);
    await client.query(`REVOKE UPDATE ON ALL SEQUENCES IN SCHEMA public FROM ${roleIdentifier}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE UPDATE ON SEQUENCES FROM ${roleIdentifier}`);
    await client.query(`REVOKE ALL ON TABLE public._prisma_migrations FROM ${roleIdentifier}`);
    await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.audit_events FROM ${roleIdentifier}`);
    await assertRuntimePrivilegesHardened(client, runtimeRole);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function assertRuntimePrivilegesHardened(client: Client, runtimeRole: string): Promise<void> {
  const result = await client.query<{
    migrationAccess: boolean;
    sequenceUpdate: boolean;
    auditMutation: boolean;
    protectedOwnership: boolean;
    schemaCreate: boolean;
  }>(
    `SELECT
      has_table_privilege($1, 'public._prisma_migrations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS "migrationAccess",
      COALESCE((SELECT bool_or(has_sequence_privilege($1, c.oid, 'UPDATE'))
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'S'), false) AS "sequenceUpdate",
      (has_table_privilege($1, 'public.audit_events', 'UPDATE')
        OR has_table_privilege($1, 'public.audit_events', 'DELETE')
        OR has_table_privilege($1, 'public.audit_events', 'TRUNCATE')) AS "auditMutation",
      EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_roles r ON r.oid = c.relowner
        WHERE n.nspname = 'public' AND r.rolname = $1
          AND (c.relkind = 'S' OR c.relname IN ('_prisma_migrations', 'audit_events'))) AS "protectedOwnership",
      has_schema_privilege($1, 'public', 'CREATE') AS "schemaCreate"`,
    [runtimeRole]
  );
  const state = result.rows[0];
  if (!state || state.migrationAccess || state.sequenceUpdate || state.auditMutation || state.protectedOwnership || state.schemaCreate) {
    throw new Error("STAGING_MIGRATION_RUNTIME_PRIVILEGES_UNSAFE");
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function runPrismaMigrateDeploy(): Promise<void> {
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["node_modules/prisma/build/index.js", "migrate", "deploy"],
      { stdio: "inherit", shell: false }
    );
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) throw new Error("STAGING_MIGRATION_DEPLOY_FAILED");
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,119}$/.test(error.message)
    ? error.message
    : "STAGING_MIGRATION_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
