import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import {
  GET as incidentsGet,
  POST as incidentsPost,
} from "@/app/api/support/incidents/route";
import { POST as actionsPost } from "@/app/api/support/incidents/[incidentId]/actions/route";
import { POST as transitionsPost } from "@/app/api/support/incidents/[incidentId]/status-transitions/route";
import { POST as participantsPost } from "@/app/api/support/incidents/[incidentId]/participant-changes/route";
import { POST as attachmentsPost } from "@/app/api/support/incidents/[incidentId]/attachments/route";
import { GET as notificationsGet } from "@/app/api/notifications/route";
import { PUT as notificationStatePut } from "@/app/api/notifications/[notificationId]/state/route";
import {
  GET as communicationsGet,
  POST as communicationsPost,
} from "@/app/api/support/communications/route";
import { GET as communicationGet } from "@/app/api/support/communications/[communicationId]/route";
import { POST as communicationIncidentPost } from "@/app/api/support/communications/[communicationId]/incident/route";
import {
  GET as contactsGet,
  POST as contactsPost,
} from "@/app/api/customers/[customerId]/contacts/route";
import { PATCH as contactsPatch } from "@/app/api/customers/[customerId]/contacts/[contactId]/route";
import { prisma } from "@/lib/prisma";
import { sessionCookieName } from "@/modules/platform/application/auth";
import { hashPassword } from "@/modules/platform/application/passwords";
import { idempotencyStorageKey } from "@/modules/platform/application/http";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand,
} from "@/modules/platform/application/installation";

const cookieMock = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    store: {
      get(name: string) {
        const value = values.get(name);
        return value ? { name, value } : undefined;
      },
      set(name: string, value: string) {
        values.set(name, value);
      },
      delete(name: string) {
        values.delete(name);
      },
    },
    reset() {
      values.clear();
    },
  };
});
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieMock.store),
}));

const password = "Cambiar-esta-clave-2026";
const base: InitializeCommand = {
  company: { legalName: "CriGestion Test SL", taxId: "B12345678" },
  administrator: { displayName: "Administrador", userName: "admin", password },
};

