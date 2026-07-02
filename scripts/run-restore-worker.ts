import { prisma } from "../lib/prisma";
import { processNextRequestedRestore } from "../modules/platform/infrastructure/restoreExecutor";

async function main(): Promise<void> {
  const result = await processNextRequestedRestore({ prisma });

  if (!result.processed) {
    console.log("No requested restore operation found.");
    return;
  }

  if (result.status === "VALIDATED") {
    console.log(`Restore ${result.operationId} validated: ${result.backupOperationId}`);
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
