import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildAeatAnulacionHashSource,
  buildAeatAltaHashSource,
  calculateAeatAnulacionHash,
  calculateAeatAltaHash
} from "@/modules/billing/infrastructure/verifactu/aeatHash";
import { buildAeatVerifactuQrUrl } from "@/modules/billing/infrastructure/verifactu/aeatQr";
import { buildAeatF1AltaXml } from "@/modules/billing/infrastructure/verifactu/aeatAltaXml";
import { buildAeatAnulacionXml } from "@/modules/billing/infrastructure/verifactu/aeatAnulacionXml";
import { createVerifactuPayloadCipher, createVerifactuPayloadKeyring } from "@/modules/billing/infrastructure/verifactu/payloadCipher";
import { createAeatF1AltaPreparer } from "@/modules/billing/infrastructure/verifactu/aeatF1Preparer";
import { createAeatAnulacionPreparer } from "@/modules/billing/infrastructure/verifactu/aeatAnulacionPreparer";
import { formatEuropeMadridDateTime, readConfiguredVerifactuAltaPreparer } from "@/modules/billing/infrastructure/verifactu/configuredPreparer";

describe("AEAT VeriFactu technical primitives", () => {
  it("matches the official first ALTA hash vector from specification 0.1.2", () => {
    const input = {
      issuerTaxId: "89890001K",
      invoiceNumber: "12345678/G33",
      issueDate: "01-01-2024",
      invoiceType: "F1",
      totalTaxAmount: "12.35",
      totalAmount: "123.45",
      previousHash: null,
      generatedAtWithOffset: "2024-01-01T19:20:30+01:00"
    };
    expect(buildAeatAltaHashSource(input)).toBe(
      "IDEmisorFactura=89890001K&NumSerieFactura=12345678/G33&FechaExpedicionFactura=01-01-2024&TipoFactura=F1&CuotaTotal=12.35&ImporteTotal=123.45&Huella=&FechaHoraHusoGenRegistro=2024-01-01T19:20:30+01:00"
    );
    expect(calculateAeatAltaHash(input)).toBe(
      "3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60"
    );
  });

  it("matches the official chained ALTA hash vector", () => {
    expect(calculateAeatAltaHash({
      issuerTaxId: "89890001K",
      invoiceNumber: "12345679/G34",
      issueDate: "01-01-2024",
      invoiceType: "F1",
      totalTaxAmount: "12.35",
      totalAmount: "123.45",
      previousHash: "3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60",
      generatedAtWithOffset: "2024-01-01T19:20:35+01:00"
    })).toBe("F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97");
  });

  it("matches the official ANULACION hash vector from specification 0.1.2", () => {
    const input = {
      cancelledIssuerTaxId: "89890001K",
      cancelledInvoiceNumber: "12345679/G34",
      cancelledIssueDate: "01-01-2024",
      previousHash: "F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97",
      generatedAtWithOffset: "2024-01-01T19:20:40+01:00"
    };
    expect(buildAeatAnulacionHashSource(input)).toBe(
      "IDEmisorFacturaAnulada=89890001K&NumSerieFacturaAnulada=12345679/G34&FechaExpedicionFacturaAnulada=01-01-2024&Huella=F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97&FechaHoraHusoGenRegistro=2024-01-01T19:20:40+01:00"
    );
    expect(calculateAeatAnulacionHash(input)).toBe(
      "177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68"
    );
  });

  it("builds official VeriFactu QR URLs with percent-encoded values", () => {
    expect(buildAeatVerifactuQrUrl({
      environment: "TEST",
      issuerTaxId: "89890001K",
      invoiceNumber: "12345678&G33",
      issueDate: "01-01-2024",
      totalAmount: "241.4"
    })).toBe(
      "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=12345678%26G33&fecha=01-01-2024&importe=241.4"
    );
    expect(buildAeatVerifactuQrUrl({
      environment: "PRODUCTION",
      issuerTaxId: "89890001K",
      invoiceNumber: "12345678/G33",
      issueDate: "01-01-2024",
      totalAmount: "123.45"
    })).toContain("https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?");
  });

  it("rejects QR fields outside the official formats", () => {
    expect(() => buildAeatVerifactuQrUrl({
      environment: "TEST",
      issuerTaxId: "INVALID",
      invoiceNumber: "F1",
      issueDate: "01-01-2024",
      totalAmount: "1.00"
    })).toThrow("VERIFACTU_QR_INVALID_NIF");
    expect(() => buildAeatVerifactuQrUrl({
      environment: "TEST",
      issuerTaxId: "89890001K",
      invoiceNumber: "Fñ",
      issueDate: "01-01-2024",
      totalAmount: "1.00"
    })).toThrow("VERIFACTU_QR_INVALID_INVOICE_NUMBER");
  });

  it("builds an ordered F1 ALTA document with official namespaces and safe XML escaping", () => {
    const xml = buildAeatF1AltaXml(f1AltaInput());
    const golden = readFileSync(resolve("tests/fixtures/verifactu/f1-alta-first.xml"), "utf8").trim();
    expect(xml).toBe(golden);
    expect(xml).toContain('xmlns:sfLR="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd"');
    expect(xml).toContain("<sf:NombreRazon>Cliente &amp; Asociados</sf:NombreRazon>");
    expect(xml).toContain("<sf:Encadenamiento><sf:PrimerRegistro>S</sf:PrimerRegistro></sf:Encadenamiento>");
    expect(xml).toContain("<sf:TipoUsoPosibleSoloVerifactu>S</sf:TipoUsoPosibleSoloVerifactu>");
    expect(xml.indexOf("<sf:IDVersion>")).toBeLessThan(xml.indexOf("<sf:IDFactura>"));
    expect(xml.indexOf("<sf:Desglose>")).toBeLessThan(xml.indexOf("<sf:CuotaTotal>"));
    expect(xml.indexOf("<sf:SistemaInformatico>")).toBeLessThan(xml.indexOf("<sf:FechaHoraHusoGenRegistro>"));
    expect(xml.endsWith("</sfLR:RegFactuSistemaFacturacion>")).toBe(true);
  });

  it("builds RegistroAnterior and rejects invalid XSD bounds", () => {
    const first = f1AltaInput();
    const chained = {
      ...first,
      chain: {
        firstRecord: false,
        issuerTaxId: "B12345678",
        invoiceNumber: "F2600001",
        issueDate: "12-07-2026",
        hash: "A".repeat(64)
      } as const
    };
    const xml = buildAeatF1AltaXml({
      ...chained,
      hash: calculateAeatAltaHash({
        issuerTaxId: chained.issuer.taxId,
        invoiceNumber: chained.invoiceNumber,
        issueDate: chained.issueDate,
        invoiceType: "F1",
        totalTaxAmount: chained.totalTaxAmount,
        totalAmount: chained.totalAmount,
        previousHash: chained.chain.hash,
        generatedAtWithOffset: chained.generatedAtWithOffset
      })
    });
    expect(xml).toContain(`<sf:RegistroAnterior><sf:IDEmisorFactura>B12345678</sf:IDEmisorFactura><sf:NumSerieFactura>F2600001</sf:NumSerieFactura><sf:FechaExpedicionFactura>12-07-2026</sf:FechaExpedicionFactura><sf:Huella>${"A".repeat(64)}</sf:Huella></sf:RegistroAnterior>`);
    expect(() => buildAeatF1AltaXml({ ...first, invoiceNumber: "X".repeat(61) })).toThrow();
    expect(() => buildAeatF1AltaXml({ ...first, breakdowns: [] })).toThrow();
    expect(() => buildAeatF1AltaXml({ ...first, issueDate: "31-02-2026" })).toThrow();
    expect(() => buildAeatF1AltaXml({ ...first, description: "invalido\ud800" })).toThrow();
    expect(() => buildAeatF1AltaXml({ ...first, hash: "C".repeat(64) })).toThrow("La huella no corresponde");
  });

  it("builds an ALTA por rechazo with the AEAT S/X indicators in XSD order", () => {
    const xml = buildAeatF1AltaXml({
      ...f1AltaInput(),
      correction: { subsanacion: "S", rechazoPrevio: "X" }
    });
    expect(xml).toContain("<sf:Subsanacion>S</sf:Subsanacion><sf:RechazoPrevio>X</sf:RechazoPrevio>");
    expect(xml.indexOf("<sf:NombreRazonEmisor>")).toBeLessThan(xml.indexOf("<sf:Subsanacion>"));
    expect(xml.indexOf("<sf:RechazoPrevio>")).toBeLessThan(xml.indexOf("<sf:TipoFactura>"));
  });

  it("builds an incremental R4 ALTA linked to the original invoice", () => {
    const base = f1AltaInput();
    const input = {
      ...base,
      invoiceType: "R4" as const,
      rectification: {
        type: "I" as const,
        originalIssuerTaxId: "B12345678",
        originalInvoiceNumber: "F2600001",
        originalIssueDate: "12-07-2026"
      },
      invoiceNumber: "R2600001",
      breakdowns: base.breakdowns.map((item) => ({ ...item, taxableBase: "-100.00", taxAmount: "-21.00" })),
      totalTaxAmount: "-21.00",
      totalAmount: "-121.00",
      hash: calculateAeatAltaHash({
        issuerTaxId: "B12345678",
        invoiceNumber: "R2600001",
        issueDate: "12-07-2026",
        invoiceType: "R4",
        totalTaxAmount: "-21.00",
        totalAmount: "-121.00",
        previousHash: null,
        generatedAtWithOffset: base.generatedAtWithOffset
      })
    };
    const xml = buildAeatF1AltaXml(input);
    const golden = readFileSync(resolve("tests/fixtures/verifactu/r4-rectification-incremental.xml"), "utf8").trim();
    expect(xml).toBe(golden);
    expect(xml).toContain("<sf:TipoFactura>R4</sf:TipoFactura><sf:TipoRectificativa>I</sf:TipoRectificativa>");
    expect(xml).toContain("<sf:FacturasRectificadas><sf:IDFacturaRectificada><sf:IDEmisorFactura>B12345678</sf:IDEmisorFactura><sf:NumSerieFactura>F2600001</sf:NumSerieFactura><sf:FechaExpedicionFactura>12-07-2026</sf:FechaExpedicionFactura></sf:IDFacturaRectificada></sf:FacturasRectificadas>");
    expect(xml).toContain("<sf:ImporteTotal>-121.00</sf:ImporteTotal>");
  });

  it("builds an ordered ANULACION document and validates its hash", () => {
    const input = anulacionInput();
    const xml = buildAeatAnulacionXml(input);
    const golden = readFileSync(resolve("tests/fixtures/verifactu/anulacion-chained.xml"), "utf8").trim();
    expect(xml).toBe(golden);
    expect(xml).toContain("<sf:RegistroAnulacion>");
    expect(xml).toContain("<sf:IDEmisorFacturaAnulada>89890001K</sf:IDEmisorFacturaAnulada>");
    expect(xml).toContain("<sf:NumSerieFacturaAnulada>12345679/G34</sf:NumSerieFacturaAnulada>");
    expect(xml).toContain(`<sf:Huella>${input.hash}</sf:Huella>`);
    expect(xml.indexOf("<sf:IDFactura>")).toBeLessThan(xml.indexOf("<sf:Encadenamiento>"));
    expect(xml.indexOf("<sf:Encadenamiento>")).toBeLessThan(xml.indexOf("<sf:SistemaInformatico>"));
    expect(() => buildAeatAnulacionXml({ ...input, hash: "A".repeat(64) })).toThrow("La huella no corresponde");
  });

  it("encrypts the fiscal XML with authenticated context and detects tampering", () => {
    const cipher = createVerifactuPayloadCipher({
      keyId: "test-key-2026-01",
      key: Buffer.alloc(32, 7),
      random: () => Buffer.alloc(12, 9)
    });
    const context = {
      companyId: "company-1",
      sifInstallationId: "sif-1",
      invoiceId: "invoice-1",
      preparationKey: "preparation-1",
      payloadSha256: "a".repeat(64),
      recordType: "ALTA" as const,
      environment: "TEST" as const
    };
    const plaintext = Buffer.from(buildAeatF1AltaXml(f1AltaInput()), "utf8");
    const encrypted = cipher.encrypt(plaintext, context);
    expect(Buffer.from(encrypted).includes(plaintext)).toBe(false);
    expect(Buffer.from(cipher.decrypt(encrypted, context))).toEqual(plaintext);
    expect(() => cipher.decrypt(encrypted, { ...context, invoiceId: "invoice-2" })).toThrow("VERIFACTU_PAYLOAD_AUTHENTICATION_FAILED");
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 1;
    expect(() => cipher.decrypt(tampered, context)).toThrow("VERIFACTU_PAYLOAD_AUTHENTICATION_FAILED");
    const invalidHeader = Buffer.from(encrypted);
    invalidHeader[0] ^= 1;
    expect(() => cipher.decrypt(invalidHeader, context)).toThrow("VERIFACTU_ENCRYPTED_PAYLOAD_INVALID");
    const randomCipher = createVerifactuPayloadCipher({ keyId: "random-key", key: Buffer.alloc(32, 6) });
    expect(randomCipher.encrypt(plaintext, context)).not.toEqual(randomCipher.encrypt(plaintext, context));
  });

  it("decrypts historical payloads after rotating the active key", () => {
    const oldCipher = createVerifactuPayloadKeyring({
      activeKeyId: "key-2025",
      keys: { "key-2025": Buffer.alloc(32, 1) },
      random: () => Buffer.alloc(12, 2)
    });
    const context = payloadContext();
    const encrypted = oldCipher.encrypt(Buffer.from("fiscal-xml"), context);
    const rotated = createVerifactuPayloadKeyring({
      activeKeyId: "key-2026",
      keys: { "key-2025": Buffer.alloc(32, 1), "key-2026": Buffer.alloc(32, 3) }
    });
    expect(Buffer.from(rotated.decrypt(encrypted, context)).toString("utf8")).toBe("fiscal-xml");
    expect(rotated.keyId).toBe("key-2026");
  });

  it("composes hash, QR, XML and authenticated encryption for an F1 alta", () => {
    const cipher = createVerifactuPayloadCipher({
      keyId: "test-key",
      key: Buffer.alloc(32, 4),
      random: () => Buffer.alloc(12, 5)
    });
    const prepare = createAeatF1AltaPreparer({
      cipher,
      nowWithOffset: () => "2026-07-12T12:00:00+02:00"
    });
    const input = preparationInput();
    const result = prepare(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value).toMatchObject({
      canonicalizationVersion: "AEAT_HASH_0.1.2",
      recordHash: "70A0810B558871D3A3187EE2788C28075EA8887CBAAC61EE0E3129388ABC3A81",
      encryptionKeyId: "test-key",
      qrUrl: "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=B12345678&numserie=F2600001&fecha=12-07-2026&importe=121.00"
    });
    const plaintext = cipher.decrypt(result.value.payloadCiphertext, {
      companyId: input.invoice.companyId,
      sifInstallationId: input.installation.id,
      invoiceId: input.invoice.id,
      preparationKey: result.value.preparationKey,
      payloadSha256: result.value.payloadSha256,
      recordType: "ALTA",
      environment: "TEST"
    });
    expect(Buffer.from(plaintext).toString("utf8")).toBe(buildAeatF1AltaXml(f1AltaInput()));

    const later = createAeatF1AltaPreparer({
      cipher,
      nowWithOffset: () => "2026-07-12T12:00:30+02:00"
    })(input);
    expect(later.ok).toBe(true);
    if (later.ok) expect(later.value.preparationKey).toBe(result.value.preparationKey);
  });

  it("composes hash, XML and authenticated encryption for an ANULACION", () => {
    const cipher = createVerifactuPayloadCipher({ keyId: "test-key", key: Buffer.alloc(32, 4), random: () => Buffer.alloc(12, 5) });
    const prepare = createAeatAnulacionPreparer({ cipher, nowWithOffset: () => "2024-01-01T19:20:40+01:00" });
    const result = prepare(anulacionPreparationInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.recordHash).toBe("177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68");
    const input = anulacionPreparationInput();
    const plaintext = cipher.decrypt(result.value.payloadCiphertext, {
      companyId: input.target.companyId,
      sifInstallationId: input.installation.id,
      invoiceId: input.target.invoiceId,
      preparationKey: result.value.preparationKey,
      payloadSha256: result.value.payloadSha256,
      recordType: "ANULACION",
      environment: "TEST"
    });
    expect(Buffer.from(plaintext).toString("utf8")).toContain("<sf:RegistroAnulacion>");
  });

  it("fails closed for tax treatments and manifests outside the certified F1 subset", () => {
    const prepare = createAeatF1AltaPreparer({
      cipher: createVerifactuPayloadCipher({ keyId: "test-key", key: Buffer.alloc(32, 4) }),
      nowWithOffset: () => "2026-07-12T12:00:00+02:00"
    });
    const input = preparationInput();
    expect(prepare({
      ...input,
      invoice: { ...input.invoice, taxSummaries: [{ ...input.invoice.taxSummaries[0]!, taxRateCode: "IVA_0", taxRate: "0.00", taxAmount: "0.00" }] }
    })).toMatchObject({ ok: false, error: { code: "VERIFACTU_F1_TAX_SCOPE_NOT_SUPPORTED" } });
    expect(prepare({
      ...input,
      installation: { ...input.installation, artifactManifestSha256: "f".repeat(64) }
    })).toMatchObject({ ok: false, error: { code: "VERIFACTU_MANIFEST_NOT_SUPPORTED" } });
  });

  it("formats Madrid timestamps with the correct seasonal offset and fails closed without a keyring", () => {
    expect(formatEuropeMadridDateTime(new Date("2026-01-12T11:00:00.000Z"))).toBe("2026-01-12T12:00:00+01:00");
    expect(formatEuropeMadridDateTime(new Date("2026-07-12T10:00:00.000Z"))).toBe("2026-07-12T12:00:00+02:00");
    expect(readConfiguredVerifactuAltaPreparer(
      { ...process.env, APP_ENV: "test", VERIFACTU_ENABLED: "true", VERIFACTU_ENVIRONMENT: "TEST", VERIFACTU_ALLOW_PRODUCTION: "false", VERIFACTU_PAYLOAD_KEYS: undefined },
      () => new Date(),
      () => {}
    )).toBeUndefined();
    expect(readConfiguredVerifactuAltaPreparer({
      ...process.env,
      APP_ENV: "test",
      VERIFACTU_ENABLED: "true",
      VERIFACTU_ENVIRONMENT: "TEST",
      VERIFACTU_ALLOW_PRODUCTION: "false",
      VERIFACTU_PAYLOAD_ACTIVE_KEY_ID: "active-2026",
      VERIFACTU_PAYLOAD_KEYS: JSON.stringify({ "active-2026": Buffer.alloc(32, 8).toString("base64") })
    }, () => new Date("2026-07-12T10:00:00.000Z"))).toBeTypeOf("function");
  });
});

