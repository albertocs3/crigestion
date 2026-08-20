import "server-only";

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";

const colorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const categoryValuesSchema = z.object({
  expectedVersion: z.number().int().positive(),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().min(3).max(500).nullable(),
  color: colorSchema,
  reason: z.string().trim().min(3).max(500),
}).strict();

const supportCategoryChangeBaseSchema = z.discriminatedUnion("action", [
  categoryValuesSchema.extend({ action: z.literal("update") }).strict(),
  z.object({
    action: z.literal("set-status"),
    expectedVersion: z.number().int().positive(),
    isActive: z.boolean(),
    confirmation: z.enum(["ACTIVATE_SUPPORT_CATEGORY", "DEACTIVATE_SUPPORT_CATEGORY"]),
    reason: z.string().trim().min(3).max(500),
  }).strict(),
]);
export const supportCategoryChangeSchema = supportCategoryChangeBaseSchema.superRefine((value, context) => {
  if (value.action !== "set-status") return;
  const expected = value.isActive ? "ACTIVATE_SUPPORT_CATEGORY" : "DEACTIVATE_SUPPORT_CATEGORY";
  if (value.confirmation !== expected) context.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmation"], message: "La confirmación no coincide con el estado solicitado." });
});

export const supportCategoryParamsSchema = z.object({ categoryId: z.string().uuid() }).strict();
export type SupportCategoryChangeCommand = z.infer<typeof supportCategoryChangeSchema>;
export type SupportCategoryChangeContext = RequestContext & { idempotencyKey: string; requestHash: string; scope: string };

const changedFieldSchema = z.enum(["name", "description", "color", "isActive"]);
export type SupportCategoryChangeDto = {
  category: { id: string; name: string; description: string | null; color: string; isActive: boolean; version: number };
  change: { id: string; type: "UPDATE" | "STATUS"; resultingVersion: number; changedFields: Array<z.infer<typeof changedFieldSchema>>; changedAt: string };
};

const replaySchema: z.ZodType<SupportCategoryChangeDto> = z.object({
  category: z.object({ id: z.string().uuid(), name: z.string(), description: z.string().nullable(), color: colorSchema, isActive: z.boolean(), version: z.number().int().positive() }).strict(),
  change: z.object({ id: z.string().uuid(), type: z.enum(["UPDATE", "STATUS"]), resultingVersion: z.number().int().positive(), changedFields: z.array(changedFieldSchema).min(1), changedAt: z.string().datetime() }).strict(),
}).strict();

type FailureStatus = 403 | 404 | 409 | 429 | 503;
type FailureCode = "SUPPORT_CATEGORY_CHANGE_FORBIDDEN" | "SUPPORT_CATEGORY_NOT_FOUND" | "SUPPORT_CATEGORY_VERSION_CONFLICT" | "SUPPORT_CATEGORY_UNCHANGED" | "SUPPORT_CATEGORY_ALREADY_EXISTS" | "SUPPORT_CATEGORY_LAST_ACTIVE" | "SUPPORT_CATEGORY_RATE_LIMITED" | "SUPPORT_CATEGORY_BUSY" | "IDEMPOTENCY_KEY_REUSED" | "IDEMPOTENCY_REPLAY_INVALID";
type Failure = { ok: false; status: FailureStatus; error: { code: FailureCode; message: string; retryAfterSeconds?: number } };
export type SupportCategoryChangeResult = { ok: true; status: 200 | 201; value: SupportCategoryChangeDto } | Failure;

type LockedCategory = { id: string; companyId: string; name: string; normalizedName: string; description: string | null; color: string; isActive: boolean; version: number };

