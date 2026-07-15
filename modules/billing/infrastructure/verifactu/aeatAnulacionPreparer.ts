import "server-only";

import { createHash } from "node:crypto";
import { buildAeatAnulacionXml } from "@/modules/billing/infrastructure/verifactu/aeatAnulacionXml";
import { aeatHashCanonicalizationVersion, calculateAeatAnulacionHash } from "@/modules/billing/infrastructure/verifactu/aeatHash";
import { supportedVerifactuManifestSha256, supportedVerifactuManifestVersion } from "@/modules/billing/infrastructure/verifactu/aeatF1Preparer";
import type { VerifactuPayloadCipher } from "@/modules/billing/infrastructure/verifactu/payloadCipher";

export type VerifactuAnulacionPreparationInput = {
  idempotencyKey: string;
  target: {
    id: string;
    companyId: string;
    invoiceId: string;
    issuerTaxId: string;
    issuerName: string;
    invoiceNumber: string;
    invoiceIssueDate: string;
    recordHash: string;
  };
  installation: {
    id: string;
    environment: "TEST" | "PRODUCTION";
    contractVersion: string;
    schemaVersion: string;
    artifactManifestVersion: string;
    artifactManifestSha256: string;
    previousRecordId: string | null;
    previousRecordHash: string | null;
    previousInvoiceNumber: string | null;
    previousInvoiceIssueDate: string | null;
    producerTaxId: string;
    producerName: string;
    systemName: string;
    systemId: string;
    systemVersion: string;
    installationNumber: string;
  };
};

export type VerifactuAnulacionPreparer = (input: VerifactuAnulacionPreparationInput) =>
  | { ok: true; value: {
      preparationKey: string;
      generatedAt: Date;
      canonicalizationVersion: string;
      recordHash: string;
      payloadCiphertext: Uint8Array;
      payloadSha256: string;
      encryptionKeyId: string;
    } }
  | { ok: false; error: { code: string } };

export function createAeatAnulacionPreparer(options: {
  cipher: VerifactuPayloadCipher;
  nowWithOffset: () => string;
}): VerifactuAnulacionPreparer {
  return (input) => {
    try {
      if (input.installation.contractVersion !== "VF_V1" || input.installation.schemaVersion !== "tikeV1.0") {
        return { ok: false, error: { code: "VERIFACTU_VERSION_NOT_SUPPORTED" } };
      }
      if (input.installation.artifactManifestVersion !== supportedVerifactuManifestVersion
        || input.installation.artifactManifestSha256 !== supportedVerifactuManifestSha256) {
        return { ok: false, error: { code: "VERIFACTU_MANIFEST_NOT_SUPPORTED" } };
      }
      const previousFields = [
        input.installation.previousRecordId,
        input.installation.previousRecordHash,
        input.installation.previousInvoiceNumber,
        input.installation.previousInvoiceIssueDate
      ];
      if (!previousFields.every((value) => value === null) && !previousFields.every((value) => value !== null)) {
        return { ok: false, error: { code: "VERIFACTU_CHAIN_SNAPSHOT_INVALID" } };
      }
      const cancelledIssueDate = toAeatDate(input.target.invoiceIssueDate);
      const generatedAtWithOffset = options.nowWithOffset();
      const previousHash = input.installation.previousRecordHash;
      const recordHash = calculateAeatAnulacionHash({
        cancelledIssuerTaxId: input.target.issuerTaxId,
        cancelledInvoiceNumber: input.target.invoiceNumber,
        cancelledIssueDate,
        previousHash,
        generatedAtWithOffset
      });
      const xml = buildAeatAnulacionXml({
        issuer: { name: input.target.issuerName, taxId: input.target.issuerTaxId },
        cancelledInvoiceNumber: input.target.invoiceNumber,
        cancelledIssueDate,
        chain: previousHash && input.installation.previousRecordId
          && input.installation.previousInvoiceNumber && input.installation.previousInvoiceIssueDate
          ? {
              firstRecord: false,
              issuerTaxId: input.target.issuerTaxId,
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
        input.target.id,
        input.target.recordHash,
        input.installation.artifactManifestVersion,
        input.installation.artifactManifestSha256,
        "ANULACION"
      ].join("\u0000"), "utf8").digest("hex")}`;
      const payloadCiphertext = options.cipher.encrypt(plaintext, {
        companyId: input.target.companyId,
        sifInstallationId: input.installation.id,
        invoiceId: input.target.invoiceId,
        preparationKey,
        payloadSha256,
        recordType: "ANULACION",
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
          encryptionKeyId: options.cipher.keyId
        }
      };
    } catch {
      return { ok: false, error: { code: "VERIFACTU_CANCELLATION_PREPARATION_FAILED" } };
    }
  };
}

function toAeatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("VERIFACTU_DATE_INVALID");
  return `${match[3]}-${match[2]}-${match[1]}`;
}
