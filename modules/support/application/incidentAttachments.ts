import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";
import {
  getAttachmentClamdScanPath,
  getAttachmentStorageRoot,
} from "@/modules/platform/application/environment";
import { idempotencyStorageKey } from "@/modules/platform/application/http";
import {
  ClamdAttachmentScanner,
  type AttachmentScanner,
} from "@/modules/platform/infrastructure/attachmentScanner";
import {
  AttachmentIntegrityError,
  FileAttachmentStorage,
} from "@/modules/platform/infrastructure/attachmentStorage";
import {
  IncidentAttachmentValidationError,
  prepareIncidentAttachment,
  type PreparedIncidentAttachment,
} from "@/modules/support/infrastructure/incidentAttachmentFile";

export type SupportIncidentAttachmentDto = {
  id: string;
  originalFileName: string;
  mediaType: "image/jpeg" | "application/pdf";
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy: { id: string; displayName: string };
  downloadUrl: string;
};
export type SupportIncidentAttachmentPage = { attachments: SupportIncidentAttachmentDto[]; nextCursor: string | null };

type UploadResult =
  | { ok: true; status: 200 | 201; value: { attachment: SupportIncidentAttachmentDto } }
  | { ok: false; status: 403 | 404 | 409 | 422 | 429 | 503; error: { code: string; message: string; retryAfterSeconds?: number } };

export type DownloadIncidentAttachmentResult =
  | { ok: true; status: 200; value: { bytes: Buffer; attachment: SupportIncidentAttachmentDto; etag: string } }
  | { ok: false; status: 404 | 503; error: { code: string; message: string } };

type Storage = Pick<FileAttachmentStorage, "writeTemporary" | "publish" | "readVerified" | "removeTemporary" | "removePublished">;
type Dependencies = {
  storage: Storage;
  scanner: AttachmentScanner;
  prepare: typeof prepareIncidentAttachment;
  afterPersistenceResolved?: () => Promise<void>;
};
const supportAttachmentCompanyCapacityBytes = 1536 * 1024 * 1024;
const maximumConcurrentDownloads = 4;
let activeDownloads = 0;

class AttachmentPersistenceRetryExhausted extends Error {}

const replaySchema: z.ZodType<{ attachment: SupportIncidentAttachmentDto }> = z.object({
  attachment: z.object({
    id: z.string().uuid(),
    originalFileName: z.string(),
    mediaType: z.enum(["image/jpeg", "application/pdf"]),
    sizeBytes: z.number().int().positive(),
    uploadedAt: z.string().datetime(),
    uploadedBy: z.object({ id: z.string().uuid(), displayName: z.string() }).strict(),
    downloadUrl: z.string(),
  }).strict(),
}).strict();

export function supportIncidentAttachmentRequestHash(input: {
  incidentId: string;
  actionId: string | null;
  bytes: Buffer;
  fileName: string;
  declaredMimeType: string;
}): string {
  return createHash("sha256")
    .update("support-incident-attachment-v1\0")
    .update(input.incidentId).update("\0")
    .update(input.actionId ?? "").update("\0")
    .update(input.fileName.normalize("NFC")).update("\0")
    .update(input.declaredMimeType).update("\0")
    .update(input.bytes)
    .digest("hex");
}

export async function listSupportIncidentAttachments(
  incidentId: string,
  actor: SessionUser,
): Promise<SupportIncidentAttachmentDto[] | null> {
  return (await listSupportIncidentAttachmentPage(incidentId, actor, null))?.attachments ?? null;
}

