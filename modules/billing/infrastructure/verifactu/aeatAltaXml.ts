import "server-only";

import { z } from "zod";
import { calculateAeatAltaHash } from "@/modules/billing/infrastructure/verifactu/aeatHash";

export const aeatSupplyNamespace = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd";
export const aeatInformationNamespace = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd";

const xmlText = (max: number) => z.string().min(1).max(max)
  .refine((value) => value === value.trim(), "No se permiten espacios perifericos.")
  .refine(isValidXml10Text, "El texto contiene caracteres no validos en XML 1.0.");
const nif = z.string().regex(/^[A-Z0-9]{9}$/);
const date = z.string().regex(/^\d{2}-\d{2}-\d{4}$/).refine(isValidSpanishDate);
const dateTimeWithOffset = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?[+-]\d{2}:\d{2}$/)
  .refine(isValidDateTimeWithOffset);
const amount = z.string().regex(/^[+-]?\d{1,12}(?:\.\d{1,2})?$/);
const rate = z.string().regex(/^\d{1,3}(?:\.\d{1,2})?$/).refine((value) => Number(value) <= 100);
const hash = z.string().regex(/^[0-9A-F]{64}$/);

const breakdownSchema = z.object({
  tax: z.literal("01"),
  regimeKey: z.enum(["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "14", "15", "17", "18", "19", "20", "21"]),
  operationClassification: z.enum(["S1", "S2"]),
  taxRate: rate,
  taxableBase: amount,
  taxAmount: amount
}).strict();

const systemSchema = z.object({
  producerName: xmlText(120),
  producerTaxId: nif,
  systemName: xmlText(30),
  systemId: xmlText(2),
  version: xmlText(50),
  installationNumber: xmlText(100)
}).strict();

const chainSchema = z.discriminatedUnion("firstRecord", [
  z.object({ firstRecord: z.literal(true) }).strict(),
  z.object({
    firstRecord: z.literal(false),
    issuerTaxId: nif,
    invoiceNumber: xmlText(60),
    issueDate: date,
    hash
  }).strict()
]);

export const aeatF1AltaXmlSchema = z.object({
  issuer: z.object({ name: xmlText(120), taxId: nif }).strict(),
  recipient: z.object({ name: xmlText(120), taxId: nif }).strict(),
  correction: z.object({
    subsanacion: z.literal("S"),
    rechazoPrevio: z.literal("X")
  }).strict().nullable().default(null),
  invoiceType: z.enum(["F1", "R4"]).default("F1"),
  rectification: z.object({
    type: z.literal("I"),
    originalIssuerTaxId: nif,
    originalInvoiceNumber: xmlText(60),
    originalIssueDate: date
  }).strict().nullable().default(null),
  invoiceNumber: xmlText(60),
  issueDate: date,
  operationDate: date.optional(),
  description: xmlText(500),
  breakdowns: z.array(breakdownSchema).min(1).max(12),
  totalTaxAmount: amount,
  totalAmount: amount,
  chain: chainSchema,
  system: systemSchema,
  generatedAtWithOffset: dateTimeWithOffset,
  hash
}).strict().superRefine((input, context) => {
  if ((input.invoiceType === "R4") !== Boolean(input.rectification)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["rectification"], message: "La referencia rectificativa no corresponde al tipo de factura." });
  }
  if (!input.chain.firstRecord && input.chain.issuerTaxId !== input.issuer.taxId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["chain", "issuerTaxId"], message: "El registro anterior debe pertenecer al mismo emisor." });
  }
  const breakdownTax = input.breakdowns.reduce((total, item) => total + decimalToCents(item.taxAmount), 0n);
  const breakdownBase = input.breakdowns.reduce((total, item) => total + decimalToCents(item.taxableBase), 0n);
  if (breakdownTax !== decimalToCents(input.totalTaxAmount)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["totalTaxAmount"], message: "La cuota total no coincide con el desglose." });
  }
  if (breakdownBase + breakdownTax !== decimalToCents(input.totalAmount)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["totalAmount"], message: "El importe total no coincide con base y cuota." });
  }
  const expectedHash = calculateAeatAltaHash({
    issuerTaxId: input.issuer.taxId,
    invoiceNumber: input.invoiceNumber,
    issueDate: input.issueDate,
    invoiceType: input.invoiceType,
    totalTaxAmount: input.totalTaxAmount,
    totalAmount: input.totalAmount,
    previousHash: input.chain.firstRecord ? null : input.chain.hash,
    generatedAtWithOffset: input.generatedAtWithOffset
  });
  if (input.hash !== expectedHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["hash"], message: "La huella no corresponde al contenido del registro." });
  }
});

export type AeatF1AltaXmlInput = z.input<typeof aeatF1AltaXmlSchema>;

