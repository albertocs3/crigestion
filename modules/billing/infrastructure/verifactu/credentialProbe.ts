import "server-only";

import { createHash } from "node:crypto";
import type { StagedVerifactuCredential } from "./credentialStore";
import { postVerifactuSoap, type MtlsHttpResult } from "./mtlsHttpClient";
import { AeatSoapCodecError, decodeAeatQueryEnvelope, encodeAeatQueryEnvelope } from "./soapCodec";

export type VerifactuCredentialProbeResult = {
  outcome: "PASSED" | "FAILED" | "UNKNOWN";
  stableCode: string;
  responseSha256?: string;
};

export type VerifactuCredentialProbe = (input: {
  credential: StagedVerifactuCredential;
  fiscalKey: { issuerName: string; issuerTaxId: string; invoiceNumber: string; issueDate: string };
}) => Promise<VerifactuCredentialProbeResult>;

export function createAeatVerifactuCredentialProbe(
  post: typeof postVerifactuSoap = postVerifactuSoap
): VerifactuCredentialProbe {
  return async (input): Promise<VerifactuCredentialProbeResult> => {
    const envelope = encodeAeatQueryEnvelope(input.fiscalKey);
    try {
      const response = await post({
        environment: "TEST",
        credential: {
          credentialRef: input.credential.credentialRef,
          versionId: input.credential.versionId,
          version: String(input.credential.version),
          endpointKind: input.credential.endpointKind,
          pfx: input.credential.pfx,
          passphrase: input.credential.passphrase,
          release: input.credential.release
        },
        body: envelope
      });
      if (!response.ok) return classifyFailure(response);
      const raw = Buffer.from(response.body);
      let responseSha256: string | undefined;
      try {
        responseSha256 = createHash("sha256").update(raw).digest("hex");
        if (response.status < 200 || response.status >= 300) {
          return { outcome: response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500 ? "UNKNOWN" : "FAILED", stableCode: "VERIFACTU_AEAT_TEST_HTTP_REJECTED", responseSha256 };
        }
        const decoded = decodeAeatQueryEnvelope(raw);
        if (decoded.kind === "FAULT") return { outcome: "FAILED", stableCode: "VERIFACTU_AEAT_TEST_SOAP_FAULT", responseSha256 };
        return { outcome: "PASSED", stableCode: "VERIFACTU_AEAT_TEST_PASSED", responseSha256 };
      } catch (error) {
        return {
          outcome: "FAILED",
          stableCode: error instanceof AeatSoapCodecError ? "VERIFACTU_AEAT_TEST_RESPONSE_INVALID" : "VERIFACTU_AEAT_TEST_FAILED",
          responseSha256
        };
      } finally { raw.fill(0); }
    } finally { envelope.fill(0); }
  };
}

function classifyFailure(result: Extract<MtlsHttpResult, { ok: false }>): VerifactuCredentialProbeResult {
  return {
    outcome: result.phase === "POSSIBLY_SENT" || result.code === "TIMEOUT" ? "UNKNOWN" : "FAILED",
    stableCode: `VERIFACTU_AEAT_TEST_${result.code}`
  };
}
