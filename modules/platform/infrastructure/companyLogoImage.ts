import "server-only";

import sharp from "sharp";

export const companyLogoMaxBytes = 5_242_880;
const companyLogoMaxDimension = 4096;
const companyLogoMaxPixels = 16_000_000;

export class CompanyLogoValidationError extends Error {
  constructor(
    readonly code:
      | "COMPANY_LOGO_INVALID_NAME"
      | "COMPANY_LOGO_UNSUPPORTED_MEDIA_TYPE"
      | "COMPANY_LOGO_TOO_LARGE"
      | "COMPANY_LOGO_INVALID_IMAGE"
      | "COMPANY_LOGO_DIMENSIONS_EXCEEDED"
  ) {
    super(code);
  }
}

export type CanonicalCompanyLogo = {
  bytes: Buffer;
  originalFileName: string;
  extension: "png" | "jpg";
  mediaType: "image/png" | "image/jpeg";
  width: number;
  height: number;
};

export async function canonicalizeCompanyLogo(input: {
  bytes: Buffer;
  originalFileName: string;
  declaredMimeType: string;
}): Promise<CanonicalCompanyLogo> {
  const originalFileName = normalizeOriginalFileName(input.originalFileName);
  const extension = readExtension(originalFileName);
  const expectedMediaType = extension === "png" ? "image/png" : "image/jpeg";

  if (input.declaredMimeType !== expectedMediaType) {
    throw new CompanyLogoValidationError("COMPANY_LOGO_UNSUPPORTED_MEDIA_TYPE");
  }
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > companyLogoMaxBytes) {
    throw new CompanyLogoValidationError("COMPANY_LOGO_TOO_LARGE");
  }

  try {
    const decoder = sharp(input.bytes, {
      animated: false,
      failOn: "warning",
      limitInputPixels: companyLogoMaxPixels
    });
    const metadata = await decoder.metadata();
    if (
      metadata.format !== (extension === "jpg" ? "jpeg" : "png") ||
      !metadata.width ||
      !metadata.height ||
      (metadata.pages ?? 1) !== 1
    ) {
      throw new CompanyLogoValidationError("COMPANY_LOGO_INVALID_IMAGE");
    }
    if (
      metadata.width > companyLogoMaxDimension ||
      metadata.height > companyLogoMaxDimension ||
      metadata.width * metadata.height > companyLogoMaxPixels
    ) {
      throw new CompanyLogoValidationError("COMPANY_LOGO_DIMENSIONS_EXCEEDED");
    }

    const oriented = decoder.rotate();
    const bytes = extension === "png"
      ? await oriented.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
      : await oriented.flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();

    if (bytes.byteLength < 1 || bytes.byteLength > companyLogoMaxBytes) {
      bytes.fill(0);
      throw new CompanyLogoValidationError("COMPANY_LOGO_TOO_LARGE");
    }

    return {
      bytes,
      originalFileName,
      extension,
      mediaType: expectedMediaType,
      width: metadata.width,
      height: metadata.height
    };
  } catch (error) {
    if (error instanceof CompanyLogoValidationError) throw error;
    throw new CompanyLogoValidationError("COMPANY_LOGO_INVALID_IMAGE");
  }
}

function normalizeOriginalFileName(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length < 1 ||
    Buffer.byteLength(normalized, "utf8") > 255 ||
    /[\\/\u0000-\u001f\u007f]/.test(normalized) ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new CompanyLogoValidationError("COMPANY_LOGO_INVALID_NAME");
  }
  return normalized;
}

function readExtension(fileName: string): "png" | "jpg" {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName);
  const extension = match?.[1]?.toLocaleLowerCase("en-US");
  if (extension !== "png" && extension !== "jpg") {
    throw new CompanyLogoValidationError("COMPANY_LOGO_UNSUPPORTED_MEDIA_TYPE");
  }
  return extension;
}
