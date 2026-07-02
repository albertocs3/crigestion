import { prisma } from "../lib/prisma";
import { processNextRequestedBackup } from "../modules/platform/infrastructure/backupExecutor";

async function main(): Promise<void> {
  const result = await processNextRequestedBackup({ prisma });

  if (!result.processed) {
    console.log("No requested backup operation found.");
    return;
  }

  if (result.status === "VERIFIED") {
    console.log(`Backup ${result.operationId} verified: ${result.storageKey}`);
    return;
  }

  console.error(`Backup ${result.operationId} failed: ${result.errorCode}`);
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
