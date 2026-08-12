import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidDateOnly, "La fecha no es valida.");
const statuses = ["NEW", "IN_PROGRESS", "PENDING_CUSTOMER", "PENDING_THIRD_PARTY"] as const;
const priorities = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

export const supportIndicatorsQuerySchema = z.object({
  from: dateOnlySchema,
  to: dateOnlySchema,
  scope: z.enum(["self", "global"]).default("self"),
  technicianId: z.string().uuid().optional(),
}).strict().superRefine((value, context) => {
  if (value.from > value.to) context.addIssue({ code: "custom", path: ["to"], message: "La fecha final no puede ser anterior a la inicial." });
  if (differenceInDays(value.from, value.to) > 365) context.addIssue({ code: "custom", path: ["to"], message: "El periodo no puede superar 366 dias." });
  if (value.scope === "self" && value.technicianId) context.addIssue({ code: "custom", path: ["technicianId"], message: "El tecnico solo puede seleccionarse en alcance global." });
});

export type SupportIndicatorsQuery = z.infer<typeof supportIndicatorsQuerySchema>;
type Metric = { value: number | null; sampleSize: number };
type Technician = { id: string; displayName: string };
type Breakdown = Technician & {
  assignedOpen: number;
  averageFirstActionSeconds: Metric;
  averageResolutionSeconds: Metric;
  resolvedCount: number;
  closedCount: number;
};

export type SupportIndicatorsDto = {
  period: { from: string; to: string; timeZone: "Europe/Madrid" };
  scope: { type: "SELF" | "GLOBAL" | "TECHNICIAN"; technician?: Technician };
  snapshot: {
    asOf: string;
    openByStatus: Record<(typeof statuses)[number], number>;
    openByPriority: Record<(typeof priorities)[number], number>;
    assignedByTechnician?: Array<Technician & { count: number }>;
  };
  performance: {
    averageFirstActionSeconds: Metric;
    averageResolutionSeconds: Metric;
    resolvedCount: number;
    closedCount: number;
  };
  breakdown?: Breakdown[];
};

type Failure = { ok: false; status: 403 | 404 | 429; error: { code: "SUPPORT_INDICATORS_FORBIDDEN" | "SUPPORT_INDICATORS_SCOPE_FORBIDDEN" | "SUPPORT_TECHNICIAN_NOT_FOUND" | "SUPPORT_INDICATORS_RATE_LIMITED"; message: string; retryAfterSeconds?: number } };
export type SupportIndicatorsResult = { ok: true; value: SupportIndicatorsDto } | Failure;
type SnapshotRow = { responsibleUserId: string; status: (typeof statuses)[number]; priority: (typeof priorities)[number]; count: number };
type DurationRow = { ownerUserId: string; sampleSize: number; totalSeconds: number };
type CountRow = { ownerUserId: string; count: number };

