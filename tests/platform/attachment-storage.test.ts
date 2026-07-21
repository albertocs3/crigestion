import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AttachmentIntegrityError,
  FileAttachmentStorage
} from "@/modules/platform/infrastructure/attachmentStorage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("file attachment storage", () => {
  it("publishes an immutable opaque key and verifies size and hash", async () => {
    const root = await privateTemporaryDirectory();
    const storage = new FileAttachmentStorage(root);
    const bytes = Buffer.from("canonical-logo");
    const key = `company-logo/${randomUUID()}/${randomUUID()}.png`;
    const temporary = await storage.writeTemporary(bytes, "canonical");

    await storage.publish(temporary, key);

    await expect(readFile(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(storage.readVerified(
      key,
      bytes.byteLength,
      createHash("sha256").update(bytes).digest("hex")
    )).resolves.toEqual(bytes);
  });

  it("never overwrites an existing published object", async () => {
    const root = await privateTemporaryDirectory();
    const storage = new FileAttachmentStorage(root);
    const key = `company-logo/${randomUUID()}/${randomUUID()}.jpg`;
    const first = await storage.writeTemporary(Buffer.from("first"), "canonical");
    const second = await storage.writeTemporary(Buffer.from("second"), "canonical");

    await storage.publish(first, key);
    await expect(storage.publish(second, key)).rejects.toMatchObject({ code: "EEXIST" });
    await storage.removeTemporary(second);
  });

  it("rejects traversal keys and tampered content", async () => {
    const root = await privateTemporaryDirectory();
    const storage = new FileAttachmentStorage(root);
    await expect(storage.readVerified("../secret.png", 1, "0".repeat(64)))
      .rejects.toThrow("ATTACHMENT_STORAGE_KEY_INVALID");

    const key = `company-logo/${randomUUID()}/${randomUUID()}.png`;
    const bytes = Buffer.from("original");
    const temporary = await storage.writeTemporary(bytes, "canonical");
    await storage.publish(temporary, key);
    const published = path.join(root, ...key.split("/"));
    await writeFile(published, "tampered");
    await chmod(published, 0o600);

    await expect(storage.readVerified(
      key,
      bytes.byteLength,
      createHash("sha256").update(bytes).digest("hex")
    )).rejects.toBeInstanceOf(AttachmentIntegrityError);
  });

  it("rejects an intermediate symlink without writing outside the root", async () => {
    const root = await privateTemporaryDirectory();
    const outside = await privateTemporaryDirectory();
    const storage = new FileAttachmentStorage(root);
    const companyId = randomUUID();
    const attachmentId = randomUUID();
    const temporary = await storage.writeTemporary(Buffer.from("logo"), "canonical");
    await symlink(
      outside,
      path.join(root, "company-logo"),
      process.platform === "win32" ? "junction" : "dir"
    );

    await expect(storage.publish(
      temporary,
      `company-logo/${companyId}/${attachmentId}.png`
    )).rejects.toThrow("ATTACHMENT_STORAGE_DIRECTORY_UNSAFE");
    await expect(readFile(path.join(outside, companyId, `${attachmentId}.png`)))
      .rejects.toMatchObject({ code: "ENOENT" });
    await storage.removeTemporary(temporary);
  });
});

async function privateTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crigestion-attachments-"));
  await chmod(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}
