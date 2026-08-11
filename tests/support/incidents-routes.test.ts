import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { GET as incidentsGet, POST as incidentsPost } from "@/app/api/support/incidents/route";
import { POST as actionsPost } from "@/app/api/support/incidents/[incidentId]/actions/route";
import { POST as transitionsPost } from "@/app/api/support/incidents/[incidentId]/status-transitions/route";
import { prisma } from "@/lib/prisma";
import { sessionCookieName } from "@/modules/platform/application/auth";
import { hashPassword } from "@/modules/platform/application/passwords";
import { hashRequestBody, initializePlatform, type InitializeCommand } from "@/modules/platform/application/installation";

const cookieMock = vi.hoisted(() => { const values = new Map<string, string>(); return { values, store: { get(name: string) { const value = values.get(name); return value ? { name, value } : undefined; }, set(name: string, value: string) { values.set(name, value); }, delete(name: string) { values.delete(name); } }, reset() { values.clear(); } }; });
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieMock.store) }));

const password = "Cambiar-esta-clave-2026";
const base: InitializeCommand = { company: { legalName: "CriGestion Test SL", taxId: "B12345678" }, administrator: { displayName: "Administrador", userName: "admin", password } };

describe("support incidents HTTP contracts", () => {
  beforeEach(async () => { process.env.APP_BASE_URL = "http://localhost:3000"; process.env.AUTH_COOKIE_SECURE = "false"; cookieMock.reset(); await reset(); await initialize(); });
  afterAll(async () => { await reset(); await prisma.$disconnect(); });

  it("rejects unauthenticated listing with no-store", async () => {
    const response = await incidentsGet(request("/api/support/incidents"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(await response.json()).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("requires CSRF before creating an incident", async () => {
    await loginAs("admin", password);
    const response = await incidentsPost(jsonRequest("/api/support/incidents", await payload()));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "CSRF_TOKEN_INVALID" });
  });

  it("requires both create and view permissions", async () => {
    const role = await prisma.role.create({ data: { code: "SupportCreator", name: "Alta soporte", permissions: { create: { permission: { connect: { code: "Support.Create" } } } } } });
    await prisma.user.create({ data: { displayName: "Creador", userName: "creator", normalizedUserName: "creator", passwordHash: hashPassword("Cambiar-creator-2026"), roleId: role.id } });
    await loginAs("creator", "Cambiar-creator-2026"); const csrf = await csrfToken();
    const response = await incidentsPost(jsonRequest("/api/support/incidents", await payload(), { csrf }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("creates once and replays the stored response", async () => {
    await loginAs("admin", password); const csrf = await csrfToken(); const body = await payload(); const key = randomUUID();
    const first = await incidentsPost(jsonRequest("/api/support/incidents", body, { csrf, key }));
    const replay = await incidentsPost(jsonRequest("/api/support/incidents", body, { csrf, key }));
    expect(first.status).toBe(201); expect(replay.status).toBe(200);
    expect(responseId(await first.json())).toBe(responseId(await replay.json()));
    expect(first.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(await prisma.supportIncident.count()).toBe(1);
    expect(await prisma.auditEvent.count({ where: { eventType: "SUPPORT_INCIDENT_CREATED" } })).toBe(1);
  });

  it("registers and replays an action through the protected route", async () => {
    await loginAs("admin", password); const csrf = await csrfToken();
    const incidentResponse = await incidentsPost(jsonRequest("/api/support/incidents", await payload(), { csrf, key: randomUUID() }));
    const incident = await incidentResponse.json() as { id: string; version: number };
    const body = { expectedVersion: incident.version, text: "Se verifica el acceso y se documenta la intervención.", performedAt: new Date().toISOString() };
    const key = randomUUID(); const context = { params: Promise.resolve({ incidentId: incident.id }) };
    const first = await actionsPost(jsonRequest(`/api/support/incidents/${incident.id}/actions`, body, { csrf, key }), context);
    const replay = await actionsPost(jsonRequest(`/api/support/incidents/${incident.id}/actions`, body, { csrf, key }), context);
    expect(first.status).toBe(201); expect(replay.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const firstBody = await first.json() as { action: { id: string }; incident: { status: string; version: number } };
    const replayBody = await replay.json() as { action: { id: string } };
    expect(firstBody).toMatchObject({ incident: { status: "IN_PROGRESS", version: 2 } });
    expect(replayBody.action.id).toBe(firstBody.action.id);
    expect(await prisma.supportIncidentAction.count()).toBe(1);
  });

  it("resolves once and replays the versioned transition", async () => {
    await loginAs("admin", password); const csrf = await csrfToken();
    const created = await incidentsPost(jsonRequest("/api/support/incidents", await payload(), { csrf, key: randomUUID() }));
    const incident = await created.json() as { id: string; version: number }; const body = { action: "resolve", expectedVersion: incident.version, solution: "Se aplica la corrección y se verifica el servicio." }; const key = randomUUID(); const context = { params: Promise.resolve({ incidentId: incident.id }) };
    const first = await transitionsPost(jsonRequest(`/api/support/incidents/${incident.id}/status-transitions`, body, { csrf, key }), context);
    const replay = await transitionsPost(jsonRequest(`/api/support/incidents/${incident.id}/status-transitions`, body, { csrf, key }), context);
    expect(first.status).toBe(201); expect(replay.status).toBe(200); expect(first.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const firstBody = await first.json() as { transition: { id: string }; incident: { status: string; version: number } }; const replayBody = await replay.json() as { transition: { id: string } };
    expect(firstBody).toMatchObject({ incident: { status: "RESOLVED", version: 2 } }); expect(replayBody.transition.id).toBe(firstBody.transition.id); expect(await prisma.supportIncidentStatusTransition.count()).toBe(1);
  });
});

async function initialize() { const raw = JSON.stringify(base); const result = await initializePlatform(base, randomUUID(), hashRequestBody(raw)); if (!result.ok) throw new Error(result.error.code); const row = await prisma.installation.findFirstOrThrow(); await prisma.supportIncidentCategory.create({ data: { companyId: row.companyId!, name: "General", normalizedName: "general", description: "Categoria inicial", color: "#475569" } }); }
async function payload() { const installation = await prisma.installation.findFirstOrThrow(); const taxId = `X${randomUUID().replaceAll("-", "").slice(0, 20)}`; const customer = await prisma.customer.create({ data: { code: randomUUID().slice(0, 8), type: "COMPANY", legalName: "Cliente Soporte SL", taxId, normalizedTaxId: taxId, fiscalTreatment: "DOMESTIC", fiscalAddressLine: "Calle Uno 1", fiscalPostalCode: "28001", fiscalCity: "Madrid", fiscalCountry: "ES", createdById: installation.initialAdministratorId! } }); const category = await prisma.supportIncidentCategory.findFirstOrThrow(); return { customerId: customer.id, storeId: null, categoryId: category.id, responsibleUserId: installation.initialAdministratorId!, title: "Incidencia desde API", description: "Descripción interna para la prueba de contrato.", priority: "MEDIUM" }; }
async function loginAs(userName: string, userPassword: string) { const response = await loginPost(jsonRequest("/api/auth/login", { userName, password: userPassword })); expect(response.status).toBe(200); expect(cookieMock.values.has(sessionCookieName)).toBe(true); }
async function csrfToken() { const response = await csrfGet(request("/api/auth/csrf")); const body = await response.json() as { csrfToken: string }; return body.csrfToken; }
function request(path: string) { return new Request(`http://localhost${path}`); }
function jsonRequest(path: string, body: unknown, options: { csrf?: string; key?: string } = {}) { const headers = new Headers({ "Content-Type": "application/json", Origin: "http://localhost:3000" }); if (options.csrf) headers.set("X-CSRF-Token", options.csrf); if (options.key) headers.set("Idempotency-Key", options.key); return new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) }); }
function responseId(value: unknown): string | undefined { return typeof value === "object" && value !== null && "id" in value ? String(value.id) : undefined; }
async function reset() { await prisma.$transaction(async (tx) => { await tx.$executeRawUnsafe('ALTER TABLE "support_incident_events" DISABLE TRIGGER "support_incident_events_append_only"'); await tx.$executeRawUnsafe('ALTER TABLE "support_incident_actions" DISABLE TRIGGER "support_incident_actions_append_only"'); await tx.$executeRawUnsafe('ALTER TABLE "support_incident_status_transitions" DISABLE TRIGGER "support_incident_status_transitions_append_only"'); await tx.supportIncidentEvent.deleteMany(); await tx.supportIncidentStatusTransition.deleteMany(); await tx.supportIncidentAction.deleteMany(); await tx.supportIncident.deleteMany(); await tx.$executeRawUnsafe('ALTER TABLE "support_incident_status_transitions" ENABLE TRIGGER "support_incident_status_transitions_append_only"'); await tx.$executeRawUnsafe('ALTER TABLE "support_incident_actions" ENABLE TRIGGER "support_incident_actions_append_only"'); await tx.$executeRawUnsafe('ALTER TABLE "support_incident_events" ENABLE TRIGGER "support_incident_events_append_only"'); }); await prisma.supportIncidentNumberSequence.deleteMany(); await prisma.supportIncidentCategory.deleteMany(); await prisma.idempotencyRecord.deleteMany(); await prisma.auditEvent.deleteMany(); await prisma.installation.deleteMany(); await prisma.session.deleteMany(); await prisma.customer.deleteMany(); await prisma.reservedUserName.deleteMany(); await prisma.user.deleteMany(); await prisma.rolePermission.deleteMany(); await prisma.permission.deleteMany(); await prisma.role.deleteMany(); await prisma.company.deleteMany(); }
