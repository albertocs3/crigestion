import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";
import { getBillingConfiguration } from "@/modules/billing/application/configuration";
import {
  getInvoiceDetail,
  type InvoiceDetail
} from "@/modules/billing/application/invoices";
import { getPlatformConfiguration } from "@/modules/platform/application/configuration";

const pageWidth = 595.28;
const pageHeight = 841.89;
const centimetersToPoints = 72 / 2.54;
const regularFont = "F1";
const boldFont = "F2";
const invoiceImagePath =
  "C:\\Users\\USER\\iCloudDrive\\Documents\\IA\\M\u00e1ster IA\\mockup\\logo_con_datos_fiscales.jpg";
const verifactuQrSize = cm(3.5);

export type InvoicePdfResult =
  | {
      ok: true;
      status: 200;
      value: {
        bytes: Uint8Array;
        filename: string;
      };
    }
  | {
      ok: false;
      status: 404 | 409;
      error: {
        code:
          | "CONFIGURATION_NOT_FOUND"
          | "INVOICE_NOT_FOUND"
          | "INVOICE_PDF_NOT_AVAILABLE";
        message: string;
      };
    };

type PdfCompany = {
  legalName: string;
  taxId: string;
  email: string | null;
};

type PdfConfiguration = {
  invoiceLegalFooter: string;
  invoiceAccentColor: string;
};

type JpegImage = {
  data: Buffer;
  width: number;
  height: number;
};

export async function generateInvoicePdf(
  invoiceId: string,
  actor: SessionUser
): Promise<InvoicePdfResult> {
  const [invoice, platformConfiguration, billingConfiguration] = await Promise.all([
    getInvoiceDetail(invoiceId, actor),
    getPlatformConfiguration(),
    getBillingConfiguration()
  ]);

  if (!invoice) {
    return {
      ok: false,
      status: 404,
      error: {
        code: "INVOICE_NOT_FOUND",
        message: "La factura no existe."
      }
    };
  }

  if (invoice.status === "DRAFT") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "INVOICE_PDF_NOT_AVAILABLE",
        message: "El PDF solo esta disponible para facturas emitidas."
      }
    };
  }

  if (!platformConfiguration) {
    return {
      ok: false,
      status: 404,
      error: {
        code: "CONFIGURATION_NOT_FOUND",
        message: "La configuracion de plataforma no existe."
      }
    };
  }

  const bytes = renderInvoicePdf({
    invoice,
    company: platformConfiguration.company,
    configuration: billingConfiguration
  });

  await prisma.auditEvent.create({
    data: {
      eventType: "INVOICE_PDF_DOWNLOADED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        invoiceId: invoice.id,
        number: invoice.number
      }
    }
  });

  return {
    ok: true,
    status: 200,
    value: {
      bytes,
      filename: `${invoice.number ?? invoice.id}.pdf`
    }
  };
}

function renderInvoicePdf({
  invoice,
  company,
  configuration
}: {
  invoice: InvoiceDetail;
  company: PdfCompany;
  configuration: PdfConfiguration;
}): Uint8Array {
  const document = new PdfDocument();
  const issuerImage = loadIssuerImage();
  const issuerImageName = issuerImage ? document.addJpegImage(issuerImage) : null;
  const linesPerFirstPage = 8;
  const linesPerNextPage = 20;
  const chunks = chunkInvoiceLines(invoice.lines, linesPerFirstPage, linesPerNextPage);

  chunks.forEach((lines, pageIndex) => {
    const isFirstPage = pageIndex === 0;
    const isLastPage = pageIndex === chunks.length - 1;
    const content = new PdfPageContent();
    const footerLines = wrapText(
      configuration.invoiceLegalFooter.trim() ||
        "Factura generada por CriGestion.",
      95
    );

    drawHeader(
      content,
      invoice,
      company,
      configuration,
      pageIndex + 1,
      chunks.length,
      issuerImageName
    );
    drawCustomerBox(content, invoice, configuration);
    drawLinesTable(content, lines, isFirstPage ? 10 : 6.5, configuration);

    if (isLastPage) {
      drawTaxSummary(content, invoice, 19, configuration);
      drawTotals(content, invoice, 19, configuration);
      drawDueDates(content, invoice, 22, configuration);
    }

    drawFooter(content, footerLines);
    document.addPage(content.toString());
  });

  return document.toUint8Array();
}

