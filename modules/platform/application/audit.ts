import "server-only";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";

const defaultLimit = 25;
const maxLimit = 100;
const redactedValue = "[REDACTED]";
const sensitiveKeyPattern =
  /password|token|secret|certificate|privatekey|iban|credential|hash/i;

export const listAuditEventsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  cursor: z.string().uuid().optional(),
  eventType: z.string().trim().min(1).max(120).optional()
});

export type ListAuditEventsCommand = z.infer<typeof listAuditEventsSchema>;

export type AuditEventListItem = {
  id: string;
  eventType: string;
  actorType: string;
  payload: unknown;
  createdAt: string;
};

export type AuditEventList = {
  events: AuditEventListItem[];
  nextCursor: string | null;
};

export async function listAuditEvents(
  command: ListAuditEventsCommand,
  actor: SessionUser
): Promise<AuditEventList> {
  const events = await prisma.auditEvent.findMany({
    where: command.eventType
      ? {
          eventType: command.eventType
        }
      : undefined,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    cursor: command.cursor ? { id: command.cursor } : undefined,
    skip: command.cursor ? 1 : 0,
    take: command.limit + 1,
    select: {
      id: true,
      eventType: true,
      actorType: true,
      payload: true,
      createdAt: true
    }
  });

  const page = events.slice(0, command.limit);
  const nextCursor = events.length > command.limit ? page.at(-1)?.id ?? null : null;

  await prisma.auditEvent.create({
    data: {
      eventType: "AUDIT_VIEWED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        eventType: command.eventType ?? null,
        limit: command.limit,
        cursor: command.cursor ?? null,
        resultCount: page.length
      }
    }
  });

  return {
    events: page.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      actorType: event.actorType,
      payload: sanitizeAuditPayload(event.payload),
      createdAt: event.createdAt.toISOString()
    })),
    nextCursor
  };
}

function sanitizeAuditPayload(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return "[MAX_DEPTH]";
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditPayload(item, depth + 1));
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    sanitized[key] = sensitiveKeyPattern.test(key)
      ? redactedValue
      : sanitizeAuditPayload(child, depth + 1);
  }

  return sanitized;
}
