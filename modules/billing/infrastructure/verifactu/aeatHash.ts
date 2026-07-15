import "server-only";

import { createHash } from "node:crypto";

export const aeatHashCanonicalizationVersion = "AEAT_HASH_0.1.2";

export type AeatAltaHashInput = {
  issuerTaxId: string;
  invoiceNumber: string;
  issueDate: string;
  invoiceType: string;
  totalTaxAmount: string;
  totalAmount: string;
  previousHash: string | null;
  generatedAtWithOffset: string;
};

export type AeatAnulacionHashInput = {
  cancelledIssuerTaxId: string;
  cancelledInvoiceNumber: string;
  cancelledIssueDate: string;
  previousHash: string | null;
  generatedAtWithOffset: string;
};

export function buildAeatAltaHashSource(input: AeatAltaHashInput): string {
  return [
    ["IDEmisorFactura", input.issuerTaxId],
    ["NumSerieFactura", input.invoiceNumber],
    ["FechaExpedicionFactura", input.issueDate],
    ["TipoFactura", input.invoiceType],
    ["CuotaTotal", input.totalTaxAmount],
    ["ImporteTotal", input.totalAmount],
    ["Huella", input.previousHash ?? ""],
    ["FechaHoraHusoGenRegistro", input.generatedAtWithOffset]
  ].map(([name, value]) => `${name}=${value.trim()}`).join("&");
}

export function calculateAeatAltaHash(input: AeatAltaHashInput): string {
  return createHash("sha256")
    .update(buildAeatAltaHashSource(input), "utf8")
    .digest("hex")
    .toUpperCase();
}

export function buildAeatAnulacionHashSource(input: AeatAnulacionHashInput): string {
  return [
    ["IDEmisorFacturaAnulada", input.cancelledIssuerTaxId],
    ["NumSerieFacturaAnulada", input.cancelledInvoiceNumber],
    ["FechaExpedicionFacturaAnulada", input.cancelledIssueDate],
    ["Huella", input.previousHash ?? ""],
    ["FechaHoraHusoGenRegistro", input.generatedAtWithOffset]
  ].map(([name, value]) => `${name}=${value.trim()}`).join("&");
}

export function calculateAeatAnulacionHash(input: AeatAnulacionHashInput): string {
  return createHash("sha256")
    .update(buildAeatAnulacionHashSource(input), "utf8")
    .digest("hex")
    .toUpperCase();
}
