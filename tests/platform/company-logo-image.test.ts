import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  canonicalizeCompanyLogo,
  CompanyLogoValidationError
} from "@/modules/platform/infrastructure/companyLogoImage";

describe("company logo image validation", () => {
  it("normalizes PNG input and strips metadata", async () => {
    const input = await sharp({
      create: { width: 32, height: 16, channels: 4, background: "#336699" }
    }).withMetadata({ exif: { IFD0: { Artist: "must-not-survive" } } }).png().toBuffer();

    const result = await canonicalizeCompanyLogo({
      bytes: input,
      originalFileName: "  logotipo.png  ",
      declaredMimeType: "image/png"
    });
    const metadata = await sharp(result.bytes).metadata();

    expect(result).toMatchObject({
      originalFileName: "logotipo.png",
      extension: "png",
      mediaType: "image/png",
      width: 32,
      height: 16
    });
    expect(metadata.format).toBe("png");
    expect(metadata.exif).toBeUndefined();
  });

  it("normalizes JPEG input", async () => {
    const input = await sharp({
      create: { width: 12, height: 8, channels: 3, background: "#ffffff" }
    }).jpeg().toBuffer();

    const result = await canonicalizeCompanyLogo({
      bytes: input,
      originalFileName: "logo.JPG",
      declaredMimeType: "image/jpeg"
    });

    expect(result.extension).toBe("jpg");
    expect(result.mediaType).toBe("image/jpeg");
    expect((await sharp(result.bytes).metadata()).format).toBe("jpeg");
  });

  it.each([
    ["../logo.png", "image/png", "COMPANY_LOGO_INVALID_NAME"],
    ["logo.svg", "image/svg+xml", "COMPANY_LOGO_UNSUPPORTED_MEDIA_TYPE"],
    ["logo.png", "image/jpeg", "COMPANY_LOGO_UNSUPPORTED_MEDIA_TYPE"]
  ] as const)("rejects invalid input %s", async (fileName, mimeType, code) => {
    const input = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#ffffff" }
    }).png().toBuffer();

    await expect(canonicalizeCompanyLogo({
      bytes: input,
      originalFileName: fileName,
      declaredMimeType: mimeType
    })).rejects.toMatchObject({ code });
  });

  it("rejects content that does not match its extension", async () => {
    const jpeg = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#ffffff" }
    }).jpeg().toBuffer();

    await expect(canonicalizeCompanyLogo({
      bytes: jpeg,
      originalFileName: "logo.png",
      declaredMimeType: "image/png"
    })).rejects.toBeInstanceOf(CompanyLogoValidationError);
  });

  it("rejects excessive dimensions before decoding the full image", async () => {
    const input = await sharp({
      create: { width: 4097, height: 1, channels: 3, background: "#ffffff" }
    }).png().toBuffer();

    await expect(canonicalizeCompanyLogo({
      bytes: input,
      originalFileName: "logo.png",
      declaredMimeType: "image/png"
    })).rejects.toMatchObject({ code: "COMPANY_LOGO_DIMENSIONS_EXCEEDED" });
  });
});
