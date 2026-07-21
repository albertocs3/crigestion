import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  link,
  open,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

const recoveryMagic = "CRIGESTION-RECOVERY-BUNDLE-v1";
const authTagLength = 16;
const maxHeaderFrameLength = 16 * 1024;
const maxBundlePlaintextBytes = 32 * 1024 * 1024 * 1024;
const maxBundleFileBytes =
  maxBundlePlaintextBytes + maxHeaderFrameLength + authTagLength;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/;

const headerSchema = z.object({
  algorithm: z.literal("aes-256-gcm+hkdf-sha256"),
  bundleId: z.string().regex(idPattern),
  contentType: z.literal("application/gzip"),
  createdAt: z.string().datetime(),
  environment: z.enum(["staging", "production"]),
  iv: z.string().min(1),
  keyFingerprint: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  keyId: z.string().regex(idPattern),
  productVersion: z.string().regex(idPattern),
  salt: z.string().min(1)
}).strict();

export type RecoveryBundleHeader = z.infer<typeof headerSchema>;

export async function encryptRecoveryBundle(options: {
  source: Readable;
  outputPath: string;
  masterKey: Buffer;
  header: Omit<
    RecoveryBundleHeader,
    "algorithm" | "contentType" | "iv" | "keyFingerprint" | "salt"
  >;
}): Promise<void> {
  assertMasterKey(options.masterKey);
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const header = headerSchema.parse({
    ...options.header,
    algorithm: "aes-256-gcm+hkdf-sha256",
    contentType: "application/gzip",
    keyFingerprint: fingerprintMasterKey(options.masterKey),
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url")
  });
  const headerFrame = createHeaderFrame(header);
  const key = deriveBundleKey(options.masterKey, salt, header.bundleId);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const finalPath = path.resolve(options.outputPath);
  const temporaryPath = `${finalPath}.tmp`;

  cipher.setAAD(headerFrame);
  await mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(finalPath), 0o700);

  try {
    await writeFile(temporaryPath, headerFrame, { flag: "wx", mode: 0o600 });
    await pipeline(
      options.source,
      byteLimit(maxBundlePlaintextBytes),
      cipher,
      createWriteStream(temporaryPath, { flags: "a", mode: 0o600 })
    );
    await appendFile(temporaryPath, cipher.getAuthTag());
    await chmod(temporaryPath, 0o600);
    await syncFile(temporaryPath);
    await link(temporaryPath, finalPath);
    await syncDirectory(path.dirname(finalPath));
    await rm(temporaryPath);
    await chmod(finalPath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  } finally {
    key.fill(0);
  }
}

export async function verifyRecoveryBundle(
  filePath: string,
  masterKey: Buffer
): Promise<RecoveryBundleHeader> {
  const { header, decipher, contentStart, contentEnd } = await createDecipher(
    filePath,
    masterKey
  );

  await pipeline(
    createReadStream(filePath, { start: contentStart, end: contentEnd }),
    decipher,
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      }
    })
  );

  return header;
}

export async function decryptRecoveryBundleToFile(
  filePath: string,
  outputPath: string,
  masterKey: Buffer
): Promise<RecoveryBundleHeader> {
  const verifiedHeader = await verifyRecoveryBundle(filePath, masterKey);
  const { header, decipher, contentStart, contentEnd } = await createDecipher(
    filePath,
    masterKey
  );

  if (JSON.stringify(header) !== JSON.stringify(verifiedHeader)) {
    throw new Error("RECOVERY_BUNDLE_CHANGED_AFTER_VERIFICATION");
  }

  const finalPath = path.resolve(outputPath);
  try {
    await pipeline(
      createReadStream(filePath, { start: contentStart, end: contentEnd }),
      decipher,
      createWriteStream(finalPath, { flags: "wx", mode: 0o600 })
    );
    await chmod(finalPath, 0o600);
    return header;
  } catch (error) {
    await rm(finalPath, { force: true });
    throw error;
  }
}

export async function readRecoveryBundleMasterKey(filePath: string): Promise<Buffer> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  let encoded: string;
  try {
    const file = await handle.stat();
    const currentUserId = process.getuid?.();
    if (
      !file.isFile() ||
      (file.mode & 0o077) !== 0 ||
      (currentUserId !== undefined && file.uid !== currentUserId)
    ) {
      throw new Error("RECOVERY_BUNDLE_KEY_FILE_UNSAFE");
    }
    encoded = (await handle.readFile("utf8")).trim();
  } finally {
    await handle.close();
  }
  let key: Buffer;
  if (/^[a-fA-F0-9]{64}$/.test(encoded)) {
    key = Buffer.from(encoded, "hex");
  } else {
    key = Buffer.from(encoded, "base64");
    if (key.toString("base64") !== encoded) {
      key.fill(0);
      throw new Error("RECOVERY_BUNDLE_KEY_INVALID");
    }
  }
  assertMasterKey(key);
  return key;
}

