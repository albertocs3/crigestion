import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createCustomer } from "@/modules/customers/application/customers";
import { login } from "@/modules/platform/application/auth";
import { hashRequestBody, initializePlatform, type InitializeCommand } from "@/modules/platform/application/installation";
import { createSupportAction, hashSupportActionRequest } from "@/modules/support/application/actions";
import { createSupportCategory, createSupportIncident, getSupportIncident, hashSupportRequest, listSupportIncidents, listSupportReferences } from "@/modules/support/application/incidents";
import { hashSupportStatusTransitionRequest, transitionSupportIncident } from "@/modules/support/application/statusTransitions";

const password = "Cambiar-esta-clave-2026";
const installation: InitializeCommand = { company: { legalName: "CriGestion Test SL", taxId: "B12345678", email: "admin@example.test" }, administrator: { displayName: "Administrador", userName: "admin", password } };

describe("support incidents application", () => {
  beforeEach(async () => { await reset(); await initialize(); });
  afterAll(async () => { await reset(); await prisma.$disconnect(); });

  it("creates an incident with annual numbering, append-only history and opaque audit", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const references = await listSupportReferences();
    const command = { customerId: customer.id, storeId: null, categoryId: references.categories[0]!.id, responsibleUserId: actor.id, title: "Error al acceder al servicio", description: "El usuario informa de un error reproducible al iniciar sesión.", priority: "URGENT" as const };
    const context = { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(command), scope: "incident:create", correlationId: "support-test-0001" };

    const created = await createSupportIncident(command, actor, context);
    const replay = await createSupportIncident(command, actor, context);
    expect(created).toMatchObject({ ok: true, status: 201, value: { number: `INC-${new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric" }).format(new Date())}-00001`, status: "NEW", priority: "URGENT", version: 1, events: [{ type: "CREATED", toStatus: "NEW" }] } });
    expect(replay).toMatchObject({ ok: true, status: 200, value: { id: created.ok ? created.value.id : "" } });
    expect(await prisma.supportIncident.count()).toBe(1);
    expect(await prisma.supportIncidentEvent.count()).toBe(1);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUPPORT_INCIDENT_CREATED" } });
    expect(audit.payload).toMatchObject({ actorUserId: actor.id, customerId: customer.id, priority: "URGENT", correlationId: "support-test-0001" });
    expect(JSON.stringify(audit.payload)).not.toContain(command.title);
    expect(JSON.stringify(audit.payload)).not.toContain(command.description);
  });

  it("records actions append-only and advances a new incident exactly once", async () => {
    const actor = await admin(); const customer = await createCustomerRecord(actor); const refs = await listSupportReferences();
    const incidentCommand = { customerId: customer.id, storeId: null, categoryId: refs.categories[0]!.id, responsibleUserId: actor.id, title: "Acceso intermitente", description: "Se requiere una revisión técnica del acceso.", priority: "HIGH" as const };
    const incident = await createSupportIncident(incidentCommand, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(incidentCommand), scope: "incident:create" });
    if (!incident.ok) throw new Error(incident.error.code);
    const actionCommand = { expectedVersion: 1, text: "Se revisa la configuración y se reproduce el problema.", performedAt: new Date().toISOString() };
    const context = { idempotencyKey: randomUUID(), requestHash: hashSupportActionRequest({ incidentId: incident.value.id, ...actionCommand }), scope: `incident:${incident.value.id}:action:create`, correlationId: "support-action-0001" };
    const created = await createSupportAction(incident.value.id, actionCommand, actor, context);
    const replay = await createSupportAction(incident.value.id, actionCommand, actor, context);
    expect(created).toMatchObject({ ok: true, status: 201, value: { incident: { status: "IN_PROGRESS", version: 2 }, action: { text: actionCommand.text, author: { id: actor.id } } } });
    expect(replay).toMatchObject({ ok: true, status: 200, value: { action: { id: created.ok ? created.value.action.id : "" } } });
    const stored = await prisma.supportIncident.findUniqueOrThrow({ where: { id: incident.value.id }, include: { actions: true, events: true } });
    expect(stored).toMatchObject({ status: "IN_PROGRESS", version: 2 });
    expect(stored.firstActionAt?.toISOString()).toBe(actionCommand.performedAt);
    expect(stored.actions).toHaveLength(1);
    expect(stored.events.filter((event) => event.eventType === "ACTION_ADDED")).toHaveLength(1);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUPPORT_INCIDENT_ACTION_ADDED" } });
    expect(audit.payload).toMatchObject({ actorUserId: actor.id, incidentId: incident.value.id, previousStatus: "NEW", status: "IN_PROGRESS", version: 2, hasText: true, correlationId: "support-action-0001" });
    expect(JSON.stringify(audit.payload)).not.toContain(actionCommand.text);
    await expect(prisma.supportIncidentAction.update({ where: { id: stored.actions[0]!.id }, data: { text: "Texto alterado" } })).rejects.toThrow();
    await expect(prisma.$transaction(async (tx) => {
      const performedAt = new Date();
      await tx.supportIncidentAction.create({ data: { companyId: stored.companyId, incidentId: stored.id, authorUserId: actor.id, text: "Actuación sin evento coincidente.", performedAt } });
      await tx.supportIncident.update({ where: { id: stored.id }, data: { firstActionAt: stored.firstActionAt && stored.firstActionAt < performedAt ? stored.firstActionAt : performedAt, version: { increment: 1 } } });
    })).rejects.toThrow(/matching event/i);
  });

  it("rejects actions from a non-responsible technician and stale versions", async () => {
    const actor = await admin(); const customer = await createCustomerRecord(actor); const refs = await listSupportReferences();
    const incidentCommand = { customerId: customer.id, storeId: null, categoryId: refs.categories[0]!.id, responsibleUserId: actor.id, title: "Incidencia asignada", description: "Solo el responsable puede actuar en esta fase.", priority: "MEDIUM" as const };
    const incident = await createSupportIncident(incidentCommand, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(incidentCommand), scope: "incident:create" }); if (!incident.ok) throw new Error(incident.error.code);
    const role = await prisma.role.create({ data: { code: "SupportTechnician", name: "Técnico de soporte", permissions: { create: ["Support.View", "Support.AddActions"].map((code) => ({ permission: { connect: { code } } })) } } });
    const user = await prisma.user.create({ data: { displayName: "Técnico", userName: "support-tech", normalizedUserName: "support-tech", passwordHash: "not-used", roleId: role.id } });
    const technician = { id: user.id, displayName: user.displayName, userName: user.userName, role: { code: role.code, name: role.name }, permissions: ["Support.View", "Support.AddActions"] };
    const command = { expectedVersion: 1, text: "Intento de actuación no asignada.", performedAt: new Date().toISOString() };
    const denied = await createSupportAction(incident.value.id, command, technician, { idempotencyKey: randomUUID(), requestHash: hashSupportActionRequest({ incidentId: incident.value.id, ...command }), scope: `incident:${incident.value.id}:action:create` });
    expect(denied).toMatchObject({ ok: false, status: 403, error: { code: "SUPPORT_INCIDENT_ACTION_FORBIDDEN" } });
    expect(await prisma.auditEvent.findFirst({ where: { eventType: "SUPPORT_INCIDENT_ACTION_DENIED", payload: { path: ["actorUserId"], equals: technician.id } } })).not.toBeNull();
    const first = await createSupportAction(incident.value.id, command, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportActionRequest({ incidentId: incident.value.id, ...command }), scope: `incident:${incident.value.id}:action:create` });
    expect(first.ok).toBe(true);
    const stale = await createSupportAction(incident.value.id, command, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportActionRequest({ incidentId: incident.value.id, ...command }), scope: `incident:${incident.value.id}:action:create` });
    expect(stale).toMatchObject({ ok: false, status: 409, error: { code: "SUPPORT_INCIDENT_VERSION_CONFLICT" } });
    const resolveCommand = { action: "resolve" as const, expectedVersion: 2, solution: "Se corrige la configuración y se valida el acceso." };
    const resolved = await transitionSupportIncident(incident.value.id, resolveCommand, actor, transitionContext(incident.value.id, resolveCommand));
    expect(resolved).toMatchObject({ ok: true, value: { incident: { status: "RESOLVED", version: 3 } } });
    const finalizedCommand = { ...command, expectedVersion: 3 };
    const finalized = await createSupportAction(incident.value.id, finalizedCommand, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportActionRequest({ incidentId: incident.value.id, ...finalizedCommand }), scope: `incident:${incident.value.id}:action:create` });
    expect(finalized).toMatchObject({ ok: false, status: 409, error: { code: "SUPPORT_INCIDENT_FINALIZED" } });
  });

  it("preserves pending, close and reopen transitions with versioned evidence", async () => {
    const actor = await admin(); const customer = await createCustomerRecord(actor); const refs = await listSupportReferences();
    const command = { customerId: customer.id, storeId: null, categoryId: refs.categories[0]!.id, responsibleUserId: actor.id, title: "Seguimiento externo", description: "La incidencia requiere respuesta del cliente.", priority: "MEDIUM" as const };
    const incident = await createSupportIncident(command, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(command), scope: "incident:create" }); if (!incident.ok) throw new Error(incident.error.code);
    const pending = { action: "set-pending" as const, expectedVersion: 1, targetStatus: "PENDING_CUSTOMER" as const, reason: "Esperamos confirmación del cliente." };
    expect(await transitionSupportIncident(incident.value.id, pending, actor, transitionContext(incident.value.id, pending))).toMatchObject({ ok: true, status: 201, value: { incident: { status: "PENDING_CUSTOMER", version: 2 } } });
    const resume = { action: "resume" as const, expectedVersion: 2, reason: "El cliente aporta la información solicitada." };
    expect(await transitionSupportIncident(incident.value.id, resume, actor, transitionContext(incident.value.id, resume))).toMatchObject({ ok: true, value: { incident: { status: "IN_PROGRESS", version: 3 } } });
    const close = { action: "close" as const, expectedVersion: 3, closeReason: "OTHER" as const, detail: "Caso absorbido por una actuación preventiva." };
    expect(await transitionSupportIncident(incident.value.id, close, actor, transitionContext(incident.value.id, close))).toMatchObject({ ok: true, value: { incident: { status: "CLOSED", version: 4 } } });
    const reopen = { action: "reopen" as const, expectedVersion: 4, reason: "El problema vuelve a reproducirse." };
    const reopened = await transitionSupportIncident(incident.value.id, reopen, actor, transitionContext(incident.value.id, reopen));
    const replay = await transitionSupportIncident(incident.value.id, reopen, actor, transitionContext(incident.value.id, reopen, "reopen-key"));
    expect(reopened).toMatchObject({ ok: true, value: { incident: { status: "IN_PROGRESS", version: 5 } } });
    expect(replay.ok).toBe(false);
    const stored = await prisma.supportIncident.findUniqueOrThrow({ where: { id: incident.value.id }, include: { transitions: true, events: true } });
    expect(stored.transitions).toHaveLength(4); expect(stored.events).toHaveLength(5); expect(stored.closeReason).toBeNull();
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "SUPPORT_INCIDENT_STATUS_CHANGED", payload: { path: ["action"], equals: "set-pending" } } });
    expect(JSON.stringify(audit.payload)).not.toContain(pending.reason);
    await expect(prisma.supportIncidentStatusTransition.update({ where: { id: stored.transitions[0]!.id }, data: { reasonText: "Alterado" } })).rejects.toThrow();
    await expect(prisma.supportIncident.update({ where: { id: stored.id }, data: { status: "CLOSED", version: { increment: 1 }, closedAt: new Date(), closeReason: "DUPLICATE" } })).rejects.toThrow();
  });

  it("rejects a store belonging to another customer", async () => {
    const actor = await admin();
    const customer = await createCustomerRecord(actor);
    const other = await createCustomerRecord(actor, { legalName: "Otro Cliente SL", taxId: "B00000000", email: "otro@example.test", sepaMandate: { reference: "SEPA-2", signedAt: "2026-07-01" } });
    const store = await prisma.customerStore.create({ data: { customerId: other.id, code: "T00001", name: "Tienda ajena", addressLine: "Calle Dos 2", postalCode: "28002", city: "Madrid", country: "ES", createdById: actor.id } });
    const refs = await listSupportReferences();
    const command = { customerId: customer.id, storeId: store.id, categoryId: refs.categories[0]!.id, responsibleUserId: actor.id, title: "Incidencia con tienda", description: "La tienda no pertenece al cliente.", priority: "MEDIUM" as const };
    const result = await createSupportIncident(command, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(command), scope: "incident:create" });
    expect(result).toMatchObject({ ok: false, status: 422, error: { code: "SUPPORT_STORE_NOT_FOUND" } });
    expect(await prisma.supportIncident.count()).toBe(0);
  });

  it("lists without descriptions and returns the authorized detail", async () => {
    const actor = await admin(); const customer = await createCustomerRecord(actor); const refs = await listSupportReferences();
    const command = { customerId: customer.id, storeId: null, categoryId: refs.categories[0]!.id, responsibleUserId: actor.id, title: "Consulta de soporte", description: "Texto interno que no debe aparecer en el listado.", priority: "MEDIUM" as const };
    const created = await createSupportIncident(command, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(command), scope: "incident:create" });
    if (!created.ok) throw new Error(created.error.code);
    const list = await listSupportIncidents({ limit: 25, search: "Texto interno" }, actor);
    const detail = await getSupportIncident(created.value.id, actor);
    expect(list.incidents).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(command.description);
    expect(detail?.description).toBe(command.description);
  });

  it("creates normalized unique categories idempotently", async () => {
    const actor = await admin(); const command = { name: "Conectividad", description: "Red y comunicaciones", color: "#2563EB" };
    const context = { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(command), scope: "category:create" };
    expect(await createSupportCategory(command, actor, context)).toMatchObject({ ok: true, status: 201 });
    expect(await createSupportCategory(command, actor, context)).toMatchObject({ ok: true, status: 200 });
    const duplicate = { ...command, name: "Cónéctividad" };
    expect(await createSupportCategory(duplicate, actor, { idempotencyKey: randomUUID(), requestHash: hashSupportRequest(duplicate), scope: "category:create" })).toMatchObject({ ok: false, status: 409, error: { code: "SUPPORT_CATEGORY_ALREADY_EXISTS" } });
  });
});