export async function listSupportIncidentAttachmentPage(incidentId: string, actor: SessionUser, cursor: string | null): Promise<SupportIncidentAttachmentPage | null> {
  if (!actor.permissions.includes("Support.View")) return null;
  const companyId = await currentCompanyId(); if (!companyId) return null;
  const incident = await prisma.supportIncident.findFirst({ where: { id: incidentId, companyId }, select: { id: true } }); if (!incident) return null;
  const decoded = cursor ? decodeAttachmentCursor(cursor) : null; if (cursor && !decoded) return null;
  const links = await prisma.supportIncidentAttachment.findMany({
    where: { incidentId, companyId, ...(decoded ? { OR: [{ attachedAt: { lt: decoded.attachedAt } }, { attachedAt: decoded.attachedAt, id: { lt: decoded.id } }] } : {}), attachment: { purpose: "SUPPORT_INCIDENT", status: "AVAILABLE", scanResult: "CLEAN" } },
    orderBy: [{ attachedAt: "desc" }, { id: "desc" }], take: 101,
    select: { id: true, attachedAt: true, attachment: { select: attachmentSelect } },
  });
  const hasMore = links.length > 100; const visible = links.slice(0, 100); const last = visible.at(-1);
  return { attachments: visible.map(({ attachment }) => toDto(incidentId, attachment)), nextCursor: hasMore && last ? encodeAttachmentCursor(last.attachedAt, last.id) : null };
}

export function isSupportIncidentAttachmentCursor(value: string): boolean { return decodeAttachmentCursor(value) !== null; }

export async function uploadSupportIncidentAttachment(
  input: {
    incidentId: string;
    actionId: string | null;
    bytes: Buffer;
    fileName: string;
    declaredMimeType: string;
    clientIdempotencyKey: string;
    requestHash: string;
  },
  actor: SessionUser,
  context: { correlationId: string },
  dependencies: Dependencies = defaultDependencies(),
): Promise<UploadResult> {
  const companyId = await currentCompanyId();
  if (!companyId) return notFound();
  const key = idempotencyStorageKey(actor.id, "support-incident-attachment", input.incidentId, input.clientIdempotencyKey);
  const replay = await readReplay(key, input.requestHash);
  if (replay) return replay;
  const preflight = await uploadAuthority(input.incidentId, companyId, actor);
  if (preflight === "missing") return notFound();
  if (preflight === "forbidden") return forbidden();
  const attachmentId = randomUUID();
  let originalTemporaryPath: string | null = null;
  let canonicalTemporaryPath: string | null = null;
  let publishedStorageKey: string | null = null;
  let prepared: PreparedIncidentAttachment | null = null;
  try {
    originalTemporaryPath = await dependencies.storage.writeTemporary(input.bytes, "upload");
    const originalScan = await dependencies.scanner.scan(originalTemporaryPath);
    const originalFailure = await scanFailure(originalScan.outcome, actor.id, companyId, input.incidentId, context.correlationId);
    if (originalFailure) return originalFailure;
    try {
      prepared = await dependencies.prepare({ bytes: input.bytes, originalFileName: input.fileName, declaredMimeType: input.declaredMimeType });
    } catch (error) {
      if (!(error instanceof IncidentAttachmentValidationError)) throw error;
      await auditRejected(actor.id, companyId, input.incidentId, error.code, context.correlationId);
      return validationFailure(error.code);
    }
    canonicalTemporaryPath = await dependencies.storage.writeTemporary(prepared.bytes, "canonical");
    const finalScan = await dependencies.scanner.scan(canonicalTemporaryPath);
    const finalFailure = await scanFailure(finalScan.outcome, actor.id, companyId, input.incidentId, context.correlationId);
    if (finalFailure) return finalFailure;
    const sha256 = createHash("sha256").update(prepared.bytes).digest("hex");
    publishedStorageKey = `support-incident/${companyId}/${input.incidentId}/${attachmentId}.${prepared.extension}`;
    await dependencies.storage.publish(canonicalTemporaryPath, publishedStorageKey);
    canonicalTemporaryPath = null;
    const persisted = await persist({
      ...input,
      idempotencyKey: key,
      attachmentId,
      companyId,
      prepared,
      sha256,
      storageKey: publishedStorageKey,
      scanEngine: finalScan.engine,
      scanEngineVersion: finalScan.version,
      actor,
      correlationId: context.correlationId,
    });
    await dependencies.afterPersistenceResolved?.();
    if (!persisted.ok || persisted.replayed) {
      await dependencies.storage.removePublished(publishedStorageKey).catch(() => auditCleanupFailure(attachmentId, companyId, context.correlationId));
      publishedStorageKey = null;
    }
    return persisted.result;
  } catch (error) {
    if (publishedStorageKey) {
      if (error instanceof AttachmentPersistenceRetryExhausted) {
        await dependencies.storage.removePublished(publishedStorageKey).catch(() => auditCleanupFailure(attachmentId, companyId, context.correlationId));
        publishedStorageKey = null;
        return { ok: false, status: 503, error: { code: "SUPPORT_ATTACHMENT_DATABASE_BUSY", message: "La base de datos esta ocupada. Reintenta sin cambiar el archivo.", retryAfterSeconds: 3 } };
      }
      const reconciled = await reconcile(attachmentId, companyId, input.incidentId, key, input.requestHash).catch(() => null);
      if (reconciled) {
        publishedStorageKey = null;
        return reconciled;
      }
      await auditUncertain(attachmentId, companyId, input.incidentId, context.correlationId);
      publishedStorageKey = null;
    }
    throw error;
  } finally {
    prepared?.bytes.fill(0);
    await Promise.allSettled([
      dependencies.storage.removeTemporary(originalTemporaryPath),
      dependencies.storage.removeTemporary(canonicalTemporaryPath),
    ]);
  }
}

