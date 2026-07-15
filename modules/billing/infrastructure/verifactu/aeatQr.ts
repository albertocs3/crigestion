import "server-only";

export type AeatQrEnvironment = "TEST" | "PRODUCTION";

export type AeatVerifactuQrInput = {
  environment: AeatQrEnvironment;
  issuerTaxId: string;
  invoiceNumber: string;
  issueDate: string;
  totalAmount: string;
};

const qrBaseUrls: Record<AeatQrEnvironment, string> = {
  TEST: "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR",
  PRODUCTION: "https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR"
};
const printableAsciiPattern = /^[\x20-\x7e]+$/;
const nifPattern = /^[A-Z0-9]{9}$/;
const datePattern = /^\d{2}-\d{2}-\d{4}$/;
const amountPattern = /^-?\d{1,12}(?:\.\d{1,2})?$/;

export function buildAeatVerifactuQrUrl(input: AeatVerifactuQrInput): string {
  if (!nifPattern.test(input.issuerTaxId)) throw new Error("VERIFACTU_QR_INVALID_NIF");
  if (!input.invoiceNumber || input.invoiceNumber.length > 60 || !printableAsciiPattern.test(input.invoiceNumber)) {
    throw new Error("VERIFACTU_QR_INVALID_INVOICE_NUMBER");
  }
  if (!datePattern.test(input.issueDate)) throw new Error("VERIFACTU_QR_INVALID_DATE");
  if (!amountPattern.test(input.totalAmount)) throw new Error("VERIFACTU_QR_INVALID_AMOUNT");

  const query = [
    ["nif", input.issuerTaxId],
    ["numserie", input.invoiceNumber],
    ["fecha", input.issueDate],
    ["importe", input.totalAmount]
  ].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("&");
  return `${qrBaseUrls[input.environment]}?${query}`;
}
