import "server-only";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type {
  RequestContext,
  SessionUser
} from "@/modules/platform/application/auth";

const singletonKey = 1;
const operationExclusionAdvisoryLockKey = 72072072;

export const updateMaintenanceModeSchema = z.discriminatedUnion("enabled", [
  z.object({
    enabled: z.literal(true),
    restoreOperationId: z.string().uuid(),
    reason: z.string().trim().min(10).max(500)
  }),
  z.object({
    enabled: z.literal(false),
    reason: z.string().trim().max(500).optional()
  })
]);

export type UpdateMaintenanceModeCommand = z.infer<
  typeof updateMaintenanceModeSchema
>;

export type MaintenanceModeState = {
  enabled: boolean;
  mode: "RESTORE" | null;
  reason: string | null;
  restoreOperation: null | {
    id: string;
    status: string;
    backupOperationId: string;
  };
  enabledBy: null | {
    id: string;
    displayName: string;
    userName: string;
  };
  disabledBy: null | {
    id: string;
    displayName: string;
    userName: string;
  };
  enabledAt: string | null;
  disabledAt: string | null;
};

export type UpdateMaintenanceModeResult =
  | { ok: true; status: 200; value: MaintenanceModeState }
  | {
      ok: false;
      status: 404 | 409;
      error: {
        code:
          | "RESTORE_OPERATION_NOT_FOUND"
          | "RESTORE_OPERATION_NOT_VALIDATED"
          | "MAINTENANCE_MODE_ALREADY_ENABLED"
          | "MAINTENANCE_MODE_NOT_ENABLED";
        message: string;
      };
    };

export type MaintenanceMutationGuardResult =
  | { ok: true }
  | {
      ok: false;
      status: 423;
      error: {
        code: "MAINTENANCE_MODE_ACTIVE";
        message: string;
      };
    };

export async function getMaintenanceModeState(): Promise<MaintenanceModeState> {
  const state = await prisma.platformMaintenanceState.findUnique({
    where: { singletonKey },
    select: maintenanceStateSelect
  });

  return state ? mapMaintenanceState(state) : emptyMaintenanceState();
}