export async function downloadSupportIncidentAttachment(
  incidentId: string,
  attachmentId: string,
  actor: SessionUser,
  context: { correlationId: string },
  storage: Storage = defaultStorage(),
): Promise<DownloadIncidentAttachmentResult> {
  const companyId = await currentCompanyId();
  if (!companyId) return attachmentNotFound();
  const link = await prisma.supportIncidentAttachment.findFirst({
    where: { incidentId, companyId, attachmentId },
    select: { attachment: { select: { ...attachmentSelect, purpose: true, status: true, scanResult: true, sha256: true, storageKey: true } } },
  });
  const attachment = link?.attachment;
  if (!attachment || attachment.purpose !== "SUPPORT_INCIDENT" || attachment.status !== "AVAILABLE" || attachment.scanResult !== "CLEAN" || !attachment.sha256 || !attachment.storageKey) return attachmentNotFound();
  try {
    const bytes = await storage.readVerified(attachment.storageKey, Number(attachment.sizeBytes), attachment.sha256);
    await prisma.auditEvent.create({ data: { eventType: "SUPPORT_INCIDENT_ATTACHMENT_DOWNLOADED", actorType: "USER", payload: { actorUserId: actor.id, companyId, incidentId, attachmentId, correlationId: context.correlationId } } });
    return { ok: true, status: 200, value: { bytes, attachment: toDto(incidentId, attachment), etag: `"sha256-${attachment.sha256}"` } };
  } catch (error) {
    if (!(error instanceof AttachmentIntegrityError)) throw error;
    await prisma.auditEvent.create({ data: { eventType: "SUPPORT_INCIDENT_ATTACHMENT_INTEGRITY_FAILED", actorType: "SYSTEM", payload: { actorUserId: actor.id, companyId, incidentId, attachmentId, correlationId: context.correlationId } } });
    return { ok: false, status: 503, error: { code: "SUPPORT_ATTACHMENT_INTEGRITY_FAILED", message: "El adjunto no esta disponible porque no supera la comprobacion de integridad." } };
  }
}

