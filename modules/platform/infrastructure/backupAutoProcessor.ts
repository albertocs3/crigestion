import "server-only";

import { prisma } from "@/lib/prisma";
import { processNextRequestedBackup } from "@/modules/platform/infrastructure/backupExecutor";

let processing = false;

export function scheduleRequestedBackupProcessing(): void {
  if (!shouldAutoProcessBackups() || processing) {
    return;
  }

  processing = true;

  void processNextRequestedBackup({ prisma })
    .catch((error) => {
      console.error("Automatic backup processing failed.", error);
    })
    .finally(() => {
      processing = false;
    });
}

function shouldAutoProcessBackups(): boolean {
  const value = process.env.BACKUP_AUTO_PROCESS?.trim().toLocaleLowerCase("en-US");

  if (value) {
    return ["1", "true", "yes", "on"].includes(value);
  }

  return process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test";
}
