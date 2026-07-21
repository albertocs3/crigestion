import { createReadStream } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  decryptRecoveryBundleToFile,
  encryptRecoveryBundle,
  readRecoveryBundleMasterKey,
  verifyRecoveryBundle
} from "../modules/platform/infrastructure/recoveryBundleCrypto";
import { productVersion } from "../modules/platform/productVersion";

async function main(): Promise<void> {
  const [command, filePath, bundleId, keyId] = process.argv.slice(2);
  const keyFile = process.env.RECOVERY_BUNDLE_KEY_FILE;
  if (!keyFile) throw new Error("RECOVERY_BUNDLE_KEY_FILE_REQUIRED");
  const masterKey = await readRecoveryBundleMasterKey(keyFile);

  try {
    if (command === "check-key") {
      if (filePath || bundleId || keyId) {
        throw new Error("RECOVERY_BUNDLE_CHECK_KEY_ARGUMENTS_INVALID");
      }
      process.stdout.write("RECOVERY_BUNDLE_KEY_VALID\n");
      return;
    }

    if (command === "encrypt") {
      if (!filePath || !bundleId || !keyId) {
        throw new Error("RECOVERY_BUNDLE_ENCRYPT_ARGUMENTS_INVALID");
      }
      await encryptRecoveryBundle({
        source: process.stdin,
        outputPath: filePath,
        masterKey,
        header: {
          bundleId,
          keyId,
          createdAt: new Date().toISOString(),
          environment: "staging",
          productVersion
        }
      });
      process.stdout.write("RECOVERY_BUNDLE_ENCRYPTED\n");
      return;
    }

    if (command === "verify") {
      if (!filePath || bundleId || keyId) {
        throw new Error("RECOVERY_BUNDLE_VERIFY_ARGUMENTS_INVALID");
      }
      const header = await verifyRecoveryBundle(filePath, masterKey);
      process.stdout.write(`RECOVERY_BUNDLE_VERIFIED bundle_id=${header.bundleId}\n`);
      return;
    }

    if (command === "decrypt") {
      if (!filePath || bundleId || keyId) {
        throw new Error("RECOVERY_BUNDLE_DECRYPT_ARGUMENTS_INVALID");
      }
      const workRoot = process.env.RECOVERY_BUNDLE_WORK_DIRECTORY ?? os.tmpdir();
      const workDirectory = await mkdtemp(path.join(workRoot, "crigestion-recovery-"));
      const plaintextPath = path.join(workDirectory, "authenticated.tar.gz");
      await chmod(workDirectory, 0o700);
      try {
        await decryptRecoveryBundleToFile(filePath, plaintextPath, masterKey);
        await pipeline(createReadStream(plaintextPath), process.stdout);
      } finally {
        await rm(workDirectory, { recursive: true, force: true });
      }
      return;
    }

    throw new Error("RECOVERY_BUNDLE_COMMAND_INVALID");
  } finally {
    masterKey.fill(0);
  }
}

main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^[A-Z][A-Z0-9_]{2,119}$/.test(error.message)
      ? error.message
      : "RECOVERY_BUNDLE_CRYPTO_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
