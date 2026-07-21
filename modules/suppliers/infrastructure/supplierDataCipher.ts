import "server-only";

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const magic = Buffer.from("CGSP", "ascii");
const version = 1;
const ivLength = 12;
const tagLength = 16;
const keyIdPattern = /^[A-Za-z0-9_-]{1,120}$/;

export type SupplierSensitiveField = "taxId" | "email" | "phone" | "bankIban" | "bankBic";
export type SupplierCipherContext = { companyId: string; supplierId: string; field: SupplierSensitiveField };

export type SupplierDataProtector = {
  encrypt(value: string, context: SupplierCipherContext): Uint8Array<ArrayBuffer>;
  decrypt(value: Uint8Array, context: SupplierCipherContext): string;
  lookupHash(value: string): string;
};

export function readSupplierDataProtectorFromEnvironment(env: NodeJS.ProcessEnv = process.env): SupplierDataProtector {
  const activeKeyId = env.SENSITIVE_DATA_ACTIVE_KEY_ID?.trim() ?? "";
  const lookupSecret = env.SENSITIVE_DATA_LOOKUP_SECRET ?? "";
  let encodedKeys: unknown;
  try { encodedKeys = JSON.parse(env.SENSITIVE_DATA_KEYS ?? ""); } catch { throw new Error("SENSITIVE_DATA_KEYRING_INVALID"); }
  if (!encodedKeys || typeof encodedKeys !== "object" || Array.isArray(encodedKeys) || lookupSecret.length < 32) {
    throw new Error("SENSITIVE_DATA_KEYRING_INVALID");
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of Object.entries(encodedKeys)) {
    if (!keyIdPattern.test(keyId) || typeof encoded !== "string") throw new Error("SENSITIVE_DATA_KEYRING_INVALID");
    const key = Buffer.from(encoded, "base64");
    if (key.byteLength !== 32 || key.toString("base64") !== encoded) throw new Error("SENSITIVE_DATA_KEY_INVALID");
    keys.set(keyId, key);
  }
  const activeKey = keys.get(activeKeyId);
  if (!activeKey) throw new Error("SENSITIVE_DATA_ACTIVE_KEY_NOT_FOUND");
  return createSupplierDataProtector({ activeKeyId, keys, lookupSecret });
}

export function createSupplierDataProtector(options: {
  activeKeyId: string;
  keys: ReadonlyMap<string, Uint8Array>;
  lookupSecret: string;
  random?: (size: number) => Uint8Array;
}): SupplierDataProtector {
  const random = options.random ?? randomBytes;
  return {
    encrypt(value, context) {
      if (!value) throw new Error("SENSITIVE_DATA_EMPTY");
      const key = options.keys.get(options.activeKeyId);
      if (!key) throw new Error("SENSITIVE_DATA_ACTIVE_KEY_NOT_FOUND");
      const keyId = Buffer.from(options.activeKeyId, "utf8");
      const iv = Buffer.from(random(ivLength));
      const header = Buffer.concat([magic, Buffer.from([version, keyId.byteLength]), keyId, iv]);
      const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), iv);
      cipher.setAAD(aad(header, context));
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Uint8Array.from(Buffer.concat([header, cipher.getAuthTag(), ciphertext]));
    },
    decrypt(envelope, context) {
      const bytes = Buffer.from(envelope);
      if (bytes.byteLength < magic.byteLength + 2 + 1 + ivLength + tagLength || !bytes.subarray(0, 4).equals(magic)) {
        throw new Error("SENSITIVE_DATA_ENVELOPE_INVALID");
      }
      const storedVersion = bytes[4];
      const keyIdLength = bytes[5]!;
      const headerLength = 6 + keyIdLength + ivLength;
      if (storedVersion !== version || headerLength + tagLength > bytes.byteLength) throw new Error("SENSITIVE_DATA_ENVELOPE_INVALID");
      const keyId = bytes.subarray(6, 6 + keyIdLength).toString("utf8");
      const key = options.keys.get(keyId);
      if (!key) throw new Error("SENSITIVE_DATA_KEY_NOT_FOUND");
      try {
        const header = bytes.subarray(0, headerLength);
        const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), header.subarray(headerLength - ivLength));
        decipher.setAAD(aad(header, context));
        decipher.setAuthTag(bytes.subarray(headerLength, headerLength + tagLength));
        return Buffer.concat([decipher.update(bytes.subarray(headerLength + tagLength)), decipher.final()]).toString("utf8");
      } catch { throw new Error("SENSITIVE_DATA_AUTHENTICATION_FAILED"); }
    },
    lookupHash(value) {
      return createHmac("sha256", options.lookupSecret).update(value, "utf8").digest("hex");
    }
  };
}

function aad(header: Uint8Array, context: SupplierCipherContext): Buffer {
  const fields = ["CGSP-AAD-1", context.companyId, context.supplierId, context.field];
  if (fields.some((field) => !field || field.includes("\u0000"))) throw new Error("SENSITIVE_DATA_CONTEXT_INVALID");
  return Buffer.concat([Buffer.from(header), Buffer.from(`\u0000${fields.join("\u0000")}`, "utf8")]);
}
