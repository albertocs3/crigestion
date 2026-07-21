import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";
import {
  getAttachmentClamdScanPath,
  getAttachmentStorageRoot
} from "@/modules/platform/application/environment";
import { idempotencyStorageKey } from "@/modules/platform/application/http";
import {
  canonicalizeCompanyLogo,
  CompanyLogoValidationError,
  type CanonicalCompanyLogo
} from "@/modules/platform/infrastructure/companyLogoImage";
import {
  ClamdAttachmentScanner,
  type AttachmentScanner
} from "@/modules/platform/infrastructure/attachmentScanner";
import {
  AttachmentIntegrityError,
  FileAttachmentStorage
} from "@/modules/platform/infrastructure/attachmentStorage";

export type CompanyLogoDto = {
  id: string;
  contentType: "image/png" | "image/jpeg";
  sizeBytes: number;
  updatedAt: string;
  downloadUrl: string;
};

export type UploadCompanyLogoResult =
  | { ok: true; status: 200 | 201; value: CompanyLogoUploadValue }
  | {
      ok: false;
      status: 404 | 409 | 422 | 503;
      error: { code: string; message: string; retryAfterSeconds?: number };
    };

export type DownloadCompanyLogoResult =
  | {
      ok: true;
      status: 200;
      value: {
        bytes: Buffer;
        contentType: "image/png" | "image/jpeg";
        extension: "png" | "jpg";
        etag: string;
      };
    }
  | {
      ok: false;
      status: 404 | 503;
      error: { code: string; message: string };
    };

export type CompanyLogoStorage = Pick<
  FileAttachmentStorage,
  "writeTemporary" | "publish" | "readVerified" | "removeTemporary" | "removePublished"
>;

type CompanyLogoUploadValue = { logo: CompanyLogoDto; replaced: boolean };

export type CompanyLogoAttachmentDependencies = {
  storage: CompanyLogoStorage;
  scanner: AttachmentScanner;
  canonicalize: typeof canonicalizeCompanyLogo;
  afterPersistenceResolved?: () => Promise<void>;
};

export function companyLogoRequestHash(input: {
  bytes: Buffer;
  fileName: string;
  declaredMimeType: string;
  expectedLogoId: string | null;
}): string {
  return createHash("sha256")
    .update("company-logo-upload-v1\0")
    .update(input.fileName.normalize("NFC"))
    .update("\0")
    .update(input.declaredMimeType)
    .update("\0")
    .update(input.expectedLogoId ?? "")
    .update("\0")
    .update(input.bytes)
    .digest("hex");
}

