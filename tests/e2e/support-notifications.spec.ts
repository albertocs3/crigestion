import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/platform/application/auth";
import { hashPassword } from "@/modules/platform/application/passwords";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand,
} from "@/modules/platform/application/installation";
import {
  createSupportIncident,
  hashSupportRequest,
} from "@/modules/support/application/incidents";
import {
  changeSupportParticipants,
  hashSupportParticipantRequest,
} from "@/modules/support/application/participants";
import {
  createSupportAction,
  hashSupportActionRequest,
} from "@/modules/support/application/actions";
import {
  hashSupportStatusTransitionRequest,
  transitionSupportIncident,
} from "@/modules/support/application/statusTransitions";
import { assertDisposableTestDatabase } from "@/tests/helpers/disposableTestDatabase";

const adminPassword = "Cambiar-admin-notifications-2026";
const responsiblePassword = "Cambiar-responsible-notifications-2026";
const collaboratorPassword = "Cambiar-collaborator-notifications-2026";
const outsiderPassword = "Cambiar-outsider-notifications-2026";
const actionText = "Actuación sintética para comprobar el aviso al responsable.";
const closeDetail = "Cierre sintético previo a la reapertura E2E.";
const reopenReason = "Reapertura sintética para comprobar la notificación.";
const priorityReason = "Escalada sintética de prioridad para comprobar el aviso urgente.";

test.beforeEach(async () => {
  await resetNotificationE2eDatabase();
});

test.afterAll(async () => {
  await resetNotificationE2eDatabase();
  await prisma.$disconnect();
});

