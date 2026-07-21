import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { parse } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createVerifactuPayloadKeyring } from "../modules/billing/infrastructure/verifactu/payloadCipher";
import { createSecureEnvelopeKeyring } from "../modules/billing/infrastructure/verifactu/secureEnvelope";

const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

async function main(): Promise<void> {
  const [appEnvironmentPath, workerEnvironmentPath, expectedDatabaseArgument] = process.argv.slice(2);
  if (!appEnvironmentPath || !workerEnvironmentPath) {
    throw new Error("RECOVERY_KEYRING_ENV_PATHS_REQUIRED");
  }
  const expectedDatabase = expectedDatabaseArgument ?? "crigestion_staging";
  if (
    expectedDatabase !== "crigestion_staging" &&
    !/^crigestion_(?:bundle_snapshot|recovery_drill)_[0-9]{8}t[0-9]{6}z$/.test(expectedDatabase)
  ) {
    throw new Error("RECOVERY_DATABASE_OVERRIDE_INVALID");
  }

  const [appEnvironment, workerEnvironment] = await Promise.all([
    readEnvironment(appEnvironmentPath),
    readEnvironment(workerEnvironmentPath)
  ]);
  const credentialKeys = readKeyring(
    appEnvironment,
    "VERIFACTU_CREDENTIAL_ACTIVE_KEY_ID",
    "VERIFACTU_CREDENTIAL_KEYS"
  );
  const workerCredentialKeys = readKeyring(
    workerEnvironment,
    "VERIFACTU_CREDENTIAL_ACTIVE_KEY_ID",
    "VERIFACTU_CREDENTIAL_KEYS"
  );
  const payloadKeys = readKeyring(
    appEnvironment,
    "VERIFACTU_PAYLOAD_ACTIVE_KEY_ID",
    "VERIFACTU_PAYLOAD_KEYS"
  );
  const workerPayloadKeys = readKeyring(
    workerEnvironment,
    "VERIFACTU_PAYLOAD_ACTIVE_KEY_ID",
    "VERIFACTU_PAYLOAD_KEYS"
  );
  const responseKeys = readKeyring(
    workerEnvironment,
    "VERIFACTU_RESPONSE_ACTIVE_KEY_ID",
    "VERIFACTU_RESPONSE_KEYS"
  );

  if (
    serializeKeyring(credentialKeys) !== serializeKeyring(workerCredentialKeys) ||
    serializeKeyring(payloadKeys) !== serializeKeyring(workerPayloadKeys)
  ) {
    throw new Error("RECOVERY_SHARED_KEYRINGS_MISMATCH");
  }
  if (
    appEnvironment.VERIFACTU_ENVIRONMENT !== "TEST" ||
    workerEnvironment.VERIFACTU_WORKER_ENVIRONMENT !== "TEST" ||
    appEnvironment.VERIFACTU_ALLOW_PRODUCTION !== "false" ||
    workerEnvironment.VERIFACTU_WORKER_ALLOW_PRODUCTION !== "false"
  ) {
    throw new Error("RECOVERY_STAGING_VERIFACTU_ENVIRONMENT_UNSAFE");
  }

  const configuredDatabaseUrl = appEnvironment.DATABASE_URL;
  if (!configuredDatabaseUrl) throw new Error("RECOVERY_DATABASE_URL_MISSING");
  const databaseUrl = databaseUrlFor(configuredDatabaseUrl, expectedDatabase);
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "crigestion-staging-recovery-keyring-check"
  });
  await client.connect();
  try {
    const identity = await client.query<{ database: string; role: string }>(
      'SELECT current_database() AS database, current_user AS role'
    );
    if (
      identity.rows[0]?.database !== expectedDatabase ||
      identity.rows[0]?.role !== "crigestion_staging_app"
    ) {
      throw new Error("RECOVERY_DATABASE_IDENTITY_INVALID");
    }

    const verifiedReferences = await verifyHistoricalEnvelopes(client, {
      credential: credentialKeys,
      payload: payloadKeys,
      response: responseKeys
    });

    process.stdout.write(
      `RECOVERY_KEYRINGS_OK credential=${credentialKeys.keys.size} payload=${payloadKeys.keys.size} response=${responseKeys.keys.size} references=${verifiedReferences}\n`
    );
  } finally {
    await client.end();
  }
}

