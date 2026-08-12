import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { RequestContext, SessionUser } from "@/modules/platform/application/auth";

const openStatuses = ["NEW", "IN_PROGRESS", "PENDING_CUSTOMER", "PENDING_THIRD_PARTY"] as const;

type IncidentPreview = {
  id: string;
  number: string;
  title: string;
  status: "NEW" | "IN_PROGRESS" | "PENDING_CUSTOMER" | "PENDING_THIRD_PARTY" | "RESOLVED" | "CLOSED";
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  updatedAt: string;
};

export type SupportDashboardDto = {
  asOf: string;
  snapshot: {
    newCount: number;
    inProgressCount: number;
    pendingCustomerCount: number;
    pendingThirdPartyCount: number;
    pendingCount: number;
    urgentCount: number;
    mineCount: number;
  };
  myIncidents: IncidentPreview[];
  unreadNotifications: {
    count: number;
    items: Array<{
      id: string;
      kind: string;
      severity: "INFO" | "URGENT" | "CRITICAL";
      messageCode: string;
      incident: { id: string; number: string; href: string };
      createdAt: string;
    }>;
  };
  assignedByTechnician?: Array<{ id: string; displayName: string; count: number }>;
  latestCommunications?: Array<{
    id: string;
    channel: "PHONE" | "WHATSAPP";
    direction: "INBOUND" | "OUTBOUND";
    occurredAt: string;
    customer: { id: string; code: string; legalName: string };
    incident: { id: string; number: string } | null;
  }>;
};

type DashboardResult =
  | { ok: true; value: SupportDashboardDto }
  | { ok: false; status: 403 | 409 | 503; error: { code: "SUPPORT_DASHBOARD_FORBIDDEN" | "PLATFORM_NOT_INITIALIZED" | "SUPPORT_DASHBOARD_BUSY"; message: string; retryAfterSeconds?: number } };

type CountRow = {
  newCount: number;
  inProgressCount: number;
  pendingCustomerCount: number;
  pendingThirdPartyCount: number;
  urgentCount: number;
  mineCount: number;
};