function drawHeader(
  content: PdfPageContent,
  invoice: InvoiceDetail,
  company: PdfCompany,
  configuration: PdfConfiguration,
  pageNumber: number,
  pageCount: number,
  issuerImageName: string | null
): void {
  const accent = rgb(configuration.invoiceAccentColor);

  if (issuerImageName) {
    content.image(issuerImageName, cm(1.5), yFromTop(1.5, 4.5), cm(9), cm(4.5));
  } else {
    content.rect(cm(1.5), yFromTop(1.5, 4.5), cm(9), cm(4.5), {
      stroke: accent,
      lineWidth: 1.2
    });
    content.text("IMAGEN LOGO CON", cm(2.7), yText(3.25), 15, regularFont, accent);
    content.text("DATOS FISCALES", cm(2.7), yText(3.95), 15, regularFont, accent);
  }

  if (pageNumber === 1) {
    drawVerifactuQr(content, configuration);
  }

  content.rect(cm(1.5), yFromTop(6.5, 3), cm(8), cm(3), {
    fill: lighten(accent, 0.9)
  });
  content.rect(cm(1.5), yFromTop(6.5, 3), cm(8), cm(3), {
    stroke: accent,
    lineWidth: 0.8
  });
  content.text(invoiceTitle(invoice), cm(1.95), yText(7.15), 13, boldFont, accent);
  content.text(`Numero: ${invoice.number ?? "-"}`, cm(1.95), yText(7.85), 10, boldFont);
  content.text(`Fecha: ${formatDate(invoice.issueDate)}`, cm(1.95), yText(8.55), 10);
  content.text(`Operacion: ${formatDate(invoice.operationDate)}`, cm(1.95), yText(9.25), 10);
  content.text(`Pagina ${pageNumber} de ${pageCount}`, 480, 812, 8, regularFont, [0.35, 0.35, 0.35]);
}

function drawVerifactuQr(
  content: PdfPageContent,
  configuration: PdfConfiguration
): void {
  const accent = rgb(configuration.invoiceAccentColor);
  const x = cm(13.25);
  const y = yFromTop(1.5, 3.5);
  const centerX = x + verifactuQrSize / 2;
  const centerY = y + verifactuQrSize / 2;

  content.rect(x, y, verifactuQrSize, verifactuQrSize, {
    stroke: accent,
    lineWidth: 1.2
  });
  content.text("QR", centerX - 8, centerY - 4, 14, boldFont, accent);

  content.text(
    "Factura verificable en la sede electronica de la AEAT",
    cm(10.95),
    yText(5.65),
    8,
    regularFont,
    isRealVerifactuMode() ? [0.05, 0.09, 0.16] : [0.7, 0.7, 0.7]
  );
}

function drawCustomerBox(
  content: PdfPageContent,
  invoice: InvoiceDetail,
  configuration: PdfConfiguration
): void {
  const accent = rgb(configuration.invoiceAccentColor);
  const addressLines = fiscalAddressLines(invoice.customerSnapshot.fiscalAddress);
  const rightX = cm(19.05);
  const maxTextWidth = cm(5.9);

  content.rect(cm(11.5), yFromTop(6.5, 3), cm(8), cm(3), {
    fill: lighten(accent, 0.9)
  });
  content.rect(cm(11.5), yFromTop(6.5, 3), cm(8), cm(3), {
    stroke: accent,
    lineWidth: 0.8
  });
  content.textRight("CLIENTE", rightX, yText(7.05), 10, boldFont, accent);
  content.textRight(
    fitText(invoice.customerSnapshot.legalName, 11, maxTextWidth, boldFont),
    rightX,
    yText(7.55),
    11,
    boldFont
  );
  content.textRight(`NIF: ${invoice.customerSnapshot.taxId}`, rightX, yText(8), 10);
  addressLines.slice(0, 2).forEach((line, index) => {
    content.textRight(
      fitText(line, 10, maxTextWidth),
      rightX,
      yText(8.45 + index * 0.45),
      10
    );
  });
}