function databaseUrlFor(configuredUrl: string, expectedDatabase: string): string {
  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error("RECOVERY_DATABASE_URL_INVALID");
  }
  if (
    (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== "5432" ||
    decodeURIComponent(parsed.username) !== "crigestion_staging_app"
  ) {
    throw new Error("RECOVERY_DATABASE_URL_INVALID");
  }
  parsed.pathname = `/${expectedDatabase}`;
  return parsed.toString();
}

async function readEnvironment(filePath: string): Promise<Record<string, string>> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const file = await handle.stat();
    const currentUserId = process.getuid?.();
    if (
      !file.isFile() ||
      (file.mode & 0o007) !== 0 ||
      (currentUserId !== undefined && file.uid !== currentUserId)
    ) {
      throw new Error("RECOVERY_ENV_FILE_UNSAFE");
    }
    return parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

function readKeyring(
  environment: Record<string, string>,
  activeIdName: string,
  keysName: string
): { activeId: string; keys: Map<string, string> } {
  const activeId = environment[activeIdName] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(environment[keysName] ?? "");
  } catch {
    throw new Error("RECOVERY_KEYRING_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RECOVERY_KEYRING_INVALID");
  }

  const keys = new Map<string, string>();
  for (const [keyId, encoded] of Object.entries(parsed)) {
    if (!keyIdPattern.test(keyId) || typeof encoded !== "string") {
      throw new Error("RECOVERY_KEYRING_INVALID");
    }
    const key = Buffer.from(encoded, "base64");
    if (key.byteLength !== 32 || key.toString("base64") !== encoded) {
      throw new Error("RECOVERY_KEYRING_INVALID");
    }
    keys.set(keyId, encoded);
  }
  if (!keys.has(activeId)) throw new Error("RECOVERY_ACTIVE_KEY_MISSING");
  return { activeId, keys };
}

function serializeKeyring(keyring: { activeId: string; keys: Map<string, string> }): string {
  return JSON.stringify({
    activeId: keyring.activeId,
    keys: [...keyring.keys.entries()].sort(([left], [right]) => left.localeCompare(right))
  });
}

