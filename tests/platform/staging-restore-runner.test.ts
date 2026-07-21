import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

describe("staging isolated restore runner", () => {
  it("fails closed around the destructive restore and preserves external evidence", async () => {
    const script = await read("deploy/plesk/staging/scripts/crigestion-staging-restore");

    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("PG_BIN_DIR='/usr/lib/postgresql/14/bin'");
    expect(script).toContain("umask 077");
    expect(script).toContain("--confirm=crigestion_staging");
    expect(script).toContain("RESTORE_BACKUP_SYMLINK_FORBIDDEN");
    expect(script).toContain("RESTORE_RECOVERY_REQUIRED");
    expect(script).toContain("/var/lib/crigestion-staging-restore/restore-required");
    expect(script).toContain("flock -n 9");
    expect(script).toContain("sha256sum -c");
    expect(script).toContain("crigestion-staging-restore-drill");
    expect(script).toContain("--single-transaction");
    expect(script).toContain('--role="$MIGRATOR_ROLE"');
    expect(script).toContain('"securityVersion" = "securityVersion" + 1');
    expect(script).toContain('"revokeReason" = \'RESTORE_COMPLETED\'');

    expect(order(script, "set_phase 'STOPPING_SERVICES'"))
      .toBeLessThan(order(script, "set_phase 'CREATING_PRE_RESTORE_BACKUP'"));
    expect(order(script, "set_phase 'CREATING_PRE_RESTORE_BACKUP'"))
      .toBeLessThan(order(script, "DESTRUCTIVE_STARTED=1"));
    expect(order(script, "DESTRUCTIVE_STARTED=1"))
      .toBeLessThan(order(script, "--clean"));
    expect(order(script, "--clean"))
      .toBeLessThan(order(script, "set_phase 'MIGRATING_AND_HARDENING'"));
    expect(order(script, "set_phase 'MIGRATING_AND_HARDENING'"))
      .toBeLessThan(order(script, "set_phase 'INVALIDATING_SESSIONS'"));
    expect(order(script, "rm -f -- \"$SENTINEL\""))
      .toBeLessThan(order(script, 'systemctl start "$APP_SERVICE"', true));
  });

  it("blocks app, worker, backups and health checks while recovery is required", async () => {
    const [appUnit, workerUnit, backupScript, healthScript] = await Promise.all([
      read("deploy/plesk/staging/systemd/crigestion-staging-app.service"),
      read("deploy/plesk/staging/systemd/crigestion-staging-verifactu-worker.service"),
      read("deploy/plesk/staging/scripts/crigestion-staging-backup"),
      read("deploy/plesk/staging/scripts/crigestion-staging-health-check")
    ]);
    const sentinel = "/var/lib/crigestion-staging-restore/restore-required";

    expect(appUnit).toContain(`ExecStartPre=/usr/bin/test ! -e ${sentinel}`);
    expect(workerUnit).toContain(`ExecStartPre=/usr/bin/test ! -e ${sentinel}`);
    expect(backupScript).toContain(sentinel);
    expect(backupScript).toContain("BACKUP_BLOCKED_BY_RESTORE");
    expect(healthScript).toContain(sentinel);
    expect(healthScript).toContain("HEALTH_BLOCKED_BY_RESTORE");
  });

  it("tests restore ownership as the staging migrator before touching the active database", async () => {
    const drill = await read(
      "deploy/plesk/staging/scripts/crigestion-staging-restore-drill"
    );

    expect(drill).toContain("--role=crigestion_staging_migrator");
    expect(drill).toContain("RESTORE_DRILL_OK");
  });
});

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

function order(text: string, fragment: string, last = false): number {
  const index = last ? text.lastIndexOf(fragment) : text.indexOf(fragment);
  expect(index, `Missing fragment: ${fragment}`).toBeGreaterThanOrEqual(0);
  return index;
}