function drawLinesTable(
  content: PdfPageContent,
  lines: InvoiceDetail["lines"],
  topCm: number,
  configuration: PdfConfiguration
): void {
  const accent = rgb(configuration.invoiceAccentColor);
  const x = cm(1.5);
  const width = cm(18);
  const headerHeight = cm(0.8);
  const rowHeight = cm(0.85);
  const headerY = yFromTop(topCm, 0.8);
  const columns = [
    { x: cm(1.75), label: "Concepto" },
    { x: cm(10.05), label: "Cant." },
    { x: cm(11.8), label: "Precio" },
    { x: cm(14.1), label: "Dto." },
    { x: cm(15.9), label: "IVA" },
    { x: cm(17.7), label: "Total" }
  ];

  content.rect(x, headerY, width, headerHeight, { fill: accent });
  columns.forEach((column) => content.text(column.label, column.x, yText(topCm + 0.47), 8, boldFont, [1, 1, 1]));

  let rowTop = topCm + 0.8;
  lines.forEach((line, index) => {
    const rowY = yFromTop(rowTop, 0.85);
    const baseline = yText(rowTop + 0.52);
    if (index % 2 === 0) {
      content.rect(x, rowY, width, rowHeight, { fill: [0.97, 0.98, 0.98] });
    }
    content.text(truncate(line.description, 42), cm(1.75), baseline, 8);
    content.text(trimDecimal(line.quantity), cm(10.2), baseline, 8);
    content.text(formatMoney(line.unitPrice), cm(11.55), baseline, 8);
    content.text(`${trimDecimal(line.discountPercent)}%`, cm(14.25), baseline, 8);
    content.text(`${trimDecimal(line.taxRate.rate)}%`, cm(16.05), baseline, 8);
    content.text(formatMoney(line.totals.total), cm(17.45), baseline, 8, boldFont);
    rowTop += 0.85;
  });

  content.line(x, yFromTop(rowTop, 0), x + width, yFromTop(rowTop, 0), [0.75, 0.78, 0.8], 0.5);
}

function drawTaxSummary(
  content: PdfPageContent,
  invoice: InvoiceDetail,
  topCm: number,
  configuration: PdfConfiguration
): void {
  const accent = rgb(configuration.invoiceAccentColor);
  const x = cm(1.5);
  content.text("Desglose fiscal", x, yText(topCm + 0.15), 10, boldFont, accent);
  content.rect(x, yFromTop(topCm + 0.35, 0.75), cm(8), cm(0.75), { fill: accent });
  content.text("IVA", cm(1.75), yText(topCm + 0.85), 8, boldFont, [1, 1, 1]);
  content.text("Base", cm(3.55), yText(topCm + 0.85), 8, boldFont, [1, 1, 1]);
  content.text("Cuota", cm(6), yText(topCm + 0.85), 8, boldFont, [1, 1, 1]);
  content.text("Total", cm(8.2), yText(topCm + 0.85), 8, boldFont, [1, 1, 1]);

  invoice.taxSummary.forEach((summary, index) => {
    const y = yText(topCm + 1.45 + index * 0.65);
    content.text(`${trimDecimal(summary.taxRate)}%`, cm(1.75), y, 8);
    content.text(formatMoney(summary.taxableBase), cm(3.2), y, 8);
    content.text(formatMoney(summary.taxAmount), cm(5.75), y, 8);
    content.text(formatMoney(summary.total), cm(7.55), y, 8);
  });
}

function drawTotals(
  content: PdfPageContent,
  invoice: InvoiceDetail,
  topCm: number,
  configuration: PdfConfiguration
): void {
  const accent = rgb(configuration.invoiceAccentColor);
  const x = cm(13);

  content.rect(x, yFromTop(topCm, 3), cm(6.5), cm(3), { fill: lighten(accent, 0.9) });
  content.rect(x, yFromTop(topCm, 3), cm(6.5), cm(3), { stroke: accent, lineWidth: 0.8 });
  drawTotalLine(content, "Base imponible", invoice.totals.taxableBase, x + cm(0.3), yText(topCm + 0.7));
  drawTotalLine(content, "Descuento", invoice.totals.discountTotal, x + cm(0.3), yText(topCm + 1.35));
  drawTotalLine(content, "IVA", invoice.totals.taxAmount, x + cm(0.3), yText(topCm + 2));
  content.text("TOTAL", x + cm(0.3), yText(topCm + 2.65), 10, boldFont, accent);
  content.text(formatMoney(invoice.totals.total), x + cm(3.45), yText(topCm + 2.65), 11, boldFont, accent);
}