export async function getSupportIndicators(query: SupportIndicatorsQuery, actor: SessionUser, context: RequestContext = {}): Promise<SupportIndicatorsResult> {
  if (!actor.permissions.includes("Support.View") || !actor.permissions.includes("Support.ViewIndicators")) {
    return failure(403, "SUPPORT_INDICATORS_FORBIDDEN", "No tienes permiso para consultar indicadores de atencion al cliente.");
  }
  const globalRequested = query.scope === "global";
  if (globalRequested && !actor.permissions.includes("Support.ViewGlobalIndicators")) {
    await auditScopeDenied(actor, query, context);
    return failure(403, "SUPPORT_INDICATORS_SCOPE_FORBIDDEN", "No tienes permiso para consultar indicadores globales.");
  }

  return prisma.$transaction(async (tx) => {
    const companyId = (await tx.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId;
    if (!companyId) return failure(404, "SUPPORT_TECHNICIAN_NOT_FOUND", "El tecnico no existe.");
    const rate = await consumeIndicatorRateLimit(tx, companyId, actor.id);
    if (rate.limited) {
      if (rate.firstLimitedRequest) await tx.auditEvent.create({ data: { eventType: "SUPPORT_INDICATORS_RATE_LIMITED", actorType: "USER", payload: { actorUserId: actor.id, companyId, retryAfterSeconds: rate.retryAfterSeconds, ...(context.correlationId ? { correlationId: context.correlationId } : {}) } } });
      return { ok: false, status: 429, error: { code: "SUPPORT_INDICATORS_RATE_LIMITED", message: "Se han realizado demasiadas consultas de indicadores.", retryAfterSeconds: rate.retryAfterSeconds } };
    }

    const targetId = query.scope === "self" ? actor.id : query.technicianId ?? null;
    const target = targetId ? await tx.user.findFirst({
      where: { id: targetId, status: "ACTIVE", AND: [
        { role: { permissions: { some: { permission: { code: "Support.View" } } } } },
        { role: { permissions: { some: { permission: { code: "Support.ViewIndicators" } } } } },
      ] },
      select: { id: true, displayName: true },
    }) : null;
    if (targetId && !target) return failure(404, "SUPPORT_TECHNICIAN_NOT_FOUND", "El tecnico no existe.");

    const targetFilter = targetId ? Prisma.sql`AND i."responsibleUserId" = ${targetId}::uuid` : Prisma.empty;
    const ownerFilter = targetId ? Prisma.sql`AND metric."ownerUserId" = ${targetId}::uuid` : Prisma.empty;
    const [clock, snapshotRows, firstActionRows, resolutionRows, resolvedRows, closedRows] = await Promise.all([
      tx.$queryRaw<Array<{ asOf: Date }>>(Prisma.sql`SELECT transaction_timestamp() AS "asOf"`),
      tx.$queryRaw<SnapshotRow[]>(Prisma.sql`
        SELECT i."responsibleUserId", i."status", i."priority", count(*)::int AS "count"
        FROM "support_incidents" i
        WHERE i."companyId" = ${companyId}::uuid
          AND i."mergedIntoIncidentId" IS NULL
          AND i."status" IN ('NEW', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_THIRD_PARTY')
          ${targetFilter}
        GROUP BY i."responsibleUserId", i."status", i."priority"
      `),
      tx.$queryRaw<DurationRow[]>(Prisma.sql`
        WITH first_actions AS (
          SELECT DISTINCT ON (i."id")
            a."authorUserId" AS "ownerUserId", i."createdAt", a."performedAt"
          FROM "support_incidents" i
          JOIN "support_incident_actions" a
            ON a."companyId" = i."companyId" AND a."incidentId" = i."id"
          WHERE i."companyId" = ${companyId}::uuid AND i."mergedIntoIncidentId" IS NULL
            AND i."firstActionAt" >= (${query.from}::date::timestamp AT TIME ZONE 'Europe/Madrid')
            AND i."firstActionAt" < ((${query.to}::date + 1)::timestamp AT TIME ZONE 'Europe/Madrid')
            ${targetId ? Prisma.sql`AND a."authorUserId" = ${targetId}::uuid` : Prisma.empty}
          ORDER BY i."id", a."performedAt", a."recordedAt", a."id"
        ), metric AS (
          SELECT "ownerUserId", GREATEST(0, extract(epoch FROM ("performedAt" - "createdAt"))) AS seconds
          FROM first_actions
          WHERE "performedAt" >= (${query.from}::date::timestamp AT TIME ZONE 'Europe/Madrid')
            AND "performedAt" < ((${query.to}::date + 1)::timestamp AT TIME ZONE 'Europe/Madrid')
        )
        SELECT metric."ownerUserId", count(*)::int AS "sampleSize", sum(metric.seconds)::double precision AS "totalSeconds"
        FROM metric WHERE true ${ownerFilter}
        GROUP BY metric."ownerUserId"
      `),
      tx.$queryRaw<DurationRow[]>(Prisma.sql`
        WITH resolutions AS (
          SELECT t."id", t."incidentId", t."resultingVersion", t."occurredAt" AS "endedAt",
            e."responsibleUserIdAtEvent" AS "ownerUserId", i."createdAt"
          FROM "support_incident_status_transitions" t
          JOIN "support_incident_events" e ON e."transitionId" = t."id" AND e."companyId" = t."companyId"
          JOIN "support_incidents" i ON i."id" = t."incidentId" AND i."companyId" = t."companyId"
          WHERE t."companyId" = ${companyId}::uuid AND t."toStatus" = 'RESOLVED'
            AND i."mergedIntoIncidentId" IS NULL AND e."responsibleUserIdAtEvent" IS NOT NULL
            AND t."occurredAt" >= (${query.from}::date::timestamp AT TIME ZONE 'Europe/Madrid')
            AND t."occurredAt" < ((${query.to}::date + 1)::timestamp AT TIME ZONE 'Europe/Madrid')
            ${targetId ? Prisma.sql`AND e."responsibleUserIdAtEvent" = ${targetId}::uuid` : Prisma.empty}
        ), relevant_incidents AS (
          SELECT DISTINCT "incidentId" AS "id" FROM resolutions
        ), canonical AS (
          SELECT i."id", i."createdAt" FROM "support_incidents" i
          JOIN relevant_incidents relevant ON relevant."id" = i."id"
          WHERE i."companyId" = ${companyId}::uuid
        ), state_points AS (
          SELECT i."id" AS "incidentId", 1 AS version, i."createdAt" AS "startedAt", 'NEW'::"SupportIncidentStatus" AS state
          FROM canonical i
          UNION ALL
          SELECT e."incidentId", e."resultingVersion" AS version,
            COALESCE(t."occurredAt", e."createdAt") AS "startedAt", e."toStatus" AS state
          FROM "support_incident_events" e
          JOIN canonical i ON i."id" = e."incidentId"
          LEFT JOIN "support_incident_status_transitions" t
            ON t."id" = e."transitionId" AND t."companyId" = e."companyId"
          WHERE e."companyId" = ${companyId}::uuid AND e."resultingVersion" > 1
            AND e."toStatus" IS NOT NULL AND e."fromStatus" IS DISTINCT FROM e."toStatus"
        ), segments AS (
          SELECT "incidentId", state, "startedAt",
            lead("startedAt") OVER (PARTITION BY "incidentId" ORDER BY version) AS "endedAt"
          FROM state_points
        ), episodes AS (
          SELECT r."id", r."incidentId", r."endedAt", r."ownerUserId",
            COALESCE((
              SELECT reopen."occurredAt" FROM "support_incident_status_transitions" reopen
              WHERE reopen."companyId" = ${companyId}::uuid AND reopen."incidentId" = r."incidentId"
                AND reopen."fromStatus" IN ('RESOLVED', 'CLOSED') AND reopen."toStatus" = 'IN_PROGRESS'
                AND reopen."resultingVersion" < r."resultingVersion"
              ORDER BY reopen."resultingVersion" DESC LIMIT 1
            ), r."createdAt") AS "startedAt"
          FROM resolutions r
        ), metric AS (
          SELECT r."ownerUserId", GREATEST(0,
            extract(epoch FROM (r."endedAt" - r."startedAt")) - COALESCE((
              SELECT sum(extract(epoch FROM (LEAST(COALESCE(s."endedAt", r."endedAt"), r."endedAt") - GREATEST(s."startedAt", r."startedAt"))))
              FROM segments s
              WHERE s."incidentId" = r."incidentId"
                AND s.state IN ('PENDING_CUSTOMER', 'PENDING_THIRD_PARTY')
                AND s."startedAt" < r."endedAt" AND COALESCE(s."endedAt", r."endedAt") > r."startedAt"
            ), 0)
          ) AS seconds
          FROM episodes r
        )
        SELECT metric."ownerUserId", count(*)::int AS "sampleSize", sum(metric.seconds)::double precision AS "totalSeconds"
        FROM metric WHERE true ${ownerFilter}
        GROUP BY metric."ownerUserId"
      `),
      milestoneCounts(tx, companyId, query, targetId, "RESOLVED"),
      milestoneCounts(tx, companyId, query, targetId, "CLOSED"),
    ]);

    const firstAction = aggregateDurations(firstActionRows);
    const resolution = aggregateDurations(resolutionRows);
    const resolvedCount = sumCounts(resolvedRows);
    const closedCount = sumCounts(closedRows);
    const openByStatus = zeroRecord(statuses);
    const openByPriority = zeroRecord(priorities);
    for (const row of snapshotRows) { openByStatus[row.status] += row.count; openByPriority[row.priority] += row.count; }

    const dto: SupportIndicatorsDto = {
      period: { from: query.from, to: query.to, timeZone: "Europe/Madrid" },
      scope: query.scope === "self" ? { type: "SELF", technician: target! } : target ? { type: "TECHNICIAN", technician: target } : { type: "GLOBAL" },
      snapshot: { asOf: (clock[0]?.asOf ?? new Date()).toISOString(), openByStatus, openByPriority },
      performance: { averageFirstActionSeconds: firstAction, averageResolutionSeconds: resolution, resolvedCount, closedCount },
    };

    if (query.scope === "global" && !targetId) {
      const metricIds = new Set([...snapshotRows.map((row) => row.responsibleUserId), ...firstActionRows.map((row) => row.ownerUserId), ...resolutionRows.map((row) => row.ownerUserId), ...resolvedRows.map((row) => row.ownerUserId), ...closedRows.map((row) => row.ownerUserId)]);
      const eligible = await tx.user.findMany({ where: { status: "ACTIVE", AND: [
        { role: { permissions: { some: { permission: { code: "Support.View" } } } } },
        { role: { permissions: { some: { permission: { code: "Support.ViewIndicators" } } } } },
      ] }, select: { id: true, displayName: true } });
      eligible.forEach((user) => metricIds.add(user.id));
      const users = await tx.user.findMany({ where: { id: { in: [...metricIds] } }, select: { id: true, displayName: true }, orderBy: [{ displayName: "asc" }, { id: "asc" }] });
      dto.snapshot.assignedByTechnician = users.map((user) => ({ ...user, count: assignedCount(snapshotRows, user.id) }));
      dto.breakdown = users.map((user) => ({
        ...user,
        assignedOpen: assignedCount(snapshotRows, user.id),
        averageFirstActionSeconds: aggregateDurations(firstActionRows.filter((row) => row.ownerUserId === user.id)),
        averageResolutionSeconds: aggregateDurations(resolutionRows.filter((row) => row.ownerUserId === user.id)),
        resolvedCount: sumCounts(resolvedRows.filter((row) => row.ownerUserId === user.id)),
        closedCount: sumCounts(closedRows.filter((row) => row.ownerUserId === user.id)),
      }));
    }

    await tx.auditEvent.create({ data: { eventType: "SUPPORT_INDICATORS_VIEWED", actorType: "USER", payload: {
      actorUserId: actor.id, companyId, scope: dto.scope.type, from: query.from, to: query.to,
      hasBreakdown: dto.scope.type === "GLOBAL", ...(targetId ? { technicianId: targetId } : {}),
      ...(context.correlationId ? { correlationId: context.correlationId } : {}),
    } } });
    return { ok: true, value: dto };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function listSupportIndicatorTechnicians(actor: SessionUser): Promise<Technician[]> {
  if (!actor.permissions.includes("Support.View") || !actor.permissions.includes("Support.ViewIndicators") || !actor.permissions.includes("Support.ViewGlobalIndicators")) return [];
  return prisma.user.findMany({ where: { status: "ACTIVE", AND: [
    { role: { permissions: { some: { permission: { code: "Support.View" } } } } },
    { role: { permissions: { some: { permission: { code: "Support.ViewIndicators" } } } } },
  ] }, select: { id: true, displayName: true }, orderBy: [{ displayName: "asc" }, { id: "asc" }] });
}

async function milestoneCounts(tx: Prisma.TransactionClient, companyId: string, query: SupportIndicatorsQuery, targetId: string | null, status: "RESOLVED" | "CLOSED"): Promise<CountRow[]> {
  const targetFilter = targetId ? Prisma.sql`AND e."responsibleUserIdAtEvent" = ${targetId}::uuid` : Prisma.empty;
  return tx.$queryRaw<CountRow[]>(Prisma.sql`
    SELECT e."responsibleUserIdAtEvent" AS "ownerUserId", count(*)::int AS "count"
    FROM "support_incident_status_transitions" t
    JOIN "support_incident_events" e ON e."transitionId" = t."id" AND e."companyId" = t."companyId"
    JOIN "support_incidents" i ON i."id" = t."incidentId" AND i."companyId" = t."companyId"
    WHERE t."companyId" = ${companyId}::uuid AND t."toStatus" = ${status}::"SupportIncidentStatus"
      AND i."mergedIntoIncidentId" IS NULL AND e."responsibleUserIdAtEvent" IS NOT NULL
      AND t."occurredAt" >= (${query.from}::date::timestamp AT TIME ZONE 'Europe/Madrid')
      AND t."occurredAt" < ((${query.to}::date + 1)::timestamp AT TIME ZONE 'Europe/Madrid')
      ${targetFilter}
    GROUP BY e."responsibleUserIdAtEvent"
  `);
}

function aggregateDurations(rows: DurationRow[]): Metric {
  const sampleSize = rows.reduce((sum, row) => sum + row.sampleSize, 0);
  const totalSeconds = rows.reduce((sum, row) => sum + row.totalSeconds, 0);
  return { value: sampleSize === 0 ? null : Math.round(totalSeconds / sampleSize), sampleSize };
}
function sumCounts(rows: CountRow[]): number { return rows.reduce((sum, row) => sum + row.count, 0); }
function assignedCount(rows: SnapshotRow[], userId: string): number { return rows.filter((row) => row.responsibleUserId === userId).reduce((sum, row) => sum + row.count, 0); }
function zeroRecord<T extends readonly string[]>(keys: T): Record<T[number], number> { return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T[number], number>; }
function failure(status: Failure["status"], code: Failure["error"]["code"], message: string): Failure { return { ok: false, status, error: { code, message } }; }
function parseDateOnly(value: string): Date { return new Date(`${value}T00:00:00.000Z`); }
function isValidDateOnly(value: string): boolean { const parsed = parseDateOnly(value); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; }
function differenceInDays(from: string, to: string): number { return Math.floor((parseDateOnly(to).getTime() - parseDateOnly(from).getTime()) / 86_400_000); }

async function auditScopeDenied(actor: SessionUser, query: SupportIndicatorsQuery, context: RequestContext): Promise<void> {
  const companyId = (await prisma.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId;
  await prisma.auditEvent.create({ data: { eventType: "SUPPORT_INDICATORS_ACCESS_DENIED", actorType: "USER", payload: {
    actorUserId: actor.id, ...(companyId ? { companyId } : {}), reason: "GLOBAL_SCOPE_FORBIDDEN", from: query.from, to: query.to,
    hasTechnicianTarget: Boolean(query.technicianId), ...(context.correlationId ? { correlationId: context.correlationId } : {}),
  } } });
}

async function consumeIndicatorRateLimit(tx: Prisma.TransactionClient, companyId: string, actorId: string): Promise<{ limited: false } | { limited: true; firstLimitedRequest: boolean; retryAfterSeconds: number }> {
  const now = new Date(); const windowMs = 15 * 60 * 1000; const windowStart = new Date(now.getTime() - windowMs);
  const [bucket] = await tx.$queryRaw<Array<{ count: number; windowStart: Date }>>(Prisma.sql`
    INSERT INTO "rate_limit_buckets" ("id", "key", "windowStart", "count", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), ${`support-indicators:${companyId}:${actorId}`}, ${now}, 1, ${now}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN 1 ELSE "rate_limit_buckets"."count" + 1 END,
      "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" <= ${windowStart} THEN ${now} ELSE "rate_limit_buckets"."windowStart" END,
      "updatedAt" = ${now}
    RETURNING "count", "windowStart"
  `);
  if (!bucket || bucket.count <= 120) return { limited: false };
  return { limited: true, firstLimitedRequest: bucket.count === 121, retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStart.getTime() + windowMs - now.getTime()) / 1000)) };
}

export function defaultSupportIndicatorPeriod(now = new Date()): { from: string; to: string } {
  const to = madridDateOnly(now); const fromDate = parseDateOnly(to); fromDate.setUTCDate(fromDate.getUTCDate() - 29);
  return { from: fromDate.toISOString().slice(0, 10), to };
}
function madridDateOnly(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}
