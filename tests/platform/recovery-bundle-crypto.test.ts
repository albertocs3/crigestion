import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptRecoveryBundleToFile,
  encryptRecoveryBundle,
  verifyRecoveryBundle
} from "@/modules/platform/infrastructure/recoveryBundleCrypto";

describe("recovery bundle crypto", () => {
  let directory: string;
  const key = Buffer.from(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "hex"
  );

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "crigestion-recovery-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("encrypts, authenticates and decrypts a bundle with strict metadata", async () => {
    const artifact = path.join(directory, "bundle.cgrb");
    const plaintext = Buffer.from("fake gzip recovery archive");

    await encryptRecoveryBundle({
      source: Readable.from([plaintext]),
      outputPath: artifact,
      masterKey: key,
      header: {
        bundleId: "staging-20260721T120000Z",
        keyId: "recovery-2026-01",
        createdAt: "2026-07-21T12:00:00.000Z",
        environment: "staging",
        productVersion: "0.1.0"
      }
    });

    const header = await verifyRecoveryBundle(artifact, key);
    const decrypted = path.join(directory, "decrypted.tar.gz");
    await decryptRecoveryBundleToFile(artifact, decrypted, key);

    expect(header).toMatchObject({
      algorithm: "aes-256-gcm+hkdf-sha256",
      bundleId: "staging-20260721T120000Z",
      contentType: "application/gzip",
      environment: "staging",
      keyId: "recovery-2026-01"
    });
    expect(await readFile(decrypted)).toEqual(plaintext);
  });

  it("rejects a wrong key without publishing plaintext", async () => {
    const artifact = path.join(directory, "bundle.cgrb");
    const decrypted = path.join(directory, "decrypted.tar.gz");
    await createBundle(artifact, key);

    await expect(
      decryptRecoveryBundleToFile(artifact, decrypted, randomBytes(32))
    ).rejects.toThrow();
    await expect(readFile(decrypted)).rejects.toThrow();
  });

  it("never overwrites an existing recovery artifact", async () => {
    const artifact = path.join(directory, "bundle.cgrb");
    await writeFile(artifact, "existing", { mode: 0o600 });

    await expect(createBundle(artifact, key)).rejects.toThrow();
    expect(await readFile(artifact, "utf8")).toBe("existing");
  });

  it("rejects ciphertext and authentication tag tampering", async () => {
    const artifact = path.join(directory, "bundle.cgrb");
    await createBundle(artifact, key);
    const original = await readFile(artifact);

    for (const offset of [original.length - 17, original.length - 1]) {
      const tampered = Buffer.from(original);
      tampered[offset] = (tampered[offset] ?? 0) ^ 0xff;
      const target = path.join(directory, `tampered-${offset}.cgrb`);
      await writeFile(target, tampered, { mode: 0o600 });
      await expect(verifyRecoveryBundle(target, key)).rejects.toThrow();
    }
  });

  it("rejects truncation and an invalid master key", async () => {
    const artifact = path.join(directory, "bundle.cgrb");
    await createBundle(artifact, key);
    const original = await readFile(artifact);
    const truncated = path.join(directory, "truncated.cgrb");
    await writeFile(truncated, original.subarray(0, original.length - 8));

    await expect(verifyRecoveryBundle(truncated, key)).rejects.toThrow();
    await expect(verifyRecoveryBundle(artifact, Buffer.alloc(31))).rejects.toThrow(
      "RECOVERY_BUNDLE_KEY_INVALID"
    );
  });
});

async function createBundle(artifact: string, key: Buffer): Promise<void> {
  await encryptRecoveryBundle({
    source: Readable.from(["recovery archive"]),
    outputPath: artifact,
    masterKey: key,
    header: {
      bundleId: "staging-20260721T120000Z",
      keyId: "recovery-2026-01",
      createdAt: "2026-07-21T12:00:00.000Z",
      environment: "staging",
      productVersion: "0.1.0"
    }
  });
}