function drawDueDates(
  content: PdfPageContent,
  invoice: InvoiceDetail,
  topCm: number,
  configuration: PdfConfiguration
): void {
  const accent = rgb(configuration.invoiceAccentColor);
  content.text("Vencimientos", cm(1.5), yText(topCm + 0.25), 10, boldFont, accent);
  invoice.dueDates.forEach((dueDate, index) => {
    const rowY = yText(topCm + 0.9 + index * 0.55);
    content.text(formatDate(dueDate.dueDate), cm(1.5), rowY, 8);
    content.text(formatMoney(dueDate.amount), cm(4.45), rowY, 8, boldFont);
    content.text(paymentMethodLabel(dueDate.paymentMethod), cm(7.2), rowY, 8);
  });
}

function drawFooter(content: PdfPageContent, footerLines: string[]): void {
  content.line(cm(1.5), yFromTop(28.2, 0), cm(19.5), yFromTop(28.2, 0), [0.8, 0.82, 0.84], 0.5);
  footerLines.slice(0, 4).forEach((line, index) => {
    content.text(line, cm(1.5), yText(25.25 + index * 0.35), 8, regularFont, [0.05, 0.09, 0.16]);
  });
}

function drawTotalLine(
  content: PdfPageContent,
  label: string,
  amount: string,
  x: number,
  y: number
): void {
  content.text(label, x, y, 8);
  content.text(formatMoney(amount), x + cm(3.35), y, 8, boldFont);
}

function chunkInvoiceLines(
  lines: InvoiceDetail["lines"],
  firstPageSize: number,
  nextPageSize: number
): Array<InvoiceDetail["lines"]> {
  if (lines.length <= firstPageSize) {
    return [lines];
  }

  const chunks = [lines.slice(0, firstPageSize)];
  let index = firstPageSize;

  while (index < lines.length) {
    chunks.push(lines.slice(index, index + nextPageSize));
    index += nextPageSize;
  }

  return chunks;
}

function invoiceTitle(invoice: InvoiceDetail): string {
  if (invoice.status === "RECTIFIED") {
    return "Factura rectificativa";
  }

  return "Factura";
}