export function buildAeatF1AltaXml(rawInput: AeatF1AltaXmlInput): string {
  const input = aeatF1AltaXmlSchema.parse(rawInput);
  const sf = (name: string, value: string) => `<sf:${name}>${escapeXml(value)}</sf:${name}>`;
  const breakdowns = input.breakdowns.map((item) => [
    "<sf:DetalleDesglose>",
    sf("Impuesto", item.tax),
    sf("ClaveRegimen", item.regimeKey),
    sf("CalificacionOperacion", item.operationClassification),
    sf("TipoImpositivo", item.taxRate),
    sf("BaseImponibleOimporteNoSujeto", item.taxableBase),
    sf("CuotaRepercutida", item.taxAmount),
    "</sf:DetalleDesglose>"
  ].join("")).join("");
  const chain = input.chain.firstRecord
    ? `<sf:Encadenamiento>${sf("PrimerRegistro", "S")}</sf:Encadenamiento>`
    : `<sf:Encadenamiento><sf:RegistroAnterior>${sf("IDEmisorFactura", input.chain.issuerTaxId)}${sf("NumSerieFactura", input.chain.invoiceNumber)}${sf("FechaExpedicionFactura", input.chain.issueDate)}${sf("Huella", input.chain.hash)}</sf:RegistroAnterior></sf:Encadenamiento>`;

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<sfLR:RegFactuSistemaFacturacion xmlns:sfLR="${aeatSupplyNamespace}" xmlns:sf="${aeatInformationNamespace}">`,
    "<sfLR:Cabecera><sf:ObligadoEmision>",
    sf("NombreRazon", input.issuer.name),
    sf("NIF", input.issuer.taxId),
    "</sf:ObligadoEmision></sfLR:Cabecera>",
    "<sfLR:RegistroFactura><sf:RegistroAlta>",
    sf("IDVersion", "1.0"),
    `<sf:IDFactura>${sf("IDEmisorFactura", input.issuer.taxId)}${sf("NumSerieFactura", input.invoiceNumber)}${sf("FechaExpedicionFactura", input.issueDate)}</sf:IDFactura>`,
    sf("NombreRazonEmisor", input.issuer.name),
    ...(input.correction ? [sf("Subsanacion", input.correction.subsanacion), sf("RechazoPrevio", input.correction.rechazoPrevio)] : []),
    sf("TipoFactura", input.invoiceType),
    ...(input.rectification ? [
      sf("TipoRectificativa", input.rectification.type),
      `<sf:FacturasRectificadas><sf:IDFacturaRectificada>${sf("IDEmisorFactura", input.rectification.originalIssuerTaxId)}${sf("NumSerieFactura", input.rectification.originalInvoiceNumber)}${sf("FechaExpedicionFactura", input.rectification.originalIssueDate)}</sf:IDFacturaRectificada></sf:FacturasRectificadas>`
    ] : []),
    ...(input.operationDate ? [sf("FechaOperacion", input.operationDate)] : []),
    sf("DescripcionOperacion", input.description),
    `<sf:Destinatarios><sf:IDDestinatario>${sf("NombreRazon", input.recipient.name)}${sf("NIF", input.recipient.taxId)}</sf:IDDestinatario></sf:Destinatarios>`,
    `<sf:Desglose>${breakdowns}</sf:Desglose>`,
    sf("CuotaTotal", input.totalTaxAmount),
    sf("ImporteTotal", input.totalAmount),
    chain,
    `<sf:SistemaInformatico>${sf("NombreRazon", input.system.producerName)}${sf("NIF", input.system.producerTaxId)}${sf("NombreSistemaInformatico", input.system.systemName)}${sf("IdSistemaInformatico", input.system.systemId)}${sf("Version", input.system.version)}${sf("NumeroInstalacion", input.system.installationNumber)}${sf("TipoUsoPosibleSoloVerifactu", "S")}${sf("TipoUsoPosibleMultiOT", "N")}${sf("IndicadorMultiplesOT", "N")}</sf:SistemaInformatico>`,
    sf("FechaHoraHusoGenRegistro", input.generatedAtWithOffset),
    sf("TipoHuella", "01"),
    sf("Huella", input.hash),
    "</sf:RegistroAlta></sfLR:RegistroFactura>",
    "</sfLR:RegFactuSistemaFacturacion>"
  ].join("");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isValidSpanishDate(value: string): boolean {
  const [day, month, year] = value.split("-").map(Number);
  if (!day || !month || !year) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function isValidDateTimeWithOffset(value: string): boolean {
  const match = /T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const [, hours, minutes, seconds, , offsetHours, offsetMinutes] = match.map((item) => item ?? "");
  const offsetHour = Number(offsetHours);
  return Number(hours) <= 23 && Number(minutes) <= 59 && Number(seconds) <= 59
    && offsetHour <= 14 && Number(offsetMinutes) <= 59
    && (offsetHour !== 14 || offsetMinutes === "00")
    && !Number.isNaN(Date.parse(value));
}

function isValidXml10Text(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index)!;
    if (codePoint > 0xffff) index += 1;
    if (!(codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
      || (codePoint >= 0x20 && codePoint <= 0xd7ff)
      || (codePoint >= 0xe000 && codePoint <= 0xfffd)
      || (codePoint >= 0x10000 && codePoint <= 0x10ffff))) return false;
  }
  return true;
}

function decimalToCents(value: string): bigint {
  const negative = value.startsWith("-");
  const unsigned = value.replace(/^[+-]/, "");
  const [integer, fraction = ""] = unsigned.split(".");
  const cents = BigInt(integer) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -cents : cents;
}
