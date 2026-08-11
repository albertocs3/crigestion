import "server-only";

import path from "node:path";
import sharp from "sharp";

export const incidentAttachmentMaxBytes = 16 * 1024 * 1024;
const maximumImagePixels = 40_000_000;
const maximumPdfObjects = 100_000;

export type PreparedIncidentAttachment = {
  bytes: Buffer;
  originalFileName: string;
  extension: "jpg" | "pdf";
  mediaType: "image/jpeg" | "application/pdf";
};

export class IncidentAttachmentValidationError extends Error {
  constructor(
    readonly code:
      | "SUPPORT_ATTACHMENT_INVALID_NAME"
      | "SUPPORT_ATTACHMENT_TOO_LARGE"
      | "SUPPORT_ATTACHMENT_UNSUPPORTED_MEDIA_TYPE"
      | "SUPPORT_ATTACHMENT_CONTENT_INVALID",
  ) {
    super(code);
  }
}

export async function prepareIncidentAttachment(input: {
  bytes: Buffer;
  originalFileName: string;
  declaredMimeType: string;
}): Promise<PreparedIncidentAttachment> {
  const originalFileName = normalizeOriginalFileName(input.originalFileName);
  assertSize(input.bytes);
  const extension = readExtension(originalFileName);
  const mediaType = extension === "jpg" ? "image/jpeg" : "application/pdf";
  if (input.declaredMimeType !== mediaType) {
    throw new IncidentAttachmentValidationError(
      "SUPPORT_ATTACHMENT_UNSUPPORTED_MEDIA_TYPE",
    );
  }

  if (extension === "pdf") {
    validatePdf(input.bytes);
    return { bytes: Buffer.from(input.bytes), originalFileName, extension, mediaType };
  }

  try {
    const decoder = sharp(input.bytes, {
      animated: false,
      failOn: "warning",
      limitInputPixels: maximumImagePixels,
    });
    const metadata = await decoder.metadata();
    if (
      metadata.format !== "jpeg" ||
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) !== 1 ||
      metadata.width * metadata.height > maximumImagePixels
    ) {
      throw new IncidentAttachmentValidationError(
        "SUPPORT_ATTACHMENT_CONTENT_INVALID",
      );
    }
    const bytes = await decoder
      .rotate()
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
    assertSize(bytes);
    return { bytes, originalFileName, extension, mediaType };
  } catch (error) {
    if (error instanceof IncidentAttachmentValidationError) throw error;
    throw new IncidentAttachmentValidationError(
      "SUPPORT_ATTACHMENT_CONTENT_INVALID",
    );
  }
}

function normalizeOriginalFileName(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length < 1 ||
    Buffer.byteLength(normalized, "utf8") > 255 ||
    path.basename(normalized) !== normalized ||
    /[\\/\u0000-\u001f\u007f]/.test(normalized) ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new IncidentAttachmentValidationError(
      "SUPPORT_ATTACHMENT_INVALID_NAME",
    );
  }
  return normalized;
}

function readExtension(fileName: string): "jpg" | "pdf" {
  const extension = path.extname(fileName).toLocaleLowerCase("en-US");
  if (extension === ".jpg" || extension === ".jpeg") return "jpg";
  if (extension === ".pdf") return "pdf";
  throw new IncidentAttachmentValidationError(
    "SUPPORT_ATTACHMENT_UNSUPPORTED_MEDIA_TYPE",
  );
}

function assertSize(bytes: Buffer): void {
  if (bytes.byteLength < 1 || bytes.byteLength > incidentAttachmentMaxBytes) {
    throw new IncidentAttachmentValidationError("SUPPORT_ATTACHMENT_TOO_LARGE");
  }
}

function validatePdf(bytes: Buffer): void {
  const header = bytes.subarray(0, Math.min(bytes.length, 1024)).toString("latin1");
  const tail = bytes.subarray(Math.max(0, bytes.length - 4096)).toString("latin1");
  if (!/^%PDF-1\.[0-7](?:\r\n|\r|\n)/.test(header) || !/%%EOF[\x00\x09\x0a\x0c\x0d\x20]*$/.test(tail)) {
    throw new IncidentAttachmentValidationError(
      "SUPPORT_ATTACHMENT_CONTENT_INVALID",
    );
  }
  const text = bytes.toString("latin1");
  const forbidden = /\/(?:Encrypt|JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA|AcroForm)\b/;
  const objectCount = text.match(/\b\d+\s+\d+\s+obj\b/g)?.length ?? 0;
  const eofCount = text.match(/%%EOF/g)?.length ?? 0;
  const startXref = /startxref\s+(\d+)\s+%%EOF[\x00\x09\x0a\x0c\x0d\x20]*$/.exec(text);
  const xrefOffset = startXref ? Number(startXref[1]) : Number.NaN;
  if (
    forbidden.test(text) ||
    /\/[A-Za-z0-9]*#[0-9A-Fa-f]{2}/.test(text) ||
    /\/(?:ObjStm|XRef)\b/.test(text) ||
    eofCount !== 1 ||
    objectCount < 1 ||
    objectCount > maximumPdfObjects ||
    !Number.isSafeInteger(xrefOffset) ||
    xrefOffset < 0 ||
    xrefOffset >= bytes.length
  ) {
    throw new IncidentAttachmentValidationError(
      "SUPPORT_ATTACHMENT_CONTENT_INVALID",
    );
  }
  const xrefTarget = text.slice(xrefOffset, xrefOffset + 128);
  if (!/^xref\b/.test(xrefTarget)) {
    throw new IncidentAttachmentValidationError(
      "SUPPORT_ATTACHMENT_CONTENT_INVALID",
    );
  }
}
