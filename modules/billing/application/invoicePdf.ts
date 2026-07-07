import "server-only";

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
const margin = 42;
const regularFont = "F1";
const boldFont = "F2";
const millimetersToPoints = 72 / 25.4;
const verifactuQrSize = 35 * millimetersToPoints;

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
  const linesPerFirstPage = 13;
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

    drawHeader(content, invoice, company, configuration, pageIndex + 1, chunks.length);
    drawCustomerBox(content, invoice, configuration);
    const tableBottomY = drawLinesTable(content, lines, isFirstPage ? 510 : 650, configuration);

    if (isLastPage) {
      drawTaxSummary(content, invoice, Math.min(tableBottomY - 32, 330), configuration);
      drawTotals(content, invoice, Math.min(tableBottomY - 32, 330), configuration);
      drawDueDates(content, invoice, 205, configuration);
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
  pageCount: number
): void {
  const accent = rgb(configuration.invoiceAccentColor);

  content.rect(margin, 748, 92, 50, { stroke: accent, lineWidth: 1.2 });
  content.text("LOGO", margin + 25, 774, 15, boldFont, accent);

  if (pageNumber === 1) {
    drawVerifactuQr(content, configuration);
  }

  content.text(company.legalName, margin, 718, 12, boldFont);
  content.text(`NIF: ${company.taxId}`, margin, 703, 9);
  if (company.email) {
    content.text(company.email, margin, 690, 9);
  }

  content.rect(298, 648, 140, 76, { fill: lighten(accent, 0.86) });
  content.rect(298, 648, 140, 76, { stroke: accent, lineWidth: 1 });
  content.text(invoiceTitle(invoice), 312, 704, 14, boldFont, accent);
  content.text(`Numero: ${invoice.number ?? "-"}`, 312, 686, 9, boldFont);
  content.text(`Fecha: ${formatDate(invoice.issueDate)}`, 312, 671, 9);
  content.text(`Operacion: ${formatDate(invoice.operationDate)}`, 312, 656, 9);
  content.text(`Pagina ${pageNumber} de ${pageCount}`, 480, 812, 8, regularFont, [0.35, 0.35, 0.35]);
}

function drawVerifactuQr(
  content: PdfPageContent,
  configuration: PdfConfiguration
): void {
  const accent = rgb(configuration.invoiceAccentColor);
  const x = pageWidth - margin - verifactuQrSize;
  const y = pageHeight - margin - verifactuQrSize;
  const centerX = x + verifactuQrSize / 2;
  const centerY = y + verifactuQrSize / 2;

  content.rect(x, y, verifactuQrSize, verifactuQrSize, {
    stroke: accent,
    lineWidth: 1.2
  });
  content.text("QR", centerX - 8, centerY - 4, 14, boldFont, accent);

  if (!isRealVerifactuMode()) {
    return;
  }

  content.text(
    "Factura verificable en la sede",
    x - 4,
    y - 13,
    7,
    regularFont,
    [0.35, 0.35, 0.35]
  );
  content.text(
    "electronica de la AEAT",
    x + 14,
    y - 23,
    7,
    regularFont,
    [0.35, 0.35, 0.35]
  );
}

function drawCustomerBox(
  content: PdfPageContent,
  invoice: InvoiceDetail,
  configuration: PdfConfiguration
): void {
  const accent = rgb(configuration.invoiceAccentColor);
  const addressLines = fiscalAddressLines(invoice.customerSnapshot.fiscalAddress);

  content.rect(margin, 565, 511, 80, { fill: lighten(accent, 0.9) });
  content.rect(margin, 565, 511, 80, { stroke: accent, lineWidth: 0.8 });
  content.text("CLIENTE", margin + 14, 625, 8, boldFont, accent);
  content.text(invoice.customerSnapshot.legalName, margin + 14, 606, 12, boldFont);
  content.text(`NIF: ${invoice.customerSnapshot.taxId}`, margin + 14, 589, 9);
  addressLines.slice(0, 2).forEach((line, index) => {
    content.text(line, 285, 606 - index * 15, 9);
  });
}

function drawLinesTable(
  content: PdfPageContent,
  lines: InvoiceDetail["lines"],
  topY: number,
  configuration: PdfConfiguration
): number {
  const accent = rgb(configuration.invoiceAccentColor);
  const columns = [
    { x: margin + 8, label: "Concepto" },
    { x: 284, label: "Cant." },
    { x: 334, label: "Precio" },
    { x: 395, label: "Dto." },
    { x: 448, label: "IVA" },
    { x: 500, label: "Total" }
  ];

  content.rect(margin, topY, 511, 22, { fill: accent });
  columns.forEach((column) => content.text(column.label, column.x, topY + 7, 8, boldFont, [1, 1, 1]));

  let y = topY - 20;
  lines.forEach((line, index) => {
    if (index % 2 === 0) {
      content.rect(margin, y - 4, 511, 20, { fill: [0.97, 0.98, 0.98] });
    }
    content.text(truncate(line.description, 42), margin + 8, y + 2, 8);
    content.text(trimDecimal(line.quantity), 288, y + 2, 8);
    content.text(formatMoney(line.unitPrice), 326, y + 2, 8);
    content.text(`${trimDecimal(line.discountPercent)}%`, 400, y + 2, 8);
    content.text(`${trimDecimal(line.taxRate.rate)}%`, 452, y + 2, 8);
    content.text(formatMoney(line.totals.total), 494, y + 2, 8, boldFont);
    y -= 20;
  });

  content.line(margin, y + 14, 553, y + 14, [0.75, 0.78, 0.8], 0.5);

  return y;
}

