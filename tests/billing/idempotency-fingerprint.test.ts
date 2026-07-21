import { describe, expect, it } from "vitest";
import { createIdempotencyKey, fingerprintBytes, fingerprintText } from "@/modules/billing/presentation/idempotencyFingerprint";

describe("client idempotency fingerprints", () => {
  it("is deterministic without Web Crypto", () => {
    expect(fingerprintText("same request")).toBe(fingerprintText("same request"));
    expect(fingerprintBytes(new Uint8Array([1, 2, 3]))).toBe(fingerprintBytes(new Uint8Array([1, 2, 3])));
  });

  it("changes when text, bytes, or length change", () => {
    expect(fingerprintText("request-a")).not.toBe(fingerprintText("request-b"));
    expect(fingerprintBytes(new Uint8Array([1, 2, 3]))).not.toBe(fingerprintBytes(new Uint8Array([1, 2, 4])));
    expect(fingerprintBytes(new Uint8Array([1, 2, 3]))).not.toBe(fingerprintBytes(new Uint8Array([1, 2, 3, 0])));
  });

  it("creates a UUID-shaped idempotency key", () => {
    expect(createIdempotencyKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
