import { describe, expect, it } from "vitest";
import { createSupplierDataProtector } from "@/modules/suppliers/infrastructure/supplierDataCipher";

describe("supplier sensitive data protector", () => {
  it("encrypts with authenticated context and supports key rotation", () => {
    const keys = new Map([["k1", Buffer.alloc(32, 1)], ["k2", Buffer.alloc(32, 2)]]);
    const context = { companyId: "company-1", supplierId: "supplier-1", field: "taxId" as const };
    const first = createSupplierDataProtector({ activeKeyId: "k1", keys, lookupSecret: "lookup-secret-with-at-least-32-characters", random: () => Buffer.alloc(12, 3) });
    const envelope = first.encrypt("B12345674", context);
    const rotated = createSupplierDataProtector({ activeKeyId: "k2", keys, lookupSecret: "lookup-secret-with-at-least-32-characters" });
    expect(Buffer.from(envelope).includes(Buffer.from("B12345674"))).toBe(false);
    expect(rotated.decrypt(envelope, context)).toBe("B12345674");
    expect(() => rotated.decrypt(envelope, { ...context, supplierId: "another" })).toThrow("SENSITIVE_DATA_AUTHENTICATION_FAILED");
    expect(first.lookupHash("B12345674")).toBe(rotated.lookupHash("B12345674"));
  });
});