export async function consumeSupportAttachmentRateLimit(userId: string, scope: "upload" | "download"): Promise<boolean> {
  const now = new Date();
  const windowMs = scope === "upload" ? 15 * 60_000 : 60_000;
  const windowStart = new Date(now.getTime() - windowMs);
  const key = `support-attachment:${scope}:${userId}`;
  const [bucket] = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (${randomUUID()}::uuid, ${key}, ${now}, 1, ${now}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN 1 ELSE "rate_limit_buckets"."count" + 1 END,
      "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN ${now} ELSE "rate_limit_buckets"."windowStart" END,
      "updatedAt" = ${now}
    RETURNING "count"
  `;
  return Boolean(bucket && bucket.count > (scope === "upload" ? 10 : 30));
}

export function acquireSupportAttachmentDownloadSlot(): boolean {
  if (activeDownloads >= maximumConcurrentDownloads) return false;
  activeDownloads += 1;
  return true;
}

export function releaseSupportAttachmentDownloadSlot(): void {
  activeDownloads = Math.max(0, activeDownloads - 1);
}

export async function auditSupportAttachmentRateLimited(actorUserId: string, scope: "upload" | "download", correlationId: string): Promise<void> {
  await prisma.auditEvent.create({ data: { eventType: "SUPPORT_ATTACHMENT_RATE_LIMITED", actorType: "USER", payload: { actorUserId, scope, correlationId } } });
}

const attachmentSelect = {
  id: true,
  originalFileName: true,
  detectedMimeType: true,
  sizeBytes: true,
  uploadedAt: true,
  uploadedBy: { select: { id: true, displayName: true } },
} as const;

async function persist(input: {
  incidentId: string; actionId: string | null; attachmentId: string; companyId: string;
  idempotencyKey: string; requestHash: string; declaredMimeType: string;
  prepared: PreparedIncidentAttachment; sha256: string; storageKey: string;
  scanEngine: string; scanEngineVersion: string | null; actor: SessionUser; correlationId: string;
}): Promise<{ ok: boolean; replayed: boolean; result: UploadResult }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
      const companyRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "companies" WHERE "id" = ${input.companyId}::uuid FOR UPDATE`);
      if (!companyRows[0]) return { ok: false, replayed: false, result: notFound() };
      const rows = await tx.$queryRaw<Array<{ id: string; responsibleUserId: string; number: string }>>(Prisma.sql`
        SELECT "id", "responsibleUserId", "number" FROM "support_incidents"
        WHERE "id" = ${input.incidentId}::uuid AND "companyId" = ${input.companyId}::uuid FOR UPDATE
      `);
      const incident = rows[0];
      if (!incident) return { ok: false, replayed: false, result: notFound() };
      const existing = await tx.idempotencyRecord.findUnique({ where: { key: input.idempotencyKey } });
      if (existing) return { ok: true, replayed: true, result: replayResult(existing, input.requestHash) };
      if (!(await hasUploadAuthority(tx, incident.id, incident.responsibleUserId, input.companyId, input.actor))) return { ok: false, replayed: false, result: forbidden() };
      if (input.actionId) {
        const action = await tx.supportIncidentAction.findFirst({ where: { id: input.actionId, incidentId: incident.id, companyId: input.companyId }, select: { id: true } });
        if (!action) return { ok: false, replayed: false, result: notFound() };
      }
      const usage = await tx.attachment.aggregate({ where: { companyId: input.companyId, purpose: "SUPPORT_INCIDENT", status: { not: "PHYSICALLY_DELETED" } }, _sum: { sizeBytes: true } });
      if (Number(usage._sum?.sizeBytes ?? 0n) + input.prepared.bytes.byteLength > supportAttachmentCompanyCapacityBytes) return { ok: false, replayed: false, result: capacityUnavailable() };
      const now = new Date();
      const created = await tx.attachment.create({ data: {
        id: input.attachmentId, companyId: input.companyId, purpose: "SUPPORT_INCIDENT",
        originalFileName: input.prepared.originalFileName, extension: input.prepared.extension,
        declaredMimeType: input.declaredMimeType, detectedMimeType: input.prepared.mediaType,
        sizeBytes: input.prepared.bytes.byteLength, sha256: input.sha256, storageKey: input.storageKey,
        status: "AVAILABLE", scanResult: "CLEAN", scanEngine: input.scanEngine,
        scanEngineVersion: input.scanEngineVersion, scanCompletedAt: now, availableAt: now,
        uploadedById: input.actor.id,
      }, select: attachmentSelect });
      await tx.supportIncidentAttachment.create({ data: { companyId: input.companyId, incidentId: incident.id, actionId: input.actionId, attachmentId: created.id } });
      const value = { attachment: toDto(incident.id, created) };
      await tx.idempotencyRecord.create({ data: { key: input.idempotencyKey, requestHash: input.requestHash, responseStatus: 201, responseBody: value } });
      await tx.auditEvent.create({ data: { eventType: "SUPPORT_INCIDENT_ATTACHMENT_UPLOADED", actorType: "USER", payload: { actorUserId: input.actor.id, companyId: input.companyId, incidentId: incident.id, attachmentId: created.id, actionId: input.actionId, mediaType: input.prepared.mediaType, sizeBytes: input.prepared.bytes.byteLength, correlationId: input.correlationId } } });
      return { ok: true, replayed: false, result: { ok: true, status: 201, value } as UploadResult };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        if (attempt < 2) continue;
        throw new AttachmentPersistenceRetryExhausted("SUPPORT_ATTACHMENT_TRANSACTION_RETRY_EXHAUSTED");
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const replay = await readReplay(input.idempotencyKey, input.requestHash);
        if (replay) return { ok: replay.ok, replayed: true, result: replay };
      }
      throw error;
    }
  }
  throw new AttachmentPersistenceRetryExhausted("SUPPORT_ATTACHMENT_TRANSACTION_RETRY_EXHAUSTED");
}

