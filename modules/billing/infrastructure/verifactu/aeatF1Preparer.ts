import "server-only";

import { createHash } from "node:crypto";
import type { VerifactuAltaPreparer } from "@/modules/billing/application/invoices";
import { buildAeatF1AltaXml } from "@/modules/billing/infrastructure/verifactu/aeatAltaXml";
import { aeatHashCanonicalizationVersion, calculateAeatAltaHash } from "@/modules/billing/infrastructure/verifactu/aeatHash";
import { buildAeatVerifactuQrUrl } from "@/modules/billing/infrastructure/verifactu/aeatQr";
import type { VerifactuPayloadCipher } from "@/modules/billing/infrastructure/verifactu/payloadCipher";

export const supportedVerifactuManifestVersion = "AEAT_VERIFACTU_ARTIFACTS_V1";
export const supportedVerifactuManifestSha256 = "c0f4eb1826683c43faa7fc004ed221ce47d6d8383d962506ecc4d9e089062206";
const supportedVatRates = new Set(["4.00", "10.00", "21.00"]);

export function createAeatF1AltaPreparer(options: {
  cipher: VerifactuPayloadCipher;
  nowWithOffset: () => string;
}): VerifactuAltaPreparer {
  return (input) => {
    try {
      if (input.invoice.customerFiscalTreatment !== "DOMESTIC") {
        return { ok: false, error: { code: "VERIFACTU_F1_SCOPE_NOT_SUPPORTED" } };
      }
      const rectification = input.invoice.rectification ?? null;
      if ((input.invoice.documentType === "STANDARD") !== (rectification === null)) {
        return { ok: false, error: { code: "VERIFACTU_INVOICE_SHAPE_INVALID" } };
      }
      if (input.installation.contractVersion !== "VF_V1" || input.installation.schemaVersion !== "tikeV1.0") {
        return { ok: false, error: { code: "VERIFACTU_VERSION_NOT_SUPPORTED" } };
      }
      if (
        input.installation.artifactManifestVersion !== supportedVerifactuManifestVersion
        || input.installation.artifactManifestSha256 !== supportedVerifactuManifestSha256
      ) {
        return { ok: false, error: { code: "VERIFACTU_MANIFEST_NOT_SUPPORTED" } };
      }
      if (!input.invoice.taxSummaries.every((summary) => isSupportedVatSummary(summary, input.invoice.documentType))) {
        return { ok: false, error: { code: "VERIFACTU_F1_TAX_SCOPE_NOT_SUPPORTED" } };
      }
      const issueDate = toAeatDate(input.invoice.issueDate);
      const operationDate = toAeatDate(input.invoice.operationDate);
      const generatedAtWithOffset = options.nowWithOffset();
      const previousHash = input.installation.previousRecordHash;
      const previousFields = [
        input.installation.previousRecordId,
        previousHash,
        input.installation.previousInvoiceNumber,
        input.installation.previousInvoiceIssueDate
      ];
      if (!previousFields.every((value) => value === null) && !previousFields.every((value) => value !== null)) {
        return { ok: false, error: { code: "VERIFACTU_CHAIN_SNAPSHOT_INVALID" } };
      }
      const invoiceType = input.invoice.documentType === "RECTIFICATION" ? "R4" : "F1";
      const recordHash = calculateAeatAltaHash({
        issuerTaxId: input.invoice.issuerTaxId,
        invoiceNumber: input.invoice.number,
        issueDate,
        invoiceType,
        totalTaxAmount: input.invoice.taxAmount,
        totalAmount: input.invoice.total,
        previousHash,
        generatedAtWithOffset
      });
      const xml = buildAeatF1AltaXml({
        issuer: { name: input.invoice.issuerName, taxId: input.invoice.issuerTaxId },
        recipient: { name: input.invoice.customerLegalName, taxId: input.invoice.customerTaxId },
        correction: input.correction ? {
          subsanacion: input.correction.subsanacion,
          rechazoPrevio: input.correction.rechazoPrevio
        } : null,
        invoiceType,
        rectification: rectification ? {
          type: "I",
          originalIssuerTaxId: input.invoice.issuerTaxId,
          originalInvoiceNumber: rectification.originalInvoiceNumber,
          originalIssueDate: toAeatDate(rectification.originalIssueDate)
        } : null,
        invoiceNumber: input.invoice.number,
        issueDate,
        operationDate,
        description: operationDescription(input.invoice.lines.map((line) => line.description)),
        breakdowns: input.invoice.taxSummaries.map((summary) => ({
          tax: "01" as const,
          regimeKey: "01" as const,
          operationClassification: "S1" as const,
          taxRate: summary.taxRate,
          taxableBase: summary.taxableBase,
          taxAmount: summary.taxAmount
        })),
        totalTaxAmount: input.invoice.taxAmount,
        totalAmount: input.invoice.total,
        chain: previousHash && input.installation.previousRecordId
          && input.installation.previousInvoiceNumber && input.installation.previousInvoiceIssueDate
          ? {
              firstRecord: false,
              issuerTaxId: input.invoice.issuerTaxId,
              invoiceNumber: input.installation.previousInvoiceNumber,
              issueDate: toAeatDate(input.installation.previousInvoiceIssueDate),
              hash: previousHash
            }
          : { firstRecord: true },
        system: {
          producerName: input.installation.producerName,
          producerTaxId: input.installation.producerTaxId,
          systemName: input.installation.systemName,
          systemId: input.installation.systemId,
          version: input.installation.systemVersion,
          installationNumber: input.installation.installationNumber
        },
        generatedAtWithOffset,
        hash: recordHash
      });
      const plaintext = Buffer.from(xml, "utf8");
      const payloadSha256 = createHash("sha256").update(plaintext).digest("hex");
      const preparationKey = `vf1:${createHash("sha256").update([
        input.idempotencyKey,
        input.invoice.id,
        input.installation.artifactManifestVersion,
        input.installation.artifactManifestSha256,
        "ALTA",
        input.correction?.rejectedRecordId ?? "ORIGINAL"
      ].join("\u0000"), "utf8").digest("hex")}`;
      const payloadCiphertext = options.cipher.encrypt(plaintext, {
        companyId: input.invoice.companyId,
        sifInstallationId: input.installation.id,
        invoiceId: input.invoice.id,
        preparationKey,
        payloadSha256,
        recordType: "ALTA",
        environment: input.installation.environment
      });
      return {
        ok: true,
        value: {
          preparationKey,
          generatedAt: new Date(generatedAtWithOffset),
          canonicalizationVersion: aeatHashCanonicalizationVersion,
          recordHash,
          payloadCiphertext,
          payloadSha256,
          encryptionKeyId: options.cipher.keyId,
          qrUrl: buildAeatVerifactuQrUrl({
            environment: input.installation.environment,
            issuerTaxId: input.invoice.issuerTaxId,
            invoiceNumber: input.invoice.number,
            issueDate,
            totalAmount: input.invoice.total
          })
        }
      };
    } catch {
      return { ok: false, error: { code: "VERIFACTU_F1_PREPARATION_FAILED" } };
    }
  };
}

function isSupportedVatSummary(summary: {
  taxRateCode: string;
  taxRate: string;
  taxableBase: string;
  taxAmount: string;
  total: string;
}, documentType: "STANDARD" | "RECTIFICATION"): boolean {
  const expectedCode = `IVA_${Number(summary.taxRate).toString()}`;
  const direction = documentType === "RECTIFICATION" ? -1 : 1;
  return supportedVatRates.has(summary.taxRate)
    && summary.taxRateCode === expectedCode
    && Number(summary.taxableBase) * direction > 0
    && Number(summary.taxAmount) * direction > 0
    && Number(summary.total) * direction > 0;
}

function toAeatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("VERIFACTU_DATE_INVALID");
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function operationDescription(descriptions: string[]): string {
  const value = [...new Set(descriptions)].join("; ");
  if (!value || value.length > 500) throw new Error("VERIFACTU_DESCRIPTION_INVALID");
  return value;
}
