import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { prepareIncidentAttachment } from "@/modules/support/infrastructure/incidentAttachmentFile";

describe("support incident attachment validation", () => {
  it("decodes and canonicalizes a JPEG without metadata", async () => {
    const source = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#336699" } }).withMetadata({ exif: { IFD0: { ImageDescription: "private" } } }).jpeg().toBuffer();
    const result = await prepareIncidentAttachment({ bytes: source, originalFileName: "evidencia.jpeg", declaredMimeType: "image/jpeg" });
    expect(result.extension).toBe("jpg");
    expect(result.mediaType).toBe("image/jpeg");
    expect((await sharp(result.bytes).metadata()).format).toBe("jpeg");
    expect(result.bytes.includes(Buffer.from("private"))).toBe(false);
  });

  it("accepts a structurally coherent passive PDF", async () => {
    const bytes = minimalPdf();
    const result = await prepareIncidentAttachment({ bytes, originalFileName: "informe.pdf", declaredMimeType: "application/pdf" });
    expect(result.bytes.equals(bytes)).toBe(true);
  });

  it.each(["/JavaScript", "/Encrypt", "/EmbeddedFile", "/AcroForm"])("rejects active PDF token %s", async (token) => {
    const bytes = minimalPdf(token);
    await expect(prepareIncidentAttachment({ bytes, originalFileName: "informe.pdf", declaredMimeType: "application/pdf" })).rejects.toMatchObject({ code: "SUPPORT_ATTACHMENT_CONTENT_INVALID" });
  });

  it.each(["/J#53", "/Java#53cript", "/Type /ObjStm", "/Type /XRef"])("rejects non-inspectable PDF construct %s", async (token) => {
    await expect(prepareIncidentAttachment({ bytes: minimalPdf(token), originalFileName: "informe.pdf", declaredMimeType: "application/pdf" })).rejects.toMatchObject({ code: "SUPPORT_ATTACHMENT_CONTENT_INVALID" });
  });

  it.each(["/Type%comment\n/ObjStm", "/Type%comment\n/XRef"])("rejects commented non-inspectable PDF construct %s", async (token) => {
    await expect(prepareIncidentAttachment({ bytes: minimalPdf(token), originalFileName: "informe.pdf", declaredMimeType: "application/pdf" })).rejects.toMatchObject({ code: "SUPPORT_ATTACHMENT_CONTENT_INVALID" });
  });

  it("rejects incremental PDF updates", async () => {
    const bytes = Buffer.concat([minimalPdf(), Buffer.from("\n%%EOF\n")]);
    await expect(prepareIncidentAttachment({ bytes, originalFileName: "informe.pdf", declaredMimeType: "application/pdf" })).rejects.toMatchObject({ code: "SUPPORT_ATTACHMENT_CONTENT_INVALID" });
  });

  it("rejects MIME and extension mismatch", async () => {
    await expect(prepareIncidentAttachment({ bytes: minimalPdf(), originalFileName: "informe.jpg", declaredMimeType: "image/jpeg" })).rejects.toMatchObject({ code: "SUPPORT_ATTACHMENT_CONTENT_INVALID" });
  });

  it.each(["../informe.pdf", "sub/informe.pdf", "informe\r\nmal.pdf"])("rejects unsafe name %s", async (originalFileName) => {
    await expect(prepareIncidentAttachment({ bytes: minimalPdf(), originalFileName, declaredMimeType: "application/pdf" })).rejects.toMatchObject({ code: "SUPPORT_ATTACHMENT_INVALID_NAME" });
  });
});

function minimalPdf(extra = ""): Buffer {
  const header = "%PDF-1.4\n";
  const object = `1 0 obj\n<< /Type /Catalog ${extra} >>\nendobj\n`;
  const xrefOffset = Buffer.byteLength(header + object, "latin1");
  return Buffer.from(`${header}${object}xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "latin1");
}
