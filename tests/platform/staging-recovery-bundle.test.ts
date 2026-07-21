import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import packageManifest from "../../package.json";

const root = process.cwd();

describe("staging recovery bundle deployment", () => {
  it("builds an encrypted allowlisted bundle without nesting its master key", async () => {
    const script = await read("deploy/plesk/staging/scripts/crigestion-staging-recovery-bundle");

    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("PG_BIN_DIR='/usr/lib/postgresql/14/bin'");
    expect(script).toContain("umask 077");
    expect(script).toContain("verify-staging-recovery-keyrings.ts");
    expect(script).toContain("recovery-bundle-crypto.ts");
    expect(script).toContain("RECOVERY_BUNDLE_KEY_FILE");
    expect(script).not.toContain("BACKUP_ENCRYPTION_KEY");
    expect(script).not.toContain("recovery-bundle.key.cred");
    expect(script).toContain('"uploads": { "status": "not_implemented"');
    expect(script).toContain("roles-allowlisted.sql");
    expect(script).toContain("application-release.tar");
    expect(script).toContain("RELEASE_COMMIT");
    expect(script).toContain("--dereference --hard-dereference");
    expect(script).toContain("CONFIG_HASH_BEFORE");
    expect(script).toContain("CONFIG_HASH_AFTER");
    expect(script).toContain("RECOVERY_BUNDLE_OK");
    expect(script).toContain('[ "$PUBLISHED" -eq 1 ]');
    expect(packageManifest.dependencies.dotenv).toBeDefined();

    for (const file of [
      "app.env",
      "verifactu-worker.env",
      "migrator.env",
      "alert.env",
      "build.env",
      "recovery-bundle.env"
    ]) {
      expect(script).toContain(file);
    }
  });

  it("uses a root-only systemd credential and a root-only runtime directory", async () => {
    const script = await read(
      "deploy/plesk/staging/scripts/crigestion-staging-recovery-bundle"
    );
    const unit = await read(
      "deploy/plesk/staging/systemd/crigestion-staging-recovery-bundle.service"
    );
    const timer = await read(
      "deploy/plesk/staging/systemd/crigestion-staging-recovery-bundle.timer"
    );
    const alert = await read(
      "deploy/plesk/staging/systemd/crigestion-staging-recovery-bundle-alert.service"
    );

    expect(unit).toContain("LoadCredential=recovery-bundle.key:");
    expect(unit).toContain("InaccessiblePaths=/etc/crigestion-staging/recovery-bundle.key");
    expect(unit).toContain("EnvironmentFile=/etc/crigestion-staging/recovery-bundle.env");
    expect(unit).not.toContain("RECOVERY_BUNDLE_KEY_FILE=");
    expect(script).toContain(
      'EXPECTED_KEY_FILE="$CREDENTIALS_DIRECTORY/recovery-bundle.key"'
    );
    expect(script).toContain("RECOVERY_BUNDLE_KEY_SOURCE_CONFLICT");
    expect(script).toContain('RECOVERY_BUNDLE_KEY_FILE="$KEY_FILE"');
    expect(script).not.toContain("export RECOVERY_BUNDLE_KEY_FILE");
    expect(unit).toContain("RuntimeDirectoryMode=0700");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("OnFailure=crigestion-staging-recovery-bundle-alert.service");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("crigestion-staging-recovery-bundle.service");
    expect(alert).toContain("recovery-bundle-failure");
  });

  it("monitors freshness and transport checksum without loading the decryption key", async () => {
    const health = await read(
      "deploy/plesk/staging/scripts/crigestion-staging-health-check"
    );

    expect(health).toContain("crigestion-staging-recovery-bundle.timer");
    expect(health).toContain("CRIGESTION_STAGING_RECOVERY_BUNDLE_STALE");
    expect(health).toContain("sha256sum -c");
    expect(health).not.toContain("RECOVERY_BUNDLE_KEY_FILE");
  });

  it("validates the master key before atomically publishing its source file", async () => {
    const cryptoCli = await read("scripts/recovery-bundle-crypto.ts");
    const runbook = await read("docs/plataforma/11-despliegue-staging-plesk.md");

    expect(cryptoCli).toContain('command === "check-key"');
    expect(cryptoCli).toContain("RECOVERY_BUNDLE_KEY_VALID");
    expect(runbook).toContain("mktemp /etc/crigestion-staging/.recovery-bundle.key");
    expect(runbook).toContain("check-key");
    expect(runbook).toContain("ln -- \"$KEY_TEMP\" \"$KEY_FINAL\"");
  });
});

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}