export async function uploadCompanyLogo(
  input: {
    bytes: Buffer;
    fileName: string;
    declaredMimeType: string;
    expectedLogoId: string | null;
    clientIdempotencyKey: string;
    requestHash: string;
  },
  actor: SessionUser,
  context: { correlationId: string },
  dependencies: CompanyLogoAttachmentDependencies = defaultDependencies()
): Promise<UploadCompanyLogoResult> {
  const company = await currentCompany();
  if (!company) return companyNotFound();

  const idempotencyKey = idempotencyStorageKey(
    actor.id,
    "company-logo-upload",
    company.id,
    input.clientIdempotencyKey
  );
  const replay = await readReplay(idempotencyKey, input.requestHash);
  if (replay) return replay;
  if (company.logoAttachmentId !== input.expectedLogoId) return companyLogoChanged();

  const attachmentId = randomUUID();
  let originalTemporaryPath: string | null = null;
  let canonicalTemporaryPath: string | null = null;
  let publishedStorageKey: string | null = null;
  let canonical: CanonicalCompanyLogo | null = null;

  try {
    originalTemporaryPath = await dependencies.storage.writeTemporary(input.bytes, "upload");
    const originalScan = await dependencies.scanner.scan(originalTemporaryPath);
    const originalScanFailure = await scanFailureResult(
      originalScan.outcome,
      actor,
      company.id,
      context.correlationId
    );
    if (originalScanFailure) return originalScanFailure;

    try {
      canonical = await dependencies.canonicalize({
        bytes: input.bytes,
        originalFileName: input.fileName,
        declaredMimeType: input.declaredMimeType
      });
    } catch (error) {
      if (!(error instanceof CompanyLogoValidationError)) throw error;
      await auditRejected(actor.id, company.id, error.code, context.correlationId);
      return validationFailure(error.code);
    }

    canonicalTemporaryPath = await dependencies.storage.writeTemporary(
      canonical.bytes,
      "canonical"
    );
    const canonicalScan = await dependencies.scanner.scan(canonicalTemporaryPath);
    const canonicalScanFailure = await scanFailureResult(
      canonicalScan.outcome,
      actor,
      company.id,
      context.correlationId
    );
    if (canonicalScanFailure) return canonicalScanFailure;

    const sha256 = createHash("sha256").update(canonical.bytes).digest("hex");
    publishedStorageKey = `company-logo/${company.id}/${attachmentId}.${canonical.extension}`;
    await dependencies.storage.publish(canonicalTemporaryPath, publishedStorageKey);
    canonicalTemporaryPath = null;

    const persisted = await persistCompanyLogo({
      attachmentId,
      companyId: company.id,
      expectedLogoId: input.expectedLogoId,
      idempotencyKey,
      requestHash: input.requestHash,
      originalFileName: canonical.originalFileName,
      extension: canonical.extension,
      declaredMimeType: input.declaredMimeType,
      detectedMimeType: canonical.mediaType,
      sizeBytes: canonical.bytes.byteLength,
      sha256,
      storageKey: publishedStorageKey,
      scanEngine: canonicalScan.engine,
      scanEngineVersion: canonicalScan.version,
      actor,
      correlationId: context.correlationId
    });
    await dependencies.afterPersistenceResolved?.();

    if (!persisted.ok || persisted.replayed) {
      try {
        await dependencies.storage.removePublished(publishedStorageKey);
      } catch {
        await auditOrphanCleanupFailed(
          attachmentId,
          company.id,
          context.correlationId
        );
      }
      publishedStorageKey = null;
    }
    return persisted.result;
  } catch (error) {
    if (publishedStorageKey) {
      try {
        const reconciled = await reconcileUncertainPersistence({
          attachmentId,
          companyId: company.id,
          idempotencyKey,
          requestHash: input.requestHash
        });
        if (reconciled) {
          publishedStorageKey = null;
          return reconciled;
        }
      } catch {
        // A second database failure leaves the transaction outcome unknowable.
      }
      await auditUncertainPersistence(
        attachmentId,
        company.id,
        context.correlationId
      );
      // Never compensate an uncertain commit by deleting the object. A later
      // reconciler may remove a proven orphan; preserving it cannot break a
      // committed AVAILABLE row.
      publishedStorageKey = null;
    }
    throw error;
  } finally {
    canonical?.bytes.fill(0);
    await Promise.allSettled([
      dependencies.storage.removeTemporary(originalTemporaryPath),
      dependencies.storage.removeTemporary(canonicalTemporaryPath)
    ]);
  }
}

