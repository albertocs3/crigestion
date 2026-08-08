import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { jsonResponse, validationError } from "@/modules/platform/application/http";
import { createPurchaseRectification, createPurchaseRectificationSchema, readPurchaseRectificationReplay } from "@/modules/purchases/application/purchases";
import { authorizePurchaseMutation } from "../../_http";

const paramsSchema = z.object({ purchaseId: z.string().uuid() });
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ purchaseId: string }> }) {
  const auth = await authorizePurchaseMutation(request, "Purchases.Rectify");
  if (!auth.ok) return auth.response;
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return jsonResponse(request, validationError(params.error.flatten()), { status: 422 });
  const parsed = createPurchaseRectificationSchema.safeParse(auth.body);
  if (!parsed.success) return jsonResponse(request, validationError(parsed.error.flatten()), { status: 422 });
  const targetFingerprint = fingerprintTarget(params.data.purchaseId);
  const mutationContext = {
    correlationId: auth.correlationId,
    idempotencyKey: auth.idempotencyKey,
    requestHash: auth.requestHash,
    scope: `rectify:${params.data.purchaseId}`
  };
  const replay = await readPurchaseRectificationReplay(auth.user, mutationContext);
  if (replay?.ok) return jsonResponse(request, replay.value, { status: replay.status });
  if (await consumeRateLimit(auth.user.id, targetFingerprint, auth.correlationId)) {
    return jsonResponse(request, { code: "RATE_LIMITED", message: "Demasiados intentos de rectificación. Espere quince minutos." }, { status: 429, headers: { "Retry-After": "900" } });
  }
  if (replay) {
    await auditDenied(auth.user.id, targetFingerprint, replay.error.code, auth.correlationId);
    return jsonResponse(request, replay.error, { status: replay.status });
  }
  const result = await createPurchaseRectification(params.data.purchaseId, parsed.data, auth.user, mutationContext);
  if (!result.ok) await auditDenied(auth.user.id, targetFingerprint, result.error.code, auth.correlationId);
  return jsonResponse(request, result.ok ? result.value : result.error, {
    status: result.status,
    ...(result.status === 503 ? { headers: { "Retry-After": "3" } } : {})
  });
}

async function consumeRateLimit(userId: string, targetFingerprint: string, correlationId: string): Promise<boolean> {
  const now = new Date(); const windowStart = new Date(now.getTime() - 15 * 60_000);
  return prisma.$transaction(async (tx) => {
    const [bucket] = await tx.$queryRaw<Array<{ count: number; windowStart: Date }>>`
      INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
      VALUES (${randomUUID()}::uuid, ${`purchase-rectification:${userId}`}, ${now}, 1, ${now}, ${now})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN 1 ELSE LEAST("rate_limit_buckets"."count" + 1, 7) END,
        "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN ${now} ELSE "rate_limit_buckets"."windowStart" END,
        "updatedAt" = ${now}
      RETURNING "count", "windowStart"`;
    if (bucket && bucket.count > 5) await tx.auditEvent.upsert({ where: { id: rateLimitAuditId(userId, bucket.windowStart) }, update: {},
      create: { id: rateLimitAuditId(userId, bucket.windowStart), eventType: "PURCHASE_RECTIFICATION_RATE_LIMITED", actorType: "USER", payload: { actorUserId: userId, targetFingerprint, correlationId } } });
    return Boolean(bucket && bucket.count > 5);
  });
}

async function auditDenied(userId: string, targetFingerprint: string, stableCode: string, correlationId: string): Promise<void> {
  try { await prisma.auditEvent.create({ data: { eventType: "PURCHASE_RECTIFICATION_DENIED", actorType: "USER", payload: { actorUserId: userId, targetFingerprint, stableCode, correlationId } } }); }
  catch { console.error("PURCHASE_RECTIFICATION_DENIAL_AUDIT_FAILED", { correlationId }); }
}

function fingerprintTarget(purchaseId: string): string { return createHash("sha256").update(`purchase-rectification:${purchaseId}`).digest("hex"); }
function rateLimitAuditId(userId: string, windowStart: Date): string {
  const hex = createHash("sha256").update(`purchase-rectification-rate-limit:${userId}:${windowStart.toISOString()}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
