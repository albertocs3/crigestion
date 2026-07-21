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
    expect(script).toContain('"status": "included"');
    expect(script).toContain("ATTACHMENT_DIR='/var/lib/crigestion-staging/attachments'");
    expect(script).toContain("attachments.tar.sha256");
    expect(script).toContain("RECOVERY_ATTACHMENT_PATH_REJECTED");
    expect(script).toContain("ATTACHMENT_ROOT_DECLARATIONS");
    expect(script).toContain("REFERENCED_UPLOAD_ENTRIES");
    expect(script).toContain("MAX_ATTACHMENT_BYTES");
    expect(script).toContain("MAX_UPLOAD_BYTES");
    expect(script).toContain("MAX_PAYLOAD_BYTES");
    expect(script).toContain("ulimit -f");
    expect(script).toContain("SNAPSHOT_UPLOAD_BYTES");
    expect(script).toContain("crigestion_bundle_snapshot_");
    expect(script).toContain('--dbname="$SNAPSHOT_DB"');
    expect(script).toContain("RECOVERY_BUNDLE_SNAPSHOT_CLEANUP_FAILED");
    expect(script).toContain("SET ROLE crigestion_staging_app");
    expect(script).toContain('"productVersion": "$PRODUCT_VERSION"');
    expect(script).toContain('"$WORK_DIR/configuration/app.env"');
    expect(script).toContain('test "$(sha256sum "$referenced_file"');
    expect(script).toContain('"quarantineIncluded": false');
    expect(script).toContain("roles-allowlisted.sql");
    expect(script).toContain("application-release.tar");
    expect(script).toContain("RELEASE_COMMIT");
    expect(script).toContain("--dereference --hard-dereference");
    expect(script).toContain("CONFIG_HASH_BEFORE");
    expect(script).toContain("CONFIG_HASH_AFTER");
    expect(script).toContain("RECOVERY_BUNDLE_OK");
    expect(script).toContain("crigestion-staging-recovery-drill");
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
    expect(unit).toContain("StateDirectoryMode=0700");
    expect(unit).toContain("MemoryMax=1G");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ReadOnlyPaths=/var/lib/crigestion-staging/attachments");
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
    expect(health).toContain("clamav-daemon.service");
    expect(health).toContain("test -x /usr/bin/clamdscan");
  });

  it("validates the master key before atomically publishing its source file", async () => {
    const cryptoCli = await read("scripts/recovery-bundle-crypto.ts");
    const runbook = await read("docs/plataforma/11-despliegue-staging-plesk.md");

    expect(cryptoCli).toContain('command === "check-key"');
    expect(cryptoCli).toContain('command === "inspect"');
    expect(cryptoCli).toContain("RECOVERY_BUNDLE_KEY_VALID");
    expect(runbook).toContain("mktemp /etc/crigestion-staging/.recovery-bundle.key");
    expect(runbook).toContain("check-key");
    expect(runbook).toContain("ln -- \"$KEY_TEMP\" \"$KEY_FINAL\"");
  });

  it("drills database and attachments without touching the active database", async () => {
    const drill = await read(
      "deploy/plesk/staging/scripts/crigestion-staging-recovery-drill"
    );
    const extractor = await read("scripts/extract-recovery-bundle.py");
    const unit = await read(
      "deploy/plesk/staging/systemd/crigestion-staging-recovery-drill.service"
    );

    expect(drill).toContain("set -euo pipefail");
    expect(drill).toContain("crigestion_recovery_drill_");
    expect(drill).toContain("extract-recovery-bundle.py");
    expect(drill).toContain("pg_restore");
    expect(drill).toContain('test "$(sha256sum "$restored_file"');
    expect(drill).toContain("RECOVERY_DRILL_OK");
    expect(drill).toContain("RECOVERY_DRILL_CLEANUP_FAILED");
    expect(drill).toContain("MANIFEST_REFERENCED_COUNT");
    expect(drill).toContain('cmp --silent "$RESTORED_REFERENCES"');
    expect(drill).toContain('"$PAYLOAD/configuration/app.env"');
    expect(drill).not.toContain('dropdb "$ACTIVE_DB"');
    expect(extractor).toContain("RECOVERY_ARCHIVE_SPECIAL_ENTRY_REJECTED");
    expect(extractor).toContain("RECOVERY_INVENTORY_HASH_MISMATCH");
    expect(unit).toContain("LoadCredential=recovery-bundle.key:");
    expect(unit).toContain("StateDirectoryMode=0700");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("MemoryMax=1G");
    expect(drill).toContain('recovery-bundle-crypto.ts" inspect');
    expect(drill).toContain("SET ROLE crigestion_staging_app");
    expect(drill).toContain("STALE_DRILL_DATABASES");
  });
});

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}