export async function changeSupportCategory(categoryId: string, command: SupportCategoryChangeCommand, actor: SessionUser, context: SupportCategoryChangeContext): Promise<SupportCategoryChangeResult> {
  if (!actor.permissions.includes("Support.View") || !actor.permissions.includes("Support.ManageCategories")) {
    return fail(403, "SUPPORT_CATEGORY_CHANGE_FORBIDDEN", "No tienes permiso para modificar categorías.");
  }
  const key = scopedKey(actor, context);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const companyId = (await tx.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId;
        if (!companyId) return fail(404, "SUPPORT_CATEGORY_NOT_FOUND", "La categoría no existe.");
        const stored = await tx.idempotencyRecord.findUnique({ where: { key } });
        if (stored) {
          const categoryExists = await tx.supportIncidentCategory.findFirst({ where: { id: categoryId, companyId }, select: { id: true } });
          if (!categoryExists) {
            await auditDenied(tx, actor.id, companyId, categoryId, "NOT_FOUND", context.correlationId);
            return fail(404, "SUPPORT_CATEGORY_NOT_FOUND", "La categoría no existe.");
          }
          const replay = parseReplay(stored.requestHash, context.requestHash, stored.responseBody);
          if (replay.ok) return replay;
          const rate = await consumeRateLimit(tx, companyId, actor.id);
          if (rate.limited) return rateLimited(tx, actor, companyId, categoryId, rate, context.correlationId);
          await auditDenied(tx, actor.id, companyId, categoryId, replay.error.code, context.correlationId);
          return replay;
        }
        const rate = await consumeRateLimit(tx, companyId, actor.id);
        if (rate.limited) return rateLimited(tx, actor, companyId, categoryId, rate, context.correlationId);

        const categories = await tx.$queryRaw<LockedCategory[]>(Prisma.sql`
          SELECT "id", "companyId", "name", "normalizedName", "description", "color", "isActive", "version"
          FROM "support_incident_categories"
          WHERE "companyId" = ${companyId}::uuid
          ORDER BY "id"
          FOR UPDATE
        `);
        const category = categories.find((item) => item.id === categoryId);
        if (!category) {
          await auditDenied(tx, actor.id, companyId, categoryId, "NOT_FOUND", context.correlationId);
          return fail(404, "SUPPORT_CATEGORY_NOT_FOUND", "La categoría no existe.");
        }
        if (category.version !== command.expectedVersion) {
          await auditDenied(tx, actor.id, companyId, categoryId, "VERSION_CONFLICT", context.correlationId);
          return fail(409, "SUPPORT_CATEGORY_VERSION_CONFLICT", "La categoría ha cambiado. Recarga antes de continuar.");
        }

        const next = command.action === "update"
          ? { name: command.name, normalizedName: await normalizeSupportCategoryName(tx, command.name), description: command.description, color: command.color, isActive: category.isActive }
          : { name: category.name, normalizedName: category.normalizedName, description: category.description, color: category.color, isActive: command.isActive };
        if (categories.some((item) => item.id !== categoryId && item.normalizedName === next.normalizedName)) {
          await auditDenied(tx, actor.id, companyId, categoryId, "NAME_CONFLICT", context.correlationId);
          return fail(409, "SUPPORT_CATEGORY_ALREADY_EXISTS", "Ya existe una categoría con ese nombre.");
        }
        const changedFields = changedFieldsFor(category, next);
        if (changedFields.length === 0) {
          await auditDenied(tx, actor.id, companyId, categoryId, "UNCHANGED", context.correlationId);
          return fail(409, "SUPPORT_CATEGORY_UNCHANGED", "No se ha indicado ningún cambio.");
        }
        if (!next.isActive && category.isActive && categories.filter((item) => item.isActive).length === 1) {
          await auditDenied(tx, actor.id, companyId, categoryId, "LAST_ACTIVE", context.correlationId);
          return fail(409, "SUPPORT_CATEGORY_LAST_ACTIVE", "Debe permanecer al menos una categoría activa.");
        }

        const resultingVersion = category.version + 1;
        const now = new Date();
        const change = await tx.supportIncidentCategoryChange.create({
          data: {
            companyId, categoryId, actorUserId: actor.id,
            previousName: category.name, correctedName: next.name,
            previousNormalizedName: category.normalizedName, correctedNormalizedName: next.normalizedName,
            previousDescription: category.description, correctedDescription: next.description,
            previousColor: category.color, correctedColor: next.color,
            previousIsActive: category.isActive, correctedIsActive: next.isActive,
            reason: command.reason, resultingVersion, changedAt: now,
          },
          select: { id: true, changedAt: true },
        });
        const updated = await tx.supportIncidentCategory.update({
          where: { id: categoryId },
          data: { ...next, version: resultingVersion, updatedAt: now },
          select: { id: true, name: true, description: true, color: true, isActive: true, version: true },
        });
        const value: SupportCategoryChangeDto = {
          category: updated,
          change: { id: change.id, type: command.action === "update" ? "UPDATE" : "STATUS", resultingVersion, changedFields, changedAt: change.changedAt.toISOString() },
        };
        await tx.auditEvent.create({ data: { eventType: "SUPPORT_INCIDENT_CATEGORY_CHANGED", actorType: "USER", payload: { actorUserId: actor.id, companyId, categoryId, categoryChangeId: change.id, changeType: value.change.type, previousVersion: category.version, version: resultingVersion, changedFields, previousIsActive: category.isActive, isActive: next.isActive, ...(context.correlationId ? { correlationId: context.correlationId } : {}) } } });
        await tx.idempotencyRecord.create({ data: { key, requestHash: context.requestHash, responseStatus: 201, responseBody: value as unknown as Prisma.InputJsonValue } });
        return { ok: true, status: 201, value };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isSerializationConflict(error)) {
        if (attempt < 2) continue;
        return fail(503, "SUPPORT_CATEGORY_BUSY", "No se pudo completar el cambio por concurrencia. Inténtalo de nuevo.", 3);
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const replay = await prisma.idempotencyRecord.findUnique({ where: { key } });
        if (replay) return parseReplay(replay.requestHash, context.requestHash, replay.responseBody);
        return fail(409, "SUPPORT_CATEGORY_ALREADY_EXISTS", "Ya existe una categoría con ese nombre.");
      }
      throw error;
    }
  }
  return fail(503, "SUPPORT_CATEGORY_BUSY", "No se pudo completar el cambio por concurrencia. Inténtalo de nuevo.", 3);
}