export async function downloadCompanyLogo(
  actor: SessionUser,
  context: { correlationId: string },
  storage: CompanyLogoStorage = defaultStorage()
): Promise<DownloadCompanyLogoResult> {
  const installation = await prisma.installation.findFirst({
    where: { status: "INITIALIZED" },
    select: {
      company: {
        select: {
          id: true,
          logoAttachment: {
            select: {
              id: true,
              status: true,
              purpose: true,
              detectedMimeType: true,
              extension: true,
              sizeBytes: true,
              sha256: true,
              storageKey: true
            }
          }
        }
      }
    }
  });
  const company = installation?.company;
  const logo = company?.logoAttachment;
  if (
    !company ||
    !logo ||
    logo.status !== "AVAILABLE" ||
    logo.purpose !== "COMPANY_LOGO" ||
    !isCompanyLogoMediaType(logo.detectedMimeType) ||
    (logo.extension !== "png" && logo.extension !== "jpg") ||
    !logo.sha256 ||
    !logo.storageKey
  ) {
    return {
      ok: false,
      status: 404,
      error: { code: "COMPANY_LOGO_NOT_FOUND", message: "La empresa no tiene logotipo." }
    };
  }

  try {
    const bytes = await storage.readVerified(
      logo.storageKey,
      Number(logo.sizeBytes),
      logo.sha256
    );
    await prisma.auditEvent.create({
      data: {
        eventType: "COMPANY_LOGO_DOWNLOADED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          companyId: company.id,
          attachmentId: logo.id,
          correlationId: context.correlationId
        }
      }
    });
    return {
      ok: true,
      status: 200,
      value: {
        bytes,
        contentType: logo.detectedMimeType,
        extension: logo.extension,
        etag: `"sha256-${logo.sha256}"`
      }
    };
  } catch (error) {
    if (!(error instanceof AttachmentIntegrityError)) throw error;
    await prisma.auditEvent.create({
      data: {
        eventType: "COMPANY_LOGO_INTEGRITY_FAILED",
        actorType: "SYSTEM",
        payload: {
          actorUserId: actor.id,
          companyId: company.id,
          attachmentId: logo.id,
          correlationId: context.correlationId
        }
      }
    });
    return {
      ok: false,
      status: 503,
      error: {
        code: "COMPANY_LOGO_INTEGRITY_FAILED",
        message: "El logotipo no esta disponible porque no supera la comprobacion de integridad."
      }
    };
  }
}

