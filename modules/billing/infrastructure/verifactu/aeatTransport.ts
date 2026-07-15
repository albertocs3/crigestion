import "server-only";

import { createHash } from "node:crypto";
import type { VerifactuTransport, VerifactuTransportResult } from "@/modules/billing/application/verifactuOutboxWorker";
import { VerifactuCredentialError, type VerifactuCredentialProvider } from "./credentialProvider";
import { postVerifactuSoap, type MtlsHttpResult } from "./mtlsHttpClient";
import { AeatSoapCodecError, decodeAeatQueryEnvelope, decodeAeatSubmitEnvelope, encodeAeatQueryEnvelope, encodeAeatSubmitEnvelope } from "./soapCodec";
import type { SecureEnvelopeCipher } from "./secureEnvelope";

export function createAeatVerifactuTransport(options: {
  credentialProvider: VerifactuCredentialProvider;
  responseCipher: SecureEnvelopeCipher;
  post?: typeof postVerifactuSoap;
}): VerifactuTransport {
  const post = options.post ?? postVerifactuSoap;
  return {
    async submit(input) {
      let envelope: Uint8Array;
      try { envelope = encodeAeatSubmitEnvelope(input.xml); }
      catch (error) { return localFailure(error, "VERIFACTU_SOAP_REQUEST_INVALID"); }
      return execute("SUBMIT", input, envelope, (raw) => {
        const decoded = decodeAeatSubmitEnvelope(raw);
        if (decoded.kind === "FAULT") return uncertain("VERIFACTU_AEAT_SOAP_FAULT");
        const expectedOperation = input.context.recordType === "ANULACION" ? "Anulacion" : "Alta";
        if (decoded.lines.length !== 1 || decoded.lines[0].operation !== expectedOperation || !sameKey(decoded.lines[0], input.fiscalKey)) return dead("VERIFACTU_AEAT_RESPONSE_AMBIGUOUS");
        const line = decoded.lines[0];
        const coherent = (decoded.status === "Correcto" && line.status === "Correcto")
          || (decoded.status === "ParcialmenteCorrecto" && line.status === "AceptadoConErrores")
          || (decoded.status === "Incorrecto" && line.status === "Incorrecto");
        if (!coherent || ((decoded.status === "Correcto" || decoded.status === "ParcialmenteCorrecto") && !decoded.csv)) return dead("VERIFACTU_AEAT_RESPONSE_INCOHERENT");
        const outcome = line.status === "Correcto" ? "ACCEPTED" : line.status === "AceptadoConErrores" ? "ACCEPTED_WITH_ERRORS" : "REJECTED";
        return { outcome, stableCode: line.errorCode ? "VERIFACTU_AEAT_RECORD_ERROR" : null, aeatCsv: decoded.csv ?? undefined, aeatCodes: line.errorCode ? [line.errorCode] : undefined };
      });
    },
    async reconcile(input) {
      let envelope: Uint8Array;
      try { envelope = encodeAeatQueryEnvelope(input.fiscalKey); }
      catch (error) { return localFailure(error, "VERIFACTU_SOAP_QUERY_INVALID"); }
      return execute("RECONCILE", input, envelope, (raw) => {
        const decoded = decodeAeatQueryEnvelope(raw);
        if (decoded.kind === "FAULT") return retry("VERIFACTU_AEAT_SOAP_FAULT");
        if (decoded.hasMore || decoded.records.length > 1) return dead("VERIFACTU_AEAT_RESPONSE_AMBIGUOUS");
        if (decoded.records.length === 0) return retry("VERIFACTU_RECONCILIATION_NOT_FOUND");
        const record = decoded.records[0];
        if (!sameKey(record, input.fiscalKey)) return dead("VERIFACTU_AEAT_RESPONSE_MISMATCH");
        if (input.context.recordType === "ANULACION" && record.status !== "Anulado") {
          return retry("VERIFACTU_CANCELLATION_NOT_VISIBLE");
        }
        const outcome = record.status === "Correcto" || record.status === "Anulado" ? "ACCEPTED" : "ACCEPTED_WITH_ERRORS";
        const stableCode = input.context.recordType === "ALTA" && record.status === "Anulado"
          ? "VERIFACTU_RECONCILED_RECORD_ANULLED"
          : record.errorCode ? "VERIFACTU_AEAT_RECORD_ERROR" : null;
        return { outcome, stableCode, aeatCodes: record.errorCode ? [record.errorCode] : undefined };
      });
    }
  };

  async function execute(
    operation: "SUBMIT" | "RECONCILE",
    input: Parameters<VerifactuTransport["submit"]>[0] | Parameters<VerifactuTransport["reconcile"]>[0],
    envelope: Uint8Array,
    decode: (raw: Uint8Array) => VerifactuTransportResult
  ): Promise<VerifactuTransportResult> {
    const requestSha256 = createHash("sha256").update(envelope).digest("hex");
    let lease;
    try {
      lease = await options.credentialProvider.acquire({ credentialRef: input.credentialRef, companyId: input.context.companyId, environment: input.environment });
      const identity = { credentialVersionId: lease.versionId, mtlsRefId: lease.credentialRef, endpointKind: lease.endpointKind, requestSha256 };
      const response = await post({ environment: input.environment, credential: lease, body: envelope });
      if (!response.ok) return { ...classifyHttpFailure(operation, response), ...identity };
      if (response.status < 200 || response.status >= 300) {
        if (Buffer.isBuffer(response.body)) response.body.fill(0);
        return { ...classifyHttpStatus(operation, response.status), ...identity };
      }
      const rawResponse = Buffer.from(response.body);
      let result: VerifactuTransportResult;
      try { result = decode(rawResponse); }
      catch (error) {
        result = error instanceof AeatSoapCodecError
          ? operation === "SUBMIT" ? uncertain("VERIFACTU_AEAT_RESPONSE_INVALID") : retry("VERIFACTU_AEAT_RESPONSE_INVALID")
          : dead("VERIFACTU_ADAPTER_FAILURE");
      }
      try {
        const sha256 = createHash("sha256").update(rawResponse).digest("hex");
        const ciphertext = options.responseCipher.encrypt(rawResponse, responseContext(input, operation, sha256, lease.versionId, lease.endpointKind));
        return { ...result, ...identity, response: { ciphertext, sha256, encryptionKeyId: options.responseCipher.keyId } };
      } finally {
        rawResponse.fill(0);
      }
    } catch (error) {
      if (error instanceof VerifactuCredentialError) return { ...dead(error.code), requestSha256 };
      return { ...dead("VERIFACTU_ADAPTER_FAILURE"), requestSha256 };
    } finally {
      lease?.release();
      if (envelope instanceof Uint8Array) envelope.fill(0);
    }
  }
}

