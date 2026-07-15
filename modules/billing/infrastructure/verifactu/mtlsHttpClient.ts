import "server-only";

import { request } from "node:https";
import type { ClientRequest, IncomingHttpHeaders } from "node:http";
import type { VerifactuCredentialLease, VerifactuEnvironment } from "./credentialProvider";

export type MtlsHttpResult =
  | { ok: true; status: number; headers: IncomingHttpHeaders; body: Uint8Array }
  | {
      ok: false;
      phase: "BEFORE_SEND" | "POSSIBLY_SENT";
      code:
        | "CONNECT_FAILED"
        | "TIMEOUT"
        | "REQUEST_INVALID"
        | "RESPONSE_TOO_LARGE"
        | "CONTENT_ENCODING_REJECTED"
        | "CONTENT_TYPE_REJECTED";
    };

const endpoints = {
  TEST: {
    STANDARD: "https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP",
    SEAL: "https://prewww10.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP"
  },
  PRODUCTION: {
    STANDARD: "https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP",
    SEAL: "https://www10.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP"
  }
} as const;

export function resolveVerifactuEndpoint(
  environment: VerifactuEnvironment,
  endpointKind: "STANDARD" | "SEAL"
): URL {
  return new URL(endpoints[environment][endpointKind]);
}

export type VerifactuMtlsHttpInput = {
  environment: VerifactuEnvironment;
  credential: VerifactuCredentialLease;
  body: Uint8Array;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  maxResponseBytes?: number;
};

export function createVerifactuMtlsHttpClient(
  options: {
    endpointResolver?: (environment: VerifactuEnvironment, endpointKind: "STANDARD" | "SEAL") => URL;
    trustedCa?: string | Buffer;
  } = {}
): (input: VerifactuMtlsHttpInput) => Promise<MtlsHttpResult> {
  const endpointResolver = options.endpointResolver ?? resolveVerifactuEndpoint;
  return (input) => postSoapMtls(endpointResolver(input.environment, input.credential.endpointKind), input, options.trustedCa);
}

export const postVerifactuSoap = createVerifactuMtlsHttpClient();

function postSoapMtls(endpoint: URL, input: VerifactuMtlsHttpInput, trustedCa?: string | Buffer): Promise<MtlsHttpResult> {
  const connectTimeoutMs = input.connectTimeoutMs ?? 10_000;
  const responseTimeoutMs = input.responseTimeoutMs ?? 30_000;
  const maxResponseBytes = input.maxResponseBytes ?? 2 * 1024 * 1024;
  if (
    input.body.byteLength === 0 || input.body.byteLength > 1024 * 1024 ||
    !Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 1_000 || connectTimeoutMs > 60_000 ||
    !Number.isFinite(responseTimeoutMs) || responseTimeoutMs < 1_000 || responseTimeoutMs > 60_000 ||
    !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 2 * 1024 * 1024
  ) {
    input.credential.release();
    return Promise.resolve({ ok: false, phase: "BEFORE_SEND", code: "REQUEST_INVALID" });
  }

  return new Promise((resolve) => {
    let settled = false;
    let possiblySent = false;
    const timers: {
      connect?: ReturnType<typeof setTimeout>;
      response?: ReturnType<typeof setTimeout>;
    } = {};
    const finish = (result: MtlsHttpResult): void => {
      if (settled) return;
      settled = true;
      if (timers.connect) clearTimeout(timers.connect);
      if (timers.response) clearTimeout(timers.response);
      input.credential.release();
      resolve(result);
    };

    let httpRequest: ClientRequest;
    try {
      httpRequest = request(endpoint, {
        method: "POST",
        agent: false,
        pfx: input.credential.pfx,
        passphrase: input.credential.passphrase,
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
        ...(trustedCa ? { ca: trustedCa } : {}),
        servername: endpoint.hostname,
        headers: {
          "content-type": "text/xml; charset=utf-8",
          "content-length": String(input.body.byteLength),
          soapaction: "",
          accept: "text/xml"
        }
      });
    } catch {
      finish({ ok: false, phase: "BEFORE_SEND", code: "CONNECT_FAILED" });
      return;
    }

    timers.connect = setTimeout(() => {
      httpRequest.destroy();
      finish({ ok: false, phase: "BEFORE_SEND", code: "TIMEOUT" });
    }, connectTimeoutMs);

    httpRequest.once("socket", (socket) => {
      socket.once("secureConnect", () => {
        if (timers.connect) clearTimeout(timers.connect);
        possiblySent = true;
        timers.response = setTimeout(() => {
          httpRequest.destroy();
          finish({ ok: false, phase: "POSSIBLY_SENT", code: "TIMEOUT" });
        }, responseTimeoutMs);
        httpRequest.end(input.body);
      });
    });

    httpRequest.once("response", (response) => {
      const contentType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "text/xml") {
        response.destroy();
        finish({ ok: false, phase: "POSSIBLY_SENT", code: "CONTENT_TYPE_REJECTED" });
        return;
      }
      const contentEncoding = response.headers["content-encoding"];
      if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
        response.destroy();
        finish({ ok: false, phase: "POSSIBLY_SENT", code: "CONTENT_ENCODING_REJECTED" });
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > maxResponseBytes) {
          response.destroy();
          finish({ ok: false, phase: "POSSIBLY_SENT", code: "RESPONSE_TOO_LARGE" });
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        finish({ ok: true, status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
      });
      response.once("aborted", () => {
        finish({ ok: false, phase: "POSSIBLY_SENT", code: "CONNECT_FAILED" });
      });
      response.once("error", () => {
        finish({ ok: false, phase: "POSSIBLY_SENT", code: "CONNECT_FAILED" });
      });
      response.once("close", () => {
        if (!response.complete) {
          finish({ ok: false, phase: "POSSIBLY_SENT", code: "CONNECT_FAILED" });
        }
      });
    });
    httpRequest.once("error", () => {
      finish({ ok: false, phase: possiblySent ? "POSSIBLY_SENT" : "BEFORE_SEND", code: "CONNECT_FAILED" });
    });
  });
}