export async function consumeCompanyLogoRateLimit(
  userId: string,
  scope: "upload" | "download"
): Promise<boolean> {
  const now = new Date();
  const windowMilliseconds = scope === "upload" ? 15 * 60_000 : 60_000;
  const windowStart = new Date(now.getTime() - windowMilliseconds);
  const key = `company-logo:${scope}:${userId}`;
  const [bucket] = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (${randomUUID()}::uuid, ${key}, ${now}, 1, ${now}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN 1 ELSE "rate_limit_buckets"."count" + 1 END,
      "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN ${now} ELSE "rate_limit_buckets"."windowStart" END,
      "updatedAt" = ${now}
    RETURNING "count"
  `;
  return Boolean(bucket && bucket.count > (scope === "upload" ? 5 : 120));
}

async function persistCompanyLogo(input: {
  attachmentId: string;
  companyId: string;
  expectedLogoId: string | null;
  idempotencyKey: string;
  requestHash: string;
  originalFileName: string;
  extension: "png" | "jpg";
  declaredMimeType: string;
  detectedMimeType: "image/png" | "image/jpeg";
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  scanEngine: string;
  scanEngineVersion: string | null;
  actor: SessionUser;
  correlationId: string;
}): Promise<{
  ok: boolean;
  replayed: boolean;
  result: UploadCompanyLogoResult;
}> {
  const now = new Date();

  try {
    return await prisma.$transaction(async (tx) => {
      const [lockedCompany] = await tx.$queryRaw<Array<{ logoAttachmentId: string | null }>>`
        SELECT "logoAttachmentId"
        FROM "companies"
        WHERE "id" = ${input.companyId}::uuid
        FOR UPDATE
      `;
      if (!lockedCompany) {
        return { ok: false, replayed: false, result: companyNotFound() };
      }

      const existing = await tx.idempotencyRecord.findUnique({
        where: { key: input.idempotencyKey }
      });
      if (existing) {
        return {
          ok: true,
          replayed: true,
          result: idempotencyRecordResult(existing, input.requestHash)
        };
      }
      if (lockedCompany.logoAttachmentId !== input.expectedLogoId) {
        return { ok: false, replayed: false, result: companyLogoChanged() };
      }

      if (lockedCompany.logoAttachmentId) {
        await tx.attachment.update({
          where: {
            id_companyId: {
              id: lockedCompany.logoAttachmentId,
              companyId: input.companyId
            }
          },
          data: { status: "REPLACED", replacedAt: now }
        });
      }

      const created = await tx.attachment.create({
        data: {
          id: input.attachmentId,
          companyId: input.companyId,
          purpose: "COMPANY_LOGO",
          originalFileName: input.originalFileName,
          extension: input.extension,
          declaredMimeType: input.declaredMimeType,
          detectedMimeType: input.detectedMimeType,
          sizeBytes: input.sizeBytes,
          sha256: input.sha256,
          storageKey: input.storageKey,
          status: "AVAILABLE",
          scanResult: "CLEAN",
          scanEngine: input.scanEngine,
          scanEngineVersion: input.scanEngineVersion,
          scanCompletedAt: now,
          availableAt: now,
          replacesAttachmentId: lockedCompany.logoAttachmentId,
          uploadedById: input.actor.id
        }
      });
      await tx.company.update({
        where: { id: input.companyId },
        data: { logoAttachmentId: created.id }
      });

      const response = uploadResponse(created, Boolean(lockedCompany.logoAttachmentId));
      await tx.idempotencyRecord.create({
        data: {
          key: input.idempotencyKey,
          requestHash: input.requestHash,
          responseStatus: response.status,
          responseBody: response.value
        }
      });
      await tx.auditEvent.create({
        data: {
          eventType: lockedCompany.logoAttachmentId
            ? "COMPANY_LOGO_REPLACED"
            : "COMPANY_LOGO_UPLOADED",
          actorType: "USER",
          payload: {
            actorUserId: input.actor.id,
            companyId: input.companyId,
            attachmentId: created.id,
            previousAttachmentId: lockedCompany.logoAttachmentId,
            mediaType: input.detectedMimeType,
            sizeBytes: input.sizeBytes,
            correlationId: input.correlationId
          }
        }
      });

      return { ok: true, replayed: false, result: response };
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const replay = await readReplay(input.idempotencyKey, input.requestHash);
      if (replay) return { ok: replay.ok, replayed: true, result: replay };
    }
    throw error;
  }
}

async function currentCompany(): Promise<{ id: string; logoAttachmentId: string | null } | null> {
  const installation = await prisma.installation.findFirst({
    where: { status: "INITIALIZED" },
    select: { company: { select: { id: true, logoAttachmentId: true } } }
  });
  return installation?.company ?? null;
}

async function readReplay(
  idempotencyKey: string,
  requestHash: string
): Promise<UploadCompanyLogoResult | null> {
  const existing = await prisma.idempotencyRecord.findUnique({
    where: { key: idempotencyKey }
  });
  return existing ? idempotencyRecordResult(existing, requestHash) : null;
}

async function reconcileUncertainPersistence(input: {
  attachmentId: string;
  companyId: string;
  idempotencyKey: string;
  requestHash: string;
}): Promise<UploadCompanyLogoResult | null> {
  const replay = await readReplay(input.idempotencyKey, input.requestHash);
  if (replay?.ok) return replay;

  const attachment = await prisma.attachment.findFirst({
    where: {
      id: input.attachmentId,
      companyId: input.companyId,
      purpose: "COMPANY_LOGO",
      status: "AVAILABLE",
      logoCompany: { id: input.companyId }
    },
    select: {
      id: true,
      detectedMimeType: true,
      sizeBytes: true,
      updatedAt: true,
      replacesAttachmentId: true
    }
  });
  return attachment ? uploadResponse(attachment, Boolean(attachment.replacesAttachmentId)) : null;
}

async function auditUncertainPersistence(
  attachmentId: string,
  companyId: string,
  correlationId: string
): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      eventType: "ATTACHMENT_PERSISTENCE_OUTCOME_UNCERTAIN",
      actorType: "SYSTEM",
      payload: { attachmentId, companyId, correlationId }
    }
  }).catch(() => undefined);
}

async function auditOrphanCleanupFailed(
  attachmentId: string,
  companyId: string,
  correlationId: string
): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      eventType: "ATTACHMENT_ORPHAN_CLEANUP_FAILED",
      actorType: "SYSTEM",
      payload: { attachmentId, companyId, correlationId }
    }
  }).catch(() => undefined);
}

function idempotencyRecordResult(
  record: { requestHash: string; responseStatus: number; responseBody: Prisma.JsonValue },
  requestHash: string
): UploadCompanyLogoResult {
  if (record.requestHash !== requestHash) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "La clave de idempotencia ya se uso con otra peticion."
      }
    };
  }
  return {
    ok: true,
    status: record.responseStatus === 201 ? 201 : 200,
    value: record.responseBody as CompanyLogoUploadValue
  };
}

function uploadResponse(
  attachment: {
    id: string;
    detectedMimeType: string | null;
    sizeBytes: bigint;
    updatedAt: Date;
  },
  replaced: boolean
): Extract<UploadCompanyLogoResult, { ok: true }> {
  if (!isCompanyLogoMediaType(attachment.detectedMimeType)) {
    throw new Error("COMPANY_LOGO_MEDIA_TYPE_INVALID");
  }
  return {
    ok: true,
    status: replaced ? 200 : 201,
    value: {
      logo: {
        id: attachment.id,
        contentType: attachment.detectedMimeType,
        sizeBytes: Number(attachment.sizeBytes),
        updatedAt: attachment.updatedAt.toISOString(),
        downloadUrl: "/api/platform/configuration/company/logo"
      },
      replaced
    }
  };
}

async function scanFailureResult(
  outcome: "clean" | "infected" | "inconclusive",
  actor: SessionUser,
  companyId: string,
  correlationId: string
): Promise<UploadCompanyLogoResult | null> {
  if (outcome === "clean") return null;
  const code = outcome === "infected" ? "COMPANY_LOGO_FILE_REJECTED" : "ANTIVIRUS_UNAVAILABLE";
  await auditRejected(actor.id, companyId, code, correlationId);
  return outcome === "infected"
    ? {
        ok: false,
        status: 422,
        error: { code, message: "El archivo no supera la validacion de seguridad." }
      }
    : {
        ok: false,
        status: 503,
        error: {
          code,
          message: "El antivirus no esta disponible. Reintenta mas tarde sin cambiar el archivo.",
          retryAfterSeconds: 60
        }
      };
}

async function auditRejected(
  actorUserId: string,
  companyId: string,
  reasonCode: string,
  correlationId: string
): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      eventType: reasonCode === "ANTIVIRUS_UNAVAILABLE"
        ? "COMPANY_LOGO_SCAN_UNAVAILABLE"
        : "COMPANY_LOGO_UPLOAD_REJECTED",
      actorType: "USER",
      payload: { actorUserId, companyId, reasonCode, correlationId }
    }
  });
}

function validationFailure(code: CompanyLogoValidationError["code"]): UploadCompanyLogoResult {
  const messages: Record<CompanyLogoValidationError["code"], string> = {
    COMPANY_LOGO_INVALID_NAME: "El nombre del archivo no es valido.",
    COMPANY_LOGO_UNSUPPORTED_MEDIA_TYPE: "Solo se admiten archivos PNG o JPG.",
    COMPANY_LOGO_TOO_LARGE: "El logotipo no puede superar 5 MiB.",
    COMPANY_LOGO_INVALID_IMAGE: "El contenido no es una imagen PNG o JPG valida.",
    COMPANY_LOGO_DIMENSIONS_EXCEEDED: "El logotipo supera las dimensiones permitidas."
  };
  return { ok: false, status: 422, error: { code, message: messages[code] } };
}

function companyNotFound(): UploadCompanyLogoResult {
  return {
    ok: false,
    status: 404,
    error: { code: "CONFIGURATION_NOT_FOUND", message: "La configuracion de plataforma no existe." }
  };
}

function companyLogoChanged(): UploadCompanyLogoResult {
  return {
    ok: false,
    status: 409,
    error: {
      code: "COMPANY_LOGO_CHANGED",
      message: "El logotipo ha cambiado. Recarga la pagina antes de reemplazarlo."
    }
  };
}

function isCompanyLogoMediaType(value: string | null): value is "image/png" | "image/jpeg" {
  return value === "image/png" || value === "image/jpeg";
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function defaultDependencies(): CompanyLogoAttachmentDependencies {
  return {
    storage: defaultStorage(),
    scanner: new ClamdAttachmentScanner(getAttachmentClamdScanPath()),
    canonicalize: canonicalizeCompanyLogo
  };
}

function defaultStorage(): CompanyLogoStorage {
  return new FileAttachmentStorage(getAttachmentStorageRoot());
}