function classifyHttpFailure(operation: "SUBMIT" | "RECONCILE", result: Extract<MtlsHttpResult, { ok: false }>): VerifactuTransportResult {
  if (result.code === "REQUEST_INVALID") return dead("VERIFACTU_MTLS_REQUEST_INVALID");
  if (result.phase === "BEFORE_SEND") return retry(`VERIFACTU_MTLS_${result.code}`);
  return operation === "SUBMIT" ? uncertain(`VERIFACTU_MTLS_${result.code}`) : retry(`VERIFACTU_MTLS_${result.code}`);
}

function classifyHttpStatus(operation: "SUBMIT" | "RECONCILE", status: number): VerifactuTransportResult {
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return operation === "SUBMIT" ? uncertain("VERIFACTU_AEAT_HTTP_TRANSIENT") : retry("VERIFACTU_AEAT_HTTP_TRANSIENT");
  }
  return dead("VERIFACTU_AEAT_HTTP_REJECTED");
}

function responseContext(
  input: Parameters<VerifactuTransport["submit"]>[0] | Parameters<VerifactuTransport["reconcile"]>[0],
  operation: "SUBMIT" | "RECONCILE",
  sha256: string,
  credentialVersionId: string,
  endpointKind: "STANDARD" | "SEAL"
): string[] {
  return ["VERIFACTU-AEAT-RESPONSE", operation, input.environment, input.requestId, input.context.companyId, input.context.sifInstallationId, input.context.invoiceId, input.context.preparationKey, credentialVersionId, endpointKind, sha256];
}

function sameKey(left: { issuerTaxId: string; invoiceNumber: string; issueDate: string }, right: { issuerTaxId: string; invoiceNumber: string; issueDate: string }): boolean {
  return left.issuerTaxId === right.issuerTaxId && left.invoiceNumber === right.invoiceNumber && left.issueDate === right.issueDate;
}

function retry(stableCode: string): VerifactuTransportResult { return { outcome: "RETRYABLE_FAILURE", stableCode, retryDisposition: "RETRY" }; }
function uncertain(stableCode: string): VerifactuTransportResult { return { outcome: "UNKNOWN", stableCode }; }
function dead(stableCode: string): VerifactuTransportResult { return { outcome: "RETRYABLE_FAILURE", stableCode, retryDisposition: "DEAD" }; }
function localFailure(error: unknown, code: string): VerifactuTransportResult { return error instanceof AeatSoapCodecError ? dead(code) : dead("VERIFACTU_ADAPTER_FAILURE"); }