export async function getSupportDashboard(actor: SessionUser, context: RequestContext = {}): Promise<DashboardResult> {
  if (!actor.permissions.includes("Support.View")) {
    return { ok: false, status: 403, error: { code: "SUPPORT_DASHBOARD_FORBIDDEN", message: "No tienes permiso para consultar Atención al cliente." } };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
    const companyId = (await tx.installation.findFirst({ where: { companyId: { not: null } }, select: { companyId: true } }))?.companyId;
    if (!companyId) return { ok: false, status: 409, error: { code: "PLATFORM_NOT_INITIALIZED", message: "La plataforma no está inicializada." } } as const;

    const canViewGlobalAssignment = actor.permissions.includes("Support.ViewGlobalIndicators");
    const canViewCommunications = actor.permissions.includes("Support.ViewCommunications");
    const clock = await tx.$queryRaw<Array<{ asOf: Date }>>(Prisma.sql`SELECT transaction_timestamp() AS "asOf"`);
    const asOf = clock[0]?.asOf ?? new Date();
    const [countRows, myRows, notificationRows, unreadCount, assignmentRows, communicationRows] = await Promise.all([
      tx.$queryRaw<CountRow[]>(Prisma.sql`
        WITH open_incidents AS MATERIALIZED (
          SELECT "status", "priority", "responsibleUserId"
          FROM "support_incidents"
          WHERE "companyId" = ${companyId}::uuid
            AND "mergedIntoIncidentId" IS NULL
            AND "status" IN ('NEW', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_THIRD_PARTY')
        )
        SELECT
          count(*) FILTER (WHERE "status" = 'NEW')::int AS "newCount",
          count(*) FILTER (WHERE "status" = 'IN_PROGRESS')::int AS "inProgressCount",
          count(*) FILTER (WHERE "status" = 'PENDING_CUSTOMER')::int AS "pendingCustomerCount",
          count(*) FILTER (WHERE "status" = 'PENDING_THIRD_PARTY')::int AS "pendingThirdPartyCount",
          count(*) FILTER (WHERE "priority" = 'URGENT')::int AS "urgentCount",
          count(*) FILTER (WHERE "responsibleUserId" = ${actor.id}::uuid)::int AS "mineCount"
        FROM open_incidents
      `),
      tx.supportIncident.findMany({
        where: { companyId, responsibleUserId: actor.id, mergedIntoIncidentId: null, status: { in: [...openStatuses] } },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 5,
        select: { id: true, number: true, title: true, status: true, priority: true, updatedAt: true },
      }),
      tx.notification.findMany({
        where: { companyId, recipientUserId: actor.id, status: "UNREAD", expiresAt: { gt: asOf } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 5,
        select: { id: true, kind: true, severity: true, messageCode: true, incidentId: true, incidentNumber: true, createdAt: true },
      }),
      tx.notification.count({ where: { companyId, recipientUserId: actor.id, status: "UNREAD", expiresAt: { gt: asOf } } }),
      canViewGlobalAssignment
        ? tx.$queryRaw<Array<{ id: string; displayName: string; count: number }>>(Prisma.sql`
            SELECT i."responsibleUserId" AS id, u."displayName", count(*)::int AS count
            FROM "support_incidents" i
            JOIN "users" u ON u.id = i."responsibleUserId"
            WHERE i."companyId" = ${companyId}::uuid
              AND i."mergedIntoIncidentId" IS NULL
              AND i."status" IN ('NEW', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_THIRD_PARTY')
            GROUP BY i."responsibleUserId", u."displayName"
            ORDER BY count DESC, u."displayName", i."responsibleUserId"
          `)
        : Promise.resolve(undefined),
      canViewCommunications
        ? tx.supportCommunication.findMany({
            where: { companyId },
            orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
            take: 5,
            select: {
              id: true, channel: true, direction: true, occurredAt: true,
              customer: { select: { id: true, code: true, legalName: true } },
              incident: { select: { id: true, number: true } },
            },
          })
        : Promise.resolve(undefined),
    ]);

    const counts = countRows[0] ?? { newCount: 0, inProgressCount: 0, pendingCustomerCount: 0, pendingThirdPartyCount: 0, urgentCount: 0, mineCount: 0 };
    const dto: SupportDashboardDto = {
      asOf: asOf.toISOString(),
      snapshot: { ...counts, pendingCount: counts.pendingCustomerCount + counts.pendingThirdPartyCount },
      myIncidents: myRows.map((incident) => ({ ...incident, updatedAt: incident.updatedAt.toISOString() })),
      unreadNotifications: {
        count: unreadCount,
        items: notificationRows.map((notification) => ({
          id: notification.id,
          kind: notification.kind,
          severity: notification.severity,
          messageCode: notification.messageCode,
          incident: { id: notification.incidentId, number: notification.incidentNumber, href: `/app/support/incidents/${notification.incidentId}` },
          createdAt: notification.createdAt.toISOString(),
        })),
      },
      ...(assignmentRows ? { assignedByTechnician: assignmentRows } : {}),
      ...(communicationRows ? { latestCommunications: communicationRows.map((communication) => ({ ...communication, occurredAt: communication.occurredAt.toISOString() })) } : {}),
    };

    await tx.auditEvent.create({ data: { eventType: "SUPPORT_DASHBOARD_VIEWED", actorType: "USER", payload: {
      actorUserId: actor.id,
      companyId,
      asOf: dto.asOf,
      disclosedGlobalAssignment: canViewGlobalAssignment,
      disclosedCommunications: canViewCommunications,
      myIncidentResultCount: dto.myIncidents.length,
      notificationResultCount: dto.unreadNotifications.items.length,
      ...(context.correlationId ? { correlationId: context.correlationId } : {}),
    } } });
    return { ok: true, value: dto } as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch (error) {
      if (!isRetryableTransactionError(error)) throw error;
      if (attempt === 2) return { ok: false, status: 503, error: { code: "SUPPORT_DASHBOARD_BUSY", message: "No se pudo obtener una foto consistente del panel. Reinténtalo en unos segundos.", retryAfterSeconds: 3 } };
    }
  }
  return { ok: false, status: 503, error: { code: "SUPPORT_DASHBOARD_BUSY", message: "No se pudo obtener una foto consistente del panel. Reinténtalo en unos segundos.", retryAfterSeconds: 3 } };
}

function isRetryableTransactionError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001"));
}