function f1AltaInput() {
  return {
    issuer: { name: "CriGestion Ejemplo SL", taxId: "B12345678" },
    recipient: { name: "Cliente & Asociados", taxId: "B87654321" },
    invoiceNumber: "F2600001",
    issueDate: "12-07-2026",
    operationDate: "12-07-2026",
    description: "Prestacion de servicios",
    breakdowns: [{
      tax: "01" as const,
      regimeKey: "01" as const,
      operationClassification: "S1" as const,
      taxRate: "21.00",
      taxableBase: "100.00",
      taxAmount: "21.00"
    }],
    totalTaxAmount: "21.00",
    totalAmount: "121.00",
    chain: { firstRecord: true as const },
    system: {
      producerName: "CriGestion Software SL",
      producerTaxId: "B11223344",
      systemName: "CriGestion",
      systemId: "CG",
      version: "0.1.0",
      installationNumber: "TEST-1"
    },
    generatedAtWithOffset: "2026-07-12T12:00:00+02:00",
    hash: calculateAeatAltaHash({
      issuerTaxId: "B12345678",
      invoiceNumber: "F2600001",
      issueDate: "12-07-2026",
      invoiceType: "F1",
      totalTaxAmount: "21.00",
      totalAmount: "121.00",
      previousHash: null,
      generatedAtWithOffset: "2026-07-12T12:00:00+02:00"
    })
  };
}