function drawTaxSummary(
  content: PdfPageContent,
  invoice: InvoiceDetail,
  topY: number,
  configuration: PdfConfiguration
): void {
  const accent = rgb(configuration.invoiceAccentColor);
  content.text("Desglose fiscal", margin, topY + 18, 10, boldFont, accent);
  content.rect(margin, topY - 4, 235, 20, { fill: accent });
  content.text("IVA", margin + 8, topY + 3, 8, boldFont, [1, 1, 1]);
  content.text("Base", margin + 58, topY + 3, 8, boldFont, [1, 1, 1]);
  content.text("Cuota", margin + 128, topY + 3, 8, boldFont, [1, 1, 1]);
  content.text("Total", margin + 190, topY + 3, 8, boldFont, [1, 1, 1]);

  invoice.taxSummary.forEach((summary, index) => {
    const y = topY - 22 - index * 18;
    content.text(`${trimDecimal(summary.taxRate)}%`, margin + 8, y, 8);
    content.text(formatMoney(summary.taxableBase), margin + 48, y, 8);
    content.text(formatMoney(summary.taxAmount), margin + 122, y, 8);
    content.text(formatMoney(summary.total), margin + 178, y, 8);
  });
}

function drawTotals(
  content: PdfPageContent,
  invoice: InvoiceDetail,
  topY: number,
  configuration: PdfConfiguration
): void {
  const accent = rgb(configuration.invoiceAccentColor);
  const x = 365;

  content.rect(x, topY - 58, 188, 84, { fill: lighten(accent, 0.9) });
  content.rect(x, topY - 58, 188, 84, { stroke: accent, lineWidth: 0.8 });
  drawTotalLine(content, "Base imponible", invoice.totals.taxableBase, x + 12, topY + 8);
  drawTotalLine(content, "Descuento", invoice.totals.discountTotal, x + 12, topY - 10);
  drawTotalLine(content, "IVA", invoice.totals.taxAmount, x + 12, topY - 28);
  content.text("TOTAL", x + 12, topY - 48, 10, boldFont, accent);
  content.text(formatMoney(invoice.totals.total), x + 103, topY - 48, 11, boldFont, accent);
}

function drawDueDates(
  content: PdfPageContent,
  invoice: InvoiceDetail,
  y: number,
  configuration: PdfConfiguration
): void {
  const accent = rgb(configuration.invoiceAccentColor);
  content.text("Vencimientos", margin, y + 18, 10, boldFont, accent);
  invoice.dueDates.forEach((dueDate, index) => {
    const rowY = y - index * 16;
    content.text(formatDate(dueDate.dueDate), margin, rowY, 8);
    content.text(formatMoney(dueDate.amount), margin + 82, rowY, 8, boldFont);
    content.text(paymentMethodLabel(dueDate.paymentMethod), margin + 160, rowY, 8);
  });
}

function drawFooter(content: PdfPageContent, footerLines: string[]): void {
  content.line(margin, 70, 553, 70, [0.8, 0.82, 0.84], 0.5);
  footerLines.slice(0, 4).forEach((line, index) => {
    content.text(line, margin, 55 - index * 10, 7, regularFont, [0.35, 0.35, 0.35]);
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
  content.text(formatMoney(amount), x + 95, y, 8, boldFont);
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
  return new Intl.DateTimeFormat("es-ES").format(new Date(`${value}T00:00:00.000Z`));
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

  toString(): string {
    return this.operations.join("\n");
  }
}

class PdfDocument {
  private readonly objects = new Map<number, string>();
  private readonly pageIds: number[] = [];
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
        `/Resources << /Font << /${regularFont} ${this.regularFontObjectId} 0 R /${boldFont} ${this.boldFontObjectId} 0 R >> >>`,
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

    const chunks: string[] = ["%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n"];
    const offsets = [0];

    Array.from(this.objects.keys())
      .sort((left, right) => left - right)
      .forEach((objectId) => {
        offsets[objectId] = Buffer.byteLength(chunks.join(""), "binary");
        chunks.push(`${objectId} 0 obj\n${this.objects.get(objectId) ?? ""}\nendobj\n`);
      });

    const xrefOffset = Buffer.byteLength(chunks.join(""), "binary");
    chunks.push(`xref\n0 ${this.nextObjectId}\n`);
    chunks.push("0000000000 65535 f \n");

    for (let objectId = 1; objectId < this.nextObjectId; objectId += 1) {
      chunks.push(`${String(offsets[objectId] ?? 0).padStart(10, "0")} 00000 n \n`);
    }

    chunks.push(
      `trailer\n<< /Size ${this.nextObjectId} /Root ${this.catalogObjectId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
    );

    return Buffer.from(chunks.join(""), "binary");
  }

  private reserveObject(): number {
    const objectId = this.nextObjectId;
    this.nextObjectId += 1;

    return objectId;
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

function number(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(3);
}
