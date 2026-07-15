import { describe, expect, it } from "vitest";
import {
  aeatSoapContract,
  AeatSoapCodecError,
  decodeAeatQueryEnvelope,
  decodeAeatSubmitEnvelope,
  encodeAeatQueryEnvelope,
  encodeAeatSubmitEnvelope
} from "@/modules/billing/infrastructure/verifactu/soapCodec";
import {
  createVerifactuCredentialProvider,
  VerifactuCredentialError,
  type StoredVerifactuCredential
} from "@/modules/billing/infrastructure/verifactu/credentialProvider";
import { postVerifactuSoap, resolveVerifactuEndpoint } from "@/modules/billing/infrastructure/verifactu/mtlsHttpClient";
import { createAeatVerifactuTransport } from "@/modules/billing/infrastructure/verifactu/aeatTransport";
import { createAeatVerifactuCredentialProbe } from "@/modules/billing/infrastructure/verifactu/credentialProbe";
import { createSecureEnvelopeKeyring } from "@/modules/billing/infrastructure/verifactu/secureEnvelope";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const soapNs = "http://schemas.xmlsoap.org/soap/envelope/";
const responseNs = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaSuministro.xsd";
const queryResponseNs = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaConsultaLR.xsd";

describe("AEAT defensive SOAP codec", () => {
  it("wraps the fixed supply root in a SOAP 1.1 document/literal envelope", () => {
    const request = encodeAeatSubmitEnvelope(Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><sfLR:RegFactuSistemaFacturacion xmlns:sfLR="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd"/>'
    ));
    expect(Buffer.from(request).toString("utf8")).toContain(`<soapenv:Envelope xmlns:soapenv="${soapNs}">`);
    expect(Buffer.from(request).toString("utf8")).toContain("<sfLR:RegFactuSistemaFacturacion");
  });

  it("encodes a closed query contract and escapes fiscal text", () => {
    const request = Buffer.from(encodeAeatQueryEnvelope({
      issuerName: "Empresa & Asociados",
      issuerTaxId: "B12345678",
      invoiceNumber: "F/2026<1",
      issueDate: "13-07-2026"
    })).toString("utf8");
    expect(request).toContain("<sf:Ejercicio>2026</sf:Ejercicio><sf:Periodo>07</sf:Periodo>");
    expect(request).toContain("Empresa &amp; Asociados");
    expect(request).toContain("F/2026&lt;1");
  });

  it("rejects impossible query dates", () => {
    expect(() => encodeAeatQueryEnvelope({ issuerName: "Empresa", issuerTaxId: "B12345678", invoiceNumber: "F1", issueDate: "31-02-2026" }))
      .toThrow(AeatSoapCodecError);
  });

  it("decodes an empty schema-ordered reconciliation response with the official SOAP wrapper", () => {
    const xml = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="${soapNs}"><soap:Header/><soap:Body Id="Body"><q:RespuestaConsultaFactuSistemaFacturacion xmlns:q="${queryResponseNs}" xmlns:sf="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd"><q:Cabecera><sf:IDVersion>1.0</sf:IDVersion><sf:ObligadoEmision><sf:NombreRazon>Empresa</sf:NombreRazon><sf:NIF>B12345678</sf:NIF></sf:ObligadoEmision></q:Cabecera><q:PeriodoImputacion><q:Ejercicio>2026</q:Ejercicio><q:Periodo>07</q:Periodo></q:PeriodoImputacion><q:IndicadorPaginacion>N</q:IndicadorPaginacion><q:ResultadoConsulta>SinDatos</q:ResultadoConsulta></q:RespuestaConsultaFactuSistemaFacturacion></soap:Body></soap:Envelope>`);
    expect(decodeAeatQueryEnvelope(xml)).toEqual({ kind: "QUERY", result: "SinDatos", hasMore: false, records: [] });
  });

  it.each([
    `<soap:Envelope xmlns:soap="${soapNs}"><soap:Header><x:Unexpected xmlns:x="urn:unexpected"/></soap:Header><soap:Body/></soap:Envelope>`,
    `<soap:Envelope xmlns:soap="${soapNs}"><soap:Body Id="Unexpected"/></soap:Envelope>`
  ])("rejects SOAP wrappers outside the fixed AEAT response shape", (xml) => {
    expect(() => decodeAeatQueryEnvelope(Buffer.from(xml))).toThrow(AeatSoapCodecError);
  });

  it("decodes an AEAT SOAP 1.1 client fault inside the official wrapper", () => {
    const xml = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="${soapNs}"><env:Header/><env:Body Id="Body"><env:Fault><faultcode>env:Client</faultcode><faultstring>Solicitud rechazada</faultstring><detail><callstack>fixture</callstack></detail></env:Fault></env:Body></env:Envelope>`);
    expect(decodeAeatQueryEnvelope(xml)).toEqual({ kind: "FAULT", faultCode: "env:Client" });
  });

  it("keeps runtime schema hashes aligned with the pinned manifest", () => {
    const manifest = JSON.parse(readFileSync(resolve("docs/facturacion/verifactu/aeat-artifacts.v1.json"), "utf8")) as {
      artifacts: Array<{ id: string; sha256: string }>;
    };
    const hash = (id: string) => manifest.artifacts.find((artifact) => artifact.id === id)?.sha256;
    expect(hash("service-wsdl")).toBe(aeatSoapContract.wsdlSha256);
    expect(hash("supply-response-xsd")).toBe(aeatSoapContract.supplyResponseXsdSha256);
    expect(hash("query-xsd")).toBe(aeatSoapContract.queryXsdSha256);
    expect(hash("query-response-xsd")).toBe(aeatSoapContract.queryResponseXsdSha256);
  });

  it("decodes schema-ordered accepted and rejected lines", () => {
    const xml = Buffer.from(`<?xml version="1.0"?><soap:Envelope xmlns:soap="${soapNs}"><soap:Body><r:RespuestaRegFactuSistemaFacturacion xmlns:r="${responseNs}" xmlns:sf="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd"><r:CSV>CSV123</r:CSV><r:Cabecera><sf:ObligadoEmision><sf:NombreRazon>Empresa</sf:NombreRazon><sf:NIF>B12345678</sf:NIF></sf:ObligadoEmision></r:Cabecera><r:TiempoEsperaEnvio>60</r:TiempoEsperaEnvio><r:EstadoEnvio>ParcialmenteCorrecto</r:EstadoEnvio><r:RespuestaLinea><r:IDFactura><sf:IDEmisorFactura>B12345678</sf:IDEmisorFactura><sf:NumSerieFactura>F1</sf:NumSerieFactura><sf:FechaExpedicionFactura>13-07-2026</sf:FechaExpedicionFactura></r:IDFactura><r:Operacion><sf:TipoOperacion>Alta</sf:TipoOperacion></r:Operacion><r:EstadoRegistro>AceptadoConErrores</r:EstadoRegistro><r:CodigoErrorRegistro>2000</r:CodigoErrorRegistro></r:RespuestaLinea></r:RespuestaRegFactuSistemaFacturacion></soap:Body></soap:Envelope>`);
    expect(decodeAeatSubmitEnvelope(xml)).toEqual({
      kind: "SUBMISSION",
      csv: "CSV123",
      waitSeconds: 60,
      status: "ParcialmenteCorrecto",
      lines: [{ issuerTaxId: "B12345678", invoiceNumber: "F1", issueDate: "13-07-2026", operation: "Alta", status: "AceptadoConErrores", errorCode: "2000" }]
    });
  });

  it("accepts RechazoPrevio X in an AEAT operation response", () => {
    const xml = Buffer.from(`<?xml version="1.0"?><soap:Envelope xmlns:soap="${soapNs}"><soap:Body><r:RespuestaRegFactuSistemaFacturacion xmlns:r="${responseNs}" xmlns:sf="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd"><r:Cabecera><sf:ObligadoEmision><sf:NombreRazon>Empresa</sf:NombreRazon><sf:NIF>B12345678</sf:NIF></sf:ObligadoEmision></r:Cabecera><r:TiempoEsperaEnvio>60</r:TiempoEsperaEnvio><r:EstadoEnvio>Correcto</r:EstadoEnvio><r:RespuestaLinea><r:IDFactura><sf:IDEmisorFactura>B12345678</sf:IDEmisorFactura><sf:NumSerieFactura>F1</sf:NumSerieFactura><sf:FechaExpedicionFactura>13-07-2026</sf:FechaExpedicionFactura></r:IDFactura><r:Operacion><sf:TipoOperacion>Alta</sf:TipoOperacion><sf:Subsanacion>S</sf:Subsanacion><sf:RechazoPrevio>X</sf:RechazoPrevio></r:Operacion><r:EstadoRegistro>Correcto</r:EstadoRegistro></r:RespuestaLinea></r:RespuestaRegFactuSistemaFacturacion></soap:Body></soap:Envelope>`);
    expect(decodeAeatSubmitEnvelope(xml)).toMatchObject({
      kind: "SUBMISSION",
      lines: [{ operation: "Alta", status: "Correcto" }]
    });
  });

  it.each([
    `<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]><x/>`,
    `<soap:Envelope xmlns:soap="urn:not-soap"><soap:Body/></soap:Envelope>`,
    `<soap:Envelope xmlns:soap="${soapNs}"><soap:Body/><soap:Body/></soap:Envelope>`
  ])("rejects hostile or ambiguous XML without returning its contents", (xml) => {
    expect(() => decodeAeatSubmitEnvelope(Buffer.from(xml))).toThrow(AeatSoapCodecError);
  });
});