async function initialize() { const body = JSON.stringify(installation); const result = await initializePlatform(installation, randomUUID(), hashRequestBody(body)); if (!result.ok) throw new Error(result.error.code); const row = await prisma.installation.findFirstOrThrow(); await prisma.supportIncidentCategory.create({ data: { companyId: row.companyId!, name: "General", normalizedName: "general", description: "Categoria inicial", color: "#475569" } }); await prisma.accountingFiscalYear.create({ data: { companyId: row.companyId!, year: 2026, startDate: new Date("2026-01-01T00:00:00.000Z"), endDate: new Date("2026-12-31T00:00:00.000Z"), planCode: "PGC_PYMES", planVersion: "2021.1", createdById: row.initialAdministratorId! } }); }
async function admin() { const result = await login({ userName: "admin", password }); if (!result.ok) throw new Error(result.error.code); return result.value.user; }
async function createCustomerRecord(actor: Awaited<ReturnType<typeof admin>>, overrides: Record<string, unknown> = {}) { const result = await createCustomer({ type: "COMPANY", legalName: "Cliente Demo SL", tradeName: "Cliente Demo", taxId: "B12345674", fiscalTreatment: "DOMESTIC", email: "cliente@example.test", phone: "+34910000000", fiscalAddressLine: "Calle Mayor 1", fiscalPostalCode: "28001", fiscalCity: "Madrid", fiscalProvince: "Madrid", fiscalCountry: "ES", defaultPaymentMethod: "BANK_TRANSFER", paymentTermsType: "IMMEDIATE", paymentDays: null, paymentFixedDay: null, creditLimit: null, bankIban: "ES9121000418450200051332", sepaMandate: { reference: "SEPA-1", signedAt: "2026-07-01" }, notes: "No auditar", ...overrides }, actor); if (!result.ok) throw new Error(result.error.code); return result.value; }
function transitionContext(incidentId: string, command: unknown, key: string = randomUUID()) { return { idempotencyKey: key, requestHash: hashSupportStatusTransitionRequest({ incidentId, ...(command as object) }), scope: `incident:${incidentId}:status-transition` }; }
async function reset() { await prisma.$transaction(async (tx) => { await tx.$executeRawUnsafe('ALTER TABLE "support_incident_events" DISABLE TRIGGER "support_incident_events_append_only"'); await tx.$executeRawUnsafe('ALTER TABLE "support_incident_actions" DISABLE TRIGGER "support_incident_actions_append_only"'); await tx.$executeRawUnsafe('ALTER TABLE "support_incident_status_transitions" DISABLE TRIGGER "support_incident_status_transitions_append_only"'); await tx.supportIncidentEvent.deleteMany(); await tx.supportIncidentStatusTransition.deleteMany(); await tx.supportIncidentAction.deleteMany(); await tx.supportIncident.deleteMany(); await tx.$executeRawUnsafe('ALTER TABLE "support_incident_status_transitions" ENABLE TRIGGER "support_incident_status_transitions_append_only"'); await tx.$executeRawUnsafe('ALTER TABLE "support_incident_actions" ENABLE TRIGGER "support_incident_actions_append_only"'); await tx.$executeRawUnsafe('ALTER TABLE "support_incident_events" ENABLE TRIGGER "support_incident_events_append_only"'); }); await prisma.supportIncidentNumberSequence.deleteMany(); await prisma.supportIncidentCategory.deleteMany(); await prisma.idempotencyRecord.deleteMany(); await prisma.auditEvent.deleteMany(); await prisma.installation.deleteMany(); await prisma.session.deleteMany(); await prisma.customerStore.deleteMany(); await prisma.customerSepaMandate.deleteMany(); await prisma.accountingJournalLine.deleteMany(); await prisma.accountingJournalEntry.deleteMany(); await prisma.accountingAccount.deleteMany(); await prisma.accountingFiscalYear.deleteMany(); await prisma.customer.deleteMany(); await prisma.reservedUserName.deleteMany(); await prisma.user.deleteMany(); await prisma.rolePermission.deleteMany(); await prisma.permission.deleteMany(); await prisma.role.deleteMany(); await prisma.company.deleteMany(); await prisma.$executeRaw`ALTER SEQUENCE customer_code_seq RESTART WITH 1`; }
