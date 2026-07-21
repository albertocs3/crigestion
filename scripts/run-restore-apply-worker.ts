import { prisma } from "../lib/prisma";
import {
  createPgRestoreApplyPort,
  processNextValidatedRestoreApply
} from "../modules/platform/infrastructure/restoreExecutor";

async function main(): Promise<void> {
  if (!process.env.RESTORE_TARGET_DATABASE_URL) {
    console.error("RESTORE_TARGET_DATABASE_URL is required to apply a restore.");
    process.exitCode = 1;
    return;
  }

  const result = await processNextValidatedRestoreApply({
    prisma,
    applyRestore: createPgRestoreApplyPort()
  });

  if (!result.processed) {
    console.log("No validated restore operation in maintenance mode found.");
    return;
  }

  if (result.status === "COMPLETED") {
    console.log(
      `Restore ${result.operationId} completed with pre-restore backup ${result.preRestoreBackupOperationId}. ${result.revokedSessionCount} sessions revoked and ${result.versionedUserCount} users versioned. Application restart is required before leaving maintenance mode.`
    );
    return;
  }

  console.error(`Restore ${result.operationId} failed: ${result.errorCode}`);
  process.exitCode = 1;
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