describe("VeriFactu credential and endpoint boundaries", () => {
  const baseCredential: StoredVerifactuCredential = {
    credentialRef: "credential:v1",
    versionId: "11111111-1111-4111-8111-111111111111",
    version: "v1",
    status: "ACTIVE",
    testedAt: new Date("2026-07-01T00:00:00Z"),
    validFrom: new Date("2026-01-01T00:00:00Z"),
    validUntil: new Date("2027-01-01T00:00:00Z"),
    allowedEnvironments: ["TEST"],
    endpointKind: "STANDARD",
    pfx: Buffer.from("not-a-pfx"),
    passphrase: "fixture-only",
    testedPfxSha256: "a".repeat(64),
    release() {}
  };

  it("rejects non-opaque credential references before consulting storage", async () => {
    let loaded = false;
    const provider = createVerifactuCredentialProvider({
      source: { async load() { loaded = true; return baseCredential; } }
    });
    await expect(provider.acquire({ credentialRef: "../../secret.pfx", companyId: "company-a", environment: "TEST" }))
      .rejects.toMatchObject({ code: "VERIFACTU_CREDENTIAL_REF_INVALID" } satisfies Partial<VerifactuCredentialError>);
    expect(loaded).toBe(false);
  });

  it("fails closed before parsing material when environment is not authorized", async () => {
    let released = 0;
    const provider = createVerifactuCredentialProvider({ source: { async load() { return { ...baseCredential, release() { released += 1; } }; } } });
    await expect(provider.acquire({ credentialRef: "credential:v1", companyId: "company-a", environment: "PRODUCTION" }))
      .rejects.toMatchObject({ code: "VERIFACTU_CREDENTIAL_ENVIRONMENT_DENIED" } satisfies Partial<VerifactuCredentialError>);
    expect(released).toBe(1);
  });

  it("uses only WSDL-fixed endpoints", () => {
    expect(resolveVerifactuEndpoint("TEST", "STANDARD").hostname).toBe("prewww1.aeat.es");
    expect(resolveVerifactuEndpoint("PRODUCTION", "SEAL").hostname).toBe("www10.agenciatributaria.gob.es");
  });

  it("rejects unsafe HTTP limits and releases the credential without opening a connection", async () => {
    let released = 0;
    const result = await postVerifactuSoap({
      environment: "TEST",
      credential: {
        credentialRef: "credential:v1", versionId: "11111111-1111-4111-8111-111111111111", version: "v1", endpointKind: "STANDARD",
        pfx: Buffer.from("fixture"), passphrase: "fixture", release() { released += 1; }
      },
      body: Buffer.from("<x/>"),
      responseTimeoutMs: Number.POSITIVE_INFINITY
    });
    expect(result).toEqual({ ok: false, phase: "BEFORE_SEND", code: "REQUEST_INVALID" });
    expect(released).toBe(1);
  });

  it("retains only the response hash when an AEAT TEST XML response is invalid", async () => {
    const response = Buffer.from("<unexpected/>");
    const probe = createAeatVerifactuCredentialProbe(async () => ({
      ok: true,
      status: 200,
      headers: { "content-type": "text/xml" },
      body: response
    }));
    const result = await probe({
      credential: {
        credentialRef: "credential:v1",
        credentialId: "11111111-1111-4111-8111-111111111111",
        versionId: "22222222-2222-4222-8222-222222222222",
        version: 1,
        companyId: "33333333-3333-4333-8333-333333333333",
        endpointKind: "STANDARD",
        pfxSha256: "a".repeat(64),
        pfx: Buffer.from("fixture"),
        passphrase: "fixture",
        release() {}
      },
      fiscalKey: { issuerName: "Empresa", issuerTaxId: "B12345678", invoiceNumber: "F1", issueDate: "13-07-2026" }
    });
    expect(result).toMatchObject({
      outcome: "FAILED",
      stableCode: "VERIFACTU_AEAT_TEST_RESPONSE_INVALID",
      responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });
});

describe("AEAT transport adapter", () => {
  const responseCipher = createSecureEnvelopeKeyring({ activeKeyId: "response-v1", keys: { "response-v1": Buffer.alloc(32, 7) }, random: () => Buffer.alloc(12, 8) });
  const fiscalKey = { issuerName: "Empresa", issuerTaxId: "B12345678", invoiceNumber: "F1", issueDate: "13-07-2026" };
  const context = {
    companyId: "11111111-1111-4111-8111-111111111111",
    sifInstallationId: "22222222-2222-4222-8222-222222222222",
    invoiceId: "33333333-3333-4333-8333-333333333333",
    preparationKey: "preparation-v1",
    recordType: "ALTA" as const
  };

  it("matches the returned fiscal key, encrypts the response and traces the credential version", async () => {
    let releases = 0;
    let sentBody = Buffer.alloc(0);
    const response = Buffer.from(`<?xml version="1.0"?><soap:Envelope xmlns:soap="${soapNs}"><soap:Body><r:RespuestaRegFactuSistemaFacturacion xmlns:r="${responseNs}" xmlns:sf="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd"><r:CSV>CSV123</r:CSV><r:Cabecera><sf:ObligadoEmision><sf:NombreRazon>Empresa</sf:NombreRazon><sf:NIF>B12345678</sf:NIF></sf:ObligadoEmision></r:Cabecera><r:TiempoEsperaEnvio>60</r:TiempoEsperaEnvio><r:EstadoEnvio>Correcto</r:EstadoEnvio><r:RespuestaLinea><r:IDFactura><sf:IDEmisorFactura>B12345678</sf:IDEmisorFactura><sf:NumSerieFactura>F1</sf:NumSerieFactura><sf:FechaExpedicionFactura>13-07-2026</sf:FechaExpedicionFactura></r:IDFactura><r:Operacion><sf:TipoOperacion>Alta</sf:TipoOperacion></r:Operacion><r:EstadoRegistro>Correcto</r:EstadoRegistro></r:RespuestaLinea></r:RespuestaRegFactuSistemaFacturacion></soap:Body></soap:Envelope>`);
    const transport = createAeatVerifactuTransport({
      credentialProvider: { async acquire() { return { credentialRef: "vfcred:test", versionId: "44444444-4444-4444-8444-444444444444", version: "1", endpointKind: "STANDARD", pfx: Buffer.from("fixture"), passphrase: "fixture", release() { releases += 1; } }; } },
      responseCipher,
      post: async (input) => {
        sentBody = Buffer.from(input.body);
        return { ok: true, status: 200, headers: { "content-type": "text/xml" }, body: response };
      }
    });
    const result = await transport.submit({ xml: Buffer.from('<?xml version="1.0"?><sfLR:RegFactuSistemaFacturacion xmlns:sfLR="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd"/>'), credentialRef: "vfcred:test", environment: "TEST", requestId: "request-v1", fiscalKey, context });
    expect(result).toMatchObject({ outcome: "ACCEPTED", aeatCsv: "CSV123", credentialVersionId: "44444444-4444-4444-8444-444444444444", mtlsRefId: "vfcred:test" });
    expect(result.requestSha256).toBe(createHash("sha256").update(sentBody).digest("hex"));
    expect(result.requestSha256).not.toBe(createHash("sha256").update(Buffer.concat([sentBody, Buffer.from(" ")])).digest("hex"));
    expect(result.response?.ciphertext).not.toEqual(response);
    expect(releases).toBeGreaterThanOrEqual(1);
  });

  it("classifies a post-handshake submit failure as UNKNOWN", async () => {
    const transport = createAeatVerifactuTransport({
      credentialProvider: { async acquire() { return { credentialRef: "vfcred:test", versionId: "44444444-4444-4444-8444-444444444444", version: "1", endpointKind: "STANDARD", pfx: Buffer.from("fixture"), passphrase: "fixture", release() {} }; } },
      responseCipher,
      post: async () => ({ ok: false, phase: "POSSIBLY_SENT", code: "TIMEOUT" })
    });
    await expect(transport.submit({ xml: Buffer.from('<sfLR:RegFactuSistemaFacturacion xmlns:sfLR="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd"/>'), credentialRef: "vfcred:test", environment: "TEST", requestId: "request-v2", fiscalKey, context }))
      .resolves.toMatchObject({ outcome: "UNKNOWN", stableCode: "VERIFACTU_MTLS_TIMEOUT" });
  });

  it("accepts only an Anulacion response for an ANULACION submit", async () => {
    const response = Buffer.from(`<?xml version="1.0"?><soap:Envelope xmlns:soap="${soapNs}"><soap:Body><r:RespuestaRegFactuSistemaFacturacion xmlns:r="${responseNs}" xmlns:sf="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd"><r:CSV>CSV-ANULACION</r:CSV><r:Cabecera><sf:ObligadoEmision><sf:NombreRazon>Empresa</sf:NombreRazon><sf:NIF>B12345678</sf:NIF></sf:ObligadoEmision></r:Cabecera><r:TiempoEsperaEnvio>60</r:TiempoEsperaEnvio><r:EstadoEnvio>Correcto</r:EstadoEnvio><r:RespuestaLinea><r:IDFactura><sf:IDEmisorFactura>B12345678</sf:IDEmisorFactura><sf:NumSerieFactura>F1</sf:NumSerieFactura><sf:FechaExpedicionFactura>13-07-2026</sf:FechaExpedicionFactura></r:IDFactura><r:Operacion><sf:TipoOperacion>Anulacion</sf:TipoOperacion></r:Operacion><r:EstadoRegistro>Correcto</r:EstadoRegistro></r:RespuestaLinea></r:RespuestaRegFactuSistemaFacturacion></soap:Body></soap:Envelope>`);
    const transport = createAeatVerifactuTransport({
      credentialProvider: { async acquire() { return { credentialRef: "vfcred:test", versionId: "44444444-4444-4444-8444-444444444444", version: "1", endpointKind: "STANDARD", pfx: Buffer.from("fixture"), passphrase: "fixture", release() {} }; } },
      responseCipher,
      post: async () => ({ ok: true, status: 200, headers: { "content-type": "text/xml" }, body: response })
    });
    await expect(transport.submit({
      xml: Buffer.from('<sfLR:RegFactuSistemaFacturacion xmlns:sfLR="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd"/>'),
      credentialRef: "vfcred:test", environment: "TEST", requestId: "request-anulacion", fiscalKey,
      context: { ...context, recordType: "ANULACION" }
    })).resolves.toMatchObject({ outcome: "ACCEPTED", aeatCsv: "CSV-ANULACION" });
  });

  it("requires EstadoRegistro Anulado when reconciling an ANULACION", async () => {
    const queryResponseNs = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaConsultaLR.xsd";
    const response = Buffer.from(`<?xml version="1.0"?><soap:Envelope xmlns:soap="${soapNs}"><soap:Body><q:RespuestaConsultaFactuSistemaFacturacion xmlns:q="${queryResponseNs}" xmlns:sf="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd"><q:Cabecera><sf:IDVersion>1.0</sf:IDVersion><sf:ObligadoEmision><sf:NombreRazon>Empresa</sf:NombreRazon><sf:NIF>B12345678</sf:NIF></sf:ObligadoEmision></q:Cabecera><q:PeriodoImputacion><q:Ejercicio>2026</q:Ejercicio><q:Periodo>07</q:Periodo></q:PeriodoImputacion><q:IndicadorPaginacion>N</q:IndicadorPaginacion><q:ResultadoConsulta>ConDatos</q:ResultadoConsulta><q:RegistroRespuestaConsultaFactuSistemaFacturacion><q:IDFactura><sf:IDEmisorFactura>B12345678</sf:IDEmisorFactura><sf:NumSerieFactura>F1</sf:NumSerieFactura><sf:FechaExpedicionFactura>13-07-2026</sf:FechaExpedicionFactura></q:IDFactura><q:DatosRegistroFacturacion/><q:EstadoRegistro><q:TimestampUltimaModificacion>2026-07-13T12:00:00+02:00</q:TimestampUltimaModificacion><q:EstadoRegistro>Anulado</q:EstadoRegistro></q:EstadoRegistro></q:RegistroRespuestaConsultaFactuSistemaFacturacion></q:RespuestaConsultaFactuSistemaFacturacion></soap:Body></soap:Envelope>`);
    const transport = createAeatVerifactuTransport({
      credentialProvider: { async acquire() { return { credentialRef: "vfcred:test", versionId: "44444444-4444-4444-8444-444444444444", version: "1", endpointKind: "STANDARD", pfx: Buffer.from("fixture"), passphrase: "fixture", release() {} }; } },
      responseCipher,
      post: async () => ({ ok: true, status: 200, headers: { "content-type": "text/xml" }, body: response })
    });
    await expect(transport.reconcile({
      credentialRef: "vfcred:test", environment: "TEST", requestId: "reconcile-anulacion", fiscalKey,
      context: { ...context, recordType: "ANULACION" }, externalSubmissionId: null
    })).resolves.toMatchObject({ outcome: "ACCEPTED", stableCode: null });
  });

  it("authenticates secure envelopes and rejects context substitution", () => {
    const encrypted = responseCipher.encrypt(Buffer.from("secret"), ["context-a"]);
    expect(Buffer.from(responseCipher.decrypt(encrypted, ["context-a"])).toString("utf8")).toBe("secret");
    expect(() => responseCipher.decrypt(encrypted, ["context-b"])).toThrow("VERIFACTU_SECURE_AUTHENTICATION_FAILED");
  });
});
