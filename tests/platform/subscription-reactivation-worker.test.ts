import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("subscription reactivation automation deployment", () => {
  it("runs as a hardened one-shot timer and fails closed during restore", async () => {
    const [service, timer, health, script] = await Promise.all([
      read("deploy/plesk/staging/systemd/crigestion-staging-subscription-reactivation-worker.service"),
      read("deploy/plesk/staging/systemd/crigestion-staging-subscription-reactivation-worker.timer"),
      read("deploy/plesk/staging/scripts/crigestion-staging-health-check"),
      read("scripts/run-subscription-reactivation-worker.ts")
    ]);

    expect(service).toContain("Type=oneshot");
    expect(service).toContain("User=crigestion-staging");
    expect(service).toContain("NoNewPrivileges=true");
    expect(service).toContain("ProtectSystem=strict");
    expect(service).toContain("/var/lib/crigestion-staging-restore/restore-required");
    expect(service).toContain("run-subscription-reactivation-worker.ts");
    expect(timer).toContain("OnUnitActiveSec=5min");
    expect(timer).toContain("Persistent=true");
    expect(health).toContain("crigestion-staging-subscription-reactivation-worker.timer");
    expect(health).toContain("crigestion-staging-subscription-reactivation-worker.service");
    expect(health).toContain("ExecMainExitTimestampMonotonic");
    expect(health).toContain('REACTIVATION_ACTIVE_STATE');
    expect(health).toContain("= 'activating'");
    expect(health).toContain("CRIGESTION_STAGING_SUBSCRIPTION_REACTIVATION_WORKER_NEVER_RAN");
    expect(health).toContain("CRIGESTION_STAGING_SUBSCRIPTION_REACTIVATION_WORKER_STALE");
    expect(service).toContain("TimeoutStartSec=120s");
    expect(script).toContain("SUBSCRIPTION_REACTIVATION_AUTOMATION_OK");
    expect(script).not.toContain("reason");
  });
});

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}
