import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const magic = Buffer.from("CGVF", "ascii");
const envelopeVersion = 1;
const algorithmAes256Gcm = 1;
const ivLength = 12;
const tagLength = 16;
const maxPayloadBytes = 2 * 1024 * 1024;
const keyIdPattern = /^[A-Za-z0-9_-]{1,120}$/;

export type VerifactuPayloadContext = {
  companyId: string;
  sifInstallationId: string;
  invoiceId: string;
  preparationKey: string;
  payloadSha256: string;
  recordType: "ALTA" | "ANULACION";
  environment: "TEST" | "PRODUCTION";
};

export type VerifactuPayloadCipher = {
  keyId: string;
  encrypt(plaintext: Uint8Array, context: VerifactuPayloadContext): Uint8Array;
  decrypt(envelope: Uint8Array, context: VerifactuPayloadContext): Uint8Array;
};

export function createVerifactuPayloadCipher(options: {
  keyId: string;
  key: Uint8Array;
  random?: (size: number) => Uint8Array;
}): VerifactuPayloadCipher {
  const key = Buffer.from(options.key);
  const keyId = options.keyId;
  const keyIdBytes = Buffer.from(keyId, "utf8");
  if (key.byteLength !== 32) throw new Error("VERIFACTU_ENCRYPTION_KEY_INVALID");
  if (!keyIdPattern.test(keyId) || keyIdBytes.byteLength > 255) {
    throw new Error("VERIFACTU_ENCRYPTION_KEY_ID_INVALID");
  }
  const secureRandom = options.random ?? randomBytes;

  return {
    keyId,
    encrypt(plaintext, context) {
      if (plaintext.byteLength === 0) throw new Error("VERIFACTU_PAYLOAD_EMPTY");
      if (plaintext.byteLength > maxPayloadBytes) throw new Error("VERIFACTU_PAYLOAD_TOO_LARGE");
      const iv = Buffer.from(secureRandom(ivLength));
      if (iv.byteLength !== ivLength) throw new Error("VERIFACTU_ENCRYPTION_IV_INVALID");
      const header = Buffer.concat([magic, Buffer.from([envelopeVersion, algorithmAes256Gcm, keyIdBytes.byteLength]), keyIdBytes, iv]);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(buildAad(header, context));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([header, cipher.getAuthTag(), ciphertext]);
    },
    decrypt(envelope, context) {
      const bytes = Buffer.from(envelope);
      if (bytes.byteLength > maxPayloadBytes + 512) throw new Error("VERIFACTU_ENCRYPTED_PAYLOAD_INVALID");
      const minimumLength = magic.byteLength + 3 + 1 + ivLength + tagLength;
      if (bytes.byteLength < minimumLength || !bytes.subarray(0, magic.byteLength).equals(magic)) {
        throw new Error("VERIFACTU_ENCRYPTED_PAYLOAD_INVALID");
      }
      const version = bytes[magic.byteLength];
      const algorithm = bytes[magic.byteLength + 1];
      const storedKeyIdLength = bytes[magic.byteLength + 2]!;
      const headerLength = magic.byteLength + 3 + storedKeyIdLength + ivLength;
      if (version !== envelopeVersion || algorithm !== algorithmAes256Gcm || headerLength + tagLength > bytes.byteLength) {
        throw new Error("VERIFACTU_ENCRYPTED_PAYLOAD_INVALID");
      }
      const storedKeyId = bytes.subarray(magic.byteLength + 3, magic.byteLength + 3 + storedKeyIdLength).toString("utf8");
      if (storedKeyId !== keyId) throw new Error("VERIFACTU_ENCRYPTION_KEY_MISMATCH");
      const header = bytes.subarray(0, headerLength);
      const iv = header.subarray(headerLength - ivLength);
      const tag = bytes.subarray(headerLength, headerLength + tagLength);
      const ciphertext = bytes.subarray(headerLength + tagLength);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(buildAad(header, context));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        throw new Error("VERIFACTU_PAYLOAD_AUTHENTICATION_FAILED");
      }
    }
  };
}

