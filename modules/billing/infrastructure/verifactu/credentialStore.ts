import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { createSecureContext } from "node:tls";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { VerifactuCredentialSource } from "./credentialProvider";
import { readVerifactuCertificateMetadata } from "./pkcs12";
import { readSecureEnvelopeKeyId, type SecureEnvelopeCipher } from "./secureEnvelope";

const materialSchema = z.object({
  pfxBase64: z.string().min(1).max(800_000),
  passphrase: z.string().max(4096)
}).strict();

export function createPrismaVerifactuCredentialSource(cipher: SecureEnvelopeCipher): VerifactuCredentialSource {
  return {
    async load(credentialRef, companyId) {
      const row = await prisma.verifactuMtlsCredential.findUnique({
        where: { ref: credentialRef },
        select: {
          id: true, companyId: true, ref: true, status: true,
          versions: {
            where: { status: "ACTIVE" }, orderBy: { version: "desc" }, take: 1,
            select: {
              id: true, version: true, endpointKind: true, allowTest: true, allowProduction: true,
              validFrom: true, validUntil: true, materialCiphertext: true, pfxSha256: true,
              testedPfxSha256: true, testedAt: true, encryptionKeyId: true, envelopeVersion: true
            }
          }
        }
      });
      const version = row?.versions[0];
      if (!row || row.companyId !== companyId || row.status !== "ACTIVE" || !version) return null;
      if (version.envelopeVersion !== 1 || readSecureEnvelopeKeyId(version.materialCiphertext) !== version.encryptionKeyId) {
        throw new Error("VERIFACTU_CREDENTIAL_ENVELOPE_METADATA_INVALID");
      }
      const plaintext = cipher.decrypt(version.materialCiphertext, credentialContext({
        companyId: row.companyId, credentialId: row.id, versionId: version.id, version: version.version,
        endpointKind: version.endpointKind, allowTest: version.allowTest, allowProduction: version.allowProduction,
        validFrom: version.validFrom, validUntil: version.validUntil, pfxSha256: version.pfxSha256
      }));
      try {
        const material = decodeCredentialMaterial(plaintext, version.pfxSha256);
        const pfx = material.pfx;
        return {
          credentialRef: row.ref,
          versionId: version.id,
          version: String(version.version),
          status: "ACTIVE" as const,
          testedAt: version.testedAt,
          validFrom: version.validFrom,
          validUntil: version.validUntil,
          allowedEnvironments: [
            ...(version.allowTest ? ["TEST" as const] : []),
            ...(version.allowProduction ? ["PRODUCTION" as const] : [])
          ],
          endpointKind: version.endpointKind,
          pfx,
          passphrase: material.passphrase,
          testedPfxSha256: version.testedPfxSha256 ?? "",
          release() { pfx.fill(0); }
        };
      } finally {
        plaintext.fill(0);
      }
    }
  };
}

export type StagedVerifactuCredential = {
  credentialRef: string;
  credentialId: string;
  versionId: string;
  version: number;
  companyId: string;
  endpointKind: "STANDARD" | "SEAL";
  pfxSha256: string;
  pfx: Buffer;
  passphrase: string;
  release(): void;
};