async function uploadAuthority(incidentId: string, companyId: string, actor: SessionUser): Promise<"allowed" | "forbidden" | "missing"> {
  const incident = await prisma.supportIncident.findFirst({ where: { id: incidentId, companyId }, select: { id: true, responsibleUserId: true } });
  if (!incident) return "missing";
  return await hasUploadAuthority(prisma, incident.id, incident.responsibleUserId, companyId, actor) ? "allowed" : "forbidden";
}

async function hasUploadAuthority(client: Pick<Prisma.TransactionClient, "supportIncidentCollaborator">, incidentId: string, responsibleUserId: string, companyId: string, actor: SessionUser): Promise<boolean> {
  if (actor.role.code === "Administrador" || actor.id === responsibleUserId) return true;
  return Boolean(await client.supportIncidentCollaborator.findFirst({ where: { incidentId, companyId, userId: actor.id, removedAt: null }, select: { id: true } }));
}

async function currentCompanyId(): Promise<string | null> {
  return (await prisma.installation.findFirst({ where: { status: "INITIALIZED" }, select: { companyId: true } }))?.companyId ?? null;
}

function toDto(incidentId: string, attachment: { id: string; originalFileName: string; detectedMimeType: string | null; sizeBytes: bigint; uploadedAt: Date; uploadedBy: { id: string; displayName: string } }): SupportIncidentAttachmentDto {
  if (attachment.detectedMimeType !== "image/jpeg" && attachment.detectedMimeType !== "application/pdf") throw new Error("SUPPORT_ATTACHMENT_MEDIA_TYPE_INVALID");
  return { id: attachment.id, originalFileName: attachment.originalFileName, mediaType: attachment.detectedMimeType, sizeBytes: Number(attachment.sizeBytes), uploadedAt: attachment.uploadedAt.toISOString(), uploadedBy: attachment.uploadedBy, downloadUrl: `/api/support/incidents/${incidentId}/attachments/${attachment.id}/download` };
}

async function readReplay(key: string, requestHash: string): Promise<UploadResult | null> {
  const record = await prisma.idempotencyRecord.findUnique({ where: { key } });
  return record ? replayResult(record, requestHash) : null;
}
function replayResult(record: { requestHash: string; responseBody: Prisma.JsonValue }, requestHash: string): UploadResult {
  if (record.requestHash !== requestHash) return { ok: false, status: 409, error: { code: "IDEMPOTENCY_KEY_REUSED", message: "La clave de idempotencia ya se uso con otra peticion." } };
  const parsed = replaySchema.safeParse(record.responseBody);
  return parsed.success ? { ok: true, status: 200, value: parsed.data } : { ok: false, status: 409, error: { code: "IDEMPOTENCY_REPLAY_INVALID", message: "La respuesta idempotente almacenada no es valida." } };
}

async function reconcile(attachmentId: string, companyId: string, incidentId: string, key: string, requestHash: string): Promise<UploadResult | null> {
  const replay = await readReplay(key, requestHash); if (replay?.ok) return replay;
  const link = await prisma.supportIncidentAttachment.findFirst({ where: { attachmentId, companyId, incidentId }, select: { attachment: { select: attachmentSelect } } });
  return link ? { ok: true, status: 200, value: { attachment: toDto(incidentId, link.attachment) } } : null;
}

