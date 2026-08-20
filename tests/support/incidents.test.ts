import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createCustomer } from "@/modules/customers/application/customers";
import {
  changeCustomerContact,
  createCustomerContact,
  createCustomerContactSchema,
  hashCustomerContactRequest,
  listCustomerContacts,
} from "@/modules/customers/application/contacts";
import { login } from "@/modules/platform/application/auth";
import { hashPassword } from "@/modules/platform/application/passwords";
import { changeNotificationState, hashNotificationStateRequest, listNotifications } from "@/modules/platform/application/notifications";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand,
} from "@/modules/platform/application/installation";
import {
  createSupportAction,
  hashSupportActionRequest,
} from "@/modules/support/application/actions";
import { correctSupportAction, hashSupportActionCorrectionRequest } from "@/modules/support/application/actionCorrections";
import { changeSupportCategory, hashSupportCategoryChangeRequest } from "@/modules/support/application/categoryChanges";
import {
  createIncidentFromCommunication,
  createSupportCategory,
  createSupportIncident,
  getSupportIncident,
  hashSupportRequest,
  listSupportIncidents,
  listSupportReferences,
} from "@/modules/support/application/incidents";
import {
  hashSupportStatusTransitionRequest,
  supportStatusTransitionSchema,
  transitionSupportIncident,
} from "@/modules/support/application/statusTransitions";
import {
  hashSupportIncidentMergeRequest,
  mergeSupportIncidents,
} from "@/modules/support/application/merges";
import {
  changeSupportParticipants,
  hashSupportParticipantRequest,
} from "@/modules/support/application/participants";
import {
  changeSupportIncidentPriority,
  hashSupportPriorityChangeRequest,
} from "@/modules/support/application/priorities";
import {
  changeSupportIncidentDetails,
  hashSupportIncidentDetailsChangeRequest,
} from "@/modules/support/application/detailsChanges";
import {
  changeSupportIncidentCustomer,
  hashSupportIncidentCustomerChangeRequest,
} from "@/modules/support/application/customerChanges";
import {
  correctSupportCommunication,
  createSupportCommunication,
  createSupportCommunicationSchema,
  getSupportCommunication,
  hashSupportCommunicationRequest,
} from "@/modules/support/application/communications";
import {
  acquireSupportAttachmentDownloadSlot,
  listSupportIncidentAttachments,
  releaseSupportAttachmentDownloadSlot,
  supportIncidentAttachmentRequestHash,
  uploadSupportIncidentAttachment,
} from "@/modules/support/application/incidentAttachments";
import { getSupportIndicators } from "@/modules/support/application/indicators";
import { getSupportDashboard } from "@/modules/support/application/dashboard";
import { getCustomerSupportContext } from "@/modules/support/application/customerContext";

const password = "Cambiar-esta-clave-2026";
const installation: InitializeCommand = {
  company: {
    legalName: "CriGestion Test SL",
    taxId: "B12345678",
    email: "admin@example.test",
  },
  administrator: { displayName: "Administrador", userName: "admin", password },
};

