import "server-only";

import { constants } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  realpath,
  unlink
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const companyLogoStorageKeyPattern =
  /^company-logo\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg)$/;
const temporaryNamePattern = /^[0-9a-f-]{36}\.(?:upload|canonical)$/;

export class AttachmentIntegrityError extends Error {
  constructor() {
    super("ATTACHMENT_INTEGRITY_FAILED");
  }
}

export class FileAttachmentStorage {
  constructor(private readonly root: string) {}

  async writeTemporary(bytes: Buffer, kind: "upload" | "canonical"): Promise<string> {
    await this.ensureRoot();
    const quarantine = path.join(this.root, ".quarantine");
    await ensureSafeDirectoryChain(this.root, quarantine);
    const name = `${randomUUID()}.${kind}`;
    const target = path.join(quarantine, name);
    const handle = await open(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600
    );

    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    return target;
  }

  async publish(temporaryPath: string, storageKey: string): Promise<void> {
    await this.ensureRoot();
    this.assertTemporaryPath(temporaryPath);
    const target = this.resolveStorageKey(storageKey);
    await ensureSafeDirectoryChain(this.root, path.dirname(target));
    await link(temporaryPath, target);
    const published = await lstat(target);
    if (!published.isFile() || published.isSymbolicLink()) {
      await unlink(target).catch(() => undefined);
      throw new Error("ATTACHMENT_STORAGE_TARGET_UNSAFE");
    }
    await unlink(temporaryPath);
    await syncDirectory(path.dirname(target));
  }

  async readVerified(
    storageKey: string,
    expectedSize: number,
    expectedSha256: string
  ): Promise<Buffer> {
    const target = this.resolveStorageKey(storageKey);
    await this.ensureRoot().catch(() => {
      throw new AttachmentIntegrityError();
    });
    await assertSafeDirectoryChain(this.root, path.dirname(target)).catch(() => {
      throw new AttachmentIntegrityError();
    });
    const handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    ).catch(() => {
      throw new AttachmentIntegrityError();
    });

    try {
      const file = await handle.stat();
      if (
        !file.isFile() ||
        file.size !== expectedSize ||
        file.size < 1 ||
        file.size > 5_242_880 ||
        (process.platform !== "win32" && (file.mode & 0o077) !== 0)
      ) {
        throw new AttachmentIntegrityError();
      }

      const bytes = await handle.readFile();
      const actualSha256 = createHash("sha256").update(bytes).digest("hex");
      if (actualSha256 !== expectedSha256) {
        bytes.fill(0);
        throw new AttachmentIntegrityError();
      }

      return bytes;
    } finally {
      await handle.close();
    }
  }

  async removeTemporary(temporaryPath: string | null): Promise<void> {
    if (!temporaryPath) return;
    this.assertTemporaryPath(temporaryPath);
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async removePublished(storageKey: string): Promise<void> {
    const target = this.resolveStorageKey(storageKey);
    await this.ensureRoot();
    await assertSafeDirectoryChain(this.root, path.dirname(target));
    await unlink(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private async ensureRoot(): Promise<void> {
    await ensureDirectory(this.root);
    const resolved = await realpath(this.root);
    if (resolved !== path.resolve(this.root)) {
      throw new Error("ATTACHMENT_STORAGE_ROOT_UNSAFE");
    }
  }

  private resolveStorageKey(storageKey: string): string {
    if (!companyLogoStorageKeyPattern.test(storageKey)) {
      throw new Error("ATTACHMENT_STORAGE_KEY_INVALID");
    }

    const target = path.resolve(this.root, ...storageKey.split("/"));
    if (!target.startsWith(`${path.resolve(this.root)}${path.sep}`)) {
      throw new Error("ATTACHMENT_STORAGE_KEY_INVALID");
    }

    return target;
  }

  private assertTemporaryPath(temporaryPath: string): void {
    const quarantine = path.resolve(this.root, ".quarantine");
    const resolved = path.resolve(temporaryPath);
    if (
      path.dirname(resolved) !== quarantine ||
      !temporaryNamePattern.test(path.basename(resolved))
    ) {
      throw new Error("ATTACHMENT_TEMPORARY_PATH_INVALID");
    }
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw new Error("ATTACHMENT_STORAGE_DIRECTORY_UNSAFE");
  }
}

async function assertSafeDirectoryChain(root: string, directory: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  if (
    resolvedDirectory !== resolvedRoot &&
    !resolvedDirectory.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error("ATTACHMENT_STORAGE_DIRECTORY_UNSAFE");
  }

  const relative = path.relative(resolvedRoot, resolvedDirectory);
  let current = resolvedRoot;
  for (const component of relative ? relative.split(path.sep) : []) {
    current = path.join(current, component);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("ATTACHMENT_STORAGE_DIRECTORY_UNSAFE");
    }
  }
  if (await realpath(resolvedDirectory) !== resolvedDirectory) {
    throw new Error("ATTACHMENT_STORAGE_DIRECTORY_UNSAFE");
  }
}

async function ensureSafeDirectoryChain(root: string, directory: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  if (!resolvedDirectory.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("ATTACHMENT_STORAGE_DIRECTORY_UNSAFE");
  }

  let current = resolvedRoot;
  for (const component of path.relative(resolvedRoot, resolvedDirectory).split(path.sep)) {
    current = path.join(current, component);
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const metadata = await lstat(current);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) ||
      await realpath(current) !== path.resolve(current)
    ) {
      throw new Error("ATTACHMENT_STORAGE_DIRECTORY_UNSAFE");
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  // Windows does not support fsync on directory handles. Linux staging does,
  // and retains the durability barrier before publish returns.
  if (process.platform === "win32") return;
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