test("shows a private and operable support inbox for each recipient", async ({ page }) => {
  const fixture = await createNotificationFixture();

  await loginAs(page, fixture.collaborator.userName, collaboratorPassword);
  await page.goto("/app/notifications");
  await expect(page.getByRole("heading", { name: "Notificaciones" })).toBeVisible();
  await expect(page.getByText("Incorporación como colaborador")).toBeVisible();
  await expect(page.getByText("Nueva actuación de un colaborador")).not.toBeVisible();
  await expect(page.getByText("Incidencia reabierta")).not.toBeVisible();
  await expect(page.getByRole("list", { name: "Notificaciones" }).getByRole("listitem")).toHaveCount(1);

  const collaboratorNotice = page
    .getByRole("listitem")
    .filter({ hasText: "Incorporación como colaborador" });
  await collaboratorNotice.getByRole("link", { name: "Abrir incidencia" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/support/incidents/${fixture.incidentId}$`));
  await expect(page.getByRole("heading", { name: fixture.incidentTitle })).toBeVisible();
  await expect(page.getByRole("group", { name: "Cambiar prioridad" })).not.toBeVisible();

  await page.goto("/app/notifications");
  await page
    .getByRole("listitem")
    .filter({ hasText: "Incorporación como colaborador" })
    .getByRole("button", { name: "Marcar como leída" })
    .click();
  await expect(page.getByText("No hay notificaciones en este filtro.")).toBeVisible();
  await page.getByRole("link", { name: "Leídas" }).click();
  await expect(page.getByText("Incorporación como colaborador")).toBeVisible();
  await page.getByRole("button", { name: "Marcar como no leída" }).click();
  await expect(page.getByText("No hay notificaciones en este filtro.")).toBeVisible();
  await page.getByRole("link", { name: "Sin leer" }).click();
  await expect(page.getByText("Incorporación como colaborador")).toBeVisible();
  expect(
    await prisma.notification.findUniqueOrThrow({
      where: { id: fixture.collaboratorNotificationId },
      select: { status: true, version: true },
    }),
  ).toEqual({ status: "UNREAD", version: 3 });
  expect(
    await prisma.notificationStateChange.count({
      where: { notificationId: fixture.collaboratorNotificationId },
    }),
  ).toBe(2);

  await loginAs(page, fixture.responsible.userName, responsiblePassword);
  await page.goto("/app/notifications");
  await expect(page.getByText("Nueva incidencia asignada")).toBeVisible();
  await expect(page.getByText("Nueva actuación de un colaborador")).toBeVisible();
  await expect(page.getByText("Incidencia reabierta")).toBeVisible();
  await expect(page.getByText("Incorporación como colaborador")).not.toBeVisible();
  await expect(page.getByRole("list", { name: "Notificaciones" }).getByRole("listitem")).toHaveCount(3);
  await expect(page.getByText(actionText)).not.toBeVisible();
  await expect(page.getByText(closeDetail)).not.toBeVisible();
  await expect(page.getByText(reopenReason)).not.toBeVisible();

  const reopenedNotice = page
    .getByRole("listitem")
    .filter({ hasText: "Incidencia reabierta" });
  await reopenedNotice.getByRole("link", { name: "Abrir incidencia" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/support/incidents/${fixture.incidentId}$`));
  await expect(page.getByRole("heading", { name: fixture.incidentTitle })).toBeVisible();
  const priorityForm = page.getByRole("group", { name: "Cambiar prioridad" });
  await priorityForm.getByLabel("Nueva prioridad").selectOption("URGENT");
  await priorityForm.getByLabel("Motivo").fill(priorityReason);
  await expect(priorityForm.getByText("Se notificará a los usuarios autorizados para recibir incidencias urgentes.")).toBeVisible();
  const urgentConfirmation = priorityForm.getByLabel(/Confirmo el cambio a urgente/);
  await expect(urgentConfirmation).toHaveAttribute("required", "");
  await urgentConfirmation.check();
  await page.getByRole("button", { name: "Actualizar prioridad" }).click();
  await expect(page.getByRole("status")).toHaveText("Prioridad actualizada.");
  await expect(page.getByLabel("Prioridad: Urgente")).toBeVisible();

  await page.goto("/app/notifications");
  const urgentNotice = page.getByRole("list", { name: "Notificaciones" }).getByRole("listitem").filter({ hasText: "Incidencia urgente" }).filter({ hasText: fixture.incidentNumber });
  await expect(urgentNotice).toHaveCount(1);
  await expect(urgentNotice.getByText("Urgente", { exact: true })).toBeVisible();
  await expect(page.getByText(priorityReason)).not.toBeVisible();
  await expect(page.getByRole("list", { name: "Notificaciones" }).getByRole("listitem")).toHaveCount(4);
  expect(await prisma.notification.count({ where: { incidentId: fixture.incidentId, recipientUserId: fixture.responsible.id, kind: "SUPPORT_INCIDENT_URGENT" } })).toBe(1);
  expect(await prisma.notification.count({ where: { incidentId: fixture.incidentId, recipientUserId: fixture.collaborator.id, kind: "SUPPORT_INCIDENT_URGENT" } })).toBe(0);
  expect(await prisma.notification.count({ where: { incidentId: fixture.incidentId, kind: "SUPPORT_INCIDENT_URGENT" } })).toBe(2);

  await loginAs(page, fixture.outsider.userName, outsiderPassword);
  await page.goto("/app/notifications?state=ALL");
  await expect(page.getByText("0 sin leer.")).toBeVisible();
  await expect(page.getByText("No hay notificaciones en este filtro.")).toBeVisible();
  await expect(page.getByText(fixture.incidentNumber)).not.toBeVisible();
  const csrfResponse = await page.request.get("/api/auth/csrf");
  const csrfBody = (await csrfResponse.json()) as { csrfToken: string };
  const denied = await page.request.put(
    `/api/notifications/${fixture.responsibleActionNotificationId}/state`,
    {
      headers: {
        Origin: new URL(page.url()).origin,
        "Idempotency-Key": randomUUID(),
        "X-CSRF-Token": csrfBody.csrfToken,
      },
      data: { state: "READ", expectedVersion: 1 },
    },
  );
  expect(denied.status()).toBe(404);
  expect(await denied.json()).toMatchObject({ code: "NOTIFICATION_NOT_FOUND" });
  expect(
    await prisma.notification.findUniqueOrThrow({
      where: { id: fixture.responsibleActionNotificationId },
      select: { status: true, version: true },
    }),
  ).toEqual({ status: "UNREAD", version: 1 });
});

