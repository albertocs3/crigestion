import "server-only";

import { z } from "zod";
import { calculateAeatAnulacionHash } from "@/modules/billing/infrastructure/verifactu/aeatHash";
import { aeatInformationNamespace, aeatSupplyNamespace } from "@/modules/billing/infrastructure/verifactu/aeatAltaXml";

const xmlText = (max: number) => z.string().min(1).max(max)
  .refine((value) => value === value.trim(), "No se permiten espacios perifericos.")
  .refine(isValidXml10Text, "El texto contiene caracteres no validos en XML 1.0.");
const nif = z.string().regex(/^[A-Z0-9]{9}$/);
const date = z.string().regex(/^\d{2}-\d{2}-\d{4}$/).refine(isValidSpanishDate);
const dateTimeWithOffset = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?[+-]\d{2}:\d{2}$/)
  .refine(isValidDateTimeWithOffset);
const hash = z.string().regex(/^[0-9A-F]{64}$/);

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

export const aeatAnulacionXmlSchema = z.object({
  issuer: z.object({ name: xmlText(120), taxId: nif }).strict(),
  cancelledInvoiceNumber: xmlText(60),
  cancelledIssueDate: date,
  chain: chainSchema,
  system: systemSchema,
  generatedAtWithOffset: dateTimeWithOffset,
  hash
}).strict().superRefine((input, context) => {
  if (!input.chain.firstRecord && input.chain.issuerTaxId !== input.issuer.taxId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["chain", "issuerTaxId"], message: "El registro anterior debe pertenecer al mismo emisor." });
  }
  const expectedHash = calculateAeatAnulacionHash({
    cancelledIssuerTaxId: input.issuer.taxId,
    cancelledInvoiceNumber: input.cancelledInvoiceNumber,
    cancelledIssueDate: input.cancelledIssueDate,
    previousHash: input.chain.firstRecord ? null : input.chain.hash,
    generatedAtWithOffset: input.generatedAtWithOffset
  });
  if (input.hash !== expectedHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["hash"], message: "La huella no corresponde al contenido del registro." });
  }
});

export type AeatAnulacionXmlInput = z.infer<typeof aeatAnulacionXmlSchema>;

export function buildAeatAnulacionXml(rawInput: AeatAnulacionXmlInput): string {
  const input = aeatAnulacionXmlSchema.parse(rawInput);
  const sf = (name: string, value: string) => `<sf:${name}>${escapeXml(value)}</sf:${name}>`;
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
    "<sfLR:RegistroFactura><sf:RegistroAnulacion>",
    sf("IDVersion", "1.0"),
    `<sf:IDFactura>${sf("IDEmisorFacturaAnulada", input.issuer.taxId)}${sf("NumSerieFacturaAnulada", input.cancelledInvoiceNumber)}${sf("FechaExpedicionFacturaAnulada", input.cancelledIssueDate)}</sf:IDFactura>`,
    chain,
    `<sf:SistemaInformatico>${sf("NombreRazon", input.system.producerName)}${sf("NIF", input.system.producerTaxId)}${sf("NombreSistemaInformatico", input.system.systemName)}${sf("IdSistemaInformatico", input.system.systemId)}${sf("Version", input.system.version)}${sf("NumeroInstalacion", input.system.installationNumber)}${sf("TipoUsoPosibleSoloVerifactu", "S")}${sf("TipoUsoPosibleMultiOT", "N")}${sf("IndicadorMultiplesOT", "N")}</sf:SistemaInformatico>`,
    sf("FechaHoraHusoGenRegistro", input.generatedAtWithOffset),
    sf("TipoHuella", "01"),
    sf("Huella", input.hash),
    "</sf:RegistroAnulacion></sfLR:RegistroFactura>",
    "</sfLR:RegFactuSistemaFacturacion>"
  ].join("");
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
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
