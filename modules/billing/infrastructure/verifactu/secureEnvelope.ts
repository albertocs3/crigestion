import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const magic = Buffer.from("CGVS", "ascii");
const maxPlaintextBytes = 2 * 1024 * 1024;
const keyIdPattern = /^[A-Za-z0-9_-]{1,120}$/;

export type SecureEnvelopeCipher = {
  readonly keyId: string;
  encrypt(plaintext: Uint8Array, context: readonly string[]): Uint8Array;
  decrypt(ciphertext: Uint8Array, context: readonly string[]): Uint8Array;
};

export function createSecureEnvelopeKeyring(options: {
  activeKeyId: string;
  keys: Record<string, Uint8Array>;
  random?: (size: number) => Uint8Array;
}): SecureEnvelopeCipher {
  const keys = new Map(Object.entries(options.keys).map(([id, value]) => {
    const key = Buffer.from(value);
    if (!keyIdPattern.test(id) || key.byteLength !== 32) throw new Error("VERIFACTU_SECURE_KEYRING_INVALID");
    return [id, key] as const;
  }));
  if (!keys.has(options.activeKeyId)) throw new Error("VERIFACTU_SECURE_ACTIVE_KEY_NOT_FOUND");
  const secureRandom = options.random ?? randomBytes;
  return {
    keyId: options.activeKeyId,
    encrypt(plaintext, context) {
      if (plaintext.byteLength === 0 || plaintext.byteLength > maxPlaintextBytes) throw new Error("VERIFACTU_SECURE_PLAINTEXT_INVALID");
      const keyId = options.activeKeyId;
      const keyIdBytes = Buffer.from(keyId, "utf8");
      const iv = Buffer.from(secureRandom(12));
      if (iv.byteLength !== 12) throw new Error("VERIFACTU_SECURE_IV_INVALID");
      const header = Buffer.concat([magic, Buffer.from([1, keyIdBytes.byteLength]), keyIdBytes, iv]);
      const cipher = createCipheriv("aes-256-gcm", keys.get(keyId)!, iv);
      cipher.setAAD(aad(header, context));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([header, cipher.getAuthTag(), ciphertext]);
    },
    decrypt(envelope, context) {
      const bytes = Buffer.from(envelope);
      if (bytes.byteLength < 34 || bytes.byteLength > maxPlaintextBytes + 256 || !bytes.subarray(0, 4).equals(magic) || bytes[4] !== 1) {
        throw new Error("VERIFACTU_SECURE_ENVELOPE_INVALID");
      }
      const keyIdLength = bytes[5]!;
      const headerLength = 6 + keyIdLength + 12;
      if (headerLength + 16 > bytes.byteLength) throw new Error("VERIFACTU_SECURE_ENVELOPE_INVALID");
      const keyId = bytes.subarray(6, 6 + keyIdLength).toString("utf8");
      const key = keys.get(keyId);
      if (!key) throw new Error("VERIFACTU_SECURE_KEY_NOT_FOUND");
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(headerLength - 12, headerLength));
        decipher.setAAD(aad(bytes.subarray(0, headerLength), context));
        decipher.setAuthTag(bytes.subarray(headerLength, headerLength + 16));
        return Buffer.concat([decipher.update(bytes.subarray(headerLength + 16)), decipher.final()]);
      } catch {
        throw new Error("VERIFACTU_SECURE_AUTHENTICATION_FAILED");
      }
    }
  };
}

export function readSecureEnvelopeKeyring(
  activeKeyIdValue: string | undefined,
  keysValue: string | undefined
): SecureEnvelopeCipher {
  let parsed: unknown;
  try { parsed = JSON.parse(keysValue ?? ""); } catch { throw new Error("VERIFACTU_SECURE_KEYRING_INVALID"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("VERIFACTU_SECURE_KEYRING_INVALID");
  const keys: Record<string, Uint8Array> = {};
  for (const [id, encoded] of Object.entries(parsed)) {
    if (typeof encoded !== "string") throw new Error("VERIFACTU_SECURE_KEYRING_INVALID");
    const key = Buffer.from(encoded, "base64");
    if (key.byteLength !== 32 || key.toString("base64") !== encoded) throw new Error("VERIFACTU_SECURE_KEYRING_INVALID");
    keys[id] = key;
  }
  return createSecureEnvelopeKeyring({ activeKeyId: activeKeyIdValue?.trim() ?? "", keys });
}

export function readSecureEnvelopeKeyId(envelope: Uint8Array): string {
  const bytes = Buffer.from(envelope);
  if (bytes.byteLength < 6 || !bytes.subarray(0, 4).equals(magic) || bytes[4] !== 1) throw new Error("VERIFACTU_SECURE_ENVELOPE_INVALID");
  const length = bytes[5]!;
  if (length === 0 || 6 + length + 28 > bytes.byteLength) throw new Error("VERIFACTU_SECURE_ENVELOPE_INVALID");
  const keyId = bytes.subarray(6, 6 + length).toString("utf8");
  if (!keyIdPattern.test(keyId)) throw new Error("VERIFACTU_SECURE_ENVELOPE_INVALID");
  return keyId;
}

function aad(header: Uint8Array, context: readonly string[]): Buffer {
  if (context.length === 0 || context.some((value) => !value || value.includes("\0"))) throw new Error("VERIFACTU_SECURE_CONTEXT_INVALID");
  return Buffer.concat([Buffer.from(header), Buffer.from(`\0CGVS-AAD-1\0${context.join("\0")}`, "utf8")]);
}
