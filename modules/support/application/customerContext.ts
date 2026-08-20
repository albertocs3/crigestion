import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type {
  RequestContext,
  SessionUser,
} from "@/modules/platform/application/auth";

const openStatuses = [
  "NEW",
  "IN_PROGRESS",
  "PENDING_CUSTOMER",
  "PENDING_THIRD_PARTY",
] as const;

const finalizedStatuses = ["RESOLVED", "CLOSED"] as const;

type IncidentPreview = {
  id: string;
  number: string;
  title: string;
  status: (typeof openStatuses)[number] | (typeof finalizedStatuses)[number];
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  updatedAt: string;
  mergedInto: { id: string; number: string } | null;
};

export type CustomerSupportContextDto = {
  asOf: string;
  customerId: string;
  openIncidents: { total: number; items: IncidentPreview[] };
  finalizedIncidents: { total: number; items: IncidentPreview[] };
  communications?: {
    total: number;
    items: Array<{
      id: string;
      channel: "PHONE" | "WHATSAPP";
      direction: "INBOUND" | "OUTBOUND";
      occurredAt: string;
      result:
        | "RESOLVED_NO_FOLLOW_UP"
        | "REQUIRES_FOLLOW_UP"
        | "NO_ANSWER"
        | "INFORMATION_PROVIDED"
        | "REFERRED_TO_INCIDENT";
      incident: { id: string; number: string } | null;
    }>;
  };
};

type CustomerSupportContextResult =
  | { ok: true; value: CustomerSupportContextDto }
  | {
      ok: false;
      status: 403 | 404 | 409 | 503;
      error: {
        code:
          | "SUPPORT_CUSTOMER_CONTEXT_FORBIDDEN"
          | "SUPPORT_CUSTOMER_NOT_FOUND"
          | "PLATFORM_NOT_INITIALIZED"
          | "SUPPORT_CUSTOMER_CONTEXT_BUSY";
        message: string;
        retryAfterSeconds?: number;
      };
    };

const incidentSelect = {
  id: true,
  number: true,
  title: true,
  status: true,
  priority: true,
  updatedAt: true,
  mergedIntoIncident: { select: { id: true, number: true } },
} satisfies Prisma.SupportIncidentSelect;

export async function getCustomerSupportContext(
  customerId: string,
  actor: SessionUser,
  context: RequestContext = {},
): Promise<CustomerSupportContextResult> {
  if (
    !actor.permissions.includes("Customers.View") ||
    !actor.permissions.includes("Support.View")
  ) {
    return {
      ok: false,
      status: 403,
      error: {
        code: "SUPPORT_CUSTOMER_CONTEXT_FORBIDDEN",
        message: "No tienes permiso para consultar el contexto de soporte del cliente.",
      },
    };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const installation = await tx.installation.findFirst({
            where: { companyId: { not: null } },
            select: { companyId: true },
          });
          const companyId = installation?.companyId;
          if (!companyId) {
            return {
              ok: false,
              status: 409,
              error: {
                code: "PLATFORM_NOT_INITIALIZED",
                message: "La plataforma no está inicializada.",
              },
            } as const;
          }

          const customer = await tx.customer.findUnique({
            where: { id: customerId },
            select: { id: true },
          });
          if (!customer) {
            return {
              ok: false,
              status: 404,
              error: {
                code: "SUPPORT_CUSTOMER_NOT_FOUND",
                message: "El cliente no existe.",
              },
            } as const;
          }

          const canViewCommunications = actor.permissions.includes(
            "Support.ViewCommunications",
          );
          const clock = await tx.$queryRaw<Array<{ asOf: Date }>>(
            Prisma.sql`SELECT transaction_timestamp() AS "asOf"`,
          );
          const asOf = clock[0]?.asOf ?? new Date();
          const baseWhere = { companyId, customerId } as const;

          const [
            openRows,
            openTotal,
            finalizedRows,
            finalizedTotal,
            communicationRows,
            communicationTotal,
          ] = await Promise.all([
            tx.supportIncident.findMany({
              where: {
                ...baseWhere,
                mergedIntoIncidentId: null,
                status: { in: [...openStatuses] },
              },
              orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
              take: 10,
              select: incidentSelect,
            }),
            tx.supportIncident.count({
              where: {
                ...baseWhere,
                mergedIntoIncidentId: null,
                status: { in: [...openStatuses] },
              },
            }),
            tx.supportIncident.findMany({
              where: {
                ...baseWhere,
                status: { in: [...finalizedStatuses] },
              },
              orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
              take: 10,
              select: incidentSelect,
            }),
            tx.supportIncident.count({
              where: {
                ...baseWhere,
                status: { in: [...finalizedStatuses] },
              },
            }),
            canViewCommunications
              ? tx.supportCommunication.findMany({
                  where: baseWhere,
                  orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
                  take: 10,
                  select: {
                    id: true,
                    channel: true,
                    direction: true,
                    occurredAt: true,
                    result: true,
                    incident: { select: { id: true, number: true } },
                  },
                })
              : Promise.resolve(undefined),
            canViewCommunications
              ? tx.supportCommunication.count({ where: baseWhere })
              : Promise.resolve(undefined),
          ]);

          const value: CustomerSupportContextDto = {
            asOf: asOf.toISOString(),
            customerId,
            openIncidents: {
              total: openTotal,
              items: openRows.map(mapIncident),
            },
            finalizedIncidents: {
              total: finalizedTotal,
              items: finalizedRows.map(mapIncident),
            },
            ...(communicationRows && communicationTotal !== undefined
              ? {
                  communications: {
                    total: communicationTotal,
                    items: communicationRows.map((communication) => ({
                      ...communication,
                      occurredAt: communication.occurredAt.toISOString(),
                    })),
                  },
                }
              : {}),
          };

          await tx.auditEvent.create({
            data: {
              eventType: "SUPPORT_CUSTOMER_CONTEXT_VIEWED",
              actorType: "USER",
              payload: {
                actorUserId: actor.id,
                companyId,
                customerId,
                disclosedCommunications: canViewCommunications,
                openIncidentResultCount: value.openIncidents.items.length,
                finalizedIncidentResultCount:
                  value.finalizedIncidents.items.length,
                communicationResultCount: value.communications?.items.length ?? 0,
                ...(context.correlationId
                  ? { correlationId: context.correlationId }
                  : {}),
              },
            },
          });

          return { ok: true, value } as const;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    } catch (error) {
      if (!isRetryableTransactionError(error)) throw error;
      if (attempt === 2) {
        return {
          ok: false,
          status: 503,
          error: {
            code: "SUPPORT_CUSTOMER_CONTEXT_BUSY",
            message:
              "No se pudo obtener una vista consistente del cliente. Reinténtalo en unos segundos.",
            retryAfterSeconds: 3,
          },
        };
      }
    }
  }

  return {
    ok: false,
    status: 503,
    error: {
      code: "SUPPORT_CUSTOMER_CONTEXT_BUSY",
      message:
        "No se pudo obtener una vista consistente del cliente. Reinténtalo en unos segundos.",
      retryAfterSeconds: 3,
    },
  };
}

function mapIncident(
  incident: Prisma.SupportIncidentGetPayload<{ select: typeof incidentSelect }>,
): IncidentPreview {
  return {
    id: incident.id,
    number: incident.number,
    title: incident.title,
    status: incident.status,
    priority: incident.priority,
    updatedAt: incident.updatedAt.toISOString(),
    mergedInto: incident.mergedIntoIncident,
  };
}

function isRetryableTransactionError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" ||
      (error.code === "P2010" && error.meta?.code === "40001"))
  );
}