export function hashSupportCategoryChangeRequest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

async function normalizeSupportCategoryName(tx: Prisma.TransactionClient, value: string): Promise<string> { const [row] = await tx.$queryRaw<Array<{ value: string }>>(Prisma.sql`SELECT lower(unaccent(btrim(${value}))) AS "value"`); if (!row) throw new Error("SUPPORT_CATEGORY_NORMALIZATION_FAILED"); return row.value; }
function changedFieldsFor(current: LockedCategory, next: Pick<LockedCategory, "name" | "normalizedName" | "description" | "color" | "isActive">): SupportCategoryChangeDto["change"]["changedFields"] {
  const fields: SupportCategoryChangeDto["change"]["changedFields"] = [];
  if (current.name !== next.name) fields.push("name");
  if (current.description !== next.description) fields.push("description");
  if (current.color !== next.color) fields.push("color");
  if (current.isActive !== next.isActive) fields.push("isActive");
  return fields;
}
function scopedKey(actor: SessionUser, context: SupportCategoryChangeContext): string { return `v1:support:${createHash("sha256").update(`${actor.id}:${context.scope}:${context.idempotencyKey}`).digest("hex")}`; }
function parseReplay(storedHash: string, requestHash: string, body: Prisma.JsonValue): SupportCategoryChangeResult {
  if (storedHash !== requestHash) return fail(409, "IDEMPOTENCY_KEY_REUSED", "La clave de idempotencia ya se usó con otra petición.");
  const parsed = replaySchema.safeParse(body);
  return parsed.success ? { ok: true, status: 200, value: parsed.data } : fail(409, "IDEMPOTENCY_REPLAY_INVALID", "La respuesta idempotente almacenada no es válida.");
}
function fail(status: FailureStatus, code: FailureCode, message: string, retryAfterSeconds?: number): Failure { return { ok: false, status, error: { code, message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) } }; }
function isSerializationConflict(error: unknown): boolean { return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001")); }
async function auditDenied(tx: Prisma.TransactionClient, actorUserId: string, companyId: string, categoryId: string, reason: string, correlationId?: string): Promise<void> { await tx.auditEvent.create({ data: { eventType: "SUPPORT_INCIDENT_CATEGORY_CHANGE_DENIED", actorType: "USER", payload: { actorUserId, companyId, categoryFingerprint: createHash("sha256").update(categoryId).digest("hex"), reason, ...(correlationId ? { correlationId } : {}) } } }); }
async function rateLimited(tx: Prisma.TransactionClient, actor: SessionUser, companyId: string, categoryId: string, rate: { limited: true; firstLimitedRequest: boolean; retryAfterSeconds: number }, correlationId?: string): Promise<Failure> { if (rate.firstLimitedRequest) await auditDenied(tx, actor.id, companyId, categoryId, "RATE_LIMITED", correlationId); return fail(429, "SUPPORT_CATEGORY_RATE_LIMITED", "Se han realizado demasiados intentos. Inténtalo más tarde.", rate.retryAfterSeconds); }
async function consumeRateLimit(tx: Prisma.TransactionClient, companyId: string, actorId: string): Promise<{ limited: false } | { limited: true; firstLimitedRequest: boolean; retryAfterSeconds: number }> {
  const now = new Date(); const windowMs = 15 * 60 * 1000; const resetBefore = new Date(now.getTime() - windowMs);
  const [bucket] = await tx.$queryRaw<Array<{ count: number; windowStart: Date }>>(Prisma.sql`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), ${`support-category-change:${companyId}:${actorId}`}, ${now}, 1, ${now}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${resetBefore} THEN 1 ELSE "rate_limit_buckets"."count" + 1 END,
      "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${resetBefore} THEN ${now} ELSE "rate_limit_buckets"."windowStart" END,
      "updatedAt" = ${now}
    RETURNING "count", "windowStart"
  `);
  if (!bucket || bucket.count <= 20) return { limited: false };
  return { limited: true, firstLimitedRequest: bucket.count === 21, retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStart.getTime() + windowMs - now.getTime()) / 1000)) };
}