export async function updateMaintenanceMode(
  command: UpdateMaintenanceModeCommand,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<UpdateMaintenanceModeResult> {
  if (command.enabled) {
    return enableMaintenanceMode(command, actor, context);
  }

  return disableMaintenanceMode(actor, context);
}

export async function requireMaintenanceModeInactive(
  actor: SessionUser,
  request: Pick<Request, "method" | "url">,
  context: Pick<RequestContext, "correlationId"> = {}
): Promise<MaintenanceMutationGuardResult> {
  const active = await prisma.platformMaintenanceState.findFirst({
    where: {
      singletonKey,
      enabled: true
    },
    select: {
      mode: true,
      restoreOperationId: true
    }
  });

  if (!active) {
    return { ok: true };
  }

  await prisma.auditEvent.create({
    data: {
      eventType: "MAINTENANCE_MUTATION_BLOCKED",
      actorType: "USER",
      payload: {
        actorUserId: actor.id,
        method: request.method,
        path: safePath(request.url),
        mode: active.mode,
        restoreOperationId: active.restoreOperationId,
        ...(context.correlationId ? { correlationId: context.correlationId } : {})
      }
    }
  });

  return {
    ok: false,
    status: 423,
    error: {
      code: "MAINTENANCE_MODE_ACTIVE",
      message: "La plataforma esta en modo mantenimiento."
    }
  };
}

async function enableMaintenanceMode(
  command: Extract<UpdateMaintenanceModeCommand, { enabled: true }>,
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId">
): Promise<UpdateMaintenanceModeResult> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${operationExclusionAdvisoryLockKey})`;

    const activeState = await tx.platformMaintenanceState.findFirst({
      where: { singletonKey, enabled: true },
      select: { id: true }
    });

    if (activeState) {
      return null;
    }

    const restoreOperation = await tx.restoreOperation.findUnique({
      where: { id: command.restoreOperationId },
      select: {
        id: true,
        status: true,
        backupOperationId: true
      }
    });

    if (!restoreOperation) {
      return { kind: "missing" } as const;
    }

    if (restoreOperation.status !== "VALIDATED") {
      return { kind: "notValidated" } as const;
    }

    const now = new Date();
    const state = await tx.platformMaintenanceState.upsert({
      where: { singletonKey },
      update: {
        enabled: true,
        mode: "RESTORE",
        reason: command.reason,
        restoreOperationId: restoreOperation.id,
        enabledById: actor.id,
        disabledById: null,
        enabledAt: now,
        disabledAt: null
      },
      create: {
        singletonKey,
        enabled: true,
        mode: "RESTORE",
        reason: command.reason,
        restoreOperationId: restoreOperation.id,
        enabledById: actor.id,
        enabledAt: now
      },
      select: maintenanceStateSelect
    });

    await tx.auditEvent.create({
      data: {
        eventType: "MAINTENANCE_MODE_ENABLED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          mode: "RESTORE",
          restoreOperationId: restoreOperation.id,
          backupOperationId: restoreOperation.backupOperationId,
          reasonLength: command.reason.length,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return { kind: "enabled", state } as const;
  });

  if (!result) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "MAINTENANCE_MODE_ALREADY_ENABLED",
        message: "El modo mantenimiento ya esta activo."
      }
    };
  }

  if (result.kind === "missing") {
    return {
      ok: false,
      status: 404,
      error: {
        code: "RESTORE_OPERATION_NOT_FOUND",
        message: "La restauracion indicada no existe."
      }
    };
  }

  if (result.kind === "notValidated") {
    return {
      ok: false,
      status: 409,
      error: {
        code: "RESTORE_OPERATION_NOT_VALIDATED",
        message: "La restauracion debe estar validada antes de activar mantenimiento."
      }
    };
  }

  return {
    ok: true,
    status: 200,
    value: mapMaintenanceState(result.state)
  };
}

async function disableMaintenanceMode(
  actor: SessionUser,
  context: Pick<RequestContext, "correlationId">
): Promise<UpdateMaintenanceModeResult> {
  const result = await prisma.$transaction(async (tx) => {
    const activeState = await tx.platformMaintenanceState.findFirst({
      where: { singletonKey, enabled: true },
      select: {
        id: true,
        mode: true,
        restoreOperationId: true
      }
    });

    if (!activeState) {
      return null;
    }

    const state = await tx.platformMaintenanceState.update({
      where: { singletonKey },
      data: {
        enabled: false,
        disabledById: actor.id,
        disabledAt: new Date()
      },
      select: maintenanceStateSelect
    });

    await tx.auditEvent.create({
      data: {
        eventType: "MAINTENANCE_MODE_DISABLED",
        actorType: "USER",
        payload: {
          actorUserId: actor.id,
          mode: activeState.mode,
          restoreOperationId: activeState.restoreOperationId,
          ...(context.correlationId ? { correlationId: context.correlationId } : {})
        }
      }
    });

    return state;
  });

  if (!result) {
    return {
      ok: false,
      status: 409,
      error: {
        code: "MAINTENANCE_MODE_NOT_ENABLED",
        message: "El modo mantenimiento no esta activo."
      }
    };
  }

  return {
    ok: true,
    status: 200,
    value: mapMaintenanceState(result)
  };
}

const maintenanceStateSelect = {
  enabled: true,
  mode: true,
  reason: true,
  enabledAt: true,
  disabledAt: true,
  restoreOperation: {
    select: {
      id: true,
      status: true,
      backupOperationId: true
    }
  },
  enabledBy: {
    select: {
      id: true,
      displayName: true,
      userName: true
    }
  },
  disabledBy: {
    select: {
      id: true,
      displayName: true,
      userName: true
    }
  }
} as const;

function mapMaintenanceState(state: {
  enabled: boolean;
  mode: "RESTORE" | null;
  reason: string | null;
  enabledAt: Date | null;
  disabledAt: Date | null;
  restoreOperation: null | {
    id: string;
    status: string;
    backupOperationId: string;
  };
  enabledBy: null | {
    id: string;
    displayName: string;
    userName: string;
  };
  disabledBy: null | {
    id: string;
    displayName: string;
    userName: string;
  };
}): MaintenanceModeState {
  return {
    enabled: state.enabled,
    mode: state.mode,
    reason: state.reason,
    restoreOperation: state.restoreOperation,
    enabledBy: state.enabledBy,
    disabledBy: state.disabledBy,
    enabledAt: state.enabledAt?.toISOString() ?? null,
    disabledAt: state.disabledAt?.toISOString() ?? null
  };
}

function emptyMaintenanceState(): MaintenanceModeState {
  return {
    enabled: false,
    mode: null,
    reason: null,
    restoreOperation: null,
    enabledBy: null,
    disabledBy: null,
    enabledAt: null,
    disabledAt: null
  };
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "unknown";
  }
}