async function createDecipher(filePath: string, masterKey: Buffer): Promise<{
  header: RecoveryBundleHeader;
  decipher: ReturnType<typeof createDecipheriv>;
  contentStart: number;
  contentEnd: number;
}> {
  assertMasterKey(masterKey);
  const file = await stat(filePath);
  if (
    !file.isFile() ||
    file.size <= authTagLength ||
    file.size > maxBundleFileBytes
  ) {
    throw new Error("RECOVERY_BUNDLE_INCOMPLETE");
  }

  const parsed = await readHeader(filePath, file.size);
  if (parsed.header.keyFingerprint !== fingerprintMasterKey(masterKey)) {
    throw new Error("RECOVERY_BUNDLE_KEY_MISMATCH");
  }
  const tag = await readAuthenticationTag(filePath, file.size);
  const salt = Buffer.from(parsed.header.salt, "base64url");
  const iv = Buffer.from(parsed.header.iv, "base64url");
  if (salt.byteLength !== 32 || iv.byteLength !== 12) {
    throw new Error("RECOVERY_BUNDLE_HEADER_INVALID");
  }

  const key = deriveBundleKey(masterKey, salt, parsed.header.bundleId);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  key.fill(0);
  decipher.setAAD(parsed.frame);
  decipher.setAuthTag(tag);

  return {
    header: parsed.header,
    decipher,
    contentStart: parsed.endOffset,
    contentEnd: file.size - authTagLength - 1
  };
}

async function readHeader(filePath: string, fileSize: number): Promise<{
  frame: Buffer;
  header: RecoveryBundleHeader;
  endOffset: number;
}> {
  const handle = await open(filePath, "r");
  try {
    const prefix = Buffer.alloc(Math.min(fileSize, maxHeaderFrameLength));
    const { bytesRead } = await handle.read(prefix, 0, prefix.byteLength, 0);
    const buffer = prefix.subarray(0, bytesRead);
    const firstNewLine = buffer.indexOf(0x0a);
    const secondNewLine = buffer.indexOf(0x0a, firstNewLine + 1);
    if (
      firstNewLine < 0 ||
      secondNewLine < 0 ||
      buffer.subarray(0, firstNewLine).toString("utf8") !== recoveryMagic
    ) {
      throw new Error("RECOVERY_BUNDLE_HEADER_INVALID");
    }

    const headerLength = Number(
      buffer.subarray(firstNewLine + 1, secondNewLine).toString("utf8")
    );
    if (
      !Number.isSafeInteger(headerLength) ||
      headerLength <= 0 ||
      headerLength > maxHeaderFrameLength
    ) {
      throw new Error("RECOVERY_BUNDLE_HEADER_INVALID");
    }

    const headerStart = secondNewLine + 1;
    const headerEnd = headerStart + headerLength;
    if (headerEnd + authTagLength >= fileSize || headerEnd > buffer.byteLength) {
      throw new Error("RECOVERY_BUNDLE_INCOMPLETE");
    }

    const header = headerSchema.parse(
      JSON.parse(buffer.subarray(headerStart, headerEnd).toString("utf8"))
    );
    return {
      frame: buffer.subarray(0, headerEnd),
      header,
      endOffset: headerEnd
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("RECOVERY_BUNDLE_")) {
      throw error;
    }
    throw new Error("RECOVERY_BUNDLE_HEADER_INVALID");
  } finally {
    await handle.close();
  }
}

async function readAuthenticationTag(filePath: string, fileSize: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const tag = Buffer.alloc(authTagLength);
    const { bytesRead } = await handle.read(
      tag,
      0,
      authTagLength,
      fileSize - authTagLength
    );
    if (bytesRead !== authTagLength) throw new Error("RECOVERY_BUNDLE_INCOMPLETE");
    return tag;
  } finally {
    await handle.close();
  }
}

function createHeaderFrame(header: RecoveryBundleHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  return Buffer.concat([
    Buffer.from(`${recoveryMagic}\n${json.byteLength}\n`, "utf8"),
    json
  ]);
}

function deriveBundleKey(masterKey: Buffer, salt: Buffer, bundleId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      masterKey,
      salt,
      Buffer.from(`crigestion/recovery-bundle/v1/${bundleId}`, "utf8"),
      32
    )
  );
}

function assertMasterKey(key: Buffer): void {
  if (key.byteLength !== 32) throw new Error("RECOVERY_BUNDLE_KEY_INVALID");
}

function fingerprintMasterKey(key: Buffer): string {
  return createHash("sha256").update(key).digest().subarray(0, 16).toString("base64url");
}

function byteLimit(limit: number): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > limit) {
        callback(new Error("RECOVERY_BUNDLE_TOO_LARGE"));
        return;
      }
      callback(null, chunk);
    }
  });
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