export async function stageVerifactuCredentialVersion(input: {
  sifInstallationId: string;
  alias: string;
  pfx: Uint8Array;
  passphrase: string;
  endpointKind: "STANDARD" | "SEAL";
  allowTest: boolean;
  allowProduction: boolean;
  actorUserId: string;
  correlationId?: string;
  idempotencyKey: string;
  requestHash: string;
  cipher: SecureEnvelopeCipher;
}): Promise<{ credentialRef: string; versionId: string; version: number; validFrom: Date; validUntil: Date; replayed: boolean }> {
  const validationPfx = Buffer.from(input.pfx);
  try { createSecureContext({ pfx: validationPfx, passphrase: input.passphrase, minVersion: "TLSv1.2" }); }
  catch { throw new Error("VERIFACTU_CREDENTIAL_MATERIAL_INVALID"); }
  finally { validationPfx.fill(0); }
  if (!input.alias.trim() || input.alias.length > 120 || (!input.allowTest && !input.allowProduction)) {
    throw new Error("VERIFACTU_CREDENTIAL_METADATA_INVALID");
  }
  const metadata = readVerifactuCertificateMetadata(input.pfx, input.passphrase);
  const pfxSha256 = createHash("sha256").update(input.pfx).digest("hex");
  try {
    return await prisma.$transaction(async (tx) => {
      const existingIdempotency = await tx.idempotencyRecord.findUnique({ where: { key: input.idempotencyKey } });
      if (existingIdempotency) {
        if (existingIdempotency.requestHash !== input.requestHash) throw new Error("VERIFACTU_IDEMPOTENCY_KEY_REUSED");
        const response = stageResponseSchema.parse(existingIdempotency.responseBody);
        return { ...response, validFrom: new Date(response.validFrom), validUntil: new Date(response.validUntil), replayed: true };
      }
      const singleton = await tx.installation.findUnique({ where: { singletonKey: 1 }, select: { companyId: true } });
      const installation = singleton?.companyId ? await tx.verifactuSifInstallation.findFirst({
        where: { id: input.sifInstallationId, companyId: singleton.companyId }, select: { id: true, companyId: true, credentialRef: true }
      }) : null;
      if (!installation) throw new Error("VERIFACTU_SIF_INSTALLATION_NOT_FOUND");
      let credential = installation.credentialRef
        ? await tx.verifactuMtlsCredential.findUnique({ where: { ref: installation.credentialRef }, select: { id: true, ref: true, companyId: true, status: true } })
        : null;
      if (credential && (credential.companyId !== installation.companyId || credential.status !== "ACTIVE")) {
        throw new Error("VERIFACTU_CREDENTIAL_UNAVAILABLE");
      }
      if (credential) {
        await tx.$queryRaw`SELECT "id" FROM "verifactu_mtls_credentials" WHERE "id" = ${credential.id}::uuid FOR UPDATE`;
      } else {
        credential = await tx.verifactuMtlsCredential.create({
          data: { id: randomUUID(), companyId: installation.companyId, ref: `vfcred:${randomUUID()}`, alias: input.alias.trim() },
          select: { id: true, ref: true, companyId: true, status: true }
        });
      }
      const aggregate = await tx.verifactuMtlsCredentialVersion.aggregate({ where: { credentialId: credential.id }, _max: { version: true } });
      const version = (aggregate._max.version ?? 0) + 1;
      const versionId = randomUUID();
      const context = credentialContext({
        companyId: installation.companyId, credentialId: credential.id, versionId, version, endpointKind: input.endpointKind,
        allowTest: input.allowTest, allowProduction: input.allowProduction, validFrom: metadata.validFrom,
        validUntil: metadata.validUntil, pfxSha256
      });
      const plaintext = encodeCredentialMaterial(input.pfx, input.passphrase);
      let ciphertext: Uint8Array;
      try { ciphertext = input.cipher.encrypt(plaintext, context); }
      finally { plaintext.fill(0); }
      await tx.verifactuMtlsCredentialVersion.create({
        data: {
          id: versionId, credentialId: credential.id, version, status: "STAGED", endpointKind: input.endpointKind,
          allowTest: input.allowTest, allowProduction: input.allowProduction, validFrom: metadata.validFrom,
          validUntil: metadata.validUntil, materialCiphertext: Uint8Array.from(ciphertext), encryptionKeyId: input.cipher.keyId, pfxSha256
        }
      });
      const response = { credentialRef: credential.ref, versionId, version, validFrom: metadata.validFrom.toISOString(), validUntil: metadata.validUntil.toISOString() };
      await tx.auditEvent.create({ data: { eventType: "VERIFACTU_MTLS_VERSION_STAGED", actorType: "USER", payload: {
        actorUserId: input.actorUserId, companyId: installation.companyId, sifInstallationId: installation.id,
        mtlsRefId: credential.ref, mtlsVersionId: versionId, version, endpointKind: input.endpointKind,
        certificateSha256: metadata.certificateSha256, ...(input.correlationId ? { correlationId: input.correlationId } : {})
      } } });
      await tx.idempotencyRecord.create({ data: { key: input.idempotencyKey, requestHash: input.requestHash, responseStatus: 201, responseBody: response } });
      return { ...response, validFrom: metadata.validFrom, validUntil: metadata.validUntil, replayed: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const replay = await prisma.idempotencyRecord.findUnique({ where: { key: input.idempotencyKey } });
      if (replay?.requestHash === input.requestHash) {
        const response = stageResponseSchema.parse(replay.responseBody);
        return { ...response, validFrom: new Date(response.validFrom), validUntil: new Date(response.validUntil), replayed: true };
      }
    }
    throw error;
  }
}

export async function loadStagedVerifactuCredential(input: {
  versionId: string; companyId: string; cipher: SecureEnvelopeCipher;
}): Promise<StagedVerifactuCredential | null> {
  const version = await prisma.verifactuMtlsCredentialVersion.findFirst({
    where: { id: input.versionId, status: "STAGED", allowTest: true, credential: { companyId: input.companyId, status: "ACTIVE" } },
    select: {
      id: true, version: true, endpointKind: true, allowTest: true, allowProduction: true, validFrom: true, validUntil: true,
      materialCiphertext: true, encryptionKeyId: true, envelopeVersion: true, pfxSha256: true,
      credential: { select: { id: true, ref: true, companyId: true } }
    }
  });
  if (!version) return null;
  if (version.envelopeVersion !== 1 || readSecureEnvelopeKeyId(version.materialCiphertext) !== version.encryptionKeyId) {
    throw new Error("VERIFACTU_CREDENTIAL_ENVELOPE_METADATA_INVALID");
  }
  const plaintext = input.cipher.decrypt(version.materialCiphertext, credentialContext({
    companyId: version.credential.companyId, credentialId: version.credential.id, versionId: version.id, version: version.version,
    endpointKind: version.endpointKind, allowTest: version.allowTest, allowProduction: version.allowProduction,
    validFrom: version.validFrom, validUntil: version.validUntil, pfxSha256: version.pfxSha256
  }));
  try {
    const material = decodeCredentialMaterial(plaintext, version.pfxSha256);
    const pfx = material.pfx;
    return {
      credentialRef: version.credential.ref, credentialId: version.credential.id, versionId: version.id,
      version: version.version, companyId: version.credential.companyId, endpointKind: version.endpointKind,
      pfxSha256: version.pfxSha256, pfx, passphrase: material.passphrase, release() { pfx.fill(0); }
    };
  } finally { plaintext.fill(0); }
}

const stageResponseSchema = z.object({
  credentialRef: z.string(), versionId: z.string().uuid(), version: z.number().int().positive(),
  validFrom: z.string().datetime(), validUntil: z.string().datetime()
}).strict();

function credentialContext(input: {
  companyId: string; credentialId: string; versionId: string; version: number;
  endpointKind: "STANDARD" | "SEAL"; allowTest: boolean; allowProduction: boolean;
  validFrom: Date; validUntil: Date; pfxSha256: string;
}): string[] {
  return ["VERIFACTU-MTLS-CREDENTIAL", input.companyId, input.credentialId, input.versionId, String(input.version), input.endpointKind, String(input.allowTest), String(input.allowProduction), input.validFrom.toISOString(), input.validUntil.toISOString(), input.pfxSha256];
}

const materialMagic = Buffer.from("CGVFMTLS", "ascii");
const materialFormatVersion = 1;
const materialHeaderBytes = materialMagic.byteLength + 1 + 4 + 4;

function encodeCredentialMaterial(pfx: Uint8Array, passphrase: string): Buffer {
  const passphraseBytes = Buffer.from(passphrase, "utf8");
  if (pfx.byteLength < 1 || pfx.byteLength > 512 * 1024 || passphrase.length > 4096 || passphraseBytes.byteLength > 16_384) {
    passphraseBytes.fill(0);
    throw new Error("VERIFACTU_CREDENTIAL_MATERIAL_INVALID");
  }
  const material = Buffer.allocUnsafe(materialHeaderBytes + pfx.byteLength + passphraseBytes.byteLength);
  try {
    materialMagic.copy(material, 0);
    material.writeUInt8(materialFormatVersion, materialMagic.byteLength);
    material.writeUInt32BE(pfx.byteLength, materialMagic.byteLength + 1);
    material.writeUInt32BE(passphraseBytes.byteLength, materialMagic.byteLength + 5);
    material.set(pfx, materialHeaderBytes);
    passphraseBytes.copy(material, materialHeaderBytes + pfx.byteLength);
    return material;
  } finally {
    passphraseBytes.fill(0);
  }
}

function decodeCredentialMaterial(plaintext: Uint8Array, expectedPfxSha256: string): { pfx: Buffer; passphrase: string } {
  const buffer = Buffer.from(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  if (!buffer.subarray(0, materialMagic.byteLength).equals(materialMagic)) return decodeLegacyCredentialMaterial(buffer, expectedPfxSha256);
  if (buffer.byteLength < materialHeaderBytes || buffer.readUInt8(materialMagic.byteLength) !== materialFormatVersion) throw new Error("VERIFACTU_CREDENTIAL_MATERIAL_INVALID");
  const pfxLength = buffer.readUInt32BE(materialMagic.byteLength + 1);
  const passphraseLength = buffer.readUInt32BE(materialMagic.byteLength + 5);
  if (pfxLength < 1 || pfxLength > 512 * 1024 || passphraseLength > 16_384 || materialHeaderBytes + pfxLength + passphraseLength !== buffer.byteLength) {
    throw new Error("VERIFACTU_CREDENTIAL_MATERIAL_INVALID");
  }
  const pfx = Buffer.from(buffer.subarray(materialHeaderBytes, materialHeaderBytes + pfxLength));
  const passphraseBytes = Buffer.from(buffer.subarray(materialHeaderBytes + pfxLength));
  try {
    const passphrase = passphraseBytes.toString("utf8");
    const passphraseRoundTrip = Buffer.from(passphrase, "utf8");
    const passphraseIsValid = passphrase.length <= 4096 && passphraseRoundTrip.equals(passphraseBytes);
    passphraseRoundTrip.fill(0);
    if (!passphraseIsValid || createHash("sha256").update(pfx).digest("hex") !== expectedPfxSha256) {
      pfx.fill(0);
      throw new Error("VERIFACTU_CREDENTIAL_MATERIAL_INVALID");
    }
    return { pfx, passphrase };
  } finally {
    passphraseBytes.fill(0);
  }
}

function decodeLegacyCredentialMaterial(plaintext: Buffer, expectedPfxSha256: string): { pfx: Buffer; passphrase: string } {
  const material = materialSchema.parse(JSON.parse(plaintext.toString("utf8")) as unknown);
  const pfx = Buffer.from(material.pfxBase64, "base64");
  if (pfx.toString("base64") !== material.pfxBase64 || createHash("sha256").update(pfx).digest("hex") !== expectedPfxSha256) {
    pfx.fill(0);
    throw new Error("VERIFACTU_CREDENTIAL_MATERIAL_INVALID");
  }
  return { pfx, passphrase: material.passphrase };
}