function fiscalAddressLines(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const address = value as {
    line1?: unknown;
    postalCode?: unknown;
    city?: unknown;
    province?: unknown;
    country?: unknown;
  };
  const line1 = stringOrEmpty(address.line1);
  const locality = [
    stringOrEmpty(address.postalCode),
    stringOrEmpty(address.city),
    stringOrEmpty(address.province)
  ]
    .filter(Boolean)
    .join(" ");
  const country = stringOrEmpty(address.country);

  return [line1, locality, country].filter(Boolean);
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function paymentMethodLabel(
  method: InvoiceDetail["dueDates"][number]["paymentMethod"]
): string {
  switch (method) {
    case "BANK_TRANSFER":
      return "Transferencia";
    case "CASH":
      return "Contado";
    case "DIRECT_DEBIT":
      return "Domiciliacion";
  }
}

function formatDate(value: string): string {
  const [year, month, day] = value.split("-");

  return `${day}/${month}/${year}`;
}

function formatMoney(value: string): string {
  const amount = Number(value);

  return new Intl.NumberFormat("es-ES", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number.isFinite(amount) ? amount : 0) + " EUR";
}

function trimDecimal(value: string): string {
  return value.replace(/\.?0+$/, "");
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}.`;
}

function fitText(
  value: string,
  size: number,
  maxWidth: number,
  font = regularFont
): string {
  const text = normalizePdfText(value);

  if (estimateTextWidth(text, size, font) <= maxWidth) {
    return text;
  }

  let fitted = text;

  while (fitted.length > 1 && estimateTextWidth(`${fitted}.`, size, font) > maxWidth) {
    fitted = fitted.slice(0, -1);
  }

  return `${fitted}.`;
}

function wrapText(value: string, maxCharacters: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  words.forEach((word) => {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxCharacters && current) {
      lines.push(current);
      current = word;
      return;
    }
    current = next;
  });

  if (current) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}

function rgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#0f766e";

  return [
    Number.parseInt(normalized.slice(1, 3), 16) / 255,
    Number.parseInt(normalized.slice(3, 5), 16) / 255,
    Number.parseInt(normalized.slice(5, 7), 16) / 255
  ];
}

function lighten(
  color: [number, number, number],
  amount: number
): [number, number, number] {
  return color.map((channel) => channel + (1 - channel) * amount) as [
    number,
    number,
    number
  ];
}

function isRealVerifactuMode(): boolean {
  const enabled = process.env.VERIFACTU_ENABLED === "true";
  const environment = process.env.VERIFACTU_ENVIRONMENT?.trim().toLowerCase();

  return enabled && (environment === "real" || environment === "production");
}

function loadIssuerImage(): JpegImage | null {
  if (!existsSync(invoiceImagePath)) {
    return null;
  }

  const data = readFileSync(invoiceImagePath);
  const dimensions = readJpegDimensions(data);

  if (!dimensions) {
    return null;
  }

  return {
    data,
    width: dimensions.width,
    height: dimensions.height
  };
}

function readJpegDimensions(data: Buffer): { width: number; height: number } | null {
  let offset = 2;

  if (data[0] !== 0xff || data[1] !== 0xd8) {
    return null;
  }

  while (offset < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = data[offset + 1];
    const length = data.readUInt16BE(offset + 2);

    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: data.readUInt16BE(offset + 5),
        width: data.readUInt16BE(offset + 7)
      };
    }

    offset += 2 + length;
  }

  return null;
}

function cm(value: number): number {
  return value * centimetersToPoints;
}

function yFromTop(topCm: number, heightCm: number): number {
  return pageHeight - cm(topCm) - cm(heightCm);
}

function yText(topCm: number): number {
  return pageHeight - cm(topCm);
}

class PdfPageContent {
  private readonly operations: string[] = [];

  text(
    value: string,
    x: number,
    y: number,
    size: number,
    font = regularFont,
    color: [number, number, number] = [0.05, 0.09, 0.16]
  ): void {
    this.operations.push(
      `BT ${colorCommand(color)} /${font} ${size} Tf 1 0 0 1 ${number(x)} ${number(y)} Tm ${pdfText(value)} Tj ET`
    );
  }

  textRight(
    value: string,
    rightX: number,
    y: number,
    size: number,
    font = regularFont,
    color: [number, number, number] = [0.05, 0.09, 0.16]
  ): void {
    const text = normalizePdfText(value);
    const width = estimateTextWidth(text, size, font);

    this.text(text, rightX - width, y, size, font, color);
  }

  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: [number, number, number],
    lineWidth: number
  ): void {
    this.operations.push(
      `${colorCommand(color, "RG")} ${number(lineWidth)} w ${number(x1)} ${number(y1)} m ${number(x2)} ${number(y2)} l S`
    );
  }

  rect(
    x: number,
    y: number,
    width: number,
    height: number,
    options: {
      fill?: [number, number, number];
      stroke?: [number, number, number];
      lineWidth?: number;
    }
  ): void {
    if (options.fill) {
      this.operations.push(
        `${colorCommand(options.fill)} ${number(x)} ${number(y)} ${number(width)} ${number(height)} re f`
      );
    }

    if (options.stroke) {
      this.operations.push(
        `${colorCommand(options.stroke, "RG")} ${number(options.lineWidth ?? 1)} w ${number(x)} ${number(y)} ${number(width)} ${number(height)} re S`
      );
    }
  }

  image(name: string, x: number, y: number, width: number, height: number): void {
    this.operations.push(
      `q ${number(width)} 0 0 ${number(height)} ${number(x)} ${number(y)} cm /${name} Do Q`
    );
  }

  toString(): string {
    return this.operations.join("\n");
  }
}

class PdfDocument {
  private readonly objects = new Map<number, string | Buffer>();
  private readonly pageIds: number[] = [];
  private readonly imageResources = new Map<string, number>();
  private nextObjectId = 1;
  private readonly catalogObjectId = this.reserveObject();
  private readonly pagesObjectId = this.reserveObject();
  private readonly regularFontObjectId = this.reserveObject();
  private readonly boldFontObjectId = this.reserveObject();

  constructor() {
    this.objects.set(
      this.catalogObjectId,
      `<< /Type /Catalog /Pages ${this.pagesObjectId} 0 R >>`
    );
    this.objects.set(
      this.regularFontObjectId,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    );
    this.objects.set(
      this.boldFontObjectId,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"
    );
  }

  addJpegImage(image: JpegImage): string {
    const imageName = `Im${this.imageResources.size + 1}`;
    const objectId = this.reserveObject();
    const header = [
      `<< /Type /XObject /Subtype /Image /Width ${image.width}`,
      `/Height ${image.height}`,
      "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
      `/Length ${image.data.length} >>`,
      "stream\n"
    ].join(" ");
    const object = Buffer.concat([
      Buffer.from(header, "binary"),
      image.data,
      Buffer.from("\nendstream", "binary")
    ]);

    this.objects.set(objectId, object);
    this.imageResources.set(imageName, objectId);

    return imageName;
  }

  addPage(content: string): void {
    const contentObjectId = this.reserveObject();
    const pageObjectId = this.reserveObject();

    this.objects.set(
      contentObjectId,
      `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`
    );
    this.objects.set(
      pageObjectId,
      [
        "<< /Type /Page",
        `/Parent ${this.pagesObjectId} 0 R`,
        `/MediaBox [0 0 ${pageWidth} ${pageHeight}]`,
        `/Resources << /Font << /${regularFont} ${this.regularFontObjectId} 0 R /${boldFont} ${this.boldFontObjectId} 0 R >>${this.imageResourceDictionary()} >>`,
        `/Contents ${contentObjectId} 0 R`,
        ">>"
      ].join(" ")
    );
    this.pageIds.push(pageObjectId);
  }

  toUint8Array(): Uint8Array {
    this.objects.set(
      this.pagesObjectId,
      `<< /Type /Pages /Kids [${this.pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${this.pageIds.length} >>`
    );

    const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n", "binary")];
    const offsets = [0];
    let offset = chunks[0].length;

    Array.from(this.objects.keys())
      .sort((left, right) => left - right)
      .forEach((objectId) => {
        const object = this.objects.get(objectId) ?? "";
        const objectBuffer = typeof object === "string"
          ? Buffer.from(object, "binary")
          : object;
        const chunk = Buffer.concat([
          Buffer.from(`${objectId} 0 obj\n`, "binary"),
          objectBuffer,
          Buffer.from("\nendobj\n", "binary")
        ]);

        offsets[objectId] = offset;
        chunks.push(chunk);
        offset += chunk.length;
      });

    const xrefOffset = offset;
    chunks.push(Buffer.from(`xref\n0 ${this.nextObjectId}\n`, "binary"));
    chunks.push(Buffer.from("0000000000 65535 f \n", "binary"));

    for (let objectId = 1; objectId < this.nextObjectId; objectId += 1) {
      chunks.push(Buffer.from(`${String(offsets[objectId] ?? 0).padStart(10, "0")} 00000 n \n`, "binary"));
    }

    chunks.push(Buffer.from(
      `trailer\n<< /Size ${this.nextObjectId} /Root ${this.catalogObjectId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`,
      "binary"
    ));

    return Buffer.concat(chunks);
  }

  private reserveObject(): number {
    const objectId = this.nextObjectId;
    this.nextObjectId += 1;

    return objectId;
  }

  private imageResourceDictionary(): string {
    if (this.imageResources.size === 0) {
      return "";
    }

    const entries = Array.from(this.imageResources.entries())
      .map(([name, objectId]) => `/${name} ${objectId} 0 R`)
      .join(" ");

    return ` /XObject << ${entries} >>`;
  }
}

function colorCommand(
  color: [number, number, number],
  operator: "rg" | "RG" = "rg"
): string {
  return `${number(color[0])} ${number(color[1])} ${number(color[2])} ${operator}`;
}

function pdfText(value: string): string {
  return `(${escapePdfText(normalizePdfText(value))})`;
}

function normalizePdfText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "?");
}

function escapePdfText(value: string): string {
  return value.replace(/[\\()]/g, (character) => `\\${character}`);
}

function estimateTextWidth(value: string, size: number, font: string): number {
  const boldFactor = font === boldFont ? 0.58 : 0.52;

  return normalizePdfText(value).length * size * boldFactor;
}

function number(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(3);
}
