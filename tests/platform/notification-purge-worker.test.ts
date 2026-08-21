import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("notification retention automation deployment", () => {
  it("runs daily as a hardened bounded one-shot and is covered by health and recovery", async () => {
    const [service, timer, health, recovery, restore, migrator, script] = await Promise.all([
      read("deploy/plesk/staging/systemd/crigestion-staging-notification-purge.service"),
      read("deploy/plesk/staging/systemd/crigestion-staging-notification-purge.timer"),
      read("deploy/plesk/staging/scripts/crigestion-staging-health-check"),
      read("deploy/plesk/staging/scripts/crigestion-staging-recovery-bundle"),
      read("deploy/plesk/staging/scripts/crigestion-staging-restore"),
      read("scripts/deploy-staging-migrations.ts"),
      read("scripts/run-notification-purge.ts"),
    ]);

    expect(service).toContain("Type=oneshot");
    expect(service).toContain("User=crigestion-staging");
    expect(service).toContain("NoNewPrivileges=true");
    expect(service).toContain("ProtectSystem=strict");
    expect(service).toContain("/var/lib/crigestion-staging-restore/restore-required");
    expect(service).toContain("run-notification-purge.ts");
    expect(service).toContain("TimeoutStartSec=600s");
    expect(timer).toContain("OnCalendar=*-*-* 04:15:00 Europe/Madrid");
    expect(timer).toContain("RandomizedDelaySec=15min");
    expect(timer).toContain("Persistent=true");
    expect(health).toContain("crigestion-staging-notification-purge.timer");
    expect(health).toContain("crigestion-staging-notification-purge.service");
    expect(health).toContain("CRIGESTION_STAGING_NOTIFICATION_PURGE_NEVER_RAN");
    expect(health).toContain("CRIGESTION_STAGING_NOTIFICATION_PURGE_STALE");
    expect(recovery).toContain("crigestion-staging-notification-purge.service");
    expect(recovery).toContain("crigestion-staging-notification-purge.timer");
    expect(restore).toContain("crigestion-staging-notification-purge.service");
    expect(restore).toContain("crigestion-staging-notification-purge.timer");
    expect(script).toContain("NOTIFICATION_PURGE_BATCH_SIZE");
    expect(script).toContain("NOTIFICATION_PURGE_MAX_BATCHES");
    expect(script).toContain("NOTIFICATION_PURGE_AUTOMATION_OK");
    expect(script).toContain("NOTIFICATION_PURGE_BACKLOG_REMAINS");
    expect(migrator).toContain("REVOKE DELETE ON TABLE public.notifications, public.notification_state_changes");
    expect(migrator).toContain("purge_expired_notifications(integer, integer, text)");
  });
});

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}
