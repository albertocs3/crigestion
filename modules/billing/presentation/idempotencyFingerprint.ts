// These fingerprints only decide whether a pending client idempotency key can
// be reused. The server validates its own cryptographic request hash and safely
// rejects a client-side collision with IDEMPOTENCY_KEY_REUSED.
export function fingerprintText(value: string): string {
  let primary = 0x811c9dc5;
  let secondary = 0x9e3779b9;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    primary = Math.imul(primary ^ codeUnit, 0x01000193);
    secondary = Math.imul(secondary ^ codeUnit, 0x85ebca6b);
  }

  return `${toHex(primary)}${toHex(secondary)}:${value.length}`;
}

export function createIdempotencyKey(): string {
  const source = globalThis.crypto;
  if (typeof source.randomUUID === "function") return source.randomUUID();

  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function fingerprintBytes(value: Uint8Array): string {
  let primary = 0x811c9dc5;
  let secondary = 0x9e3779b9;

  for (const byte of value) {
    primary = Math.imul(primary ^ byte, 0x01000193);
    secondary = Math.imul(secondary ^ byte, 0x85ebca6b);
  }

  return `${toHex(primary)}${toHex(secondary)}:${value.byteLength}`;
}

function toHex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}