describe("support incidents application", () => {
  beforeEach(async () => {
    await reset();
    await initialize();
  });
  afterAll(async () => {
    await reset();
    await prisma.$disconnect();
  });

  it("creates an incident with annual numbering, append-only history and opaque audit", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const references = await listSupportReferences();
    const command = {
      customerId: customer.id,
      storeId: null,
      categoryId: references.categories[0]!.id,
      responsibleUserId: actor.id,
      title: "Error al acceder al servicio",
      description:
        "El usuario informa de un error reproducible al iniciar sesión.",
      priority: "URGENT" as const,
    };
    const context = {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportRequest(command),
      scope: "incident:create",
      correlationId: "support-test-0001",
    };

    const created = await createSupportIncident(command, actor, context);
    const replay = await createSupportIncident(command, actor, context);
    expect(created).toMatchObject({
      ok: true,
      status: 201,
      value: {
        number: `INC-${new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric" }).format(new Date())}-00001`,
        status: "NEW",
        priority: "URGENT",
        version: 1,
        events: [{ type: "CREATED", toStatus: "NEW" }],
      },
    });
    expect(replay).toMatchObject({
      ok: true,
      status: 200,
      value: { id: created.ok ? created.value.id : "" },
    });
    expect(await prisma.supportIncident.count()).toBe(1);
    expect(await prisma.supportIncidentEvent.count()).toBe(1);
    if (!created.ok) throw new Error("INCIDENT_NOT_CREATED");
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;
    await expect(
      prisma.$executeRaw`
        INSERT INTO "support_incident_events" (
          "id", "companyId", "incidentId", "actorUserId",
          "responsibleUserIdAtEvent", "resultingVersion", "eventType", "createdAt"
        )
        VALUES (
          ${randomUUID()}::uuid, ${companyId}::uuid, ${created.value.id}::uuid,
          ${actor.id}::uuid, ${randomUUID()}::uuid, 2, 'ACTION_ADDED', clock_timestamp()
        )
      `,
    ).rejects.toThrow(/responsible snapshot is invalid/i);
    const inbox = await listNotifications(actor, { state: "UNREAD", limit: 25 });
    expect(inbox).toMatchObject({ unreadCount: 1, items: [{ kind: "SUPPORT_INCIDENT_URGENT", severity: "URGENT", status: "UNREAD", incident: { id: created.ok ? created.value.id : "" } }] });
    if (!inbox?.items[0]) throw new Error("NOTIFICATION_MISSING");
    const stateCommand = { state: "READ" as const, expectedVersion: inbox.items[0].version };
    const stateContext = { idempotencyKey: randomUUID(), requestHash: hashNotificationStateRequest(inbox.items[0].id, stateCommand), correlationId: "notification-state-0001" };
    const changed = await changeNotificationState(inbox.items[0].id, stateCommand, actor, stateContext);
    await prisma.rateLimitBucket.update({ where: { key: `notification-state:${actor.id}` }, data: { count: 120, windowStart: new Date() } });
    const replayed = await changeNotificationState(inbox.items[0].id, stateCommand, actor, stateContext);
    const limitedCommand = { state: "UNREAD" as const, expectedVersion: 2 };
    const limited = await changeNotificationState(inbox.items[0].id, limitedCommand, actor, { idempotencyKey: stateContext.idempotencyKey, requestHash: hashNotificationStateRequest(inbox.items[0].id, limitedCommand) });
    expect(changed).toMatchObject({ ok: true, status: 200, value: { status: "READ", version: 2 } });
    expect(replayed).toMatchObject({ ok: true, status: 200, value: { id: inbox.items[0].id } });
    expect(limited).toMatchObject({ ok: false, status: 429, error: { code: "NOTIFICATION_STATE_RATE_LIMITED", retryAfterSeconds: expect.any(Number) } });
    expect(await prisma.notificationStateChange.count()).toBe(1);
    const storedNotification = await prisma.notification.findUniqueOrThrow({ where: { id: inbox.items[0].id } });
    await expect(prisma.notification.create({ data: { companyId: storedNotification.companyId, recipientUserId: storedNotification.recipientUserId, incidentId: storedNotification.incidentId, sourceIncidentEventId: storedNotification.sourceIncidentEventId, kind: "SUPPORT_INCIDENT_ASSIGNED", messageCode: "support.incident.assigned", incidentNumber: storedNotification.incidentNumber, severity: "INFO", expiresAt: storedNotification.expiresAt } })).rejects.toThrow();
    const archivedAt = new Date();
    await expect(prisma.$transaction(async (tx) => {
      await tx.notification.update({ where: { id: storedNotification.id }, data: { status: "ARCHIVED", version: 3, archivedAt } });
      await tx.notificationStateChange.create({ data: { companyId: storedNotification.companyId, notificationId: storedNotification.id, actorUserId: actor.id, fromStatus: "READ", toStatus: "ARCHIVED", resultingVersion: 3, occurredAt: new Date(archivedAt.getTime() - 1_000) } });
    })).rejects.toThrow();
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "SUPPORT_INCIDENT_CREATED" },
    });
    expect(audit.payload).toMatchObject({
      actorUserId: actor.id,
      customerId: customer.id,
      priority: "URGENT",
      correlationId: "support-test-0001",
    });
    expect(JSON.stringify(audit.payload)).not.toContain(command.title);
    expect(JSON.stringify(audit.payload)).not.toContain(command.description);
  });

  it("records and replays priority changes and notifies each urgent recipient once", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const references = await listSupportReferences();
    const create = { customerId: customer.id, storeId: null, categoryId: references.categories[0]!.id, responsibleUserId: actor.id, title: "Prioridad revisable", description: "Incidencia creada para comprobar la escalada posterior.", priority: "MEDIUM" as const };
    const created = await createSupportIncident(create, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(create), scope: "incident:create" });
    if (!created.ok) throw new Error(created.error.code);
    const command = { expectedVersion: created.value.version, priority: "URGENT" as const, reason: "Impacto operativo generalizado." };
    const context = { idempotencyKey: randomUUID(), requestHash: hashSupportPriorityChangeRequest({ incidentId: created.value.id, ...command }), scope: `incident:${created.value.id}:priority-change`, correlationId: "priority-test-0001" };

    const first = await changeSupportIncidentPriority(created.value.id, command, actor, context);
    const replay = await changeSupportIncidentPriority(created.value.id, command, actor, context);

    expect(first).toMatchObject({ ok: true, status: 201, value: { incident: { priority: "URGENT", version: 2 }, change: { fromPriority: "MEDIUM", toPriority: "URGENT" } } });
    expect(replay).toMatchObject({ ok: true, status: 200, value: { change: { id: first.ok ? first.value.change.id : "" } } });
    expect(await prisma.supportIncidentPriorityChange.count({ where: { incidentId: created.value.id } })).toBe(1);
    expect(await prisma.supportIncidentEvent.count({ where: { incidentId: created.value.id, eventType: "PRIORITY_CHANGED" } })).toBe(1);
    expect(await prisma.notification.count({ where: { incidentId: created.value.id, kind: "SUPPORT_INCIDENT_URGENT" } })).toBe(1);
    const unchangedCommand = { expectedVersion: 2, priority: "URGENT" as const, reason: "Se mantiene la prioridad ya vigente." };
    const unchanged = await changeSupportIncidentPriority(created.value.id, unchangedCommand, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportPriorityChangeRequest({ incidentId: created.value.id, ...unchangedCommand }), scope: `incident:${created.value.id}:priority-change` });
    expect(unchanged).toMatchObject({ ok: false, status: 409, error: { code: "SUPPORT_INCIDENT_PRIORITY_UNCHANGED" } });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUPPORT_INCIDENT_PRIORITY_CHANGED" }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(audit.payload)).not.toContain(command.reason);
    await expect(prisma.supportIncidentPriorityChange.update({ where: { id: first.ok ? first.value.change.id : randomUUID() }, data: { reason: "Intento de alterar la evidencia." } })).rejects.toThrow();
    await expect(prisma.supportIncident.update({ where: { id: created.value.id }, data: { priority: "HIGH", version: 3 } })).rejects.toThrow();
  });

  it("changes incident details once with append-only evidence and rejects incomplete SQL mutations", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const references = await listSupportReferences();
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;
    const secondCategory = await prisma.supportIncidentCategory.create({
      data: { companyId, name: "Datos revisados", normalizedName: "datos revisados", isActive: true },
    });
    const store = await prisma.customerStore.create({
      data: { customerId: customer.id, code: "S001", name: "Tienda soporte", status: "ACTIVE", addressLine: "Calle Soporte 1", postalCode: "28001", city: "Madrid", country: "ES", createdById: actor.id },
    });
    const create = {
      customerId: customer.id,
      storeId: null,
      categoryId: references.categories[0]!.id,
      responsibleUserId: actor.id,
      title: "Datos iniciales de soporte",
      description: "Descripción inicial que debe quedar preservada como evidencia.",
      priority: "MEDIUM" as const,
    };
    const created = await createSupportIncident(create, actor, {
      idempotencyKey: randomUUID(), requestHash: hashSupportRequest(create), scope: "incident:create",
    });
    if (!created.ok) throw new Error(created.error.code);
    const command = {
      expectedVersion: created.value.version,
      title: "Datos principales corregidos",
      description: "Descripción corregida y visible en la proyección vigente.",
      categoryId: secondCategory.id,
      storeId: store.id,
      reason: "Validación de la información aportada por el cliente.",
    };
    const context = {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportIncidentDetailsChangeRequest({ incidentId: created.value.id, ...command }),
      scope: `incident:${created.value.id}:details-change`,
      correlationId: "details-change-0001",
    };

    const first = await changeSupportIncidentDetails(created.value.id, command, actor, context);
    const replay = await changeSupportIncidentDetails(created.value.id, command, actor, context);
    const reusedCommand = { ...command, title: "Misma clave con otro cuerpo" };
    expect(await changeSupportIncidentDetails(created.value.id, reusedCommand, actor, { ...context, requestHash: hashSupportIncidentDetailsChangeRequest({ incidentId: created.value.id, ...reusedCommand }) })).toMatchObject({ ok: false, status: 409, error: { code: "IDEMPOTENCY_KEY_REUSED" } });

    expect(first).toMatchObject({ ok: true, status: 201, value: { incident: { id: created.value.id, version: 2, categoryId: secondCategory.id, storeId: store.id }, change: { resultingVersion: 2, changedFields: ["title", "description", "categoryId", "storeId"] } } });
    expect(replay).toMatchObject({ ok: true, status: 200, value: { change: { id: first.ok ? first.value.change.id : "" } } });
    expect(await prisma.supportIncidentDetailsChange.count({ where: { incidentId: created.value.id } })).toBe(1);
    expect(await prisma.supportIncidentEvent.count({ where: { incidentId: created.value.id, eventType: "DETAILS_CHANGED" } })).toBe(1);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUPPORT_INCIDENT_DETAILS_CHANGED" } });
    expect(audit.payload).toMatchObject({ incidentId: created.value.id, previousVersion: 1, version: 2, correlationId: "details-change-0001" });
    const auditJson = JSON.stringify(audit.payload);
    expect(auditJson).not.toContain(command.title);
    expect(auditJson).not.toContain(command.description);
    expect(auditJson).not.toContain(command.reason);
    const replayRecord = await prisma.idempotencyRecord.findFirstOrThrow({ where: { requestHash: context.requestHash } });
    await prisma.idempotencyRecord.update({ where: { key: replayRecord.key }, data: { responseBody: {} } });
    expect(await changeSupportIncidentDetails(created.value.id, command, actor, context)).toMatchObject({ ok: false, status: 409, error: { code: "IDEMPOTENCY_REPLAY_INVALID" } });
    expect(await changeSupportIncidentDetails(created.value.id, { ...command, expectedVersion: 2 }, actor, { ...context, idempotencyKey: randomUUID(), requestHash: hashSupportIncidentDetailsChangeRequest({ incidentId: created.value.id, ...command, expectedVersion: 2 }) })).toMatchObject({ ok: false, status: 409, error: { code: "SUPPORT_INCIDENT_DETAILS_UNCHANGED" } });
    await expect(prisma.supportIncidentDetailsChange.update({ where: { id: first.ok ? first.value.change.id : randomUUID() }, data: { reason: "Intento de alterar evidencia" } })).rejects.toThrow();
    await expect(prisma.supportIncident.update({ where: { id: created.value.id }, data: { title: "Mutación sin evidencia", version: 3 } })).rejects.toThrow();
    await expect(prisma.$transaction(async (tx) => {
      const fake = await tx.supportIncidentDetailsChange.create({ data: { companyId, incidentId: created.value.id, actorUserId: actor.id, customerId: customer.id, previousStoreId: store.id, correctedStoreId: store.id, previousStoreCode: store.code, previousStoreName: store.name, correctedStoreCode: store.code, correctedStoreName: store.name, previousCategoryId: secondCategory.id, correctedCategoryId: secondCategory.id, previousCategoryName: secondCategory.name, correctedCategoryName: secondCategory.name, previousTitle: "Valor anterior ficticio", correctedTitle: command.title, previousDescription: command.description, correctedDescription: command.description, reason: "Intento de fabricar una evidencia sin cambio real.", resultingVersion: 3 } });
      await tx.supportIncident.update({ where: { id: created.value.id }, data: { version: 3 } });
      await tx.supportIncidentEvent.create({ data: { companyId, incidentId: created.value.id, actorUserId: actor.id, responsibleUserIdAtEvent: actor.id, detailsChangeId: fake.id, eventType: "DETAILS_CHANGED", fromStatus: "NEW", toStatus: "NEW", resultingVersion: 3 } });
    })).rejects.toThrow();
    const otherCustomer = await createCustomerRecord(actor, { taxId: "B12345675", email: "otro@example.test", sepaMandate: { reference: "SEPA-2", signedAt: "2026-07-01" } });
    await expect(prisma.supportIncident.update({ where: { id: created.value.id }, data: { customerId: otherCustomer.id } })).rejects.toThrow();
    const inactiveCategory = await prisma.supportIncidentCategory.create({ data: { companyId, name: "Categoría inactiva", normalizedName: "categoria inactiva", isActive: false } });
    const inactiveStore = await prisma.customerStore.create({ data: { customerId: customer.id, code: "S002", name: "Tienda inactiva", status: "INACTIVE", addressLine: "Calle Soporte 2", postalCode: "28002", city: "Madrid", country: "ES", createdById: actor.id } });
    const invalidCategory = { ...command, expectedVersion: 2, title: "Intento con categoría inactiva", categoryId: inactiveCategory.id };
    expect(await changeSupportIncidentDetails(created.value.id, invalidCategory, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportIncidentDetailsChangeRequest({ incidentId: created.value.id, ...invalidCategory }), scope: `incident:${created.value.id}:details-change` })).toMatchObject({ ok: false, status: 422, error: { code: "SUPPORT_CATEGORY_NOT_AVAILABLE" } });
    const invalidStore = { ...command, expectedVersion: 2, title: "Intento con tienda inactiva", storeId: inactiveStore.id };
    expect(await changeSupportIncidentDetails(created.value.id, invalidStore, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportIncidentDetailsChangeRequest({ incidentId: created.value.id, ...invalidStore }), scope: `incident:${created.value.id}:details-change` })).toMatchObject({ ok: false, status: 422, error: { code: "SUPPORT_STORE_NOT_FOUND" } });
    const deactivateCategory = { action: "set-status" as const, expectedVersion: 1, isActive: false, confirmation: "DEACTIVATE_SUPPORT_CATEGORY" as const, reason: "Prueba de conservación histórica" };
    expect(await changeSupportCategory(secondCategory.id, deactivateCategory, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportCategoryChangeRequest({ categoryId: secondCategory.id, ...deactivateCategory }), scope: `category:${secondCategory.id}:change` })).toMatchObject({ ok: true, status: 201 });
    await prisma.customerStore.update({ where: { id: store.id }, data: { status: "INACTIVE" } });
    const preservedInactive = { ...command, expectedVersion: 2, title: "Conserva referencias históricas" };
    expect(await changeSupportIncidentDetails(created.value.id, preservedInactive, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportIncidentDetailsChangeRequest({ incidentId: created.value.id, ...preservedInactive }), scope: `incident:${created.value.id}:details-change` })).toMatchObject({ ok: true, status: 201, value: { incident: { version: 3 } } });
    const resolve = { action: "resolve" as const, expectedVersion: 3, solution: "La incidencia queda resuelta antes de una corrección documental." };
    expect(await transitionSupportIncident(created.value.id, resolve, actor, transitionContext(created.value.id, resolve))).toMatchObject({ ok: true, status: 201, value: { incident: { status: "RESOLVED", version: 4 } } });
    const finalizedChange = { ...preservedInactive, expectedVersion: 4, title: "Corrección documental final" };
    expect(await changeSupportIncidentDetails(created.value.id, finalizedChange, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportIncidentDetailsChangeRequest({ incidentId: created.value.id, ...finalizedChange }), scope: `incident:${created.value.id}:details-change` })).toMatchObject({ ok: true, status: 201, value: { incident: { version: 5 } } });
    await expect(prisma.supportIncidentDetailsChange.create({ data: { companyId, incidentId: created.value.id, actorUserId: actor.id, customerId: customer.id, previousStoreId: store.id, correctedStoreId: store.id, previousStoreCode: store.code, previousStoreName: store.name, correctedStoreCode: store.code, correctedStoreName: store.name, previousCategoryId: secondCategory.id, correctedCategoryId: secondCategory.id, previousCategoryName: "Etiqueta histórica falsificada", correctedCategoryName: secondCategory.name, previousTitle: finalizedChange.title, correctedTitle: "Cambio que no debe persistir", previousDescription: command.description, correctedDescription: command.description, reason: "Intento de insertar snapshots inconsistentes.", resultingVersion: 6 } })).rejects.toThrow();
    await expect(prisma.supportIncidentDetailsChange.create({ data: { companyId, incidentId: created.value.id, actorUserId: actor.id, customerId: customer.id, previousStoreId: store.id, correctedStoreId: store.id, previousStoreCode: null, previousStoreName: store.name, correctedStoreCode: store.code, correctedStoreName: store.name, previousCategoryId: secondCategory.id, correctedCategoryId: secondCategory.id, previousCategoryName: secondCategory.name, correctedCategoryName: secondCategory.name, previousTitle: finalizedChange.title, correctedTitle: "Cambio con snapshot nulo", previousDescription: command.description, correctedDescription: command.description, reason: "Intento de insertar un snapshot incompleto.", resultingVersion: 6 } })).rejects.toThrow();
  });

  it("corrects an action once with append-only evidence and exposes only the effective text to search", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const references = await listSupportReferences();
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;
    const create = { customerId: customer.id, storeId: null, categoryId: references.categories[0]!.id, responsibleUserId: actor.id, title: "Corrección versionada de actuación", description: "Incidencia sintética para corregir una actuación.", priority: "MEDIUM" as const };
    const created = await createSupportIncident(create, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(create), scope: "incident:create" });
    if (!created.ok) throw new Error(created.error.code);
    const actionCommand = { expectedVersion: created.value.version, text: "TextoOriginalUnicoActuacion", performedAt: new Date().toISOString() };
    const actionContext = { idempotencyKey: randomUUID(), requestHash: hashSupportActionRequest({ incidentId: created.value.id, ...actionCommand }), scope: `incident:${created.value.id}:action:create` };
    const action = await createSupportAction(created.value.id, actionCommand, actor, actionContext);
    if (!action.ok) throw new Error(action.error.code);
    const command = { expectedIncidentVersion: action.value.incident.version, expectedActionVersion: 1, text: "TextoCorregidoUnicoActuacion", reason: "Se corrige el texto después de contrastar el trabajo realizado." };
    const context = { idempotencyKey: randomUUID(), requestHash: hashSupportActionCorrectionRequest({ incidentId: created.value.id, actionId: action.value.action.id, ...command }), scope: `incident:${created.value.id}:action:${action.value.action.id}:correction`, correlationId: "action-correction-0001" };

    const first = await correctSupportAction(created.value.id, action.value.action.id, command, actor, context);
    const replay = await correctSupportAction(created.value.id, action.value.action.id, command, actor, context);
    const reused = { ...command, text: "Misma clave con un texto diferente." };
    expect(await correctSupportAction(created.value.id, action.value.action.id, reused, actor, { ...context, requestHash: hashSupportActionCorrectionRequest({ incidentId: created.value.id, actionId: action.value.action.id, ...reused }) })).toMatchObject({ ok: false, status: 409, error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    expect(first).toMatchObject({ ok: true, status: 201, value: { incident: { id: created.value.id, version: 3 }, action: { id: action.value.action.id, text: command.text, version: 2 }, correction: { resultingIncidentVersion: 3, resultingActionVersion: 2 } } });
    expect(replay).toMatchObject({ ok: true, status: 200, value: { correction: { id: first.ok ? first.value.correction.id : "" } } });
    const unchanged = { ...command, expectedIncidentVersion: 3, expectedActionVersion: 2 };
    expect(await correctSupportAction(created.value.id, action.value.action.id, unchanged, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportActionCorrectionRequest({ incidentId: created.value.id, actionId: action.value.action.id, ...unchanged }), scope: context.scope })).toMatchObject({ ok: false, status: 409, error: { code: "SUPPORT_ACTION_CORRECTION_UNCHANGED" } });
    expect(await prisma.supportIncidentActionCorrection.count({ where: { actionId: action.value.action.id } })).toBe(1);
    expect(await prisma.supportIncidentEvent.count({ where: { incidentId: created.value.id, eventType: "ACTION_CORRECTED" } })).toBe(1);
    const detail = await getSupportIncident(created.value.id, actor);
    expect(detail?.actions[0]).toMatchObject({ text: command.text, originalText: actionCommand.text, version: 2, corrections: [{ previousText: actionCommand.text, correctedText: command.text, reason: command.reason, version: 2 }] });
    expect((await listSupportIncidents({ limit: 25, search: actionCommand.text }, actor)).incidents.map((item) => item.id)).not.toContain(created.value.id);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUPPORT_INCIDENT_ACTION_CORRECTED" } });
    expect(audit.payload).toMatchObject({ incidentId: created.value.id, actionId: action.value.action.id, previousIncidentVersion: 2, incidentVersion: 3, previousActionVersion: 1, actionVersion: 2, correlationId: "action-correction-0001" });
    const auditJson = JSON.stringify(audit.payload);
    expect(auditJson).not.toContain(actionCommand.text);
    expect(auditJson).not.toContain(command.text);
    expect(auditJson).not.toContain(command.reason);
    const secondCommand = { expectedIncidentVersion: 3, expectedActionVersion: 2, text: "TextoVigenteSegundaCorreccion", reason: "Segunda corrección que sustituye por completo a la primera." };
    const second = await correctSupportAction(created.value.id, action.value.action.id, secondCommand, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportActionCorrectionRequest({ incidentId: created.value.id, actionId: action.value.action.id, ...secondCommand }), scope: context.scope });
    expect(second).toMatchObject({ ok: true, status: 201, value: { incident: { version: 4 }, action: { text: secondCommand.text, version: 3 } } });
    expect((await listSupportIncidents({ limit: 25, search: secondCommand.text }, actor)).incidents.map((item) => item.id)).toContain(created.value.id);
    expect((await listSupportIncidents({ limit: 25, search: command.text }, actor)).incidents.map((item) => item.id)).not.toContain(created.value.id);
    const correctionIndex = await prisma.$queryRaw<Array<{ indexdef: string }>>(Prisma.sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = 'support_action_corrections_text_trgm_idx'
    `);
    expect(correctionIndex[0]?.indexdef).toContain("USING gin");
    expect(correctionIndex[0]?.indexdef).toContain("gin_trgm_ops");
    const correctionPlan = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT set_config('enable_seqscan', ${"off"}, true)`);
      return tx.$queryRaw<Array<{ "QUERY PLAN": string }>>(Prisma.sql`
        EXPLAIN (COSTS OFF)
        SELECT "id"
        FROM "support_incident_action_corrections"
        WHERE "correctedText" ILIKE ${"%TextoVigenteSegundaCorreccion%"}
      `);
    });
    expect(correctionPlan.map((row) => row["QUERY PLAN"]).join("\n")).toContain("support_action_corrections_text_trgm_idx");
    await expect(prisma.supportIncidentActionCorrection.update({ where: { id: first.ok ? first.value.correction.id : randomUUID() }, data: { reason: "Intento de alterar la evidencia." } })).rejects.toThrow();
    await expect(prisma.$transaction(async (tx) => {
      await tx.supportIncidentActionCorrection.create({ data: { companyId, incidentId: created.value.id, actionId: action.value.action.id, originalAuthorUserId: actor.id, correctedByUserId: actor.id, previousText: secondCommand.text, correctedText: "Corrección sin evento", reason: "Intento de evidencia incompleta.", resultingActionVersion: 4, resultingIncidentVersion: 5 } });
      await tx.supportIncident.update({ where: { id: created.value.id }, data: { version: 5 } });
    })).rejects.toThrow();

    const invertedCreated = await createSupportIncident({ ...create, title: "Cadena invertida de correcciones" }, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest({ ...create, title: "Cadena invertida de correcciones" }), scope: "incident:create" });
    if (!invertedCreated.ok) throw new Error(invertedCreated.error.code);
    const invertedActionCommand = { expectedVersion: 1, text: "Texto original de cadena invertida", performedAt: new Date().toISOString() };
    const invertedAction = await createSupportAction(invertedCreated.value.id, invertedActionCommand, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportActionRequest({ incidentId: invertedCreated.value.id, ...invertedActionCommand }), scope: `incident:${invertedCreated.value.id}:action:create` });
    if (!invertedAction.ok) throw new Error(invertedAction.error.code);
    const later = new Date(Date.now() + 1_000);
    const earlier = new Date(later.getTime() - 500);
    await expect(prisma.$transaction(async (tx) => {
      const correctionV2 = await tx.supportIncidentActionCorrection.create({ data: { companyId, incidentId: invertedCreated.value.id, actionId: invertedAction.value.action.id, originalAuthorUserId: actor.id, correctedByUserId: actor.id, previousText: invertedActionCommand.text, correctedText: "Segundo texto con versión de incidencia posterior", reason: "Cadena deliberadamente desordenada para probar la restricción.", resultingActionVersion: 2, resultingIncidentVersion: 4, correctedAt: later } });
      const correctionV3 = await tx.supportIncidentActionCorrection.create({ data: { companyId, incidentId: invertedCreated.value.id, actionId: invertedAction.value.action.id, originalAuthorUserId: actor.id, correctedByUserId: actor.id, previousText: "Segundo texto con versión de incidencia posterior", correctedText: "Tercer texto con versión de incidencia anterior", reason: "Cadena deliberadamente desordenada para probar la restricción.", resultingActionVersion: 3, resultingIncidentVersion: 3, correctedAt: earlier } });
      await tx.supportIncidentEvent.create({ data: { companyId, incidentId: invertedCreated.value.id, actorUserId: actor.id, responsibleUserIdAtEvent: actor.id, actionCorrectionId: correctionV3.id, eventType: "ACTION_CORRECTED", fromStatus: "IN_PROGRESS", toStatus: "IN_PROGRESS", resultingVersion: 3, createdAt: earlier } });
      await tx.supportIncident.update({ where: { id: invertedCreated.value.id }, data: { version: 3 } });
      await tx.supportIncidentEvent.create({ data: { companyId, incidentId: invertedCreated.value.id, actorUserId: actor.id, responsibleUserIdAtEvent: actor.id, actionCorrectionId: correctionV2.id, eventType: "ACTION_CORRECTED", fromStatus: "IN_PROGRESS", toStatus: "IN_PROGRESS", resultingVersion: 4, createdAt: later } });
      await tx.supportIncident.update({ where: { id: invertedCreated.value.id }, data: { version: 4 } });
    })).rejects.toThrow();
  });

  it("revalidates action membership before returning a create-action replay", async () => {
    const administrator = await admin();
    const customer = await createCustomerRecord(administrator);
    const references = await listSupportReferences();
    const role = await prisma.role.create({ data: { code: "ActionReplayOwner", name: "Autor de actuación", permissions: { create: ["Support.View", "Support.AddActions"].map((code) => ({ permission: { connect: { code } } })) } } });
    const author = await prisma.user.create({ data: { displayName: "Autor inicial", userName: "action-owner", normalizedUserName: "action-owner", passwordHash: hashPassword("Cambiar-action-owner-2026"), roleId: role.id } });
    const replacement = await prisma.user.create({ data: { displayName: "Responsable sustituto", userName: "action-next", normalizedUserName: "action-next", passwordHash: hashPassword("Cambiar-action-next-2026"), roleId: role.id } });
    const create = { customerId: customer.id, storeId: null, categoryId: references.categories[0]!.id, responsibleUserId: author.id, title: "Replay de actuación protegido", description: "La pertenencia se revalida antes de devolver el texto almacenado.", priority: "MEDIUM" as const };
    const created = await createSupportIncident(create, administrator, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(create), scope: "incident:create" });
    if (!created.ok) throw new Error(created.error.code);
    const logged = await login({ userName: "action-owner", password: "Cambiar-action-owner-2026" });
    if (!logged.ok) throw new Error(logged.error.code);
    const command = { expectedVersion: 1, text: "Actuación cuyo replay requiere pertenencia vigente.", performedAt: new Date().toISOString() };
    const context = { idempotencyKey: randomUUID(), requestHash: hashSupportActionRequest({ incidentId: created.value.id, ...command }), scope: `incident:${created.value.id}:action:create` };
    expect(await createSupportAction(created.value.id, command, logged.value.user, context)).toMatchObject({ ok: true, status: 201 });
    const reassign = { action: "reassign" as const, expectedVersion: 2, responsibleUserId: replacement.id, reason: "Retirada del autor del equipo actual." };
    expect(await changeSupportParticipants(created.value.id, reassign, administrator, participantContext(created.value.id, reassign))).toMatchObject({ ok: true, status: 201 });
    expect(await createSupportAction(created.value.id, command, logged.value.user, context)).toMatchObject({ ok: false, status: 403, error: { code: "SUPPORT_INCIDENT_ACTION_FORBIDDEN" } });
  });

  it("limits action correction to the original current member or an administrator and allows finalized documentation", async () => {
    const administrator = await admin();
    const customer = await createCustomerRecord(administrator);
    const references = await listSupportReferences();
    const role = await prisma.role.create({ data: { code: "ActionCorrectionTechnician", name: "Técnico corrector", permissions: { create: ["Support.View", "Support.AddActions", "Support.CorrectActions"].map((code) => ({ permission: { connect: { code } } })) } } });
    const author = await prisma.user.create({ data: { displayName: "Autor corrector", userName: "correction-author", normalizedUserName: "correction-author", passwordHash: hashPassword("Cambiar-correction-author-2026"), roleId: role.id } });
    const replacement = await prisma.user.create({ data: { displayName: "Responsable no autor", userName: "correction-next", normalizedUserName: "correction-next", passwordHash: hashPassword("Cambiar-correction-next-2026"), roleId: role.id } });
    const create = { customerId: customer.id, storeId: null, categoryId: references.categories[0]!.id, responsibleUserId: author.id, title: "Autoridad de corrección", description: "Solo el autor vigente en el equipo o un administrador puede corregir.", priority: "MEDIUM" as const };
    const created = await createSupportIncident(create, administrator, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(create), scope: "incident:create" });
    if (!created.ok) throw new Error(created.error.code);
    const authorLogin = await login({ userName: "correction-author", password: "Cambiar-correction-author-2026" });
    const replacementLogin = await login({ userName: "correction-next", password: "Cambiar-correction-next-2026" });
    if (!authorLogin.ok || !replacementLogin.ok) throw new Error("ACTION_CORRECTION_LOGIN_FAILED");
    const actionCommand = { expectedVersion: 1, text: "Texto documentado por el autor original.", performedAt: new Date().toISOString() };
    const action = await createSupportAction(created.value.id, actionCommand, authorLogin.value.user, { idempotencyKey: randomUUID(), requestHash: hashSupportActionRequest({ incidentId: created.value.id, ...actionCommand }), scope: `incident:${created.value.id}:action:create` });
    if (!action.ok) throw new Error(action.error.code);
    const authorCommand = { expectedIncidentVersion: 2, expectedActionVersion: 1, text: "Primera corrección realizada por el autor.", reason: "Corrección inicial contrastada por el autor." };
    const authorContext = { idempotencyKey: randomUUID(), requestHash: hashSupportActionCorrectionRequest({ incidentId: created.value.id, actionId: action.value.action.id, ...authorCommand }), scope: `incident:${created.value.id}:action:${action.value.action.id}:correction` };
    expect(await correctSupportAction(created.value.id, action.value.action.id, authorCommand, authorLogin.value.user, authorContext)).toMatchObject({ ok: true, status: 201, value: { incident: { version: 3 }, action: { version: 2 } } });
    const reassign = { action: "reassign" as const, expectedVersion: 3, responsibleUserId: replacement.id, reason: "Cambio de responsable para probar la autoría." };
    expect(await changeSupportParticipants(created.value.id, reassign, administrator, participantContext(created.value.id, reassign))).toMatchObject({ ok: true, status: 201 });
    expect(await correctSupportAction(created.value.id, action.value.action.id, authorCommand, authorLogin.value.user, authorContext)).toMatchObject({ ok: false, status: 403, error: { code: "SUPPORT_ACTION_CORRECTION_FORBIDDEN" } });
    const command = { expectedIncidentVersion: 4, expectedActionVersion: 2, text: "Texto corregido después de la reasignación.", reason: "Corrección administrativa contrastada." };
    const makeContext = () => ({ idempotencyKey: randomUUID(), requestHash: hashSupportActionCorrectionRequest({ incidentId: created.value.id, actionId: action.value.action.id, ...command }), scope: `incident:${created.value.id}:action:${action.value.action.id}:correction` });
    expect(await correctSupportAction(created.value.id, action.value.action.id, command, authorLogin.value.user, makeContext())).toMatchObject({ ok: false, status: 403, error: { code: "SUPPORT_ACTION_CORRECTION_FORBIDDEN" } });
    expect(await correctSupportAction(created.value.id, action.value.action.id, command, replacementLogin.value.user, makeContext())).toMatchObject({ ok: false, status: 403, error: { code: "SUPPORT_ACTION_CORRECTION_FORBIDDEN" } });
    expect(await correctSupportAction(created.value.id, action.value.action.id, command, administrator, makeContext())).toMatchObject({ ok: true, status: 201, value: { incident: { version: 5 }, action: { version: 3 } } });
    const resolve = { action: "resolve" as const, expectedVersion: 5, solution: "La incidencia se resuelve antes de una corrección documental posterior." };
    expect(await transitionSupportIncident(created.value.id, resolve, administrator, transitionContext(created.value.id, resolve))).toMatchObject({ ok: true, status: 201, value: { incident: { status: "RESOLVED", version: 6 } } });
    const finalizedCommand = { ...command, expectedIncidentVersion: 6, expectedActionVersion: 3, text: "Texto corregido con la incidencia ya resuelta." };
    expect(await correctSupportAction(created.value.id, action.value.action.id, finalizedCommand, administrator, { idempotencyKey: randomUUID(), requestHash: hashSupportActionCorrectionRequest({ incidentId: created.value.id, actionId: action.value.action.id, ...finalizedCommand }), scope: `incident:${created.value.id}:action:${action.value.action.id}:correction` })).toMatchObject({ ok: true, status: 201, value: { incident: { version: 7 }, action: { version: 4 } } });
  });

  it("serializes concurrent corrections of the same action", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const references = await listSupportReferences();
    const create = { customerId: customer.id, storeId: null, categoryId: references.categories[0]!.id, responsibleUserId: actor.id, title: "Corrección concurrente", description: "Dos correcciones compiten por la misma versión de actuación.", priority: "MEDIUM" as const };
    const created = await createSupportIncident(create, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(create), scope: "incident:create" });
    if (!created.ok) throw new Error(created.error.code);
    const actionCommand = { expectedVersion: 1, text: "Texto inicial para la carrera de correcciones.", performedAt: new Date().toISOString() };
    const action = await createSupportAction(created.value.id, actionCommand, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportActionRequest({ incidentId: created.value.id, ...actionCommand }), scope: `incident:${created.value.id}:action:create` });
    if (!action.ok) throw new Error(action.error.code);
    const commands = ["Primera corrección concurrente.", "Segunda corrección concurrente."].map((text) => ({ expectedIncidentVersion: 2, expectedActionVersion: 1, text, reason: "Prueba de exclusión concurrente." }));
    const results = await Promise.all(commands.map((command) => correctSupportAction(created.value.id, action.value.action.id, command, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportActionCorrectionRequest({ incidentId: created.value.id, actionId: action.value.action.id, ...command }), scope: `incident:${created.value.id}:action:${action.value.action.id}:correction` })));
    expect(results.filter((result) => result.ok && result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.status === 409)).toHaveLength(1);
    expect(await prisma.supportIncidentActionCorrection.count({ where: { actionId: action.value.action.id } })).toBe(1);
    expect(await prisma.supportIncidentEvent.count({ where: { incidentId: created.value.id, eventType: "ACTION_CORRECTED" } })).toBe(1);
  });

  it("revalidates current responsibility before returning an idempotent replay", async () => {
    const administrator = await admin();
    const customer = await createCustomerRecord(administrator);
    const references = await listSupportReferences();
    const role = await prisma.role.create({ data: { code: "DetailsResponsible", name: "Responsable de datos", permissions: { create: ["Support.View", "Support.AddActions", "Support.ManageAssigned"].map((code) => ({ permission: { connect: { code } } })) } } });
    const firstUser = await prisma.user.create({ data: { displayName: "Responsable inicial", userName: "details-owner", normalizedUserName: "details-owner", passwordHash: hashPassword("Cambiar-details-owner-2026"), roleId: role.id } });
    const secondUser = await prisma.user.create({ data: { displayName: "Responsable nuevo", userName: "details-next", normalizedUserName: "details-next", passwordHash: hashPassword("Cambiar-details-next-2026"), roleId: role.id } });
    const create = { customerId: customer.id, storeId: null, categoryId: references.categories[0]!.id, responsibleUserId: firstUser.id, title: "Replay con reasignación", description: "La autorización debe comprobarse también al repetir la clave.", priority: "MEDIUM" as const };
    const created = await createSupportIncident(create, administrator, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(create), scope: "incident:create" });
    if (!created.ok) throw new Error(created.error.code);
    const logged = await login({ userName: "details-owner", password: "Cambiar-details-owner-2026" });
    if (!logged.ok) throw new Error(logged.error.code);
    const command = { expectedVersion: 1, title: "Replay corregido", description: create.description, categoryId: create.categoryId, storeId: null, reason: "Corrección previa a la reasignación." };
    const context = { idempotencyKey: randomUUID(), requestHash: hashSupportIncidentDetailsChangeRequest({ incidentId: created.value.id, ...command }), scope: `incident:${created.value.id}:details-change` };
    expect(await changeSupportIncidentDetails(created.value.id, command, logged.value.user, context)).toMatchObject({ ok: true, status: 201 });
    const reassign = { action: "reassign" as const, expectedVersion: 2, responsibleUserId: secondUser.id, reason: "Cambio de responsable para verificar el replay." };
    expect(await changeSupportParticipants(created.value.id, reassign, administrator, participantContext(created.value.id, reassign))).toMatchObject({ ok: true, status: 201 });
    expect(await changeSupportIncidentDetails(created.value.id, command, logged.value.user, context)).toMatchObject({ ok: false, status: 403, error: { code: "SUPPORT_INCIDENT_DETAILS_FORBIDDEN" } });
  });

  it("serializes concurrent details changes and denies a non-responsible technician", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const references = await listSupportReferences();
    const create = {
      customerId: customer.id,
      storeId: null,
      categoryId: references.categories[0]!.id,
      responsibleUserId: actor.id,
      title: "Edición concurrente",
      description: "Incidencia preparada para dos correcciones simultáneas.",
      priority: "MEDIUM" as const,
    };
    const created = await createSupportIncident(create, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(create), scope: "incident:create" });
    if (!created.ok) throw new Error(created.error.code);
    const role = await prisma.role.create({
      data: { code: "DetailsTechnician", name: "Técnico de datos", permissions: { create: ["Support.View", "Support.ManageAssigned"].map((code) => ({ permission: { connect: { code } } })) } },
    });
    await prisma.user.create({ data: { displayName: "Técnico ajeno", userName: "details-tech", normalizedUserName: "details-tech", passwordHash: hashPassword("Cambiar-details-tech-2026"), roleId: role.id } });
    const logged = await login({ userName: "details-tech", password: "Cambiar-details-tech-2026" });
    if (!logged.ok) throw new Error(logged.error.code);
    const deniedCommand = { expectedVersion: 1, title: "Intento ajeno", description: create.description, categoryId: create.categoryId, storeId: null, reason: "Intento sin responsabilidad vigente." };
    expect(await changeSupportIncidentDetails(created.value.id, deniedCommand, logged.value.user, { idempotencyKey: randomUUID(), requestHash: hashSupportIncidentDetailsChangeRequest({ incidentId: created.value.id, ...deniedCommand }), scope: `incident:${created.value.id}:details-change`, correlationId: "details-denied-0001" })).toMatchObject({ ok: false, status: 403, error: { code: "SUPPORT_INCIDENT_DETAILS_FORBIDDEN" } });

    const command = { expectedVersion: 1, title: "Corrección concurrente", description: create.description, categoryId: create.categoryId, storeId: null, reason: "Corrección simultánea controlada." };
    const makeContext = () => ({ idempotencyKey: randomUUID(), requestHash: hashSupportIncidentDetailsChangeRequest({ incidentId: created.value.id, ...command }), scope: `incident:${created.value.id}:details-change` });
    const results = await Promise.all([
      changeSupportIncidentDetails(created.value.id, command, actor, makeContext()),
      changeSupportIncidentDetails(created.value.id, command, actor, makeContext()),
    ]);
    expect(results.filter((result) => result.ok && result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error.code === "SUPPORT_INCIDENT_VERSION_CONFLICT")).toHaveLength(1);
    expect(await prisma.supportIncidentDetailsChange.count({ where: { incidentId: created.value.id } })).toBe(1);
    expect(await prisma.supportIncidentEvent.count({ where: { incidentId: created.value.id, eventType: "DETAILS_CHANGED" } })).toBe(1);
    const deniedAudit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUPPORT_INCIDENT_DETAILS_CHANGE_DENIED", payload: { path: ["reason"], equals: "NOT_RESPONSIBLE" } } });
    expect(deniedAudit.payload).toMatchObject({ correlationId: "details-denied-0001" });
    expect(JSON.stringify(deniedAudit.payload)).not.toContain(created.value.id);
  });

  it("changes the incident customer without rewriting linked communication history", async () => {
    const actor = await admin();
    const previousCustomer = await createCustomerRecord(actor);
    const correctedCustomer = await createCustomerRecord(actor, {
      legalName: "Cliente Destino SL",
      tradeName: "Cliente Destino",
      taxId: "B87654321",
      email: "destino@example.test",
      sepaMandate: { reference: "SEPA-DESTINO-1", signedAt: "2026-07-02" },
    });
    const references = await listSupportReferences();
    const create = {
      customerId: previousCustomer.id,
      storeId: null,
      categoryId: references.categories[0]!.id,
      responsibleUserId: actor.id,
      title: "Cliente asignado incorrectamente",
      description: "La incidencia debe conservar toda la historia al corregir el cliente.",
      priority: "MEDIUM" as const,
    };
    const incident = await createSupportIncident(create, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(create), scope: "incident:create" });
    if (!incident.ok) throw new Error(incident.error.code);
    const communicationCommand = {
      customerId: previousCustomer.id,
      channel: "PHONE" as const,
      direction: "INBOUND" as const,
      occurredAt: new Date().toISOString(),
      contactId: null,
      contactNumber: "+34910000061",
      durationSeconds: 75,
      summary: "Comunicación histórica del cliente original.",
      result: "REFERRED_TO_INCIDENT" as const,
      incidentId: incident.value.id,
    };
    const communication = await createSupportCommunication(communicationCommand, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportCommunicationRequest(communicationCommand), scope: "communication:create" });
    if (!communication.ok) throw new Error(communication.error.code);
    const before = await prisma.supportCommunication.findUniqueOrThrow({ where: { id: communication.value.id } });
    const command = {
      expectedVersion: incident.value.version,
      expectedCustomerId: previousCustomer.id,
      customerId: correctedCustomer.id,
      reason: "Se verifica documentalmente que el expediente pertenece al cliente de destino.",
      confirmation: "CHANGE_INCIDENT_CUSTOMER" as const,
    };
    const context = {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportIncidentCustomerChangeRequest({ incidentId: incident.value.id, ...command }),
      scope: `incident:${incident.value.id}:customer-change`,
      correlationId: "customer-change-0001",
    };

    const first = await changeSupportIncidentCustomer(incident.value.id, command, actor, context);
    const replay = await changeSupportIncidentCustomer(incident.value.id, command, actor, context);
    expect(first).toMatchObject({ ok: true, status: 201, value: { incident: { id: incident.value.id, customerId: correctedCustomer.id, storeId: null, version: 2 } } });
    expect(replay).toMatchObject({ ok: true, status: 200, value: { change: { id: first.ok ? first.value.change.id : "" } } });
    expect(await prisma.supportIncidentCustomerChange.count({ where: { incidentId: incident.value.id } })).toBe(1);
    expect(await prisma.supportIncidentEvent.count({ where: { incidentId: incident.value.id, eventType: "CUSTOMER_CHANGED" } })).toBe(1);
    const reused = { ...command, reason: "Una clave usada no admite un motivo diferente." };
    expect(await changeSupportIncidentCustomer(incident.value.id, reused, actor, { ...context, requestHash: hashSupportIncidentCustomerChangeRequest({ incidentId: incident.value.id, ...reused }) })).toMatchObject({ ok: false, status: 409, error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    const storedReplay = await prisma.idempotencyRecord.findFirstOrThrow({ where: { requestHash: context.requestHash } });
    await prisma.idempotencyRecord.update({ where: { id: storedReplay.id }, data: { responseBody: { incident: { id: incident.value.id } } } });
    expect(await changeSupportIncidentCustomer(incident.value.id, command, actor, context)).toMatchObject({ ok: false, status: 409, error: { code: "IDEMPOTENCY_REPLAY_INVALID" } });
    expect(await prisma.auditEvent.count({ where: { eventType: "SUPPORT_INCIDENT_CUSTOMER_CHANGE_DENIED" } })).toBeGreaterThanOrEqual(2);
    const after = await prisma.supportCommunication.findUniqueOrThrow({ where: { id: communication.value.id } });
    expect(after).toEqual(before);
    const historicalCorrection = {
      expectedVersion: before.version,
      channel: communicationCommand.channel,
      direction: communicationCommand.direction,
      occurredAt: communicationCommand.occurredAt,
      contactId: null,
      contactNumber: "+34910000064",
      durationSeconds: 90,
      summary: "Comunicación histórica corregida sin trasladarla de cliente.",
      result: communicationCommand.result,
      incidentId: incident.value.id,
      reason: "Se corrigen los datos de la llamada conservando su cliente de origen.",
    };
    expect(await correctSupportCommunication(communication.value.id, historicalCorrection, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportCommunicationRequest({ communicationId: communication.value.id, ...historicalCorrection }), scope: `communication:${communication.value.id}:correct` })).toMatchObject({ ok: true, status: 201, value: { incidentId: incident.value.id, version: 2 } });
    expect(await prisma.supportCommunication.findUniqueOrThrow({ where: { id: communication.value.id }, select: { customerId: true, incidentId: true } })).toEqual({ customerId: previousCustomer.id, incidentId: incident.value.id });
    const detail = await getSupportIncident(incident.value.id, actor);
    expect(detail?.customerChanges).toEqual([expect.objectContaining({ previousCustomer: expect.objectContaining({ id: previousCustomer.id }), correctedCustomer: expect.objectContaining({ id: correctedCustomer.id }) })]);
    expect(detail?.communications).toEqual([expect.objectContaining({ id: communication.value.id, sourceCustomer: { id: previousCustomer.id, code: previousCustomer.code, legalName: previousCustomer.legalName } })]);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUPPORT_INCIDENT_CUSTOMER_CHANGED" } });
    expect(audit.payload).toMatchObject({ correlationId: "customer-change-0001", hadLinkedCommunications: true });
    expect(JSON.stringify(audit.payload)).not.toContain(command.reason);
    expect(JSON.stringify(audit.payload)).not.toContain(previousCustomer.legalName);

    const oldCustomerLink = { ...communicationCommand, contactNumber: "+34910000062", summary: "No puede crearse un enlace histórico nuevo." };
    expect(await createSupportCommunication(oldCustomerLink, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportCommunicationRequest(oldCustomerLink), scope: "communication:create" })).toMatchObject({ ok: false, status: 422, error: { code: "SUPPORT_COMMUNICATION_INCIDENT_INVALID" } });
    const newCustomerLink = { ...oldCustomerLink, customerId: correctedCustomer.id, contactNumber: "+34910000063", summary: "Enlace nuevo con el cliente vigente." };
    expect(await createSupportCommunication(newCustomerLink, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportCommunicationRequest(newCustomerLink), scope: "communication:create" })).toMatchObject({ ok: true, status: 201 });

    const detailChange = { expectedVersion: 2, title: "Cliente corregido y datos revisados", description: create.description, categoryId: create.categoryId, storeId: null, reason: "Se valida que la edición ordinaria continúa después del cambio administrativo." };
    expect(await changeSupportIncidentDetails(incident.value.id, detailChange, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportIncidentDetailsChangeRequest({ incidentId: incident.value.id, ...detailChange }), scope: `incident:${incident.value.id}:details-change` })).toMatchObject({ ok: true, status: 201, value: { incident: { version: 3 } } });
    expect(await prisma.supportIncident.findUniqueOrThrow({ where: { id: incident.value.id }, select: { customerId: true } })).toEqual({ customerId: correctedCustomer.id });

    const changeId = first.ok ? first.value.change.id : randomUUID();
    await expect(prisma.supportIncidentCustomerChange.update({ where: { id: changeId }, data: { reason: "No mutable" } })).rejects.toThrow();
    await expect(prisma.supportIncidentCustomerChange.delete({ where: { id: changeId } })).rejects.toThrow();

    await expect(prisma.$transaction(async (tx) => {
      await tx.supportIncident.update({ where: { id: incident.value.id }, data: { customerId: previousCustomer.id, version: { increment: 1 } } });
    })).rejects.toThrow();
    const currentIncident = await prisma.supportIncident.findUniqueOrThrow({ where: { id: incident.value.id } });
    const companyId = (await prisma.installation.findFirstOrThrow()).companyId!;
    const falseChangedAt = new Date("2020-01-01T00:00:00.000Z");
    await expect(prisma.$transaction(async (tx) => {
      const falseChange = await tx.supportIncidentCustomerChange.create({ data: { companyId, incidentId: incident.value.id, actorUserId: actor.id, previousCustomerId: correctedCustomer.id, correctedCustomerId: previousCustomer.id, previousCustomerCode: correctedCustomer.code, previousCustomerLegalName: correctedCustomer.legalName, correctedCustomerCode: previousCustomer.code, correctedCustomerLegalName: previousCustomer.legalName, reason: "Evidencia con cronología deliberadamente inválida.", resultingVersion: currentIncident.version + 1, changedAt: falseChangedAt } });
      await tx.supportIncident.update({ where: { id: incident.value.id }, data: { customerId: previousCustomer.id, version: currentIncident.version + 1, updatedAt: new Date() } });
      await tx.supportIncidentEvent.create({ data: { companyId, incidentId: incident.value.id, actorUserId: actor.id, responsibleUserIdAtEvent: actor.id, customerChangeId: falseChange.id, eventType: "CUSTOMER_CHANGED", fromStatus: currentIncident.status, toStatus: currentIncident.status, resultingVersion: currentIncident.version + 1, createdAt: falseChangedAt } });
    })).rejects.toThrow();
  });

  it("rejects customer changes with a store or merge family and serializes stale versions", async () => {
    const actor = await admin();
    const firstCustomer = await createCustomerRecord(actor);
    const secondCustomer = await createCustomerRecord(actor, { legalName: "Segundo Cliente SL", tradeName: "Segundo Cliente", taxId: "B87654322", email: "segundo@example.test", sepaMandate: { reference: "SEPA-DESTINO-2", signedAt: "2026-07-03" } });
    const references = await listSupportReferences();
    const base = { customerId: firstCustomer.id, storeId: null, categoryId: references.categories[0]!.id, responsibleUserId: actor.id, description: "Incidencia para barreras del cambio administrativo.", priority: "MEDIUM" as const };
    const installation = await prisma.installation.findFirstOrThrow();
    const store = await prisma.customerStore.create({ data: { customerId: firstCustomer.id, code: "STORE-CUST-CHANGE", name: "Tienda vinculada", addressLine: "Calle Tienda 1", postalCode: "28003", city: "Madrid", country: "ES", createdById: installation.initialAdministratorId! } });
    const withStoreCommand = { ...base, storeId: store.id, title: "Incidencia con tienda" };
    const withStore = await createSupportIncident(withStoreCommand, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(withStoreCommand), scope: "incident:create" });
    if (!withStore.ok) throw new Error(withStore.error.code);
    const storeChange = { expectedVersion: 1, expectedCustomerId: firstCustomer.id, customerId: secondCustomer.id, reason: "La tienda debe retirarse antes de cambiar el cliente.", confirmation: "CHANGE_INCIDENT_CUSTOMER" as const };
    expect(await changeSupportIncidentCustomer(withStore.value.id, storeChange, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportIncidentCustomerChangeRequest({ incidentId: withStore.value.id, ...storeChange }), scope: `incident:${withStore.value.id}:customer-change` })).toMatchObject({ ok: false, status: 409, error: { code: "SUPPORT_INCIDENT_CUSTOMER_CHANGE_STORE_ATTACHED" } });

    const role = await prisma.role.create({ data: { code: "CustomerChangeNonAdmin", name: "No administrador con permisos", permissions: { create: ["Support.View", "Support.ChangeIncidentCustomer", "Customers.View"].map((code) => ({ permission: { connect: { code } } })) } } });
    const nonAdmin = await prisma.user.create({ data: { displayName: "No administrador", userName: "customer-change-non-admin", normalizedUserName: "customer-change-non-admin", passwordHash: hashPassword("Cambiar-customer-change-2026"), roleId: role.id } });
    const unauthorized = { id: nonAdmin.id, displayName: nonAdmin.displayName, userName: nonAdmin.userName, role: { code: role.code, name: role.name }, permissions: ["Support.View", "Support.ChangeIncidentCustomer", "Customers.View"] };
    expect(await changeSupportIncidentCustomer(withStore.value.id, storeChange, unauthorized, { idempotencyKey: randomUUID(), requestHash: hashSupportIncidentCustomerChangeRequest({ incidentId: withStore.value.id, ...storeChange }), scope: `incident:${withStore.value.id}:customer-change` })).toMatchObject({ ok: false, status: 403, error: { code: "SUPPORT_INCIDENT_CUSTOMER_CHANGE_FORBIDDEN" } });
    expect(await prisma.auditEvent.findFirst({ where: { eventType: "SUPPORT_INCIDENT_CUSTOMER_CHANGE_DENIED", payload: { path: ["reason"], equals: "ROLE_OR_PERMISSION" } } })).not.toBeNull();

    const concurrentCommand = { ...base, title: "Cambio concurrente de cliente" };
    const concurrentIncident = await createSupportIncident(concurrentCommand, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(concurrentCommand), scope: "incident:create" });
    if (!concurrentIncident.ok) throw new Error(concurrentIncident.error.code);
    const change = { expectedVersion: 1, expectedCustomerId: firstCustomer.id, customerId: secondCustomer.id, reason: "Dos solicitudes compiten por la misma versión.", confirmation: "CHANGE_INCIDENT_CUSTOMER" as const };
    const concurrentResults = await Promise.all([1, 2].map(() => changeSupportIncidentCustomer(concurrentIncident.value.id, change, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportIncidentCustomerChangeRequest({ incidentId: concurrentIncident.value.id, ...change }), scope: `incident:${concurrentIncident.value.id}:customer-change` })));
    expect(concurrentResults.filter((result) => result.ok && result.status === 201)).toHaveLength(1);
    expect(concurrentResults.filter((result) => !result.ok && result.error.code === "SUPPORT_INCIDENT_VERSION_CONFLICT")).toHaveLength(1);
    expect(await prisma.supportIncidentCustomerChange.count({ where: { incidentId: concurrentIncident.value.id } })).toBe(1);
    expect(await prisma.supportIncidentEvent.count({ where: { incidentId: concurrentIncident.value.id, eventType: "CUSTOMER_CHANGED" } })).toBe(1);
    const primary = await createSupportIncident({ ...base, title: "Principal del grupo" }, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest({ ...base, title: "Principal del grupo" }), scope: "incident:create" });
    const duplicate = await createSupportIncident({ ...base, title: "Duplicada del grupo" }, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest({ ...base, title: "Duplicada del grupo" }), scope: "incident:create" });
    if (!primary.ok || !duplicate.ok) throw new Error("CUSTOMER_CHANGE_FIXTURE_NOT_CREATED");
    const mergeCommand = { primaryIncidentId: primary.value.id, duplicateIncidentId: duplicate.value.id, expectedPrimaryVersion: 1, expectedDuplicateVersion: 1, reason: "Fusión previa a la barrera de cliente.", confirmation: "MERGE_DUPLICATE_INCIDENT" as const };
    const merged = await mergeSupportIncidents(mergeCommand, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportIncidentMergeRequest(mergeCommand), scope: "support:incident-merge" });
    if (!merged.ok) throw new Error(merged.error.code);
    for (const target of [merged.value.primary, merged.value.duplicate]) {
      const command = { expectedVersion: target.version, expectedCustomerId: firstCustomer.id, customerId: secondCustomer.id, reason: "No se permite separar una familia fusionada.", confirmation: "CHANGE_INCIDENT_CUSTOMER" as const };
      expect(await changeSupportIncidentCustomer(target.id, command, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportIncidentCustomerChangeRequest({ incidentId: target.id, ...command }), scope: `incident:${target.id}:customer-change` })).toMatchObject({ ok: false, status: 409, error: { code: "SUPPORT_INCIDENT_CUSTOMER_CHANGE_MERGED" } });
    }
  });

  it("merges two active incidents atomically without moving their history", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const references = await listSupportReferences();
    const baseCommand = {
      customerId: customer.id,
      storeId: null,
      categoryId: references.categories[0]!.id,
      responsibleUserId: actor.id,
      description: "Incidencia sintética para verificar una fusión trazable.",
      priority: "MEDIUM" as const,
    };
    const primary = await createSupportIncident(
      { ...baseCommand, title: "Incidencia principal" },
      actor,
      { idempotencyKey: randomUUID(), requestHash: hashSupportRequest({ ...baseCommand, title: "Incidencia principal" }), scope: "incident:create" },
    );
    const duplicate = await createSupportIncident(
      { ...baseCommand, title: "Incidencia duplicada" },
      actor,
      { idempotencyKey: randomUUID(), requestHash: hashSupportRequest({ ...baseCommand, title: "Incidencia duplicada" }), scope: "incident:create" },
    );
    if (!primary.ok || !duplicate.ok) throw new Error("MERGE_FIXTURE_NOT_CREATED");
    const actionCommand = { expectedVersion: 1, text: "Evidencia que debe conservar su incidencia de origen.", performedAt: new Date().toISOString() };
    const action = await createSupportAction(duplicate.value.id, actionCommand, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportActionRequest({ incidentId: duplicate.value.id, ...actionCommand }), scope: `incident:${duplicate.value.id}:action:create` });
    if (!action.ok) throw new Error(action.error.code);
    const collaboratorRole = await prisma.role.create({ data: { code: "MergeInactiveCollaborator", name: "Colaborador de fusión", permissions: { create: ["Support.View", "Support.AddActions"].map((code) => ({ permission: { connect: { code } } })) } } });
    const collaborator = await prisma.user.create({ data: { displayName: "Colaborador inactivo", userName: "merge-inactive", normalizedUserName: "merge-inactive", passwordHash: hashPassword("Cambiar-merge-inactive-2026"), roleId: collaboratorRole.id } });
    const participantCommand = { action: "add-collaborator" as const, expectedVersion: action.value.incident.version, userId: collaborator.id };
    const participant = await changeSupportParticipants(duplicate.value.id, participantCommand, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportParticipantRequest({ incidentId: duplicate.value.id, ...participantCommand }), scope: `incident:${duplicate.value.id}:participant-change` });
    if (!participant.ok) throw new Error(participant.error.code);
    await prisma.user.update({ where: { id: collaborator.id }, data: { status: "INACTIVE" } });
    const communicationCommand = {
      customerId: customer.id,
      channel: "PHONE" as const,
      direction: "INBOUND" as const,
      occurredAt: new Date().toISOString(),
      contactId: null,
      contactNumber: "+34910000003",
      durationSeconds: 90,
      summary: "Comunicación vinculada a la incidencia duplicada.",
      result: "REFERRED_TO_INCIDENT" as const,
      incidentId: duplicate.value.id,
    };
    const communication = await createSupportCommunication(communicationCommand, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportCommunicationRequest(communicationCommand), scope: "communication:create" });
    if (!communication.ok) throw new Error(communication.error.code);
    const unlinkedCommunicationCommand = { ...communicationCommand, incidentId: null, contactNumber: "+34910000005", summary: "Comunicación sin incidencia para probar la barrera SQL.", result: "INFORMATION_PROVIDED" as const };
    const unlinkedCommunication = await createSupportCommunication(unlinkedCommunicationCommand, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportCommunicationRequest(unlinkedCommunicationCommand), scope: "communication:create" });
    if (!unlinkedCommunication.ok) throw new Error(unlinkedCommunication.error.code);
    const attachmentInput = { incidentId: duplicate.value.id, actionId: null, bytes: Buffer.from("merge-source-pdf"), fileName: "fusion.pdf", declaredMimeType: "application/pdf", clientIdempotencyKey: randomUUID(), requestHash: "" };
    attachmentInput.requestHash = supportIncidentAttachmentRequestHash(attachmentInput);
    const attachment = await uploadSupportIncidentAttachment(attachmentInput, actor, { correlationId: "merge-attachment-0001" }, {
      storage: new IncidentAttachmentMemoryStorage(),
      scanner: { scan: async () => ({ outcome: "clean" as const, engine: "test-scanner", version: "1" }) },
      prepare: async () => ({ bytes: Buffer.from("merge-canonical-pdf"), originalFileName: "fusion.pdf", extension: "pdf" as const, mediaType: "application/pdf" as const }),
    });
    if (!attachment.ok) throw new Error(attachment.error.code);
    const command = {
      primaryIncidentId: primary.value.id,
      duplicateIncidentId: duplicate.value.id,
      expectedPrimaryVersion: primary.value.version,
      expectedDuplicateVersion: participant.value.incident.version,
      reason: "Ambos registros documentan el mismo problema operativo.",
      confirmation: "MERGE_DUPLICATE_INCIDENT" as const,
    };
    const context = { idempotencyKey: randomUUID(), requestHash: hashSupportIncidentMergeRequest(command), scope: "support:incident-merge", correlationId: "merge-test-0001" };

    const first = await mergeSupportIncidents(command, actor, context);
    const replay = await mergeSupportIncidents(command, actor, context);

    expect(first).toMatchObject({ ok: true, status: 201, value: { primary: { id: primary.value.id, version: 2 }, duplicate: { id: duplicate.value.id, status: "CLOSED", closeReason: "DUPLICATE", version: 4 } } });
    expect(replay).toMatchObject({ ok: true, status: 200, value: { merge: { id: first.ok ? first.value.merge.id : "" } } });
    const reusedCommand = { ...command, reason: "La misma clave no puede autorizar un cuerpo distinto." };
    expect(await mergeSupportIncidents(reusedCommand, actor, { ...context, requestHash: hashSupportIncidentMergeRequest(reusedCommand) })).toMatchObject({ ok: false, status: 409, error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    expect(await prisma.supportIncidentMerge.count()).toBe(1);
    expect(await prisma.supportIncidentEvent.count({ where: { eventType: "INCIDENT_MERGED" } })).toBe(2);
    expect(await prisma.notification.count({ where: { kind: "SUPPORT_INCIDENT_MERGED" } })).toBe(1);
    const mergedDetails = { expectedVersion: 4, title: "Duplicada alterada", description: baseCommand.description, categoryId: baseCommand.categoryId, storeId: null, reason: "No debe admitirse sobre una duplicada." };
    expect(await changeSupportIncidentDetails(duplicate.value.id, mergedDetails, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportIncidentDetailsChangeRequest({ incidentId: duplicate.value.id, ...mergedDetails }), scope: `incident:${duplicate.value.id}:details-change` })).toMatchObject({ ok: false, status: 409, error: { code: "SUPPORT_INCIDENT_MERGED_READ_ONLY" } });
    const mergedCorrection = { expectedIncidentVersion: 4, expectedActionVersion: 1, text: "Intento de corregir una actuación fusionada.", reason: "La duplicada debe permanecer en solo lectura." };
    expect(await correctSupportAction(duplicate.value.id, action.value.action.id, mergedCorrection, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportActionCorrectionRequest({ incidentId: duplicate.value.id, actionId: action.value.action.id, ...mergedCorrection }), scope: `incident:${duplicate.value.id}:action:${action.value.action.id}:correction` })).toMatchObject({ ok: false, status: 409, error: { code: "SUPPORT_INCIDENT_MERGED_READ_ONLY" } });
    const storedAction = await prisma.supportIncidentAction.findUniqueOrThrow({ where: { id: action.value.action.id } });
    expect(storedAction.incidentId).toBe(duplicate.value.id);
    const primaryDetail = await getSupportIncident(primary.value.id, actor);
    const duplicateDetail = await getSupportIncident(duplicate.value.id, actor);
    expect(primaryDetail?.mergedIncidents).toEqual([{ id: duplicate.value.id, number: duplicate.value.number, title: duplicate.value.title }]);
    expect(primaryDetail?.actions).toEqual(expect.arrayContaining([expect.objectContaining({ id: action.value.action.id, sourceIncident: { id: duplicate.value.id, number: duplicate.value.number } })]));
    expect(primaryDetail?.communications).toEqual(expect.arrayContaining([expect.objectContaining({ id: communication.value.id, sourceIncident: { id: duplicate.value.id, number: duplicate.value.number } })]));
    expect(await listSupportIncidentAttachments(primary.value.id, actor)).toEqual(expect.arrayContaining([expect.objectContaining({ id: attachment.value.attachment.id, sourceIncident: { id: duplicate.value.id, number: duplicate.value.number } })]));
    expect(duplicateDetail?.mergedInto).toEqual({ id: primary.value.id, number: primary.value.number });
    const physicalSearch = await listSupportIncidents({ limit: 25, search: "conservar su incidencia" }, actor);
    expect(physicalSearch.incidents.map((incident) => incident.id)).toEqual([duplicate.value.id]);
    const rejectedCommunication = { ...communicationCommand, contactNumber: "+34910000004", summary: "Intento posterior a la fusión." };
    expect(await createSupportCommunication(rejectedCommunication, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportCommunicationRequest(rejectedCommunication), scope: "communication:create" })).toMatchObject({ ok: false, status: 422, error: { code: "SUPPORT_COMMUNICATION_INCIDENT_INVALID" } });
    await expect(prisma.$executeRaw`UPDATE "support_communications" SET "incidentId" = ${duplicate.value.id}::uuid WHERE "id" = ${unlinkedCommunication.value.id}::uuid`).rejects.toThrow();
    expect(supportStatusTransitionSchema.safeParse({ action: "close", expectedVersion: 1, closeReason: "DUPLICATE" }).success).toBe(false);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUPPORT_INCIDENTS_MERGED" } });
    expect(JSON.stringify(audit.payload)).not.toContain(command.reason);
    await expect(prisma.supportIncidentMerge.update({ where: { id: first.ok ? first.value.merge.id : randomUUID() }, data: { reason: "Alteración" } })).rejects.toThrow();
  });

  it("builds an opaque permission-aware support dashboard from one canonical snapshot", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const references = await listSupportReferences();
    const base = { customerId: customer.id, storeId: null, categoryId: references.categories[0]!.id, responsibleUserId: actor.id, description: "Descripción que no debe salir en el panel.", priority: "MEDIUM" as const };
    const primary = await createSupportIncident({ ...base, title: "Principal visible" }, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest({ ...base, title: "Principal visible" }), scope: "incident:create" });
    const duplicate = await createSupportIncident({ ...base, title: "Duplicada excluida", priority: "URGENT" }, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest({ ...base, title: "Duplicada excluida", priority: "URGENT" }), scope: "incident:create" });
    if (!primary.ok || !duplicate.ok) throw new Error("DASHBOARD_FIXTURE_NOT_CREATED");
    const merge = { primaryIncidentId: primary.value.id, duplicateIncidentId: duplicate.value.id, expectedPrimaryVersion: 1, expectedDuplicateVersion: 1, reason: "Duplicado sintético para el panel.", confirmation: "MERGE_DUPLICATE_INCIDENT" as const };
    const merged = await mergeSupportIncidents(merge, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportIncidentMergeRequest(merge), scope: "support:incident-merge" });
    if (!merged.ok) throw new Error(merged.error.code);
    const communication = { customerId: customer.id, channel: "PHONE" as const, direction: "INBOUND" as const, occurredAt: new Date().toISOString(), contactId: null, contactNumber: "+34910000999", durationSeconds: 25, summary: "Resumen secreto del panel.", result: "INFORMATION_PROVIDED" as const, incidentId: primary.value.id };
    const createdCommunication = await createSupportCommunication(communication, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportCommunicationRequest(communication), scope: "communication:create" });
    if (!createdCommunication.ok) throw new Error(createdCommunication.error.code);

    const result = await getSupportDashboard(actor, { correlationId: "support-dashboard-test" });
    expect(result).toMatchObject({ ok: true, value: { snapshot: { newCount: 1, urgentCount: 0, mineCount: 1 }, myIncidents: [{ id: primary.value.id }], assignedByTechnician: [{ id: actor.id, count: 1 }], latestCommunications: [{ id: createdCommunication.value.id }], unreadNotifications: { count: expect.any(Number) } } });
    expect(JSON.stringify(result)).not.toContain(communication.summary);
    expect(JSON.stringify(result)).not.toContain(communication.contactNumber);
    expect(JSON.stringify(result)).not.toContain(base.description);
    const restricted = await getSupportDashboard({ ...actor, permissions: ["Support.View"] });
    expect(restricted.ok && "assignedByTechnician" in restricted.value).toBe(false);
    expect(restricted.ok && "latestCommunications" in restricted.value).toBe(false);
    const otherRole = await prisma.role.create({ data: { code: "SupportDashboardOther", name: "Otro técnico", permissions: { create: { permission: { connect: { code: "Support.View" } } } } } });
    const other = await prisma.user.create({ data: { displayName: "Otro técnico", userName: "dashboard-other", normalizedUserName: "dashboard-other", passwordHash: hashPassword("Cambiar-dashboard-other-2026"), roleId: otherRole.id } });
    const otherResult = await getSupportDashboard({ id: other.id, displayName: other.displayName, userName: other.userName, role: { code: otherRole.code, name: otherRole.name }, permissions: ["Support.View"] });
    expect(otherResult).toMatchObject({ ok: true, value: { snapshot: { mineCount: 0 }, myIncidents: [], unreadNotifications: { count: 0, items: [] } } });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUPPORT_DASHBOARD_VIEWED" }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(audit.payload)).not.toContain(primary.value.title);
    expect(JSON.stringify(audit.payload)).not.toContain(customer.legalName);
  });

  it("builds a permission-aware customer support context with merged history", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const references = await listSupportReferences();
    const base = {
      customerId: customer.id,
      storeId: null,
      categoryId: references.categories[0]!.id,
      responsibleUserId: actor.id,
      description: "Descripción privada del contexto del cliente.",
      priority: "MEDIUM" as const,
    };
    const primaryCommand = { ...base, title: "Incidencia principal del cliente" };
    const duplicateCommand = {
      ...base,
      title: "Incidencia duplicada del cliente",
      priority: "HIGH" as const,
    };
    const primary = await createSupportIncident(primaryCommand, actor, {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportRequest(primaryCommand),
      scope: "incident:create",
    });
    const duplicate = await createSupportIncident(duplicateCommand, actor, {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportRequest(duplicateCommand),
      scope: "incident:create",
    });
    if (!primary.ok || !duplicate.ok) throw new Error("CUSTOMER_CONTEXT_FIXTURE_NOT_CREATED");
    const mergeCommand = {
      primaryIncidentId: primary.value.id,
      duplicateIncidentId: duplicate.value.id,
      expectedPrimaryVersion: 1,
      expectedDuplicateVersion: 1,
      reason: "Duplicado sintético para el contexto del cliente.",
      confirmation: "MERGE_DUPLICATE_INCIDENT" as const,
    };
    const merge = await mergeSupportIncidents(mergeCommand, actor, {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportIncidentMergeRequest(mergeCommand),
      scope: "support:incident-merge",
    });
    if (!merge.ok) throw new Error(merge.error.code);
    const communicationCommand = {
      customerId: customer.id,
      channel: "WHATSAPP" as const,
      direction: "OUTBOUND" as const,
      occurredAt: new Date().toISOString(),
      contactId: null,
      contactNumber: "+34910000888",
      durationSeconds: null,
      summary: "Resumen privado que no pertenece a la proyección.",
      result: "INFORMATION_PROVIDED" as const,
      incidentId: primary.value.id,
    };
    const communication = await createSupportCommunication(
      communicationCommand,
      actor,
      {
        idempotencyKey: randomUUID(),
        requestHash: hashSupportCommunicationRequest(communicationCommand),
        scope: "communication:create",
      },
    );
    if (!communication.ok) throw new Error(communication.error.code);

    const result = await getCustomerSupportContext(customer.id, actor, {
      correlationId: "customer-support-context-test",
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        customerId: customer.id,
        openIncidents: { total: 1, items: [{ id: primary.value.id }] },
        finalizedIncidents: {
          total: 1,
          items: [
            {
              id: duplicate.value.id,
              status: "CLOSED",
              mergedInto: { id: primary.value.id, number: primary.value.number },
            },
          ],
        },
        communications: {
          total: 1,
          items: [{ id: communication.value.id, incident: { id: primary.value.id } }],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(communicationCommand.summary);
    expect(JSON.stringify(result)).not.toContain(communicationCommand.contactNumber);
    expect(JSON.stringify(result)).not.toContain(base.description);

    const restricted = await getCustomerSupportContext(customer.id, {
      ...actor,
      permissions: ["Customers.View", "Support.View"],
    });
    expect(restricted.ok && "communications" in restricted.value).toBe(false);
    expect(
      await getCustomerSupportContext(customer.id, {
        ...actor,
        permissions: ["Support.View"],
      }),
    ).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "SUPPORT_CUSTOMER_CONTEXT_FORBIDDEN" },
    });
    expect(await getCustomerSupportContext(randomUUID(), actor)).toMatchObject({
      ok: false,
      status: 404,
      error: { code: "SUPPORT_CUSTOMER_NOT_FOUND" },
    });
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "SUPPORT_CUSTOMER_CONTEXT_VIEWED" },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.payload).toMatchObject({
      actorUserId: actor.id,
      customerId: customer.id,
      disclosedCommunications: true,
      correlationId: "customer-support-context-test",
    });
    expect(JSON.stringify(audit.payload)).not.toContain(primary.value.title);
    expect(JSON.stringify(audit.payload)).not.toContain(customer.legalName);
  });

  it("serializes concurrent merges over the same duplicate", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const references = await listSupportReferences();
    const base = { customerId: customer.id, storeId: null, categoryId: references.categories[0]!.id, responsibleUserId: actor.id, description: "Incidencia para comprobar exclusión concurrente.", priority: "MEDIUM" as const };
    const [primary, duplicate] = await Promise.all([
      createSupportIncident({ ...base, title: "Principal concurrente" }, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest({ ...base, title: "Principal concurrente" }), scope: "incident:create" }),
      createSupportIncident({ ...base, title: "Duplicada concurrente" }, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest({ ...base, title: "Duplicada concurrente" }), scope: "incident:create" }),
    ]);
    if (!primary.ok || !duplicate.ok) throw new Error("CONCURRENT_MERGE_FIXTURE_NOT_CREATED");
    const command = { primaryIncidentId: primary.value.id, duplicateIncidentId: duplicate.value.id, expectedPrimaryVersion: 1, expectedDuplicateVersion: 1, reason: "Ambos registros son el mismo caso concurrente.", confirmation: "MERGE_DUPLICATE_INCIDENT" as const };
    const results = await Promise.all([
      mergeSupportIncidents(command, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportIncidentMergeRequest(command), scope: "incident-merge", correlationId: "merge-race-1" }),
      mergeSupportIncidents(command, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportIncidentMergeRequest(command), scope: "incident-merge", correlationId: "merge-race-2" }),
    ]);
    expect(results.filter((result) => result.ok && result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.status === 409)).toHaveLength(1);
    expect(await prisma.supportIncidentMerge.count()).toBe(1);
    expect(await prisma.supportIncidentEvent.count({ where: { eventType: "INCIDENT_MERGED" } })).toBe(2);
  });

  it("calculates own and global indicators from historical ownership and excludes pending intervals", async () => {
    const administrator = await admin();
    const role = await prisma.role.create({ data: { code: "SupportIndicatorTechnician", name: "Tecnico de indicadores", permissions: { create: ["Support.View", "Support.ViewIndicators", "Support.AddActions", "Support.ManageAssigned", "Support.Reopen"].map((code) => ({ permission: { connect: { code } } })) } } });
    const technician = await prisma.user.create({ data: { displayName: "Tecnico KPI", userName: "technician-kpi", normalizedUserName: "technician-kpi", passwordHash: hashPassword("Cambiar-technician-kpi-2026"), roleId: role.id } });
    const logged = await login({ userName: "technician-kpi", password: "Cambiar-technician-kpi-2026" });
    if (!logged.ok) throw new Error(logged.error.code);
    const customer = await createCustomerRecord(administrator);
    const references = await listSupportReferences();
    const create = { customerId: customer.id, storeId: null, categoryId: references.categories[0]!.id, responsibleUserId: technician.id, title: "Indicadores con pausas", description: "Caso sintetico para medir episodios de resolucion.", priority: "HIGH" as const };
    const incident = await createSupportIncident(create, administrator, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(create), scope: "incident:create" });
    if (!incident.ok) throw new Error(incident.error.code);
    const base = new Date(); base.setUTCMinutes(0, 0, 0); base.setUTCHours(base.getUTCHours() - 24);
    const at = (hours: number) => new Date(base.getTime() + hours * 3_600_000);
    await prisma.supportIncident.update({ where: { id: incident.value.id }, data: { createdAt: at(0) } });
    const actionCommand = { expectedVersion: 1, text: "Primera actuacion del tecnico.", performedAt: at(1).toISOString() };
    const action = await createSupportAction(incident.value.id, actionCommand, logged.value.user, { idempotencyKey: randomUUID(), requestHash: hashSupportActionRequest({ incidentId: incident.value.id, ...actionCommand }), scope: `incident:${incident.value.id}:action:create` });
    if (!action.ok) throw new Error(action.error.code);
    const transitions: string[] = [];
    for (const command of [
      { action: "set-pending" as const, expectedVersion: 2, targetStatus: "PENDING_CUSTOMER" as const, reason: "Esperando confirmacion del cliente." },
      { action: "resume" as const, expectedVersion: 3, reason: "El cliente confirma la informacion." },
      { action: "resolve" as const, expectedVersion: 4, solution: "Servicio verificado y restablecido." },
      { action: "reopen" as const, expectedVersion: 5, reason: "La incidencia vuelve a reproducirse." },
      { action: "set-pending" as const, expectedVersion: 6, targetStatus: "PENDING_THIRD_PARTY" as const, reason: "Esperando respuesta del proveedor." },
      { action: "resume" as const, expectedVersion: 7, reason: "El proveedor confirma la correccion." },
      { action: "resolve" as const, expectedVersion: 8, solution: "La segunda incidencia queda verificada." },
    ]) {
      const result = await transitionSupportIncident(incident.value.id, command, logged.value.user, transitionContext(incident.value.id, command));
      if (!result.ok) throw new Error(result.error.code);
      transitions.push(result.value.transition.id);
    }
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "support_incident_actions" DISABLE TRIGGER "support_incident_actions_append_only"');
      await tx.$executeRawUnsafe('ALTER TABLE "support_incident_status_transitions" DISABLE TRIGGER "support_incident_status_transitions_append_only"');
      await tx.$executeRawUnsafe('ALTER TABLE "support_incident_events" DISABLE TRIGGER "support_incident_events_append_only"');
      await tx.supportIncident.update({ where: { id: incident.value.id }, data: { createdAt: at(0), firstActionAt: at(1) } });
      await tx.supportIncidentAction.update({ where: { id: action.value.action.id }, data: { performedAt: at(1), recordedAt: at(1) } });
      const hours = [2, 4, 7, 8, 9, 10, 12];
      for (let index = 0; index < transitions.length; index += 1) {
        await tx.supportIncidentStatusTransition.update({ where: { id: transitions[index]! }, data: { occurredAt: at(hours[index]!) } });
        await tx.supportIncidentEvent.update({ where: { transitionId_companyId: { transitionId: transitions[index]!, companyId: (await tx.installation.findFirstOrThrow()).companyId! } }, data: { createdAt: at(hours[index]!) } });
      }
      await tx.$executeRawUnsafe('ALTER TABLE "support_incident_actions" ENABLE TRIGGER "support_incident_actions_append_only"');
      await tx.$executeRawUnsafe('ALTER TABLE "support_incident_status_transitions" ENABLE TRIGGER "support_incident_status_transitions_append_only"');
      await tx.$executeRawUnsafe('ALTER TABLE "support_incident_events" ENABLE TRIGGER "support_incident_events_append_only"');
    });
    const date = base.toISOString().slice(0, 10);
    const periodTo = new Date(base.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
    const own = await getSupportIndicators({ from: date, to: periodTo, scope: "self" }, logged.value.user, { correlationId: "indicator-self-0001" });
    expect(own).toMatchObject({ ok: true, value: { scope: { type: "SELF", technician: { id: technician.id } }, performance: { averageFirstActionSeconds: { value: 3600, sampleSize: 1 }, averageResolutionSeconds: { value: 14400, sampleSize: 2 }, resolvedCount: 2, closedCount: 0 } } });
    if (!own.ok) throw new Error(own.error.code);
    expect(own.value.snapshot).not.toHaveProperty("assignedByTechnician");
    expect(own.value).not.toHaveProperty("breakdown");
    const global = await getSupportIndicators({ from: date, to: periodTo, scope: "global" }, administrator, { correlationId: "indicator-global-0001" });
    expect(global).toMatchObject({ ok: true, value: { scope: { type: "GLOBAL" }, breakdown: expect.arrayContaining([expect.objectContaining({ id: technician.id, averageResolutionSeconds: { value: 14400, sampleSize: 2 }, resolvedCount: 2 })]) } });
    expect(await prisma.auditEvent.count({ where: { eventType: "SUPPORT_INDICATORS_VIEWED" } })).toBe(2);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUPPORT_INDICATORS_VIEWED" }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(audit.payload)).not.toContain(incident.value.title);
  });

  it("records actions append-only and advances a new incident exactly once", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const refs = await listSupportReferences();
    const incidentCommand = {
      customerId: customer.id,
      storeId: null,
      categoryId: refs.categories[0]!.id,
      responsibleUserId: actor.id,
      title: "Acceso intermitente",
      description: "Se requiere una revisión técnica del acceso.",
      priority: "HIGH" as const,
    };
    const incident = await createSupportIncident(incidentCommand, actor, {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportRequest(incidentCommand),
      scope: "incident:create",
    });
    if (!incident.ok) throw new Error(incident.error.code);
    const actionCommand = {
      expectedVersion: 1,
      text: "Se revisa la configuración y se reproduce el problema.",
      performedAt: new Date().toISOString(),
    };
    const context = {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportActionRequest({
        incidentId: incident.value.id,
        ...actionCommand,
      }),
      scope: `incident:${incident.value.id}:action:create`,
      correlationId: "support-action-0001",
    };
    const created = await createSupportAction(
      incident.value.id,
      actionCommand,
      actor,
      context,
    );
    const replay = await createSupportAction(
      incident.value.id,
      actionCommand,
      actor,
      context,
    );
    expect(created).toMatchObject({
      ok: true,
      status: 201,
      value: {
        incident: { status: "IN_PROGRESS", version: 2 },
        action: { text: actionCommand.text, author: { id: actor.id } },
      },
    });
    expect(replay).toMatchObject({
      ok: true,
      status: 200,
      value: { action: { id: created.ok ? created.value.action.id : "" } },
    });
    const stored = await prisma.supportIncident.findUniqueOrThrow({
      where: { id: incident.value.id },
      include: { actions: true, events: true },
    });
    await prisma.rateLimitBucket.update({ where: { key: `support-action:${stored.companyId}:${actor.id}` }, data: { count: 30, windowStart: new Date() } });
    const limitedCommand = { ...actionCommand, expectedVersion: 2, text: "Intento acotado por cuota persistente." };
    expect(await createSupportAction(incident.value.id, limitedCommand, actor, { ...context, requestHash: hashSupportActionRequest({ incidentId: incident.value.id, ...limitedCommand }) })).toMatchObject({ ok: false, status: 429, error: { code: "SUPPORT_ACTION_RATE_LIMITED", retryAfterSeconds: expect.any(Number) } });
    expect(stored).toMatchObject({ status: "IN_PROGRESS", version: 2 });
    expect(stored.firstActionAt?.toISOString()).toBe(actionCommand.performedAt);
    expect(stored.actions).toHaveLength(1);
    expect(
      stored.events.filter((event) => event.eventType === "ACTION_ADDED"),
    ).toHaveLength(1);
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "SUPPORT_INCIDENT_ACTION_ADDED" },
    });
    expect(audit.payload).toMatchObject({
      actorUserId: actor.id,
      incidentId: incident.value.id,
      previousStatus: "NEW",
      status: "IN_PROGRESS",
      version: 2,
      hasText: true,
      correlationId: "support-action-0001",
    });
    expect(JSON.stringify(audit.payload)).not.toContain(actionCommand.text);
    await expect(
      prisma.supportIncidentAction.update({
        where: { id: stored.actions[0]!.id },
        data: { text: "Texto alterado" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.$transaction(async (tx) => {
        const performedAt = new Date();
        await tx.supportIncidentAction.create({
          data: {
            companyId: stored.companyId,
            incidentId: stored.id,
            authorUserId: actor.id,
            text: "Actuación sin evento coincidente.",
            performedAt,
          },
        });
        await tx.supportIncident.update({
          where: { id: stored.id },
          data: {
            firstActionAt:
              stored.firstActionAt && stored.firstActionAt < performedAt
                ? stored.firstActionAt
                : performedAt,
            version: { increment: 1 },
          },
        });
      }),
    ).rejects.toThrow(/matching event/i);
  });

  it("rejects actions from a non-responsible technician and stale versions", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const refs = await listSupportReferences();
    const incidentCommand = {
      customerId: customer.id,
      storeId: null,
      categoryId: refs.categories[0]!.id,
      responsibleUserId: actor.id,
      title: "Incidencia asignada",
      description: "Solo el responsable puede actuar en esta fase.",
      priority: "MEDIUM" as const,
    };
    const incident = await createSupportIncident(incidentCommand, actor, {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportRequest(incidentCommand),
      scope: "incident:create",
    });
    if (!incident.ok) throw new Error(incident.error.code);
    const role = await prisma.role.create({
      data: {
        code: "SupportTechnician",
        name: "Técnico de soporte",
        permissions: {
          create: ["Support.View", "Support.AddActions"].map((code) => ({
            permission: { connect: { code } },
          })),
        },
      },
    });
    const user = await prisma.user.create({
      data: {
        displayName: "Técnico",
        userName: "support-tech",
        normalizedUserName: "support-tech",
        passwordHash: "not-used",
        roleId: role.id,
      },
    });
    const technician = {
      id: user.id,
      displayName: user.displayName,
      userName: user.userName,
      role: { code: role.code, name: role.name },
      permissions: ["Support.View", "Support.AddActions"],
    };
    const command = {
      expectedVersion: 1,
      text: "Intento de actuación no asignada.",
      performedAt: new Date().toISOString(),
    };
    const denied = await createSupportAction(
      incident.value.id,
      command,
      technician,
      {
        idempotencyKey: randomUUID(),
        requestHash: hashSupportActionRequest({
          incidentId: incident.value.id,
          ...command,
        }),
        scope: `incident:${incident.value.id}:action:create`,
      },
    );
    expect(denied).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "SUPPORT_INCIDENT_ACTION_FORBIDDEN" },
    });
    expect(
      await prisma.auditEvent.findFirst({
        where: {
          eventType: "SUPPORT_INCIDENT_ACTION_DENIED",
          payload: { path: ["actorUserId"], equals: technician.id },
        },
      }),
    ).not.toBeNull();
    const first = await createSupportAction(incident.value.id, command, actor, {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportActionRequest({
        incidentId: incident.value.id,
        ...command,
      }),
      scope: `incident:${incident.value.id}:action:create`,
    });
    expect(first.ok).toBe(true);
    const stale = await createSupportAction(incident.value.id, command, actor, {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportActionRequest({
        incidentId: incident.value.id,
        ...command,
      }),
      scope: `incident:${incident.value.id}:action:create`,
    });
    expect(stale).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "SUPPORT_INCIDENT_VERSION_CONFLICT" },
    });
    const resolveCommand = {
      action: "resolve" as const,
      expectedVersion: 2,
      solution: "Se corrige la configuración y se valida el acceso.",
    };
    const resolved = await transitionSupportIncident(
      incident.value.id,
      resolveCommand,
      actor,
      transitionContext(incident.value.id, resolveCommand),
    );
    expect(resolved).toMatchObject({
      ok: true,
      value: { incident: { status: "RESOLVED", version: 3 } },
    });
    const finalizedCommand = { ...command, expectedVersion: 3 };
    const finalized = await createSupportAction(
      incident.value.id,
      finalizedCommand,
      actor,
      {
        idempotencyKey: randomUUID(),
        requestHash: hashSupportActionRequest({
          incidentId: incident.value.id,
          ...finalizedCommand,
        }),
        scope: `incident:${incident.value.id}:action:create`,
      },
    );
    expect(finalized).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "SUPPORT_INCIDENT_FINALIZED" },
    });
  });

  it("preserves pending, close and reopen transitions with versioned evidence", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const refs = await listSupportReferences();
    const command = {
      customerId: customer.id,
      storeId: null,
      categoryId: refs.categories[0]!.id,
      responsibleUserId: actor.id,
      title: "Seguimiento externo",
      description: "La incidencia requiere respuesta del cliente.",
      priority: "MEDIUM" as const,
    };
    const incident = await createSupportIncident(command, actor, {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportRequest(command),
      scope: "incident:create",
    });
    if (!incident.ok) throw new Error(incident.error.code);
    const pending = {
      action: "set-pending" as const,
      expectedVersion: 1,
      targetStatus: "PENDING_CUSTOMER" as const,
      reason: "Esperamos confirmación del cliente.",
    };
    expect(
      await transitionSupportIncident(
        incident.value.id,
        pending,
        actor,
        transitionContext(incident.value.id, pending),
      ),
    ).toMatchObject({
      ok: true,
      status: 201,
      value: { incident: { status: "PENDING_CUSTOMER", version: 2 } },
    });
    const resume = {
      action: "resume" as const,
      expectedVersion: 2,
      reason: "El cliente aporta la información solicitada.",
    };
    expect(
      await transitionSupportIncident(
        incident.value.id,
        resume,
        actor,
        transitionContext(incident.value.id, resume),
      ),
    ).toMatchObject({
      ok: true,
      value: { incident: { status: "IN_PROGRESS", version: 3 } },
    });
    const close = {
      action: "close" as const,
      expectedVersion: 3,
      closeReason: "OTHER" as const,
      detail: "Caso absorbido por una actuación preventiva.",
    };
    expect(
      await transitionSupportIncident(
        incident.value.id,
        close,
        actor,
        transitionContext(incident.value.id, close),
      ),
    ).toMatchObject({
      ok: true,
      value: { incident: { status: "CLOSED", version: 4 } },
    });
    const reopen = {
      action: "reopen" as const,
      expectedVersion: 4,
      reason: "El problema vuelve a reproducirse.",
    };
    const reopenContext = transitionContext(incident.value.id, reopen, "reopen-key");
    const reopened = await transitionSupportIncident(
      incident.value.id,
      reopen,
      actor,
      reopenContext,
    );
    const replay = await transitionSupportIncident(
      incident.value.id,
      reopen,
      actor,
      reopenContext,
    );
    expect(reopened).toMatchObject({
      ok: true,
      value: { incident: { status: "IN_PROGRESS", version: 5 } },
    });
    expect(await prisma.notification.findMany({ where: { incidentId: incident.value.id, kind: "SUPPORT_INCIDENT_REOPENED" }, select: { recipientUserId: true, messageCode: true, severity: true } })).toEqual([{ recipientUserId: actor.id, messageCode: "support.incident.reopened", severity: "INFO" }]);
    expect(replay).toMatchObject({ ok: true, status: 200, value: { incident: { version: 5 } } });
    expect(await prisma.notification.count({ where: { incidentId: incident.value.id, kind: "SUPPORT_INCIDENT_REOPENED" } })).toBe(1);
    const stored = await prisma.supportIncident.findUniqueOrThrow({
      where: { id: incident.value.id },
      include: { transitions: true, events: true },
    });
    expect(stored.transitions).toHaveLength(4);
    expect(stored.events).toHaveLength(5);
    expect(stored.closeReason).toBeNull();
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: {
        eventType: "SUPPORT_INCIDENT_STATUS_CHANGED",
        payload: { path: ["action"], equals: "set-pending" },
      },
    });
    expect(JSON.stringify(audit.payload)).not.toContain(pending.reason);
    await expect(
      prisma.supportIncidentStatusTransition.update({
        where: { id: stored.transitions[0]!.id },
        data: { reasonText: "Alterado" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.supportIncident.update({
        where: { id: stored.id },
        data: {
          status: "CLOSED",
          version: { increment: 1 },
          closedAt: new Date(),
          closeReason: "DUPLICATE",
        },
      }),
    ).rejects.toThrow();
  });

  it("adds and removes collaborators, authorizes their actions and preserves reassignment history", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const refs = await listSupportReferences();
    const role = await prisma.role.create({
      data: {
        code: "SupportCollaborator",
        name: "Colaborador soporte",
        permissions: {
          create: ["Support.View", "Support.AddActions"].map((code) => ({
            permission: { connect: { code } },
          })),
        },
      },
    });
    const user = await prisma.user.create({
      data: {
        displayName: "Técnica colaboradora",
        userName: "collaborator",
        normalizedUserName: "collaborator",
        passwordHash: "not-used",
        roleId: role.id,
      },
    });
    const collaboratorActor = {
      id: user.id,
      displayName: user.displayName,
      userName: user.userName,
      role: { code: role.code, name: role.name },
      permissions: ["Support.View", "Support.AddActions"],
    };
    const create = {
      customerId: customer.id,
      storeId: null,
      categoryId: refs.categories[0]!.id,
      responsibleUserId: actor.id,
      title: "Trabajo compartido",
      description: "Intervención coordinada entre dos técnicas.",
      priority: "MEDIUM" as const,
    };
    const incident = await createSupportIncident(create, actor, {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportRequest(create),
      scope: "incident:create",
    });
    if (!incident.ok) throw new Error(incident.error.code);
    const add = {
      action: "add-collaborator" as const,
      expectedVersion: 1,
      userId: user.id,
    };
    const added = await changeSupportParticipants(
      incident.value.id,
      add,
      actor,
      participantContext(incident.value.id, add),
    );
    expect(added).toMatchObject({
      ok: true,
      value: {
        incident: { version: 2 },
        change: { type: "COLLABORATOR_ADDED" },
      },
    });
    expect(await prisma.notification.findMany({ where: { incidentId: incident.value.id, kind: "SUPPORT_INCIDENT_COLLABORATOR_ADDED" }, select: { recipientUserId: true, messageCode: true, severity: true } })).toEqual([{ recipientUserId: user.id, messageCode: "support.incident.collaborator-added", severity: "INFO" }]);
    const action = {
      expectedVersion: 2,
      text: "La colaboradora reproduce y documenta el problema.",
      performedAt: new Date().toISOString(),
    };
    const actionContext = {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportActionRequest({ incidentId: incident.value.id, ...action }),
      scope: `incident:${incident.value.id}:action:create`,
    };
    expect(await createSupportAction(incident.value.id, action, collaboratorActor, actionContext)).toMatchObject({ ok: true, status: 201, value: { incident: { version: 3 } } });
    expect(await createSupportAction(incident.value.id, action, collaboratorActor, actionContext)).toMatchObject({ ok: true, status: 200, value: { incident: { version: 3 } } });
    expect(await prisma.notification.findMany({ where: { incidentId: incident.value.id, kind: "SUPPORT_INCIDENT_COLLABORATOR_ACTION" }, select: { recipientUserId: true, messageCode: true, severity: true } })).toEqual([{ recipientUserId: actor.id, messageCode: "support.incident.collaborator-action", severity: "INFO" }]);
    expect(JSON.stringify(await prisma.auditEvent.findMany({ where: { eventType: "SUPPORT_NOTIFICATIONS_CREATED" } }))).not.toContain(action.text);
    const collaboratorId = added.ok ? added.value.change.collaboratorId! : "";
    const remove = {
      action: "remove-collaborator" as const,
      expectedVersion: 3,
      collaboratorId,
      reason: "Finaliza su intervención especializada.",
    };
    expect(
      await changeSupportParticipants(
        incident.value.id,
        remove,
        actor,
        participantContext(incident.value.id, remove),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        incident: { version: 4 },
        change: { type: "COLLABORATOR_REMOVED" },
      },
    });
    const deniedAction = { ...action, expectedVersion: 4 };
    expect(
      await createSupportAction(
        incident.value.id,
        deniedAction,
        collaboratorActor,
        {
          idempotencyKey: randomUUID(),
          requestHash: hashSupportActionRequest({
            incidentId: incident.value.id,
            ...deniedAction,
          }),
          scope: `incident:${incident.value.id}:action:create`,
        },
      ),
    ).toMatchObject({ ok: false, status: 403 });
    const reassign = {
      action: "reassign" as const,
      expectedVersion: 4,
      responsibleUserId: user.id,
      reason: "Asume la continuidad y seguimiento del caso.",
    };
    const reassigned = await changeSupportParticipants(
      incident.value.id,
      reassign,
      actor,
      participantContext(incident.value.id, reassign),
    );
    expect(reassigned).toMatchObject({
      ok: true,
      value: {
        incident: { version: 5, responsibleUserId: user.id },
        change: { type: "RESPONSIBLE_CHANGED" },
      },
    });
    const reassignmentNotifications = await prisma.notification.findMany({ where: { incidentId: incident.value.id, kind: "SUPPORT_INCIDENT_REASSIGNED" }, select: { id: true, recipientUserId: true, version: true } });
    expect(reassignmentNotifications).toEqual([{ id: expect.any(String), recipientUserId: user.id, version: 1 }]);
    const foreignCommand = { state: "READ" as const, expectedVersion: 1 };
    expect(await changeNotificationState(reassignmentNotifications[0]!.id, foreignCommand, actor, { idempotencyKey: randomUUID(), requestHash: hashNotificationStateRequest(reassignmentNotifications[0]!.id, foreignCommand), correlationId: "notification-foreign-1" })).toMatchObject({ ok: false, status: 404, error: { code: "NOTIFICATION_NOT_FOUND" } });
    expect(await prisma.auditEvent.count({ where: { eventType: "NOTIFICATION_STATE_DENIED" } })).toBe(1);
    const stored = await getSupportIncident(incident.value.id, actor);
    expect(stored?.collaborators).toHaveLength(1);
    expect(stored?.collaborators[0]?.removedAt).not.toBeNull();
    expect(stored?.participantChanges).toHaveLength(3);
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "SUPPORT_INCIDENT_RESPONSIBLE_CHANGED" },
    });
    expect(JSON.stringify(audit.payload)).not.toContain(reassign.reason);
    await expect(
      prisma.supportIncidentParticipantChange.update({
        where: { id: stored!.participantChanges[0]!.id },
        data: { reason: "Alterado" },
      }),
    ).rejects.toThrow();
  });

  it("records and corrects communications while preserving the original values", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const occurredAt = new Date().toISOString();
    const command = {
      customerId: customer.id,
      channel: "PHONE" as const,
      direction: "INBOUND" as const,
      occurredAt,
      contactId: null,
      contactNumber: "+34910000001",
      durationSeconds: 180,
      summary: "El cliente solicita información sobre el servicio.",
      result: "INFORMATION_PROVIDED" as const,
      incidentId: null,
    };
    const context = {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportCommunicationRequest(command),
      scope: "communication:create",
      correlationId: "communication-create-1",
    };
    const created = await createSupportCommunication(command, actor, context);
    const replay = await createSupportCommunication(command, actor, context);
    expect(created).toMatchObject({
      ok: true,
      status: 201,
      value: { version: 1, summary: command.summary },
    });
    expect(replay).toMatchObject({ ok: true, status: 200 });
    if (!created.ok) throw new Error("not created");
    const storedReplay = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { requestHash: context.requestHash },
    });
    await prisma.idempotencyRecord.update({
      where: { id: storedReplay.id },
      data: { responseBody: { id: created.value.id, version: 1 } },
    });
    expect(
      await createSupportCommunication(command, actor, context),
    ).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "IDEMPOTENCY_REPLAY_INVALID" },
    });
    const correction = {
      expectedVersion: 1,
      channel: "PHONE" as const,
      direction: "INBOUND" as const,
      occurredAt,
      contactId: null,
      contactNumber: "+34910000002",
      durationSeconds: 240,
      summary:
        "El cliente recibe la información completa y confirma recepción.",
      result: "RESOLVED_NO_FOLLOW_UP" as const,
      incidentId: null,
      reason: "Se corrigen número, duración y resultado tras revisar la nota.",
    };
    const corrected = await correctSupportCommunication(
      created.value.id,
      correction,
      actor,
      {
        idempotencyKey: randomUUID(),
        requestHash: hashSupportCommunicationRequest({
          communicationId: created.value.id,
          ...correction,
        }),
        scope: `communication:${created.value.id}:correct`,
        correlationId: "communication-correct-1",
      },
    );
    expect(corrected).toMatchObject({
      ok: true,
      value: {
        version: 2,
        contactNumber: correction.contactNumber,
        corrections: [
          {
            previous: { summary: command.summary },
            corrected: { summary: correction.summary },
          },
        ],
      },
    });
    const detail = await getSupportCommunication(created.value.id, actor);
    expect(detail?.corrections).toHaveLength(1);
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "SUPPORT_COMMUNICATION_CORRECTED" },
    });
    expect(JSON.stringify(audit.payload)).not.toContain(correction.reason);
    expect(JSON.stringify(audit.payload)).not.toContain(correction.summary);
    const readAudit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "SUPPORT_COMMUNICATION_VIEWED" },
    });
    expect(JSON.stringify(readAudit.payload)).not.toContain(command.summary);
    expect(JSON.stringify(readAudit.payload)).not.toContain(
      command.contactNumber,
    );
    expect(
      createSupportCommunicationSchema.safeParse({
        ...command,
        result: "REQUIRES_FOLLOW_UP",
      }).success,
    ).toBe(false);
    await expect(
      prisma.supportCommunication.delete({ where: { id: created.value.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.supportCommunication.update({
        where: { id: created.value.id },
        data: { summary: "Cambio sin evidencia", version: 3 },
      }),
    ).rejects.toThrow();
  });

  it("resolves historical incident links in the communication correction ledger", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const targetCustomer = await createCustomerRecord(actor, {
      legalName: "Cliente Destino Historial SL",
      tradeName: "Cliente Destino Historial",
      taxId: "B12345666",
      email: "destino-historial@example.test",
      bankIban: "ES7620770024003102575766",
      sepaMandate: { reference: "SEPA-HISTORIAL-2", signedAt: "2026-07-01" },
    });
    const references = await listSupportReferences();
    const baseIncident = {
      customerId: customer.id,
      storeId: null,
      categoryId: references.categories[0]!.id,
      responsibleUserId: actor.id,
      description: "Incidencia sintética para validar el historial de vínculos.",
      priority: "MEDIUM" as const,
    };
    const first = await createSupportIncident({ ...baseIncident, title: "Primer vínculo histórico" }, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest({ ...baseIncident, title: "Primer vínculo histórico" }), scope: "incident:create" });
    const second = await createSupportIncident({ ...baseIncident, title: "Segundo vínculo histórico" }, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest({ ...baseIncident, title: "Segundo vínculo histórico" }), scope: "incident:create" });
    if (!first.ok || !second.ok) throw new Error("INCIDENTS_NOT_CREATED");
    const occurredAt = new Date().toISOString();
    const command = {
      customerId: customer.id,
      channel: "PHONE" as const,
      direction: "INBOUND" as const,
      occurredAt,
      contactId: null,
      contactNumber: "+34910000011",
      durationSeconds: 120,
      summary: "Comunicación vinculada inicialmente a la primera incidencia.",
      result: "REFERRED_TO_INCIDENT" as const,
      incidentId: first.value.id,
    };
    const communication = await createSupportCommunication(command, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportCommunicationRequest(command), scope: "communication:create" });
    if (!communication.ok) throw new Error(communication.error.code);
    const correction = {
      expectedVersion: 1,
      channel: command.channel,
      direction: command.direction,
      occurredAt,
      contactId: null,
      contactNumber: command.contactNumber,
      durationSeconds: command.durationSeconds,
      summary: command.summary,
      result: command.result,
      incidentId: second.value.id,
      reason: "Se corrige la incidencia vinculada tras revisar el expediente.",
    };
    const correctionContext = { idempotencyKey: randomUUID(), requestHash: hashSupportCommunicationRequest({ communicationId: communication.value.id, ...correction }), scope: `communication:${communication.value.id}:correct` };
    const corrected = await correctSupportCommunication(communication.value.id, correction, actor, correctionContext);
    const replay = await correctSupportCommunication(communication.value.id, correction, actor, correctionContext);
    expect(corrected).toMatchObject({ ok: true, status: 201, value: { version: 2, incidentId: second.value.id, corrections: [{ resultingVersion: 2, previousIncident: { id: first.value.id, number: first.value.number }, correctedIncident: { id: second.value.id, number: second.value.number } }] } });
    expect(replay).toMatchObject({ ok: true, status: 200, value: { corrections: [{ resultingVersion: 2, previousIncident: { id: first.value.id }, correctedIncident: { id: second.value.id } }] } });

    const customerChange = {
      expectedVersion: second.value.version,
      expectedCustomerId: customer.id,
      customerId: targetCustomer.id,
      reason: "Se valida que el vínculo histórico no dependa del cliente vigente.",
      confirmation: "CHANGE_INCIDENT_CUSTOMER" as const,
    };
    expect(await changeSupportIncidentCustomer(second.value.id, customerChange, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportIncidentCustomerChangeRequest({ incidentId: second.value.id, ...customerChange }), scope: `incident:${second.value.id}:customer-change` })).toMatchObject({ ok: true });

    const detail = await getSupportCommunication(communication.value.id, actor);
    expect(detail).toMatchObject({
      incident: { id: second.value.id, number: second.value.number },
      correctionsHasMore: false,
      corrections: [{
        resultingVersion: 2,
        previous: { incidentId: first.value.id },
        corrected: { incidentId: second.value.id },
        previousIncident: { id: first.value.id, number: first.value.number },
        correctedIncident: { id: second.value.id, number: second.value.number },
      }],
    });
  });

  it("paginates communication correction history without gaps or duplicates", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const occurredAt = new Date().toISOString();
    const command = {
      customerId: customer.id,
      channel: "PHONE" as const,
      direction: "INBOUND" as const,
      occurredAt,
      contactId: null,
      contactNumber: "+34910000012",
      durationSeconds: 60,
      summary: "Resumen inicial para comprobar el límite del historial.",
      result: "INFORMATION_PROVIDED" as const,
      incidentId: null,
    };
    const communication = await createSupportCommunication(command, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportCommunicationRequest(command), scope: "communication:create" });
    if (!communication.ok) throw new Error(communication.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;
    for (let index = 1; index <= 201; index += 1) {
      if (index > 1 && (index - 1) % 20 === 0) {
        await prisma.rateLimitBucket.deleteMany({ where: { key: `support-communication-correct:${companyId}:${actor.id}` } });
      }
      const correction = {
        expectedVersion: index,
        channel: command.channel,
        direction: command.direction,
        occurredAt,
        contactId: null,
        contactNumber: command.contactNumber,
        durationSeconds: command.durationSeconds,
        summary: `Resumen corregido sintético ${index}.`,
        result: command.result,
        incidentId: null,
        reason: `Corrección sintética ${index} para validar el límite del historial.`,
      };
      const result = await correctSupportCommunication(communication.value.id, correction, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportCommunicationRequest({ communicationId: communication.value.id, ...correction }), scope: `communication:${communication.value.id}:correct` });
      expect(result).toMatchObject({ ok: true, value: { version: index + 1 } });
      if (index === 201 && result.ok) {
        expect(result.value.corrections).toHaveLength(1);
        expect(result.value.corrections[0]?.resultingVersion).toBe(202);
        expect(result.value.correctionsHasMore).toBe(false);
      }
    }

    const detail = await getSupportCommunication(communication.value.id, actor);
    expect(detail?.correctionsHasMore).toBe(true);
    expect(detail?.correctionsNextCursor).toEqual(expect.any(String));
    expect(detail?.corrections).toHaveLength(100);
    expect(detail?.corrections[0]?.resultingVersion).toBe(103);
    expect(detail?.corrections.at(-1)?.resultingVersion).toBe(202);
    const older = await getSupportCommunication(
      communication.value.id,
      actor,
      {},
      detail!.correctionsNextCursor!,
    );
    expect(older?.correctionsHasMore).toBe(true);
    expect(older?.corrections).toHaveLength(100);
    expect(older?.corrections[0]?.resultingVersion).toBe(3);
    expect(older?.corrections.at(-1)?.resultingVersion).toBe(102);
    const oldest = await getSupportCommunication(
      communication.value.id,
      actor,
      {},
      older!.correctionsNextCursor!,
    );
    expect(oldest).toMatchObject({
      correctionsHasMore: false,
      correctionsNextCursor: null,
      corrections: [{ resultingVersion: 2 }],
    });
    const versions = [...oldest!.corrections, ...older!.corrections, ...detail!.corrections]
      .map((correction) => correction.resultingVersion);
    expect(versions).toEqual(Array.from({ length: 201 }, (_, index) => index + 2));
    expect(await getSupportCommunication(randomUUID(), actor, {}, detail!.correctionsNextCursor!)).toBeNull();
  }, 15_000);

  it("creates an incident from a communication atomically and replays it", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const communicationCommand = {
      customerId: customer.id,
      channel: "WHATSAPP" as const,
      direction: "INBOUND" as const,
      occurredAt: new Date().toISOString(),
      contactNumber: "+34910000005",
      contactId: null,
      durationSeconds: null,
      summary:
        "El cliente comunica una incidencia que requiere seguimiento técnico.",
      result: "INFORMATION_PROVIDED" as const,
      incidentId: null,
    };
    const communication = await createSupportCommunication(
      communicationCommand,
      actor,
      {
        idempotencyKey: randomUUID(),
        requestHash: hashSupportCommunicationRequest(communicationCommand),
        scope: "communication:create",
      },
    );
    if (!communication.ok) throw new Error(communication.error.code);
    const refs = await listSupportReferences();
    const command = {
      expectedCommunicationVersion: 1,
      storeId: null,
      categoryId: refs.categories[0]!.id,
      responsibleUserId: actor.id,
      title: "Seguimiento de comunicación entrante",
      priority: "HIGH" as const,
    };
    const context = {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportRequest({
        communicationId: communication.value.id,
        ...command,
      }),
      scope: `communication:${communication.value.id}:incident:create`,
      correlationId: "communication-conversion-1",
    };
    const created = await createIncidentFromCommunication(
      communication.value.id,
      command,
      actor,
      context,
    );
    const replay = await createIncidentFromCommunication(
      communication.value.id,
      command,
      actor,
      context,
    );
    expect(created).toMatchObject({
      ok: true,
      status: 201,
      value: {
        title: command.title,
        description: communicationCommand.summary,
        priority: "HIGH",
      },
    });
    expect(replay).toMatchObject({ ok: true, status: 200 });
    if (!created.ok) throw new Error("incident not created");
    const storedCommunication =
      await prisma.supportCommunication.findUniqueOrThrow({
        where: { id: communication.value.id },
        include: { corrections: true },
      });
    expect(storedCommunication).toMatchObject({
      incidentId: created.value.id,
      result: "REFERRED_TO_INCIDENT",
      version: 2,
    });
    expect(storedCommunication.corrections).toHaveLength(1);
    expect(await prisma.supportIncident.count()).toBe(1);
    const duplicate = await createIncidentFromCommunication(
      communication.value.id,
      command,
      actor,
      { ...context, idempotencyKey: randomUUID() },
    );
    expect(duplicate).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "SUPPORT_COMMUNICATION_ALREADY_LINKED" },
    });
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "SUPPORT_INCIDENT_CREATED_FROM_COMMUNICATION" },
    });
    expect(JSON.stringify(audit.payload)).not.toContain(
      communicationCommand.summary,
    );
    expect(JSON.stringify(audit.payload)).not.toContain(
      communicationCommand.contactNumber,
    );
  });

  it("manages a structured customer contact and links its number to a communication", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor, {
      email: undefined,
      phone: undefined,
    });
    const contactCommand = {
      storeId: null,
      name: "Ana Soporte",
      role: "Operaciones",
      phone: "+34910000007",
      mobile: null,
      whatsapp: "+34600000007",
      email: "ana@example.test",
    };
    const contactContext = {
      idempotencyKey: randomUUID(),
      requestHash: hashCustomerContactRequest(contactCommand),
      scope: `customer:${customer.id}:contact:create`,
    };
    const contact = await createCustomerContact(
      customer.id,
      contactCommand,
      actor,
      contactContext,
    );
    const replay = await createCustomerContact(
      customer.id,
      contactCommand,
      actor,
      contactContext,
    );
    expect(contact).toMatchObject({
      ok: true,
      status: 201,
      value: { version: 1, name: "Ana Soporte" },
    });
    expect(replay).toMatchObject({ ok: true, status: 200 });
    if (!contact.ok) throw new Error("contact not created");
    const duplicateCommand = { ...contactCommand, name: "Segundo contacto" };
    expect(
      await createCustomerContact(customer.id, duplicateCommand, actor, {
        idempotencyKey: randomUUID(),
        requestHash: hashCustomerContactRequest(duplicateCommand),
        scope: `customer:${customer.id}:contact:create`,
      }),
    ).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "CUSTOMER_CONTACT_SLOT_OCCUPIED" },
    });
    const communication = {
      customerId: customer.id,
      channel: "PHONE" as const,
      direction: "OUTBOUND" as const,
      occurredAt: new Date().toISOString(),
      contactId: contact.value.id,
      contactNumber: contactCommand.phone,
      durationSeconds: 60,
      summary: "Seguimiento realizado con el contacto maestro.",
      result: "INFORMATION_PROVIDED" as const,
      incidentId: null,
    };
    const linked = await createSupportCommunication(communication, actor, {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportCommunicationRequest(communication),
      scope: "communication:create",
    });
    expect(linked).toMatchObject({
      ok: true,
      value: {
        contact: { id: contact.value.id },
        contactNumber: contactCommand.phone,
      },
    });
    expect(
      await createSupportCommunication(
        { ...communication, contactNumber: "+34919999999" },
        actor,
        {
          idempotencyKey: randomUUID(),
          requestHash: hashSupportCommunicationRequest({
            ...communication,
            contactNumber: "+34919999999",
          }),
          scope: "communication:create",
        },
      ),
    ).toMatchObject({
      ok: false,
      status: 422,
      error: { code: "SUPPORT_COMMUNICATION_CONTACT_INVALID" },
    });
    const update = {
      action: "update" as const,
      contact: {
        expectedVersion: 1,
        name: "Ana Soporte",
        role: "Coordinación",
        phone: "+34910000009",
        mobile: null,
        whatsapp: contactCommand.whatsapp,
        email: contactCommand.email,
      },
    };
    expect(
      await changeCustomerContact(
        customer.id,
        contact.value.id,
        update,
        actor,
        {
          idempotencyKey: randomUUID(),
          requestHash: hashCustomerContactRequest(update),
          scope: `customer:${customer.id}:contact:${contact.value.id}:change`,
        },
      ),
    ).toMatchObject({ ok: true, value: { version: 2, role: "Coordinación" } });
    expect(
      await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } }),
    ).toMatchObject({ phone: "+34910000009", email: contactCommand.email });
    if (!linked.ok) throw new Error("communication not created");
    const correction = {
      expectedVersion: 1,
      channel: communication.channel,
      direction: communication.direction,
      occurredAt: communication.occurredAt,
      contactId: contact.value.id,
      contactNumber: contactCommand.phone,
      durationSeconds: communication.durationSeconds,
      summary: "Seguimiento histórico corregido sin cambiar el contacto.",
      result: communication.result,
      incidentId: null,
      reason: "Se completa el resumen tras revisar la llamada.",
    };
    expect(
      await correctSupportCommunication(linked.value.id, correction, actor, {
        idempotencyKey: randomUUID(),
        requestHash: hashSupportCommunicationRequest({
          communicationId: linked.value.id,
          ...correction,
        }),
        scope: `communication:${linked.value.id}:correct`,
      }),
    ).toMatchObject({ ok: true, value: { version: 2 } });
    expect(
      (await listCustomerContacts(customer.id, actor))?.contacts,
    ).toHaveLength(1);
    await expect(
      prisma.customerContact.delete({ where: { id: contact.value.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.customerContact.update({
        where: { id: contact.value.id },
        data: { role: "Cambio directo" },
      }),
    ).rejects.toThrow();
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "CUSTOMER_CONTACT_CREATED" },
    });
    expect(JSON.stringify(audit.payload)).not.toContain(contactCommand.email);
    expect(JSON.stringify(audit.payload)).not.toContain(contactCommand.phone);
    expect(
      createCustomerContactSchema.safeParse({
        ...contactCommand,
        name: null,
        phone: null,
        whatsapp: null,
        email: null,
      }).success,
    ).toBe(false);
  });

  it("rejects a store belonging to another customer", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const other = await createCustomerRecord(actor, {
      legalName: "Otro Cliente SL",
      taxId: "B00000000",
      email: "otro@example.test",
      sepaMandate: { reference: "SEPA-2", signedAt: "2026-07-01" },
    });
    const store = await prisma.customerStore.create({
      data: {
        customerId: other.id,
        code: "T00001",
        name: "Tienda ajena",
        addressLine: "Calle Dos 2",
        postalCode: "28002",
        city: "Madrid",
        country: "ES",
        createdById: actor.id,
      },
    });
    const refs = await listSupportReferences();
    const command = {
      customerId: customer.id,
      storeId: store.id,
      categoryId: refs.categories[0]!.id,
      responsibleUserId: actor.id,
      title: "Incidencia con tienda",
      description: "La tienda no pertenece al cliente.",
      priority: "MEDIUM" as const,
    };
    const result = await createSupportIncident(command, actor, {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportRequest(command),
      scope: "incident:create",
    });
    expect(result).toMatchObject({
      ok: false,
      status: 422,
      error: { code: "SUPPORT_STORE_NOT_FOUND" },
    });
    expect(await prisma.supportIncident.count()).toBe(0);
  });

  it("lists without descriptions and returns the authorized detail", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const refs = await listSupportReferences();
    const command = {
      customerId: customer.id,
      storeId: null,
      categoryId: refs.categories[0]!.id,
      responsibleUserId: actor.id,
      title: "Consulta de soporte",
      description: "Texto interno que no debe aparecer en el listado.",
      priority: "MEDIUM" as const,
    };
    const created = await createSupportIncident(command, actor, {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportRequest(command),
      scope: "incident:create",
    });
    if (!created.ok) throw new Error(created.error.code);
    const list = await listSupportIncidents(
      { limit: 25, search: "Texto interno" },
      actor,
    );
    const detail = await getSupportIncident(created.value.id, actor);
    expect(list.incidents).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(command.description);
    expect(detail?.description).toBe(command.description);
  });

  it("finds incidents by action content without disclosing the matching text", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const refs = await listSupportReferences();
    const command = {
      customerId: customer.id,
      storeId: null,
      categoryId: refs.categories[0]!.id,
      responsibleUserId: actor.id,
      title: "Consulta operativa sin coincidencias",
      description: "El listado no debe resolver este caso por la descripción.",
      priority: "MEDIUM" as const,
    };
    const created = await createSupportIncident(command, actor, {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportRequest(command),
      scope: "incident:create",
    });
    if (!created.ok) throw new Error(created.error.code);
    const actionText = "Diagnóstico exclusivo sobre latencia cuántica Zafiro.";
    const actionCommand = {
      expectedVersion: created.value.version,
      text: actionText,
      performedAt: new Date().toISOString(),
    };
    const action = await createSupportAction(created.value.id, actionCommand, actor, {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportActionRequest({ incidentId: created.value.id, ...actionCommand }),
      scope: `incident:${created.value.id}:action:create`,
    });
    if (!action.ok) throw new Error(action.error.code);

    const list = await listSupportIncidents(
      { limit: 25, search: "latencia cuántica" },
      actor,
      { correlationId: "action-search-correlation" },
    );

    expect(list).toMatchObject({ rateLimited: false, searchBusy: false });
    expect(list.incidents.map((incident) => incident.id)).toEqual([created.value.id]);
    expect(JSON.stringify(list)).not.toContain(actionText);
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "SUPPORT_INCIDENTS_VIEWED" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.payload).toMatchObject({ hasSearch: true, correlationId: "action-search-correlation" });
    expect(JSON.stringify(audit.payload)).not.toContain("latencia cuántica");
    expect(JSON.stringify(audit.payload)).not.toContain(actionText);
    const index = await prisma.$queryRaw<Array<{ indexdef: string }>>(Prisma.sql`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = 'support_incident_actions_text_trgm_idx'
    `);
    expect(index[0]?.indexdef).toContain("USING gin");
    expect(index[0]?.indexdef).toContain("gin_trgm_ops");
    const installationRow = await prisma.installation.findFirstOrThrow({ select: { companyId: true } });
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT set_config('enable_seqscan', ${"off"}, true)`);
      return tx.$queryRaw<Array<{ "QUERY PLAN": string }>>(Prisma.sql`
        EXPLAIN (COSTS OFF)
        SELECT DISTINCT "incidentId"
        FROM "support_incident_actions"
        WHERE "companyId" = ${installationRow.companyId}::uuid
          AND "text" ILIKE ${"%latencia cuántica%"}
        LIMIT 10001
      `);
    });
    const planText = plan.map((row) => row["QUERY PLAN"]).join("\n");
    expect(planText).toContain("Limit");
    expect(planText).toContain("Unique");
  });

  it("creates normalized unique categories idempotently", async () => {
    const actor = await admin();
    const command = {
      name: "Conectividad",
      description: "Red y comunicaciones",
      color: "#2563EB",
    };
    const context = {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportRequest(command),
      scope: "category:create",
    };
    expect(await createSupportCategory(command, actor, context)).toMatchObject({
      ok: true,
      status: 201,
    });
    expect(await createSupportCategory(command, actor, context)).toMatchObject({
      ok: true,
      status: 200,
    });
    const duplicate = { ...command, name: "Cónéctividad" };
    expect(
      await createSupportCategory(duplicate, actor, {
        idempotencyKey: randomUUID(),
        requestHash: hashSupportRequest(duplicate),
        scope: "category:create",
      }),
    ).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "SUPPORT_CATEGORY_ALREADY_EXISTS" },
    });
    const unicode = { ...command, name: "Straße" };
    expect(await createSupportCategory(unicode, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(unicode), scope: "category:create" })).toMatchObject({ ok: true, status: 201, value: { name: "Straße" } });
    const unicodeDuplicate = { ...command, name: "Strasse" };
    expect(await createSupportCategory(unicodeDuplicate, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(unicodeDuplicate), scope: "category:create" })).toMatchObject({ ok: false, status: 409, error: { code: "SUPPORT_CATEGORY_ALREADY_EXISTS" } });
    const expanded = { ...command, name: "ß".repeat(61) };
    const expandedResult = await createSupportCategory(expanded, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(expanded), scope: "category:create" });
    expect(expandedResult).toMatchObject({ ok: true, status: 201 });
    expect((await prisma.supportIncidentCategory.findUniqueOrThrow({ where: { id: expandedResult.ok ? expandedResult.value.id : randomUUID() }, select: { normalizedName: true } })).normalizedName).toHaveLength(122);
  });

  it("versions category edits and status changes with append-only evidence", async () => {
    const actor = await admin();
    const create = { name: "Conectividad", description: "Red y comunicaciones", color: "#2563EB" };
    const created = await createSupportCategory(create, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(create), scope: "category:create" });
    if (!created.ok) throw new Error(created.error.code);

    const update = { action: "update" as const, expectedVersion: 1, name: "Conectividad crítica", description: "Red, enlaces y comunicaciones", color: "#DC2626", reason: "Ajuste de clasificación operativa" };
    const updateContext = { idempotencyKey: randomUUID(), requestHash: hashSupportCategoryChangeRequest({ categoryId: created.value.id, ...update }), scope: `category:${created.value.id}:change`, correlationId: randomUUID() };
    const first = await changeSupportCategory(created.value.id, update, actor, updateContext);
    const replay = await changeSupportCategory(created.value.id, update, actor, updateContext);
    expect(first).toMatchObject({ ok: true, status: 201, value: { category: { name: update.name, color: update.color, version: 2 }, change: { type: "UPDATE", resultingVersion: 2, changedFields: ["name", "description", "color"] } } });
    expect(replay).toMatchObject({ ok: true, status: 200 });

    const deactivate = { action: "set-status" as const, expectedVersion: 2, isActive: false, confirmation: "DEACTIVATE_SUPPORT_CATEGORY" as const, reason: "Categoría sustituida por la clasificación general" };
    const inactive = await changeSupportCategory(created.value.id, deactivate, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportCategoryChangeRequest({ categoryId: created.value.id, ...deactivate }), scope: `category:${created.value.id}:change` });
    expect(inactive).toMatchObject({ ok: true, status: 201, value: { category: { isActive: false, version: 3 }, change: { type: "STATUS", changedFields: ["isActive"] } } });
    expect((await listSupportReferences()).categories.map((category) => category.id)).not.toContain(created.value.id);
    const lastActive = await prisma.supportIncidentCategory.findFirstOrThrow({ where: { isActive: true } });
    const deactivateLast = { action: "set-status" as const, expectedVersion: lastActive.version, isActive: false, confirmation: "DEACTIVATE_SUPPORT_CATEGORY" as const, reason: "Intento de dejar el maestro sin opciones" };
    expect(await changeSupportCategory(lastActive.id, deactivateLast, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportCategoryChangeRequest({ categoryId: lastActive.id, ...deactivateLast }), scope: `category:${lastActive.id}:change` })).toMatchObject({ ok: false, status: 409, error: { code: "SUPPORT_CATEGORY_LAST_ACTIVE" } });
    expect(await prisma.supportIncidentCategoryChange.count({ where: { categoryId: created.value.id } })).toBe(2);
    const audits = await prisma.auditEvent.findMany({ where: { eventType: "SUPPORT_INCIDENT_CATEGORY_CHANGED" }, select: { payload: true } });
    expect(audits).toHaveLength(2);
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(update.name);
    expect(serialized).not.toContain(update.description);
    expect(serialized).not.toContain(update.reason);
    expect(serialized).not.toContain(update.color);

    const concurrentA = { action: "update" as const, expectedVersion: 3, name: "Conectividad histórica A", description: update.description, color: update.color, reason: "Primera edición concurrente" };
    const concurrentB = { ...concurrentA, name: "Conectividad histórica B", reason: "Segunda edición concurrente" };
    const concurrent = await Promise.all([
      changeSupportCategory(created.value.id, concurrentA, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportCategoryChangeRequest({ categoryId: created.value.id, ...concurrentA }), scope: `category:${created.value.id}:change` }),
      changeSupportCategory(created.value.id, concurrentB, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportCategoryChangeRequest({ categoryId: created.value.id, ...concurrentB }), scope: `category:${created.value.id}:change` }),
    ]);
    expect(concurrent.map((result) => result.status).sort()).toEqual([201, 409]);
    const current = await prisma.supportIncidentCategory.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(current.version).toBe(4);
    expect(await prisma.supportIncidentCategoryChange.count({ where: { categoryId: created.value.id } })).toBe(3);

    await expect(prisma.supportIncidentCategoryChange.create({ data: { companyId: current.companyId, categoryId: current.id, actorUserId: actor.id, previousName: current.name, correctedName: current.name, previousNormalizedName: current.normalizedName, correctedNormalizedName: current.normalizedName, previousDescription: current.description, correctedDescription: current.description, previousColor: current.color, correctedColor: "#000000", previousIsActive: current.isActive, correctedIsActive: current.isActive, reason: "Evidencia sin cambio de proyección", resultingVersion: 5 } })).rejects.toThrow();
    await expect(prisma.supportIncidentCategory.update({ where: { id: current.id }, data: { updatedAt: new Date(current.updatedAt.getTime() + 1_000) } })).rejects.toThrow();

    const directLastActive = await prisma.supportIncidentCategory.findFirstOrThrow({ where: { isActive: true } });
    const directChangedAt = new Date();
    await expect(prisma.$transaction(async (tx) => {
      await tx.supportIncidentCategoryChange.create({ data: { companyId: directLastActive.companyId, categoryId: directLastActive.id, actorUserId: actor.id, previousName: directLastActive.name, correctedName: directLastActive.name, previousNormalizedName: directLastActive.normalizedName, correctedNormalizedName: directLastActive.normalizedName, previousDescription: directLastActive.description, correctedDescription: directLastActive.description, previousColor: directLastActive.color, correctedColor: directLastActive.color, previousIsActive: true, correctedIsActive: false, reason: "Intento SQL de desactivar la última categoría", resultingVersion: directLastActive.version + 1, changedAt: directChangedAt } });
      await tx.supportIncidentCategory.update({ where: { id: directLastActive.id }, data: { isActive: false, version: directLastActive.version + 1, updatedAt: directChangedAt } });
    })).rejects.toThrow();

    await expect(prisma.$transaction(async (tx) => {
      await tx.supportIncidentCategory.update({ where: { id: created.value.id }, data: { color: "#000000", version: { increment: 1 } } });
    })).rejects.toThrow();
    await expect(prisma.supportIncidentCategoryChange.updateMany({ where: { categoryId: created.value.id }, data: { reason: "Manipulación no permitida" } })).rejects.toThrow();
    await expect(prisma.supportIncidentCategory.delete({ where: { id: created.value.id } })).rejects.toThrow();
  });

  it("serializes direct concurrent deactivation so one category remains active", async () => {
    const actor = await admin();
    const companyId = (await prisma.installation.findFirstOrThrow()).companyId!;
    const create = { name: "Segunda categoría activa", description: "Categoría para probar write-skew", color: "#2563EB" };
    const created = await createSupportCategory(create, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(create), scope: "category:create" });
    if (!created.ok) throw new Error(created.error.code);
    const categories = await prisma.supportIncidentCategory.findMany({ where: { companyId, isActive: true }, orderBy: { id: "asc" } });
    expect(categories).toHaveLength(2);

    async function deactivateDirect(category: (typeof categories)[number]) {
      const changedAt = new Date();
      return prisma.$transaction(async (tx) => {
        await tx.supportIncidentCategoryChange.create({ data: { companyId, categoryId: category.id, actorUserId: actor.id, previousName: category.name, correctedName: category.name, previousNormalizedName: category.normalizedName, correctedNormalizedName: category.normalizedName, previousDescription: category.description, correctedDescription: category.description, previousColor: category.color, correctedColor: category.color, previousIsActive: true, correctedIsActive: false, reason: "Desactivación SQL concurrente controlada", resultingVersion: category.version + 1, changedAt } });
        await tx.supportIncidentCategory.update({ where: { id: category.id }, data: { isActive: false, version: category.version + 1, updatedAt: changedAt } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    }

    const outcomes = await Promise.allSettled(categories.map(deactivateDirect));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(await prisma.supportIncidentCategory.count({ where: { companyId, isActive: true } })).toBe(1);
    expect(await prisma.supportIncidentCategoryChange.count({ where: { companyId } })).toBe(1);
  });

  it("uploads an incident attachment once with opaque audit and replay", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const references = await listSupportReferences();
    const incidentCommand = { customerId: customer.id, storeId: null, categoryId: references.categories[0]!.id, responsibleUserId: actor.id, title: "Evidencia adjunta", description: "Incidencia con documento de prueba.", priority: "MEDIUM" as const };
    const incident = await createSupportIncident(incidentCommand, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(incidentCommand), scope: "incident:create" });
    if (!incident.ok) throw new Error(incident.error.code);
    const bytes = Buffer.from("source-pdf");
    const input = { incidentId: incident.value.id, actionId: null, bytes, fileName: "evidencia.pdf", declaredMimeType: "application/pdf", clientIdempotencyKey: randomUUID(), requestHash: "" };
    input.requestHash = supportIncidentAttachmentRequestHash(input);
    const storage = new IncidentAttachmentMemoryStorage();
    const dependencies = { storage, scanner: { scan: async () => ({ outcome: "clean" as const, engine: "test-scanner", version: "1" }) }, prepare: async () => ({ bytes: Buffer.from("canonical-pdf"), originalFileName: "evidencia.pdf", extension: "pdf" as const, mediaType: "application/pdf" as const }) };
    const created = await uploadSupportIncidentAttachment(input, actor, { correlationId: "attachment-test-0001" }, dependencies);
    const replay = await uploadSupportIncidentAttachment(input, actor, { correlationId: "attachment-test-0001" }, dependencies);
    expect(created).toMatchObject({ ok: true, status: 201, value: { attachment: { originalFileName: "evidencia.pdf", mediaType: "application/pdf" } } });
    expect(replay).toMatchObject({ ok: true, status: 200, value: { attachment: { id: created.ok ? created.value.attachment.id : "" } } });
    expect(await prisma.supportIncidentAttachment.count()).toBe(1);
    expect(await prisma.attachment.count({ where: { purpose: "SUPPORT_INCIDENT", status: "AVAILABLE", scanResult: "CLEAN" } })).toBe(1);
    expect(await listSupportIncidentAttachments(incident.value.id, actor)).toHaveLength(1);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUPPORT_INCIDENT_ATTACHMENT_UPLOADED" } });
    expect(audit.payload).toMatchObject({ actorUserId: actor.id, incidentId: incident.value.id, mediaType: "application/pdf", correlationId: "attachment-test-0001" });
    expect(JSON.stringify(audit.payload)).not.toContain("evidencia.pdf");
    expect(storage.published.size).toBe(1);
  });

  it("serializes the company capacity across concurrent incident uploads", async () => {
    const actor = await admin(); const customer = await createCustomerRecord(actor); const references = await listSupportReferences();
    const createIncident = async (title: string) => { const command = { customerId: customer.id, storeId: null, categoryId: references.categories[0]!.id, responsibleUserId: actor.id, title, description: "Incidencia para probar la capacidad concurrente.", priority: "MEDIUM" as const }; const result = await createSupportIncident(command, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(command), scope: "incident:create" }); if (!result.ok) throw new Error(result.error.code); return result.value; };
    const firstIncident = await createIncident("Capacidad concurrente uno"); const secondIncident = await createIncident("Capacidad concurrente dos");
    const companyId = (await prisma.installation.findFirstOrThrow()).companyId!;
    await seedSupportAttachmentCapacity(companyId, firstIncident.id, actor.id);
    const storage = new IncidentAttachmentMemoryStorage(); const canonicalSize = 16 * 1024 * 1024;
    const dependencies = { storage, scanner: { scan: async () => ({ outcome: "clean" as const, engine: "test-scanner", version: "1" }) }, prepare: async ({ originalFileName }: { originalFileName: string }) => ({ bytes: Buffer.alloc(canonicalSize, 0x41), originalFileName, extension: "pdf" as const, mediaType: "application/pdf" as const }) };
    const makeInput = (incidentId: string) => { const value = { incidentId, actionId: null, bytes: Buffer.from("source"), fileName: `${incidentId}.pdf`, declaredMimeType: "application/pdf", clientIdempotencyKey: randomUUID(), requestHash: "" }; value.requestHash = supportIncidentAttachmentRequestHash(value); return value; };
    const results = await Promise.all([uploadSupportIncidentAttachment(makeInput(firstIncident.id), actor, { correlationId: "capacity-1" }, dependencies), uploadSupportIncidentAttachment(makeInput(secondIncident.id), actor, { correlationId: "capacity-2" }, dependencies)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([{ status: 503, error: { code: "SUPPORT_ATTACHMENT_CAPACITY_UNAVAILABLE" } }]);
    const total = await prisma.attachment.aggregate({ where: { purpose: "SUPPORT_INCIDENT" }, _sum: { sizeBytes: true } });
    expect(total._sum?.sizeBytes).toBe(1536n * 1024n * 1024n);
  });

  it("replays a concurrent upload after the first request fills capacity", async () => {
    const actor = await admin(); const customer = await createCustomerRecord(actor); const references = await listSupportReferences();
    const command = { customerId: customer.id, storeId: null, categoryId: references.categories[0]!.id, responsibleUserId: actor.id, title: "Replay al limite", description: "Prueba de replay concurrente cerca de capacidad.", priority: "MEDIUM" as const };
    const incident = await createSupportIncident(command, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(command), scope: "incident:create" }); if (!incident.ok) throw new Error(incident.error.code);
    const companyId = (await prisma.installation.findFirstOrThrow()).companyId!; await seedSupportAttachmentCapacity(companyId, incident.value.id, actor.id);
    const storage = new IncidentAttachmentMemoryStorage(); const clientIdempotencyKey = randomUUID(); const bytes = Buffer.from("same-source");
    const input = { incidentId: incident.value.id, actionId: null, bytes, fileName: "same.pdf", declaredMimeType: "application/pdf", clientIdempotencyKey, requestHash: "" }; input.requestHash = supportIncidentAttachmentRequestHash(input);
    const dependencies = { storage, scanner: { scan: async () => ({ outcome: "clean" as const, engine: "test", version: "1" }) }, prepare: async () => ({ bytes: Buffer.alloc(16 * 1024 * 1024, 0x41), originalFileName: "same.pdf", extension: "pdf" as const, mediaType: "application/pdf" as const }) };
    const results = await Promise.all([uploadSupportIncidentAttachment(input, actor, { correlationId: "same-1" }, dependencies), uploadSupportIncidentAttachment(input, actor, { correlationId: "same-2" }, dependencies)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 201]);
    expect(results.every((result) => result.ok && result.value.attachment.id === (results[0]!.ok ? results[0]!.value.attachment.id : ""))).toBe(true);
    expect(await prisma.attachment.count({ where: { companyId, purpose: "SUPPORT_INCIDENT" } })).toBe(96);
  });

  it("removes the published object after serializable retries are exhausted", async () => {
    const actor = await admin(); const customer = await createCustomerRecord(actor); const references = await listSupportReferences();
    const command = { customerId: customer.id, storeId: null, categoryId: references.categories[0]!.id, responsibleUserId: actor.id, title: "Conflicto persistente", description: "Prueba de limpieza tras rollback confirmado.", priority: "MEDIUM" as const };
    const incident = await createSupportIncident(command, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(command), scope: "incident:create" }); if (!incident.ok) throw new Error(incident.error.code);
    const bytes = Buffer.from("source"); const input = { incidentId: incident.value.id, actionId: null, bytes, fileName: "retry.pdf", declaredMimeType: "application/pdf", clientIdempotencyKey: randomUUID(), requestHash: "" }; input.requestHash = supportIncidentAttachmentRequestHash(input);
    const storage = new IncidentAttachmentMemoryStorage(); const transaction = vi.spyOn(prisma, "$transaction").mockRejectedValue(new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "test" }));
    try {
      const result = await uploadSupportIncidentAttachment(input, actor, { correlationId: "retry-exhausted" }, { storage, scanner: { scan: async () => ({ outcome: "clean", engine: "test", version: "1" }) }, prepare: async () => ({ bytes: Buffer.from("canonical"), originalFileName: "retry.pdf", extension: "pdf", mediaType: "application/pdf" }) });
      expect(result).toMatchObject({ ok: false, status: 503, error: { code: "SUPPORT_ATTACHMENT_DATABASE_BUSY", retryAfterSeconds: 3 } });
      expect(transaction).toHaveBeenCalledTimes(3); expect(storage.published.size).toBe(0);
    } finally { transaction.mockRestore(); }
  });

  it("bounds concurrent attachment downloads", () => {
    expect([1, 2, 3, 4].map(() => acquireSupportAttachmentDownloadSlot())).toEqual([true, true, true, true]);
    expect(acquireSupportAttachmentDownloadSlot()).toBe(false);
    for (let index = 0; index < 4; index += 1) releaseSupportAttachmentDownloadSlot();
    expect(acquireSupportAttachmentDownloadSlot()).toBe(true);
    releaseSupportAttachmentDownloadSlot();
  });
});

class IncidentAttachmentMemoryStorage {
  readonly temporary = new Map<string, Buffer>();
  readonly published = new Map<string, Buffer>();
  async writeTemporary(bytes: Buffer, kind: "upload" | "canonical") { const key = `${randomUUID()}.${kind}`; this.temporary.set(key, Buffer.from(bytes)); return key; }
  async publish(temporaryPath: string, storageKey: string) { const bytes = this.temporary.get(temporaryPath); if (!bytes) throw new Error("TEMPORARY_NOT_FOUND"); this.published.set(storageKey, Buffer.from(bytes)); this.temporary.delete(temporaryPath); }
  async readVerified(storageKey: string) { const bytes = this.published.get(storageKey); if (!bytes) throw new Error("NOT_FOUND"); return Buffer.from(bytes); }
  async removeTemporary(temporaryPath: string | null) { if (temporaryPath) this.temporary.delete(temporaryPath); }
  async removePublished(storageKey: string) { this.published.delete(storageKey); }
}

async function seedSupportAttachmentCapacity(companyId: string, incidentId: string, uploadedById: string) {
  const rows = Array.from({ length: 95 }, () => ({ id: randomUUID(), companyId, purpose: "SUPPORT_INCIDENT" as const, originalFileName: "historico.pdf", extension: "pdf", declaredMimeType: "application/pdf", detectedMimeType: "application/pdf", sizeBytes: 16n * 1024n * 1024n, sha256: "a".repeat(64), storageKey: "", status: "AVAILABLE" as const, scanResult: "CLEAN" as const, scanEngine: "test", scanCompletedAt: new Date(), availableAt: new Date(), uploadedById }));
  for (const row of rows) row.storageKey = `support-incident/${companyId}/${incidentId}/${row.id}.pdf`;
  await prisma.$transaction(async (tx) => { await tx.attachment.createMany({ data: rows }); await tx.supportIncidentAttachment.createMany({ data: rows.map((row) => ({ companyId, incidentId, attachmentId: row.id })) }); });
}

async function initialize() {
  const body = JSON.stringify(installation);
  const result = await initializePlatform(
    installation,
    randomUUID(),
    hashRequestBody(body),
  );
  if (!result.ok) throw new Error(result.error.code);
  const row = await prisma.installation.findFirstOrThrow();
  await prisma.supportIncidentCategory.create({
    data: {
      companyId: row.companyId!,
      name: "General",
      normalizedName: "general",
      description: "Categoria inicial",
      color: "#475569",
    },
  });
  await prisma.accountingFiscalYear.create({
    data: {
      companyId: row.companyId!,
      year: 2026,
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      endDate: new Date("2026-12-31T00:00:00.000Z"),
      planCode: "PGC_PYMES",
      planVersion: "2021.1",
      createdById: row.initialAdministratorId!,
    },
  });
}
async function admin() {
  const result = await login({ userName: "admin", password });
  if (!result.ok) throw new Error(result.error.code);
  return result.value.user;
}
async function createCustomerRecord(
  actor: Awaited<ReturnType<typeof admin>>,
  overrides: Record<string, unknown> = {},
) {
  const result = await createCustomer(
    {
      type: "COMPANY",
      legalName: "Cliente Demo SL",
      tradeName: "Cliente Demo",
      taxId: "B12345674",
      fiscalTreatment: "DOMESTIC",
      email: "cliente@example.test",
      phone: "+34910000000",
      fiscalAddressLine: "Calle Mayor 1",
      fiscalPostalCode: "28001",
      fiscalCity: "Madrid",
      fiscalProvince: "Madrid",
      fiscalCountry: "ES",
      defaultPaymentMethod: "BANK_TRANSFER",
      paymentTermsType: "IMMEDIATE",
      paymentDays: null,
      paymentFixedDay: null,
      creditLimit: null,
      bankIban: "ES9121000418450200051332",
      sepaMandate: { reference: "SEPA-1", signedAt: "2026-07-01" },
      notes: "No auditar",
      ...overrides,
    },
    actor,
  );
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function transitionContext(
  incidentId: string,
  command: unknown,
  key: string = randomUUID(),
) {
  return {
    idempotencyKey: key,
    requestHash: hashSupportStatusTransitionRequest({
      incidentId,
      ...(command as object),
    }),
    scope: `incident:${incidentId}:status-transition`,
  };
}
function participantContext(incidentId: string, command: unknown) {
  return {
    idempotencyKey: randomUUID(),
    requestHash: hashSupportParticipantRequest({
      incidentId,
      ...(command as object),
    }),
    scope: `incident:${incidentId}:participant-change`,
  };
}
async function reset() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_communications" DISABLE TRIGGER "support_communications_no_delete"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_communication_corrections" DISABLE TRIGGER "support_communication_corrections_append_only"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_events" DISABLE TRIGGER "support_incident_events_append_only"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_actions" DISABLE TRIGGER "support_incident_actions_append_only"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_status_transitions" DISABLE TRIGGER "support_incident_status_transitions_append_only"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_priority_changes" DISABLE TRIGGER "support_priority_changes_append_only"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_details_changes" DISABLE TRIGGER "support_incident_details_changes_append_only"',
    );
    await tx.$executeRawUnsafe('ALTER TABLE "support_incident_customer_changes" DISABLE TRIGGER "support_incident_customer_changes_append_only"');
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_action_corrections" DISABLE TRIGGER "support_action_corrections_append_only"',
    );
    await tx.$executeRawUnsafe('ALTER TABLE "support_incident_category_changes" DISABLE TRIGGER "support_incident_category_changes_append_only"');
    await tx.$executeRawUnsafe('ALTER TABLE "support_incident_categories" DISABLE TRIGGER "support_incident_categories_guard"');
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_participant_changes" DISABLE TRIGGER "support_incident_participant_changes_append_only"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_collaborators" DISABLE TRIGGER "support_incident_collaborators_guard"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "customer_contacts" DISABLE TRIGGER "customer_contacts_guard"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_attachments" DISABLE TRIGGER "support_incident_attachments_append_only"',
    );
    await tx.$executeRawUnsafe('ALTER TABLE "support_incident_merges" DISABLE TRIGGER "support_incident_merges_append_only"');
    await tx.$executeRawUnsafe('ALTER TABLE "support_incidents" DISABLE TRIGGER "support_incidents_merged_duplicate_guard"');
    await tx.$executeRawUnsafe('ALTER TABLE "notifications" DISABLE TRIGGER "notifications_guard"');
    await tx.$executeRawUnsafe('ALTER TABLE "notification_state_changes" DISABLE TRIGGER "notification_state_changes_append_only"');
    await tx.notificationStateChange.deleteMany();
    await tx.notification.deleteMany();
    await tx.supportCommunicationCorrection.deleteMany();
    await tx.supportCommunication.deleteMany();
    await tx.supportIncidentEvent.deleteMany();
    await tx.supportIncidentCustomerChange.deleteMany();
    await tx.supportIncidentDetailsChange.deleteMany();
    await tx.supportIncidentActionCorrection.deleteMany();
    await tx.supportIncidentCategoryChange.deleteMany();
    await tx.supportIncidentParticipantChange.deleteMany();
    await tx.supportIncidentCollaborator.deleteMany();
    await tx.supportIncidentStatusTransition.deleteMany();
    await tx.supportIncidentPriorityChange.deleteMany();
    await tx.supportIncidentAttachment.deleteMany();
    await tx.attachment.deleteMany();
    await tx.supportIncidentAction.deleteMany();
    await tx.supportIncidentMerge.deleteMany();
    await tx.supportIncident.deleteMany();
    await tx.supportIncidentCategory.deleteMany();
    await tx.customerContact.deleteMany();
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_collaborators" ENABLE TRIGGER "support_incident_collaborators_guard"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_participant_changes" ENABLE TRIGGER "support_incident_participant_changes_append_only"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_status_transitions" ENABLE TRIGGER "support_incident_status_transitions_append_only"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_priority_changes" ENABLE TRIGGER "support_priority_changes_append_only"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_details_changes" ENABLE TRIGGER "support_incident_details_changes_append_only"',
    );
    await tx.$executeRawUnsafe('ALTER TABLE "support_incident_customer_changes" ENABLE TRIGGER "support_incident_customer_changes_append_only"');
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_action_corrections" ENABLE TRIGGER "support_action_corrections_append_only"',
    );
    await tx.$executeRawUnsafe('ALTER TABLE "support_incident_category_changes" ENABLE TRIGGER "support_incident_category_changes_append_only"');
    await tx.$executeRawUnsafe('ALTER TABLE "support_incident_categories" ENABLE TRIGGER "support_incident_categories_guard"');
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_actions" ENABLE TRIGGER "support_incident_actions_append_only"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_events" ENABLE TRIGGER "support_incident_events_append_only"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_communication_corrections" ENABLE TRIGGER "support_communication_corrections_append_only"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_communications" ENABLE TRIGGER "support_communications_no_delete"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "customer_contacts" ENABLE TRIGGER "customer_contacts_guard"',
    );
    await tx.$executeRawUnsafe('ALTER TABLE "notification_state_changes" ENABLE TRIGGER "notification_state_changes_append_only"');
    await tx.$executeRawUnsafe('ALTER TABLE "notifications" ENABLE TRIGGER "notifications_guard"');
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_attachments" ENABLE TRIGGER "support_incident_attachments_append_only"',
    );
    await tx.$executeRawUnsafe('ALTER TABLE "support_incident_merges" ENABLE TRIGGER "support_incident_merges_append_only"');
    await tx.$executeRawUnsafe('ALTER TABLE "support_incidents" ENABLE TRIGGER "support_incidents_merged_duplicate_guard"');
  });
  await prisma.supportIncidentNumberSequence.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.rateLimitBucket.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.installation.deleteMany();
  await prisma.session.deleteMany();
  await prisma.customerStore.deleteMany();
  await prisma.customerSepaMandate.deleteMany();
  await prisma.accountingJournalLine.deleteMany();
  await prisma.accountingJournalEntry.deleteMany();
  await prisma.accountingAccount.deleteMany();
  await prisma.accountingFiscalYear.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.reservedUserName.deleteMany();
  await prisma.user.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.permission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.company.deleteMany();
  await prisma.$executeRaw`ALTER SEQUENCE customer_code_seq RESTART WITH 1`;
}