export async function verifyHistoricalEnvelopes(
  client: Client,
  keyrings: Record<"credential" | "payload" | "response", ReturnType<typeof readKeyring>>
): Promise<number> {
  const credentialCipher = createSecureEnvelopeKeyring({
    activeKeyId: keyrings.credential.activeId,
    keys: decodedKeys(keyrings.credential.keys)
  });
  const payloadCipher = createVerifactuPayloadKeyring({
    activeKeyId: keyrings.payload.activeId,
    keys: decodedKeys(keyrings.payload.keys)
  });
  const responseCipher = createSecureEnvelopeKeyring({
    activeKeyId: keyrings.response.activeId,
    keys: decodedKeys(keyrings.response.keys)
  });

  const credentials = await client.query<{
    allowProduction: boolean;
    allowTest: boolean;
    companyId: string;
    credentialId: string;
    encryptionKeyId: string;
    endpointKind: "STANDARD" | "SEAL";
    materialCiphertext: Buffer;
    pfxSha256: string;
    validFrom: Date;
    validUntil: Date;
    version: number;
    versionId: string;
  }>(`
    SELECT DISTINCT ON (v."encryptionKeyId")
      v."encryptionKeyId", v."materialCiphertext", v."id" AS "versionId",
      v."credentialId", v."version", v."endpointKind", v."allowTest",
      v."allowProduction", v."validFrom", v."validUntil", v."pfxSha256",
      c."companyId"
    FROM public.verifactu_mtls_credential_versions v
    JOIN public.verifactu_mtls_credentials c ON c.id = v."credentialId"
    ORDER BY v."encryptionKeyId", v."createdAt", v.id
  `);
  for (const row of credentials.rows) {
    requireKey(keyrings.credential.keys, row.encryptionKeyId);
    const plaintext = credentialCipher.decrypt(row.materialCiphertext, [
      "VERIFACTU-MTLS-CREDENTIAL",
      row.companyId,
      row.credentialId,
      row.versionId,
      String(row.version),
      row.endpointKind,
      String(row.allowTest),
      String(row.allowProduction),
      row.validFrom.toISOString(),
      row.validUntil.toISOString(),
      row.pfxSha256
    ]);
    plaintext.fill(0);
  }

  const payloads = await client.query<{
    companyId: string;
    encryptionKeyId: string;
    environment: "TEST" | "PRODUCTION";
    invoiceId: string;
    payloadCiphertext: Buffer;
    payloadSha256: string;
    preparationKey: string;
    recordType: "ALTA" | "ANULACION";
    sifInstallationId: string;
  }>(`
    SELECT DISTINCT ON (r."encryptionKeyId")
      r."encryptionKeyId", r."payloadCiphertext", r."payloadSha256",
      r."companyId", r."sifInstallationId", r."invoiceId",
      r."preparationKey", r."recordType", s."environment"
    FROM public.verifactu_fiscal_records r
    JOIN public.verifactu_sif_installations s ON s.id = r."sifInstallationId"
    ORDER BY r."encryptionKeyId", r."createdAt", r.id
  `);
  for (const row of payloads.rows) {
    requireKey(keyrings.payload.keys, row.encryptionKeyId);
    const plaintext = payloadCipher.decrypt(row.payloadCiphertext, {
      companyId: row.companyId,
      sifInstallationId: row.sifInstallationId,
      invoiceId: row.invoiceId,
      preparationKey: row.preparationKey,
      payloadSha256: row.payloadSha256,
      recordType: row.recordType,
      environment: row.environment
    });
    try {
      if (createHash("sha256").update(plaintext).digest("hex") !== row.payloadSha256) {
        throw new Error("RECOVERY_HISTORICAL_KEY_DECRYPTION_FAILED");
      }
    } finally {
      plaintext.fill(0);
    }
  }

  const responses = await client.query<{
    companyId: string;
    credentialVersionId: string;
    encryptionKeyId: string;
    endpointKind: "STANDARD" | "SEAL";
    environment: "TEST" | "PRODUCTION";
    idempotencyKey: string;
    invoiceId: string;
    kind: "SUBMIT" | "RECONCILE";
    preparationKey: string;
    responseCiphertext: Buffer;
    responseSha256: string;
    sifInstallationId: string;
  }>(`
    SELECT DISTINCT ON (a."encryptionKeyId")
      a."encryptionKeyId", a."responseCiphertext", a."responseSha256",
      a."credentialVersionId", a."idempotencyKey", a."kind",
      r."companyId", r."sifInstallationId", r."invoiceId", r."preparationKey",
      s."environment", v."endpointKind"
    FROM public.verifactu_submission_attempts a
    JOIN public.verifactu_fiscal_records r ON r.id = a."fiscalRecordId"
    JOIN public.verifactu_sif_installations s ON s.id = r."sifInstallationId"
    JOIN public.verifactu_mtls_credential_versions v ON v.id = a."credentialVersionId"
    WHERE a."responseCiphertext" IS NOT NULL
      AND a."responseSha256" IS NOT NULL
      AND a."encryptionKeyId" IS NOT NULL
    ORDER BY a."encryptionKeyId", a."createdAt", a.id
  `);
  for (const row of responses.rows) {
    requireKey(keyrings.response.keys, row.encryptionKeyId);
    const plaintext = responseCipher.decrypt(row.responseCiphertext, [
      "VERIFACTU-AEAT-RESPONSE",
      row.kind,
      row.environment,
      row.idempotencyKey,
      row.companyId,
      row.sifInstallationId,
      row.invoiceId,
      row.preparationKey,
      row.credentialVersionId,
      row.endpointKind,
      row.responseSha256
    ]);
    try {
      if (createHash("sha256").update(plaintext).digest("hex") !== row.responseSha256) {
        throw new Error("RECOVERY_HISTORICAL_KEY_DECRYPTION_FAILED");
      }
    } finally {
      plaintext.fill(0);
    }
  }

  return (credentials.rowCount ?? 0) + (payloads.rowCount ?? 0) + (responses.rowCount ?? 0);
}

function decodedKeys(keys: Map<string, string>): Record<string, Uint8Array> {
  return Object.fromEntries(
    [...keys].map(([keyId, encoded]) => [keyId, Buffer.from(encoded, "base64")])
  );
}

function requireKey(keys: Map<string, string>, keyId: string): void {
  if (!keys.has(keyId)) throw new Error("RECOVERY_HISTORICAL_KEY_MISSING");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]{2,119}$/.test(error.message)
        ? error.message
        : "RECOVERY_KEYRING_CHECK_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