function anulacionInput() {
  const previousHash = "F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97";
  const generatedAtWithOffset = "2024-01-01T19:20:40+01:00";
  return {
    issuer: { name: "Empresa Ejemplo SL", taxId: "89890001K" },
    cancelledInvoiceNumber: "12345679/G34",
    cancelledIssueDate: "01-01-2024",
    chain: {
      firstRecord: false as const,
      issuerTaxId: "89890001K",
      invoiceNumber: "12345679/G34",
      issueDate: "01-01-2024",
      hash: previousHash
    },
    system: {
      producerName: "CriGestion Software SL",
      producerTaxId: "B11223344",
      systemName: "CriGestion",
      systemId: "CG",
      version: "0.1.0",
      installationNumber: "TEST-1"
    },
    generatedAtWithOffset,
    hash: calculateAeatAnulacionHash({
      cancelledIssuerTaxId: "89890001K",
      cancelledInvoiceNumber: "12345679/G34",
      cancelledIssueDate: "01-01-2024",
      previousHash,
      generatedAtWithOffset
    })
  };
}

function anulacionPreparationInput() {
  return {
    idempotencyKey: "cancel-request-1",
    target: {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      invoiceId: "33333333-3333-4333-8333-333333333333",
      issuerTaxId: "89890001K",
      issuerName: "Empresa Ejemplo SL",
      invoiceNumber: "12345679/G34",
      invoiceIssueDate: "2024-01-01",
      recordHash: "F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97"
    },
    installation: {
      id: "44444444-4444-4444-8444-444444444444",
      environment: "TEST" as const,
      contractVersion: "VF_V1",
      schemaVersion: "tikeV1.0",
      artifactManifestVersion: "AEAT_VERIFACTU_ARTIFACTS_V1",
      artifactManifestSha256: "c0f4eb1826683c43faa7fc004ed221ce47d6d8383d962506ecc4d9e089062206",
      previousRecordId: "11111111-1111-4111-8111-111111111111",
      previousRecordHash: "F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97",
      previousInvoiceNumber: "12345679/G34",
      previousInvoiceIssueDate: "2024-01-01",
      producerTaxId: "B11223344",
      producerName: "CriGestion Software SL",
      systemName: "CriGestion",
      systemId: "CG",
      systemVersion: "0.1.0",
      installationNumber: "TEST-1"
    }
  };
}