async function createNotificationFixture() {
  const installation: InitializeCommand = {
    company: {
      legalName: "CriGestion Notifications E2E SL",
      taxId: "B12345678",
      email: "notifications-e2e@example.test",
    },
    administrator: {
      displayName: "Administrador Notifications E2E",
      userName: "admin-notifications-e2e",
      password: adminPassword,
    },
  };
  const rawInstallation = JSON.stringify(installation);
  const initialized = await initializePlatform(
    installation,
    "support-notifications-e2e-initialize",
    hashRequestBody(rawInstallation),
  );
  if (!initialized.ok) throw new Error(initialized.error.code);

  const installed = await prisma.installation.findFirstOrThrow({
    include: { initialAdministrator: { include: { role: true } } },
  });
  const companyId = installed.companyId!;
  const administrator = installed.initialAdministrator!;
  const adminActor: SessionUser = {
    id: administrator.id,
    displayName: administrator.displayName,
    userName: administrator.userName,
    role: { code: administrator.role.code, name: administrator.role.name },
    permissions: [
      "Support.View",
      "Support.ManageParticipants",
      "Support.ManageAssigned",
      "Support.Reopen",
    ],
  };

  const responsibleRole = await createRole("SupportNotificationsResponsibleE2E", [
    "Support.View",
    "Support.AddActions",
    "Support.ManageAssigned",
    "Support.ReceiveUrgentNotifications",
  ]);
  const collaboratorRole = await createRole("SupportNotificationsCollaboratorE2E", [
    "Support.View",
    "Support.AddActions",
  ]);
  const viewerRole = await createRole("SupportNotificationsViewerE2E", ["Support.View"]);
  const responsible = await createUser(
    "Responsable Notifications E2E",
    "responsible-notifications-e2e",
    responsiblePassword,
    responsibleRole.id,
  );
  const collaborator = await createUser(
    "Colaborador Notifications E2E",
    "collaborator-notifications-e2e",
    collaboratorPassword,
    collaboratorRole.id,
  );
  const outsider = await createUser(
    "Tercero Notifications E2E",
    "outsider-notifications-e2e",
    outsiderPassword,
    viewerRole.id,
  );
  const collaboratorActor = sessionUser(collaborator, collaboratorRole, [
    "Support.View",
    "Support.AddActions",
  ]);

  const customer = await prisma.customer.create({
    data: {
      code: "CLI-NOTIF-E2E",
      type: "COMPANY",
      legalName: "Cliente Notifications E2E SL",
      tradeName: "Cliente Notifications",
      taxId: "B12345674",
      normalizedTaxId: "B12345674",
      fiscalTreatment: "DOMESTIC",
      fiscalAddressLine: "Calle E2E 1",
      fiscalPostalCode: "28001",
      fiscalCity: "Madrid",
      fiscalCountry: "ES",
      createdById: administrator.id,
    },
  });
  const category = await prisma.supportIncidentCategory.create({
    data: {
      companyId,
      name: "General E2E",
      normalizedName: "general e2e",
      description: "Categoría sintética para notificaciones",
      color: "#475569",
    },
  });
  const incidentTitle = "Incidencia compartida E2E";
  const incidentCommand = {
    customerId: customer.id,
    storeId: null,
    categoryId: category.id,
    responsibleUserId: responsible.id,
    title: incidentTitle,
    description: "Incidencia sintética sin información personal real.",
    priority: "MEDIUM" as const,
  };
  const incident = await createSupportIncident(incidentCommand, adminActor, {
    idempotencyKey: randomUUID(),
    requestHash: hashSupportRequest(incidentCommand),
    scope: "incident:create",
    correlationId: "support-notifications-e2e:create",
  });
  if (!incident.ok) throw new Error(incident.error.code);

  const addCollaborator = {
    action: "add-collaborator" as const,
    expectedVersion: 1,
    userId: collaborator.id,
  };
  const added = await changeSupportParticipants(
    incident.value.id,
    addCollaborator,
    adminActor,
    {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportParticipantRequest({
        incidentId: incident.value.id,
        ...addCollaborator,
      }),
      scope: `incident:${incident.value.id}:participant-change`,
    },
  );
  if (!added.ok) throw new Error(added.error.code);

  const actionCommand = {
    expectedVersion: 2,
    text: actionText,
    performedAt: new Date().toISOString(),
  };
  const action = await createSupportAction(
    incident.value.id,
    actionCommand,
    collaboratorActor,
    {
      idempotencyKey: randomUUID(),
      requestHash: hashSupportActionRequest({
        incidentId: incident.value.id,
        ...actionCommand,
      }),
      scope: `incident:${incident.value.id}:action:create`,
    },
  );
  if (!action.ok) throw new Error(action.error.code);

  const closeCommand = {
    action: "close" as const,
    expectedVersion: 3,
    closeReason: "OTHER" as const,
    detail: closeDetail,
  };
  const closed = await transitionSupportIncident(
    incident.value.id,
    closeCommand,
    adminActor,
    transitionContext(incident.value.id, closeCommand),
  );
  if (!closed.ok) throw new Error(closed.error.code);
  const reopenCommand = {
    action: "reopen" as const,
    expectedVersion: 4,
    reason: reopenReason,
  };
  const reopened = await transitionSupportIncident(
    incident.value.id,
    reopenCommand,
    adminActor,
    transitionContext(incident.value.id, reopenCommand),
  );
  if (!reopened.ok) throw new Error(reopened.error.code);

  const collaboratorNotification = await prisma.notification.findFirstOrThrow({
    where: {
      incidentId: incident.value.id,
      recipientUserId: collaborator.id,
      kind: "SUPPORT_INCIDENT_COLLABORATOR_ADDED",
    },
    select: { id: true },
  });
  const responsibleActionNotification = await prisma.notification.findFirstOrThrow({
    where: {
      incidentId: incident.value.id,
      recipientUserId: responsible.id,
      kind: "SUPPORT_INCIDENT_COLLABORATOR_ACTION",
    },
    select: { id: true },
  });

  return {
    incidentId: incident.value.id,
    incidentNumber: incident.value.number,
    incidentTitle,
    responsible,
    collaborator,
    outsider,
    collaboratorNotificationId: collaboratorNotification.id,
    responsibleActionNotificationId: responsibleActionNotification.id,
  };
}