describe("support incidents HTTP contracts", () => {
  beforeEach(async () => {
    process.env.APP_BASE_URL = "http://localhost:3000";
    process.env.AUTH_COOKIE_SECURE = "false";
    cookieMock.reset();
    await reset();
    await initialize();
  });
  afterAll(async () => {
    await reset();
    await prisma.$disconnect();
  });

  it("rejects unauthenticated listing with no-store", async () => {
    const response = await incidentsGet(request("/api/support/incidents"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(await response.json()).toMatchObject({ code: "UNAUTHENTICATED" });
    const notifications = await notificationsGet(request("/api/notifications"));
    expect(notifications.status).toBe(401);
    expect(notifications.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });

  it("requires CSRF before creating an incident", async () => {
    await loginAs("admin", password);
    const response = await incidentsPost(
      jsonRequest("/api/support/incidents", await payload()),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "CSRF_TOKEN_INVALID" });
  });

  it("requires both create and view permissions", async () => {
    const role = await prisma.role.create({
      data: {
        code: "SupportCreator",
        name: "Alta soporte",
        permissions: {
          create: { permission: { connect: { code: "Support.Create" } } },
        },
      },
    });
    await prisma.user.create({
      data: {
        displayName: "Creador",
        userName: "creator",
        normalizedUserName: "creator",
        passwordHash: hashPassword("Cambiar-creator-2026"),
        roleId: role.id,
      },
    });
    await loginAs("creator", "Cambiar-creator-2026");
    const csrf = await csrfToken();
    const response = await incidentsPost(
      jsonRequest("/api/support/incidents", await payload(), { csrf }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("creates once and replays the stored response", async () => {
    await loginAs("admin", password);
    const csrf = await csrfToken();
    const body = await payload();
    const key = randomUUID();
    const first = await incidentsPost(
      jsonRequest("/api/support/incidents", body, { csrf, key }),
    );
    const replay = await incidentsPost(
      jsonRequest("/api/support/incidents", body, { csrf, key }),
    );
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(responseId(await first.json())).toBe(
      responseId(await replay.json()),
    );
    expect(first.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(await prisma.supportIncident.count()).toBe(1);
    expect(
      await prisma.auditEvent.count({
        where: { eventType: "SUPPORT_INCIDENT_CREATED" },
      }),
    ).toBe(1);
  });

  it("lists only the authenticated inbox and changes state without caching", async () => {
    await loginAs("admin", password);
    const csrf = await csrfToken();
    const body = await payload();
    body.priority = "URGENT";
    const created = await incidentsPost(jsonRequest("/api/support/incidents", body, { csrf, key: randomUUID() }));
    expect(created.status).toBe(201);
    const listing = await notificationsGet(request("/api/notifications?state=UNREAD"));
    expect(listing.status).toBe(200);
    expect(listing.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const inbox = await listing.json() as { unreadCount: number; items: Array<{ id: string; status: string; version: number }> };
    expect(inbox).toMatchObject({ unreadCount: 1, items: [{ status: "UNREAD", version: 1 }] });
    const invalidCursor = await notificationsGet(request("/api/notifications?cursor=not-a-cursor"));
    expect(invalidCursor.status).toBe(422);
    const notification = inbox.items[0];
    if (!notification) throw new Error("NOTIFICATION_MISSING");
    const missingCsrf = await notificationStatePut(jsonRequest(`/api/notifications/${notification.id}/state`, { state: "READ", expectedVersion: notification.version }, { key: randomUUID(), method: "PUT" }), { params: Promise.resolve({ notificationId: notification.id }) });
    expect(missingCsrf.status).toBe(403);
    expect(await missingCsrf.json()).toMatchObject({ code: "CSRF_TOKEN_INVALID" });
    const changed = await notificationStatePut(jsonRequest(`/api/notifications/${notification.id}/state`, { state: "READ", expectedVersion: notification.version }, { csrf, key: randomUUID(), method: "PUT" }), { params: Promise.resolve({ notificationId: notification.id }) });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(await changed.json()).toMatchObject({ id: notification.id, status: "READ", version: 2 });
  });

  it("rate limits even an existing attachment key before reading the multipart body", async () => {
    await loginAs("admin", password);
    const csrf = await csrfToken();
    const created = await incidentsPost(jsonRequest("/api/support/incidents", await payload(), { csrf, key: randomUUID() }));
    const incidentId = responseId(await created.json());
    if (!incidentId) throw new Error("INCIDENT_ID_MISSING");
    const adminUser = await prisma.user.findUniqueOrThrow({ where: { normalizedUserName: "admin" }, select: { id: true } });
    const clientKey = randomUUID();
    await prisma.idempotencyRecord.create({ data: { key: idempotencyStorageKey(adminUser.id, "support-incident-attachment", incidentId, clientKey), requestHash: "stored-hash", responseStatus: 201, responseBody: { attachment: {} } } });
    await prisma.rateLimitBucket.create({ data: { key: `support-attachment:upload:${adminUser.id}`, windowStart: new Date(), count: 10 } });
    let reads = 0;
    const request = new Request(`http://localhost:3000/api/support/incidents/${incidentId}/attachments`, { method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "multipart/form-data; boundary=secure-boundary", "Idempotency-Key": clientKey, "X-CSRF-Token": csrf } });
    Object.defineProperty(request, "body", { configurable: true, get() { reads += 1; throw new Error("BODY_MUST_NOT_BE_READ"); } });
    const response = await attachmentsPost(request, { params: Promise.resolve({ incidentId }) });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("900");
    expect(reads).toBe(0);
  });

  it("registers and replays an action through the protected route", async () => {
    await loginAs("admin", password);
    const csrf = await csrfToken();
    const incidentResponse = await incidentsPost(
      jsonRequest("/api/support/incidents", await payload(), {
        csrf,
        key: randomUUID(),
      }),
    );
    const incident = (await incidentResponse.json()) as {
      id: string;
      version: number;
    };
    const body = {
      expectedVersion: incident.version,
      text: "Se verifica el acceso y se documenta la intervención.",
      performedAt: new Date().toISOString(),
    };
    const key = randomUUID();
    const context = { params: Promise.resolve({ incidentId: incident.id }) };
    const first = await actionsPost(
      jsonRequest(`/api/support/incidents/${incident.id}/actions`, body, {
        csrf,
        key,
      }),
      context,
    );
    const replay = await actionsPost(
      jsonRequest(`/api/support/incidents/${incident.id}/actions`, body, {
        csrf,
        key,
      }),
      context,
    );
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    const firstBody = (await first.json()) as {
      action: { id: string };
      incident: { status: string; version: number };
    };
    const replayBody = (await replay.json()) as { action: { id: string } };
    expect(firstBody).toMatchObject({
      incident: { status: "IN_PROGRESS", version: 2 },
    });
    expect(replayBody.action.id).toBe(firstBody.action.id);
    expect(await prisma.supportIncidentAction.count()).toBe(1);
    const companyId = (await prisma.installation.findFirstOrThrow({ select: { companyId: true } })).companyId!;
    const adminId = (await prisma.user.findUniqueOrThrow({ where: { normalizedUserName: "admin" }, select: { id: true } })).id;
    await prisma.rateLimitBucket.update({ where: { key: `support-action:${companyId}:${adminId}` }, data: { count: 30, windowStart: new Date() } });
    const limited = await actionsPost(jsonRequest(`/api/support/incidents/${incident.id}/actions`, { ...body, expectedVersion: 2, text: "Otro contenido con la misma clave." }, { csrf, key }), context);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(await limited.json()).toMatchObject({ code: "SUPPORT_ACTION_RATE_LIMITED" });
  });

  it("resolves once and replays the versioned transition", async () => {
    await loginAs("admin", password);
    const csrf = await csrfToken();
    const created = await incidentsPost(
      jsonRequest("/api/support/incidents", await payload(), {
        csrf,
        key: randomUUID(),
      }),
    );
    const incident = (await created.json()) as { id: string; version: number };
    const body = {
      action: "resolve",
      expectedVersion: incident.version,
      solution: "Se aplica la corrección y se verifica el servicio.",
    };
    const key = randomUUID();
    const context = { params: Promise.resolve({ incidentId: incident.id }) };
    const first = await transitionsPost(
      jsonRequest(
        `/api/support/incidents/${incident.id}/status-transitions`,
        body,
        { csrf, key },
      ),
      context,
    );
    const replay = await transitionsPost(
      jsonRequest(
        `/api/support/incidents/${incident.id}/status-transitions`,
        body,
        { csrf, key },
      ),
      context,
    );
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    const firstBody = (await first.json()) as {
      transition: { id: string };
      incident: { status: string; version: number };
    };
    const replayBody = (await replay.json()) as { transition: { id: string } };
    expect(firstBody).toMatchObject({
      incident: { status: "RESOLVED", version: 2 },
    });
    expect(replayBody.transition.id).toBe(firstBody.transition.id);
    expect(await prisma.supportIncidentStatusTransition.count()).toBe(1);
  });

  it("adds a collaborator once through the protected participant contract", async () => {
    await loginAs("admin", password);
    const csrf = await csrfToken();
    const role = await prisma.role.create({
      data: {
        code: "SupportRouteCollaborator",
        name: "Colaborador API",
        permissions: {
          create: ["Support.View", "Support.AddActions"].map((code) => ({
            permission: { connect: { code } },
          })),
        },
      },
    });
    const user = await prisma.user.create({
      data: {
        displayName: "Colaborador API",
        userName: "collaborator-api",
        normalizedUserName: "collaborator-api",
        passwordHash: hashPassword("Cambiar-collaborator-2026"),
        roleId: role.id,
      },
    });
    const created = await incidentsPost(
      jsonRequest("/api/support/incidents", await payload(), {
        csrf,
        key: randomUUID(),
      }),
    );
    const incident = (await created.json()) as { id: string; version: number };
    const body = {
      action: "add-collaborator",
      expectedVersion: incident.version,
      userId: user.id,
    };
    const key = randomUUID();
    const context = { params: Promise.resolve({ incidentId: incident.id }) };
    const first = await participantsPost(
      jsonRequest(
        `/api/support/incidents/${incident.id}/participant-changes`,
        body,
        { csrf, key },
      ),
      context,
    );
    const replay = await participantsPost(
      jsonRequest(
        `/api/support/incidents/${incident.id}/participant-changes`,
        body,
        { csrf, key },
      ),
      context,
    );
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    const firstBody = (await first.json()) as {
      change: { id: string; type: string };
    };
    const replayBody = (await replay.json()) as { change: { id: string } };
    expect(firstBody.change.type).toBe("COLLABORATOR_ADDED");
    expect(replayBody.change.id).toBe(firstBody.change.id);
    expect(await prisma.supportIncidentCollaborator.count()).toBe(1);
    expect(await prisma.notification.findMany({ where: { incidentId: incident.id, kind: "SUPPORT_INCIDENT_COLLABORATOR_ADDED" }, select: { recipientUserId: true, messageCode: true } })).toEqual([{ recipientUserId: user.id, messageCode: "support.incident.collaborator-added" }]);
  });

  it("creates and replays a protected communication", async () => {
    await loginAs("admin", password);
    const csrf = await csrfToken();
    const incidentPayload = await payload();
    const body = {
      customerId: incidentPayload.customerId,
      channel: "WHATSAPP",
      direction: "OUTBOUND",
      occurredAt: new Date().toISOString(),
      contactNumber: "+34910000003",
      durationSeconds: null,
      summary: "Se facilita al cliente la información solicitada.",
      result: "INFORMATION_PROVIDED",
      incidentId: null,
    };
    const key = randomUUID();
    const first = await communicationsPost(
      jsonRequest("/api/support/communications", body, { csrf, key }),
    );
    const replay = await communicationsPost(
      jsonRequest("/api/support/communications", body, { csrf, key }),
    );
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    const firstBody = (await first.json()) as { id: string };
    const replayBody = (await replay.json()) as { id: string };
    expect(replayBody.id).toBe(firstBody.id);
    expect(await prisma.supportCommunication.count()).toBe(1);

    const installation = await prisma.installation.findFirstOrThrow();
    const actor = await prisma.user.findUniqueOrThrow({
      where: { userName: "admin" },
    });
    const bucketKey = `support-communication-create:${installation.companyId}:${actor.id}`;
    expect(
      await prisma.rateLimitBucket.findUnique({ where: { key: bucketKey } }),
    ).toMatchObject({ count: 1 });
    await prisma.rateLimitBucket.update({
      where: { key: bucketKey },
      data: { count: 20 },
    });
    const limited = await communicationsPost(
      jsonRequest(
        "/api/support/communications",
        { ...body, summary: "Nueva comunicación que supera la cuota." },
        { csrf, key: randomUUID() },
      ),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("900");
    expect(await limited.json()).toMatchObject({
      code: "SUPPORT_COMMUNICATION_RATE_LIMITED",
    });
    const replayAfterLimit = await communicationsPost(
      jsonRequest("/api/support/communications", body, { csrf, key }),
    );
    expect(replayAfterLimit.status).toBe(200);
    expect(
      await prisma.auditEvent.count({
        where: { eventType: "SUPPORT_COMMUNICATION_RATE_LIMITED" },
      }),
    ).toBe(1);

    const list = await communicationsGet(
      request("/api/support/communications"),
    );
    const detail = await communicationGet(
      request(`/api/support/communications/${firstBody.id}`),
      { params: Promise.resolve({ communicationId: firstBody.id }) },
    );
    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    const readAudits = await prisma.auditEvent.findMany({
      where: {
        eventType: {
          in: ["SUPPORT_COMMUNICATIONS_VIEWED", "SUPPORT_COMMUNICATION_VIEWED"],
        },
      },
      select: { payload: true },
    });
    expect(readAudits).toHaveLength(2);
    expect(JSON.stringify(readAudits)).not.toContain(body.summary);
    expect(JSON.stringify(readAudits)).not.toContain(body.contactNumber);
  });

  it("protects communication reads and requires view alongside manage", async () => {
    const anonymous = await communicationsGet(
      request("/api/support/communications"),
    );
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );

    const role = await prisma.role.create({
      data: {
        code: "CommunicationManagerOnly",
        name: "Gestor de comunicaciones sin lectura",
        permissions: {
          create: {
            permission: {
              connect: { code: "Support.ManageCommunications" },
            },
          },
        },
      },
    });
    await prisma.user.create({
      data: {
        displayName: "Gestor sin lectura",
        userName: "communication-manager",
        normalizedUserName: "communication-manager",
        passwordHash: hashPassword("Cambiar-communications-2026"),
        roleId: role.id,
      },
    });
    await loginAs("communication-manager", "Cambiar-communications-2026");
    const csrf = await csrfToken();
    const customer = await payload();
    const response = await communicationsPost(
      jsonRequest(
        "/api/support/communications",
        {
          customerId: customer.customerId,
          channel: "WHATSAPP",
          direction: "INBOUND",
          occurredAt: new Date().toISOString(),
          contactNumber: "+34910000004",
          durationSeconds: null,
          summary: "Consulta que no debe autorizarse sin lectura.",
          result: "INFORMATION_PROVIDED",
          incidentId: null,
        },
        { csrf, key: randomUUID() },
      ),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.supportCommunication.count()).toBe(0);
  });

  it("creates an incident atomically from a protected communication", async () => {
    await loginAs("admin", password);
    const csrf = await csrfToken();
    const source = await payload();
    const communicationResponse = await communicationsPost(
      jsonRequest(
        "/api/support/communications",
        {
          customerId: source.customerId,
          channel: "PHONE",
          direction: "INBOUND",
          occurredAt: new Date().toISOString(),
          contactNumber: "+34910000006",
          durationSeconds: 120,
          summary: "Llamada que requiere apertura de incidencia.",
          result: "INFORMATION_PROVIDED",
          incidentId: null,
        },
        { csrf, key: randomUUID() },
      ),
    );
    const communication = (await communicationResponse.json()) as {
      id: string;
      version: number;
    };
    const category = await prisma.supportIncidentCategory.findFirstOrThrow();
    const installation = await prisma.installation.findFirstOrThrow();
    const body = {
      expectedCommunicationVersion: communication.version,
      storeId: null,
      categoryId: category.id,
      responsibleUserId: installation.initialAdministratorId!,
      title: "Incidencia creada desde llamada",
      priority: "MEDIUM",
    };
    const key = randomUUID();
    const context = {
      params: Promise.resolve({ communicationId: communication.id }),
    };
    const first = await communicationIncidentPost(
      jsonRequest(
        `/api/support/communications/${communication.id}/incident`,
        body,
        { csrf, key },
      ),
      context,
    );
    const replay = await communicationIncidentPost(
      jsonRequest(
        `/api/support/communications/${communication.id}/incident`,
        body,
        { csrf, key },
      ),
      context,
    );
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    const firstBody = (await first.json()) as { id: string };
    expect((await replay.json()) as { id: string }).toMatchObject({
      id: firstBody.id,
    });
    expect(await prisma.supportIncident.count()).toBe(1);
    expect(
      await prisma.supportCommunication.findUniqueOrThrow({
        where: { id: communication.id },
      }),
    ).toMatchObject({ incidentId: firstBody.id, version: 2 });
  });

  it("creates and lists a protected customer contact without caching", async () => {
    await loginAs("admin", password);
    const csrf = await csrfToken();
    const customer = await payload();
    const installation = await prisma.installation.findFirstOrThrow();
    const store = await prisma.customerStore.create({
      data: {
        customerId: customer.customerId,
        code: "T00001",
        name: "Tienda API",
        addressLine: "Calle API 1",
        postalCode: "28001",
        city: "Madrid",
        country: "ES",
        createdById: installation.initialAdministratorId!,
      },
    });
    const body = {
      storeId: store.id,
      name: "Contacto API",
      role: "Soporte",
      phone: "+34910000008",
      mobile: null,
      whatsapp: "+34600000008",
      email: "contacto-api@example.test",
    };
    const key = randomUUID();
    const context = {
      params: Promise.resolve({ customerId: customer.customerId }),
    };
    const first = await contactsPost(
      jsonRequest(`/api/customers/${customer.customerId}/contacts`, body, {
        csrf,
        key,
      }),
      context,
    );
    const replay = await contactsPost(
      jsonRequest(`/api/customers/${customer.customerId}/contacts`, body, {
        csrf,
        key,
      }),
      context,
    );
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    const created = (await first.json()) as { id: string; version: number };
    const patch = await contactsPatch(
      jsonRequest(
        `/api/customers/${customer.customerId}/contacts/${created.id}`,
        {
          action: "update",
          contact: {
            expectedVersion: created.version,
            name: "Contacto API actualizado",
            role: body.role,
            phone: body.phone,
            mobile: body.mobile,
            whatsapp: body.whatsapp,
            email: body.email,
          },
        },
        { csrf, key: randomUUID(), method: "PATCH" },
      ),
      {
        params: Promise.resolve({
          customerId: customer.customerId,
          contactId: created.id,
        }),
      },
    );
    expect(patch.status).toBe(200);
    expect(patch.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(await patch.json()).toMatchObject({
      id: created.id,
      name: "Contacto API actualizado",
      version: 2,
    });
    const list = await contactsGet(
      request(`/api/customers/${customer.customerId}/contacts`),
      context,
    );
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(
      ((await list.json()) as { contacts: unknown[] }).contacts,
    ).toHaveLength(1);
  });

  it("does not expose customer contacts without an authenticated session", async () => {
    const customerId = randomUUID();
    const response = await contactsGet(
      request(`/api/customers/${customerId}/contacts`),
      { params: Promise.resolve({ customerId }) },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(await response.json()).toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

async function initialize() {
  const raw = JSON.stringify(base);
  const result = await initializePlatform(
    base,
    randomUUID(),
    hashRequestBody(raw),
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
}
async function payload() {
  const installation = await prisma.installation.findFirstOrThrow();
  const taxId = `X${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const customer = await prisma.customer.create({
    data: {
      code: randomUUID().slice(0, 8),
      type: "COMPANY",
      legalName: "Cliente Soporte SL",
      taxId,
      normalizedTaxId: taxId,
      fiscalTreatment: "DOMESTIC",
      fiscalAddressLine: "Calle Uno 1",
      fiscalPostalCode: "28001",
      fiscalCity: "Madrid",
      fiscalCountry: "ES",
      createdById: installation.initialAdministratorId!,
    },
  });
  const category = await prisma.supportIncidentCategory.findFirstOrThrow();
  return {
    customerId: customer.id,
    storeId: null,
    categoryId: category.id,
    responsibleUserId: installation.initialAdministratorId!,
    title: "Incidencia desde API",
    description: "Descripción interna para la prueba de contrato.",
    priority: "MEDIUM",
  };
}
async function loginAs(userName: string, userPassword: string) {
  const response = await loginPost(
    jsonRequest("/api/auth/login", { userName, password: userPassword }),
  );
  expect(response.status).toBe(200);
  expect(cookieMock.values.has(sessionCookieName)).toBe(true);
}
async function csrfToken() {
  const response = await csrfGet(request("/api/auth/csrf"));
  const body = (await response.json()) as { csrfToken: string };
  return body.csrfToken;
}
function request(path: string) {
  return new Request(`http://localhost${path}`);
}
function jsonRequest(
  path: string,
  body: unknown,
  options: { csrf?: string; key?: string; method?: "POST" | "PATCH" | "PUT" } = {},
) {
  const headers = new Headers({
    "Content-Type": "application/json",
    Origin: "http://localhost:3000",
  });
  if (options.csrf) headers.set("X-CSRF-Token", options.csrf);
  if (options.key) headers.set("Idempotency-Key", options.key);
  return new Request(`http://localhost${path}`, {
    method: options.method ?? "POST",
    headers,
    body: JSON.stringify(body),
  });
}
function responseId(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "id" in value
    ? String(value.id)
    : undefined;
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
      'ALTER TABLE "support_incident_participant_changes" DISABLE TRIGGER "support_incident_participant_changes_append_only"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "support_incident_collaborators" DISABLE TRIGGER "support_incident_collaborators_guard"',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE "customer_contacts" DISABLE TRIGGER "customer_contacts_guard"',
    );
    await tx.$executeRawUnsafe('ALTER TABLE "notifications" DISABLE TRIGGER "notifications_guard"');
    await tx.$executeRawUnsafe('ALTER TABLE "notification_state_changes" DISABLE TRIGGER "notification_state_changes_append_only"');
    await tx.notificationStateChange.deleteMany();
    await tx.notification.deleteMany();
    await tx.supportCommunicationCorrection.deleteMany();
    await tx.supportCommunication.deleteMany();
    await tx.supportIncidentEvent.deleteMany();
    await tx.supportIncidentParticipantChange.deleteMany();
    await tx.supportIncidentCollaborator.deleteMany();
    await tx.supportIncidentStatusTransition.deleteMany();
    await tx.supportIncidentAction.deleteMany();
    await tx.supportIncident.deleteMany();
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
  });
  await prisma.supportIncidentNumberSequence.deleteMany();
  await prisma.supportIncidentCategory.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.rateLimitBucket.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.installation.deleteMany();
  await prisma.session.deleteMany();
  await prisma.customerStore.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.reservedUserName.deleteMany();
  await prisma.user.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.permission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.company.deleteMany();
}
