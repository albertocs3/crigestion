import { createHash, randomBytes } from "node:crypto";
import type { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createVerifactuPayloadKeyring } from "@/modules/billing/infrastructure/verifactu/payloadCipher";
import { createSecureEnvelopeKeyring } from "@/modules/billing/infrastructure/verifactu/secureEnvelope";
import { verifyHistoricalEnvelopes } from "@/scripts/verify-staging-recovery-keyrings";

const companyId = "10000000-0000-4000-8000-000000000001";
const credentialId = "10000000-0000-4000-8000-000000000002";
const versionId = "10000000-0000-4000-8000-000000000003";
const sifInstallationId = "10000000-0000-4000-8000-000000000004";
const invoiceId = "10000000-0000-4000-8000-000000000005";

describe("staging recovery keyring verification", () => {
  it("authenticates one historical envelope for every referenced key", async () => {
    const fixture = createFixture();
    await expect(
      verifyHistoricalEnvelopes(fixture.client, fixture.keyrings)
    ).resolves.toBe(3);
  });

  it("rejects the correct key id backed by incorrect key bytes", async () => {
    const fixture = createFixture();
    fixture.keyrings.credential.keys.set(
      fixture.keyrings.credential.activeId,
      randomBytes(32).toString("base64")
    );

    await expect(
      verifyHistoricalEnvelopes(fixture.client, fixture.keyrings)
    ).rejects.toThrow("VERIFACTU_SECURE_AUTHENTICATION_FAILED");
  });
});

function createFixture() {
  const credentialKey = randomBytes(32);
  const payloadKey = randomBytes(32);
  const responseKey = randomBytes(32);
  const credentialKeyId = "credential-history-v1";
  const payloadKeyId = "payload-history-v1";
  const responseKeyId = "response-history-v1";
  const validFrom = new Date("2026-01-01T00:00:00.000Z");
  const validUntil = new Date("2027-01-01T00:00:00.000Z");
  const pfxSha256 = "1".repeat(64);
  const payloadPlaintext = Buffer.from("<payload/>");
  const responsePlaintext = Buffer.from("<response/>");
  const payloadSha256 = createHash("sha256").update(payloadPlaintext).digest("hex");
  const responseSha256 = createHash("sha256").update(responsePlaintext).digest("hex");

  const credentialCipher = createSecureEnvelopeKeyring({
    activeKeyId: credentialKeyId,
    keys: { [credentialKeyId]: credentialKey }
  });
  const payloadCipher = createVerifactuPayloadKeyring({
    activeKeyId: payloadKeyId,
    keys: { [payloadKeyId]: payloadKey }
  });
  const responseCipher = createSecureEnvelopeKeyring({
    activeKeyId: responseKeyId,
    keys: { [responseKeyId]: responseKey }
  });
  const credentialContext = [
    "VERIFACTU-MTLS-CREDENTIAL", companyId, credentialId, versionId, "1",
    "STANDARD", "true", "false", validFrom.toISOString(), validUntil.toISOString(),
    pfxSha256
  ];

  const query = vi.fn()
    .mockResolvedValueOnce({ rowCount: 1, rows: [{
      allowProduction: false,
      allowTest: true,
      companyId,
      credentialId,
      encryptionKeyId: credentialKeyId,
      endpointKind: "STANDARD",
      materialCiphertext: Buffer.from(
        credentialCipher.encrypt(Buffer.from("credential-material"), credentialContext)
      ),
      pfxSha256,
      validFrom,
      validUntil,
      version: 1,
      versionId
    }] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [{
      companyId,
      encryptionKeyId: payloadKeyId,
      environment: "TEST",
      invoiceId,
      payloadCiphertext: Buffer.from(payloadCipher.encrypt(payloadPlaintext, {
        companyId,
        sifInstallationId,
        invoiceId,
        preparationKey: "preparation-1",
        payloadSha256,
        recordType: "ALTA",
        environment: "TEST"
      })),
      payloadSha256,
      preparationKey: "preparation-1",
      recordType: "ALTA",
      sifInstallationId
    }] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [{
      companyId,
      credentialVersionId: versionId,
      encryptionKeyId: responseKeyId,
      endpointKind: "STANDARD",
      environment: "TEST",
      idempotencyKey: "request-1",
      invoiceId,
      kind: "SUBMIT",
      preparationKey: "preparation-1",
      responseCiphertext: Buffer.from(responseCipher.encrypt(responsePlaintext, [
        "VERIFACTU-AEAT-RESPONSE", "SUBMIT", "TEST", "request-1", companyId,
        sifInstallationId, invoiceId, "preparation-1", versionId, "STANDARD",
        responseSha256
      ])),
      responseSha256,
      sifInstallationId
    }] });

  return {
    client: { query } as unknown as Client,
    keyrings: {
      credential: {
        activeId: credentialKeyId,
        keys: new Map([[credentialKeyId, credentialKey.toString("base64")]])
      },
      payload: {
        activeId: payloadKeyId,
        keys: new Map([[payloadKeyId, payloadKey.toString("base64")]])
      },
      response: {
        activeId: responseKeyId,
        keys: new Map([[responseKeyId, responseKey.toString("base64")]])
      }
    }
  };
}