function payloadContext() {
  return {
    companyId: "company-1",
    sifInstallationId: "sif-1",
    invoiceId: "invoice-1",
    preparationKey: "preparation-1",
    payloadSha256: "a".repeat(64),
    recordType: "ALTA" as const,
    environment: "TEST" as const
  };
}

function preparationInput() {
  return {
    idempotencyKey: "issue-f2600001",
    invoice: {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      documentType: "STANDARD" as const,
      issuerName: "CriGestion Ejemplo SL",
      issuerTaxId: "B12345678",
      series: "F",
      number: "F2600001",
      issueDate: "2026-07-12",
      operationDate: "2026-07-12",
      customerCode: "1",
      customerLegalName: "Cliente & Asociados",
      customerTaxId: "B87654321",
      customerFiscalTreatment: "DOMESTIC",
      customerFiscalAddress: { country: "ES" },
      subtotal: "100.00",
      discountTotal: "0.00",
      taxableBase: "100.00",
      taxAmount: "21.00",
      total: "121.00",
      lines: [{ position: 1, description: "Prestacion de servicios", lineTaxableBase: "100.00", lineTaxAmount: "21.00", lineTotal: "121.00" }],
      taxSummaries: [{ taxRateCode: "IVA_21", taxRate: "21.00", taxableBase: "100.00", taxAmount: "21.00", total: "121.00" }]
    },
    installation: {
      id: "33333333-3333-4333-8333-333333333333",
      environment: "TEST" as const,
      contractVersion: "VF_V1",
      schemaVersion: "tikeV1.0",
      artifactManifestVersion: "AEAT_VERIFACTU_ARTIFACTS_V1",
      artifactManifestSha256: "c0f4eb1826683c43faa7fc004ed221ce47d6d8383d962506ecc4d9e089062206",
      nextPosition: 1n,
      previousRecordId: null,
      previousRecordHash: null,
      previousInvoiceNumber: null,
      previousInvoiceIssueDate: null,
      producerTaxId: "B11223344",
      producerName: "CriGestion Software SL",
      systemName: "CriGestion",
      systemId: "CG",
      systemVersion: "0.1.0",
      installationNumber: "TEST-1"
    }
  };
}
