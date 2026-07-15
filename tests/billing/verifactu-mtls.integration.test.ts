import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVerifactuMtlsHttpClient } from "@/modules/billing/infrastructure/verifactu/mtlsHttpClient";

const fixture = (name: string) => readFileSync(resolve("tests/fixtures/verifactu/mtls", name));

describe("VeriFactu real local mTLS handshake", () => {
  const ca = fixture("ca-cert.pem");
  const server = createServer({
    key: fixture("server-key.pem"), cert: fixture("server-cert.pem"), ca,
    requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.2"
  }, (request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/xml" });
      response.end("<fixture>mTLS</fixture>");
    });
  });
  let endpoint: URL;

  beforeAll(async () => {
    await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_UNAVAILABLE");
    endpoint = new URL(`https://localhost:${address.port}/verifactu`);
  });
  afterAll(async () => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())));

  it("completes a mutually authenticated request with the expected client PFX", async () => {
    let releases = 0;
    const post = createVerifactuMtlsHttpClient({ endpointResolver: () => endpoint, trustedCa: ca });
    const result = await post({ environment: "TEST", credential: lease(() => { releases += 1; }), body: Buffer.from("<soap/>") });
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(result.ok && Buffer.from(result.body).toString("utf8")).toBe("<fixture>mTLS</fixture>");
    expect(releases).toBe(1);
  });

  it("fails closed when the server trust chain is not approved", async () => {
    const post = createVerifactuMtlsHttpClient({ endpointResolver: () => endpoint, trustedCa: "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----" });
    await expect(post({ environment: "TEST", credential: lease(() => undefined, "client-no-ca.p12"), body: Buffer.from("<soap/>") }))
      .resolves.toEqual({ ok: false, phase: "BEFORE_SEND", code: "CONNECT_FAILED" });
  });

  it("is rejected when the client certificate is not trusted by the mTLS server", async () => {
    const post = createVerifactuMtlsHttpClient({ endpointResolver: () => endpoint, trustedCa: ca });
    const result = await post({ environment: "TEST", credential: lease(() => undefined, "untrusted-client.p12"), body: Buffer.from("<soap/>") });
    expect(result).toMatchObject({ ok: false, code: "CONNECT_FAILED" });
  });
});

function lease(release: () => void, pfxName = "client.p12") {
  return {
    credentialRef: "vfcred:local-fixture", versionId: "11111111-1111-4111-8111-111111111111",
    version: "1", endpointKind: "STANDARD" as const, pfx: fixture(pfxName), passphrase: "fixture-only", release
  };
}