export function readVerifactuPayloadCipherFromEnvironment(env: NodeJS.ProcessEnv = process.env): VerifactuPayloadCipher {
  const activeKeyId = env.VERIFACTU_PAYLOAD_ACTIVE_KEY_ID?.trim() ?? "";
  let encodedKeys: unknown;
  try {
    encodedKeys = JSON.parse(env.VERIFACTU_PAYLOAD_KEYS ?? "");
  } catch {
    throw new Error("VERIFACTU_ENCRYPTION_KEYRING_INVALID");
  }
  if (!encodedKeys || typeof encodedKeys !== "object" || Array.isArray(encodedKeys)) {
    throw new Error("VERIFACTU_ENCRYPTION_KEYRING_INVALID");
  }
  const keys = Object.fromEntries(Object.entries(encodedKeys).map(([keyId, encoded]) => {
    if (typeof encoded !== "string") throw new Error("VERIFACTU_ENCRYPTION_KEYRING_INVALID");
    const key = Buffer.from(encoded, "base64");
    if (key.toString("base64") !== encoded || key.byteLength !== 32) throw new Error("VERIFACTU_ENCRYPTION_KEY_INVALID");
    return [keyId, key];
  }));
  return createVerifactuPayloadKeyring({ activeKeyId, keys });
}

export function createVerifactuPayloadKeyring(options: {
  activeKeyId: string;
  keys: Record<string, Uint8Array>;
  random?: (size: number) => Uint8Array;
}): VerifactuPayloadCipher {
  const ciphers = new Map(Object.entries(options.keys).map(([keyId, key]) => [
    keyId,
    createVerifactuPayloadCipher({ keyId, key, random: options.random })
  ]));
  const active = ciphers.get(options.activeKeyId);
  if (!active) throw new Error("VERIFACTU_ACTIVE_ENCRYPTION_KEY_NOT_FOUND");
  return {
    keyId: active.keyId,
    encrypt: (plaintext, context) => active.encrypt(plaintext, context),
    decrypt(envelope, context) {
      const storedKeyId = readEnvelopeKeyId(envelope);
      const cipher = ciphers.get(storedKeyId);
      if (!cipher) throw new Error("VERIFACTU_ENCRYPTION_KEY_NOT_FOUND");
      return cipher.decrypt(envelope, context);
    }
  };
}

function buildAad(header: Uint8Array, context: VerifactuPayloadContext): Buffer {
  const fields = [
    "CGVF-AAD-1",
    context.companyId,
    context.sifInstallationId,
    context.invoiceId,
    context.preparationKey,
    context.payloadSha256,
    context.recordType,
    context.environment
  ];
  if (fields.some((field) => !field || field.includes("\u0000"))) throw new Error("VERIFACTU_PAYLOAD_CONTEXT_INVALID");
  return Buffer.concat([Buffer.from(header), Buffer.from(`\u0000${fields.join("\u0000")}`, "utf8")]);
}

function readEnvelopeKeyId(envelope: Uint8Array): string {
  const bytes = Buffer.from(envelope);
  if (bytes.byteLength < magic.byteLength + 3 || !bytes.subarray(0, magic.byteLength).equals(magic)) {
    throw new Error("VERIFACTU_ENCRYPTED_PAYLOAD_INVALID");
  }
  const keyIdLength = bytes[magic.byteLength + 2]!;
  if (magic.byteLength + 3 + keyIdLength + ivLength + tagLength > bytes.byteLength) {
    throw new Error("VERIFACTU_ENCRYPTED_PAYLOAD_INVALID");
  }
  const keyId = bytes.subarray(magic.byteLength + 3, magic.byteLength + 3 + keyIdLength).toString("utf8");
  if (!keyIdPattern.test(keyId)) throw new Error("VERIFACTU_ENCRYPTED_PAYLOAD_INVALID");
  return keyId;
}