async function scanFailure(outcome: "clean" | "infected" | "inconclusive", actorUserId: string, companyId: string, incidentId: string, correlationId: string): Promise<UploadResult | null> {
  if (outcome === "clean") return null;
  const code = outcome === "infected" ? "SUPPORT_ATTACHMENT_FILE_REJECTED" : "ANTIVIRUS_UNAVAILABLE";
  await auditRejected(actorUserId, companyId, incidentId, code, correlationId);
  return outcome === "infected" ? { ok: false, status: 422, error: { code, message: "El archivo no supera la validacion de seguridad." } } : { ok: false, status: 503, error: { code, message: "El antivirus no esta disponible. Reintenta mas tarde sin cambiar el archivo.", retryAfterSeconds: 60 } };
}
async function auditRejected(actorUserId: string, companyId: string, incidentId: string, reasonCode: string, correlationId: string): Promise<void> { await prisma.auditEvent.create({ data: { eventType: reasonCode === "ANTIVIRUS_UNAVAILABLE" ? "SUPPORT_ATTACHMENT_SCAN_UNAVAILABLE" : "SUPPORT_ATTACHMENT_UPLOAD_REJECTED", actorType: "USER", payload: { actorUserId, companyId, incidentId, reasonCode, correlationId } } }); }
async function auditCleanupFailure(attachmentId: string, companyId: string, correlationId: string): Promise<void> { await prisma.auditEvent.create({ data: { eventType: "ATTACHMENT_ORPHAN_CLEANUP_FAILED", actorType: "SYSTEM", payload: { attachmentId, companyId, correlationId } } }).catch(() => undefined); }
async function auditUncertain(attachmentId: string, companyId: string, incidentId: string, correlationId: string): Promise<void> { await prisma.auditEvent.create({ data: { eventType: "ATTACHMENT_PERSISTENCE_OUTCOME_UNCERTAIN", actorType: "SYSTEM", payload: { attachmentId, companyId, incidentId, correlationId } } }).catch(() => undefined); }
function validationFailure(code: IncidentAttachmentValidationError["code"]): UploadResult { const messages: Record<IncidentAttachmentValidationError["code"], string> = { SUPPORT_ATTACHMENT_INVALID_NAME: "El nombre del archivo no es valido.", SUPPORT_ATTACHMENT_TOO_LARGE: "El archivo no puede superar 16 MiB.", SUPPORT_ATTACHMENT_UNSUPPORTED_MEDIA_TYPE: "Solo se admiten archivos JPG o PDF.", SUPPORT_ATTACHMENT_CONTENT_INVALID: "El contenido no es un JPG o PDF seguro y valido." }; return { ok: false, status: 422, error: { code, message: messages[code] } }; }
function notFound(): UploadResult { return { ok: false, status: 404, error: { code: "SUPPORT_INCIDENT_NOT_FOUND", message: "La incidencia no existe." } }; }
function forbidden(): UploadResult { return { ok: false, status: 403, error: { code: "SUPPORT_ATTACHMENT_FORBIDDEN", message: "Solo el responsable, un colaborador activo o un administrador puede adjuntar archivos." } }; }
function capacityUnavailable(): UploadResult { return { ok: false, status: 503, error: { code: "SUPPORT_ATTACHMENT_CAPACITY_UNAVAILABLE", message: "La capacidad operativa de adjuntos esta agotada. Contacta con administracion.", retryAfterSeconds: 300 } }; }
function attachmentNotFound(): Extract<DownloadIncidentAttachmentResult, { ok: false }> { return { ok: false, status: 404, error: { code: "SUPPORT_ATTACHMENT_NOT_FOUND", message: "El adjunto no existe." } }; }
function defaultStorage(): FileAttachmentStorage { return new FileAttachmentStorage(getAttachmentStorageRoot()); }
function defaultDependencies(): Dependencies { return { storage: defaultStorage(), scanner: new ClamdAttachmentScanner(getAttachmentClamdScanPath()), prepare: prepareIncidentAttachment }; }
function encodeAttachmentCursor(attachedAt: Date, id: string): string { return Buffer.from(JSON.stringify({ attachedAt: attachedAt.toISOString(), id }), "utf8").toString("base64url"); }
function decodeAttachmentCursor(value: string): { attachedAt: Date; id: string } | null { try { const parsed = z.object({ attachedAt: z.string().datetime(), id: z.string().uuid() }).strict().safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))); return parsed.success ? { attachedAt: new Date(parsed.data.attachedAt), id: parsed.data.id } : null; } catch { return null; } }