async function createRole(code: string, permissions: string[]) {
  return prisma.role.create({
    data: {
      code,
      name: code,
      permissions: {
        create: permissions.map((permissionCode) => ({
          permission: { connect: { code: permissionCode } },
        })),
      },
    },
  });
}

async function createUser(
  displayName: string,
  userName: string,
  password: string,
  roleId: string,
) {
  return prisma.user.create({
    data: {
      displayName,
      userName,
      normalizedUserName: userName,
      passwordHash: hashPassword(password),
      roleId,
    },
  });
}

function sessionUser(
  user: { id: string; displayName: string; userName: string },
  role: { code: string; name: string },
  permissions: string[],
): SessionUser {
  return {
    id: user.id,
    displayName: user.displayName,
    userName: user.userName,
    role: { code: role.code, name: role.name },
    permissions,
  };
}

function transitionContext(incidentId: string, command: unknown) {
  return {
    idempotencyKey: randomUUID(),
    requestHash: hashSupportStatusTransitionRequest({ incidentId, ...(command as object) }),
    scope: `incident:${incidentId}:status-transition`,
  };
}

async function loginAs(page: Page, userName: string, password: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Usuario").fill(userName);
  await page.getByLabel("Contrasena").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/app$/);
}

async function resetNotificationE2eDatabase() {
  await assertDisposableTestDatabase();
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "companies",
      "roles",
      "permissions",
      "idempotency_records",
      "audit_events",
      "rate_limit_buckets",
      "login_attempts",
      "reserved_user_names"
    CASCADE
  `);
}
