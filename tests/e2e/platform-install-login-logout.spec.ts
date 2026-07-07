import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";

const companyName = "CriGestion E2E SL";
const taxId = "B12345678";
const email = "admin-e2e@example.test";
const displayName = "Administrador E2E";
const userName = "admin-e2e";
const password = "Cambiar-e2e-2026";
const limitedUserName = "auditor-e2e";
const limitedPassword = "Cambiar-auditor-2026";
const restoreReason = "Restauracion operativa E2E sin datos sensibles";
const maintenanceReason = "Ventana de mantenimiento E2E controlada";

test.beforeEach(async () => {
  await resetPlatformTables();
});

test.afterAll(async () => {
  await resetPlatformTables();
  await prisma.$disconnect();
});

test("initializes the platform, logs in, shows the session, and logs out", async ({
  page
}) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/platform\/installation$/);

  await page.goto("/platform/installation");

  await expect(page.getByRole("heading", { name: "Estado de la instalacion" })).toBeVisible();
  await page.getByLabel("Nombre legal").fill(companyName);
  await page.getByLabel("NIF").fill(taxId);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Nombre visible").fill(displayName);
  await page.getByLabel("Usuario").fill(userName);
  await page.getByLabel("Contrasena").fill(password);
  await page.getByRole("button", { name: "Inicializar" }).click();

  await expect(page.getByText("Instalacion completada")).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Iniciar sesion" })).toBeVisible();

  await page.goto("/login");
  await page.getByLabel("Usuario").fill(userName);
  await page.getByLabel("Contrasena").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Inicio operativo" })).toBeVisible();
  await expect(page.getByText(`Sesion activa de ${displayName}`)).toBeVisible();
  await expect(page.getByText(userName)).toBeVisible();
  await expect(page.getByRole("link", { name: "Configuracion" })).toBeVisible();

  await page.getByRole("link", { name: "Configuracion" }).click();
  await expect(page).toHaveURL(/\/app\/configuration$/);
  await expect(page.getByRole("heading", { name: "Configuracion" })).toBeVisible();
  await page.getByLabel("Nombre legal").fill("CriGestion E2E Actualizada SL");
  await page.getByLabel("NIF").fill("B87654321");
  await page.getByLabel("Email").fill("contabilidad-e2e@example.test");
  await page.getByRole("button", { name: "Guardar configuracion" }).click();
  await expect(page.getByText("Configuracion actualizada.")).toBeVisible();
  await expect(page.locator('input[name="legalName"]')).toHaveValue(
    "CriGestion E2E Actualizada SL"
  );

  await page.goto("/login");
  await expect(page).toHaveURL(/\/app$/);
  await page.goto("/platform/installation");
  await expect(page).toHaveURL(/\/app$/);

  const sessionCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === "crigestion_session"
  );
  expect(sessionCookie).toBeDefined();
  expect(sessionCookie?.httpOnly).toBe(true);

  await page.getByRole("button", { name: "Cerrar sesion" }).click();

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Iniciar sesion" })).toBeVisible();
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);

  const revokedSessionCount = await prisma.session.count({
    where: {
      revokedAt: {
        not: null
      },
      user: {
        normalizedUserName: userName
      }
    }
  });
  const configurationAuditCount = await prisma.auditEvent.count({
    where: {
      eventType: "COMPANY_CONFIGURATION_UPDATED"
    }
  });
  expect(revokedSessionCount).toBe(1);
  expect(configurationAuditCount).toBe(1);
});

test("shows access denied for a user without users or roles permissions", async ({
  page
}) => {
  await createLimitedUser(page);

  await loginLimitedUser(page);

  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Inicio operativo" })).toBeVisible();
  await expect(page.getByText("Sesion activa de Usuario Auditor E2E")).toBeVisible();
  await expect(page.getByRole("link", { name: "Ver auditoria" })).toBeVisible();

  await page.goto("/app/users");
  await expect(page).toHaveURL(/\/app\/users$/);
  await expect(page.getByRole("heading", { name: "Usuarios" })).toBeVisible();
  await expect(page.getByText("No tienes permiso para realizar esta accion.")).toBeVisible();
  await expect(page.getByText("Usuarios internos, estado de acceso")).not.toBeVisible();

  await page.goto("/app/roles");
  await expect(page).toHaveURL(/\/app\/roles$/);
  await expect(page.getByRole("heading", { name: "Roles" })).toBeVisible();
  await expect(page.getByText("No tienes permiso para realizar esta accion.")).toBeVisible();
  await expect(page.getByText("Roles protegidos y personalizados")).not.toBeVisible();

  await page.goto("/app/customers");
  await expect(page).toHaveURL(/\/app\/customers$/);
  await expect(page.getByRole("heading", { name: "Clientes" })).toBeVisible();
  await expect(page.getByText("No tienes permiso para realizar esta accion.")).toBeVisible();
  await expect(page.getByText("Maestro fiscal inicial")).not.toBeVisible();

  await page.goto("/app/audit");
  await expect(page).toHaveURL(/\/app\/audit$/);
  await expect(page.getByRole("heading", { name: "Auditoria" })).toBeVisible();
  await expect(page.getByText("LOGIN_SUCCEEDED").first()).toBeVisible();
  await expect(page.getByText(limitedPassword)).not.toBeVisible();

  const deniedAuditCount = await prisma.auditEvent.count({
    where: {
      eventType: "ACCESS_DENIED"
    }
  });
  expect(deniedAuditCount).toBe(3);
});

test("propagates correlation ids through middleware, protected API errors, and audit", async ({
  page
}) => {
  await createLimitedUser(page);
  await loginLimitedUser(page);

  const response = await page.evaluate(async () => {
    const protectedResponse = await fetch("/api/platform/users");

    return {
      status: protectedResponse.status,
      correlationId: protectedResponse.headers.get("X-Correlation-ID"),
      body: await protectedResponse.json()
    };
  });

  expect(response.status).toBe(403);
  expect(response.correlationId).toEqual(expect.stringMatching(/^[a-zA-Z0-9._:-]{8,100}$/));
  const correlationId = response.correlationId;

  if (!correlationId) {
    throw new Error("Protected API response did not include a correlation id.");
  }

  expect(response.body).toEqual({
    code: "FORBIDDEN",
    message: "No tienes permiso para realizar esta accion.",
    correlationId
  });
  expect(JSON.stringify(response.body)).not.toContain(limitedPassword);

  const auditEvent = await prisma.auditEvent.findFirstOrThrow({
    where: {
      eventType: "ACCESS_DENIED",
      payload: {
        path: ["correlationId"],
        equals: correlationId
      }
    }
  });

  expect(auditEvent.payload).toMatchObject({
    permission: "Platform.ManageUsers",
    correlationId
  });
  expect(JSON.stringify(auditEvent.payload)).not.toContain(limitedPassword);
});

test("requests restore validation and manages maintenance mode from the UI", async ({
  page
}) => {
  await initializeAndLoginAdmin(page, "e2e-restore-maintenance-setup");

  await page.getByRole("link", { name: "Restauraciones" }).click();
  await expect(page).toHaveURL(/\/app\/restores$/);
  await expect(page.getByRole("heading", { name: "Restauraciones" })).toBeVisible();
  await expect(page.getByLabel("Copia verificada")).toBeDisabled();
  await expect(page.getByLabel("Copia verificada")).toHaveValue("");
  await expect(page.getByText("No hay restauraciones para mostrar.")).toBeVisible();
  await expect(page.getByText("Inactivo", { exact: true })).toBeVisible();

  const backup = await createVerifiedBackupForAdmin();

  await page.reload();
  await page.getByLabel("Copia verificada").selectOption(backup.id);
  await page.getByLabel("Motivo").first().fill(restoreReason);
  await page.getByRole("button", { name: "Solicitar validacion" }).click();
  await expect(page.getByText("Restauracion solicitada.")).toBeVisible();
  await expect(page.getByText(restoreReason)).toBeVisible();
  await expect(page.getByText("Solicitada").first()).toBeVisible();

  const restore = await prisma.restoreOperation.findFirstOrThrow({
    where: {
      backupOperationId: backup.id,
      reason: restoreReason
    }
  });
  const restoreAudit = await prisma.auditEvent.findFirstOrThrow({
    where: { eventType: "RESTORE_REQUESTED" }
  });
  expect(restoreAudit.payload).toMatchObject({
    restoreOperationId: restore.id,
    reasonLength: restoreReason.length
  });
  expect(JSON.stringify(restoreAudit.payload)).not.toContain(restoreReason);

  await prisma.restoreOperation.update({
    where: { id: restore.id },
    data: {
      status: "VALIDATED",
      validatedAt: new Date("2026-07-03T10:00:00.000Z")
    }
  });

  await page.reload();
  await expect(page.getByText("Validada").first()).toBeVisible();
  await expect(page.getByText("Lista para mantenimiento")).toBeVisible();
  await page.getByLabel("Restauracion validada").selectOption(restore.id);
  await page.getByLabel("Motivo").nth(1).fill(maintenanceReason);
  await page.getByRole("button", { name: "Activar mantenimiento" }).click();
  await expect(page.getByText("Modo mantenimiento actualizado.")).toBeVisible();
  await expect(page.getByText("Activo", { exact: true })).toBeVisible();
  await expect(page.getByText(restore.id).first()).toBeVisible();

  await page.goto("/app/backups");
  await page.getByRole("button", { name: "Solicitar copia" }).click();
  await expect(page.getByText("La plataforma esta en modo mantenimiento.")).toBeVisible();

  const blockedEvent = await prisma.auditEvent.findFirstOrThrow({
    where: { eventType: "MAINTENANCE_MUTATION_BLOCKED" }
  });
  expect(blockedEvent.payload).toMatchObject({
    method: "POST",
    path: "/api/platform/backups",
    mode: "RESTORE",
    restoreOperationId: restore.id
  });

  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Inicio operativo" })).toBeVisible();
  await page.getByRole("button", { name: "Cerrar sesion" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Usuario").fill(userName);
  await page.getByLabel("Contrasena").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Inicio operativo" })).toBeVisible();

  await page.goto("/app/restores");
  await expect(page.getByText("Activo", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Desactivar mantenimiento" }).click();
  await expect(page.getByText("Modo mantenimiento actualizado.")).toBeVisible();
  await expect(page.getByText("Inactivo", { exact: true })).toBeVisible();

  const maintenanceState = await prisma.platformMaintenanceState.findUniqueOrThrow({
    where: { singletonKey: 1 }
  });
  const enabledAuditCount = await prisma.auditEvent.count({
    where: { eventType: "MAINTENANCE_MODE_ENABLED" }
  });
  const disabledAuditCount = await prisma.auditEvent.count({
    where: { eventType: "MAINTENANCE_MODE_DISABLED" }
  });
  expect(maintenanceState.enabled).toBe(false);
  expect(enabledAuditCount).toBe(1);
  expect(disabledAuditCount).toBe(1);
});

test("creates a customer and primary store from the UI", async ({ page }) => {
  await initializeAndLoginAdmin(page, "e2e-customers-setup");

  await page.getByRole("link", { name: "Clientes" }).click();
  await expect(page).toHaveURL(/\/app\/customers$/);
  await expect(page.getByRole("heading", { name: "Clientes" })).toBeVisible();
  await expect(page.getByText("No hay clientes para mostrar.")).toBeVisible();

  await fillCustomerForm(page);
  await page.getByRole("button", { name: "Crear cliente" }).click();
  await expect(page.getByText("Cliente creado.")).toBeVisible();
  const customer = await prisma.customer.findUniqueOrThrow({
    where: { normalizedTaxId: "B12345674" }
  });
  await expect(page.getByText("Cliente E2E SL").first()).toBeVisible();
  await expect(page.getByText(customer.code).first()).toBeVisible();
  await expect(page.getByText("Limite: 1200.00")).toBeVisible();
  await expect(page.getByText("Observacion interna E2E")).not.toBeVisible();

  await page.getByRole("link", { name: "Tiendas" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/customers/${customer.id}/stores$`));
  await expect(page.getByRole("heading", { name: "Tiendas" })).toBeVisible();
  await expect(page.getByText("No hay tiendas para mostrar.")).toBeVisible();

  await fillStoreForm(page);
  await page.getByRole("button", { name: "Crear tienda" }).click();
  await expect(page.getByText("Tienda creada.")).toBeVisible();
  const store = await prisma.customerStore.findFirstOrThrow({
    where: { customerId: customer.id, name: "Tienda E2E Centro" }
  });
  await expect(page.getByText("Tienda E2E Centro").first()).toBeVisible();
  await expect(page.getByText(store.code).first()).toBeVisible();
  await expect(page.getByText("Principal").first()).toBeVisible();
  await expect(page.getByText("Observacion tienda E2E")).not.toBeVisible();
  const customerAuditCount = await prisma.auditEvent.count({
    where: { eventType: "CUSTOMER_CREATED" }
  });
  const storeAuditCount = await prisma.auditEvent.count({
    where: { eventType: "CUSTOMER_STORE_CREATED" }
  });
  expect(customerAuditCount).toBe(1);
  expect(storeAuditCount).toBe(1);
});

async function createLimitedUser(page: import("@playwright/test").Page): Promise<void> {
  await initializeAndLoginAdmin(page, "e2e-permissions-setup");

  await createAuthenticatedResource(page, "/api/platform/roles", {
      code: "ConsultaAuditoria",
      name: "Consulta auditoria",
      permissionCodes: ["Platform.ViewAudit"]
    });
  await createAuthenticatedResource(page, "/api/platform/users", {
      displayName: "Usuario Auditor E2E",
      userName: limitedUserName,
      password: limitedPassword,
      roleCode: "ConsultaAuditoria"
    });

  await page.context().clearCookies();
}

async function fillCustomerForm(page: import("@playwright/test").Page): Promise<void> {
  await page.getByLabel("Razon social").fill("Cliente E2E SL");
  await page.getByLabel("Nombre comercial").fill("Cliente E2E");
  await page.getByLabel("NIF / VAT").fill("B12345674");
  await page.getByLabel("Email").fill("cliente-e2e@example.test");
  await page.getByLabel("Telefono").fill("+34910000000");
  await page.getByLabel("Direccion fiscal").fill("Calle E2E 1");
  await page.getByLabel("Codigo postal").fill("28001");
  await page.getByLabel("Localidad").fill("Madrid");
  await page.getByLabel("Provincia").fill("Madrid");
  await page.getByLabel("Limite de credito").fill("1200.00");
  await page.getByLabel("Observaciones").fill("Observacion interna E2E");
}

async function fillStoreForm(page: import("@playwright/test").Page): Promise<void> {
  await page.getByLabel("Nombre comercial").fill("Tienda E2E Centro");
  await page.getByLabel("Tienda principal").check();
  await page.getByLabel("Direccion").fill("Calle Tienda E2E 2");
  await page.getByLabel("Codigo postal").fill("28002");
  await page.getByLabel("Localidad").fill("Madrid");
  await page.getByLabel("Provincia").fill("Madrid");
  await page.getByLabel("Email", { exact: true }).fill("tienda-e2e@example.test");
  await page.getByLabel("Telefono", { exact: true }).fill("+34910000001");
  await page.getByLabel("WhatsApp", { exact: true }).fill("+34910000002");
  await page.getByLabel("Contacto", { exact: true }).fill("Contacto E2E");
  await page.getByLabel("Funcion").fill("Gerencia");
  await page.getByLabel("Telefono contacto").fill("+34910000003");
  await page.getByLabel("Movil contacto").fill("+34600000001");
  await page.getByLabel("Email contacto").fill("contacto-e2e@example.test");
  await page.getByLabel("WhatsApp contacto").fill("+34600000002");
  await page.getByLabel("Observaciones").fill("Observacion tienda E2E");
}

async function initializeAndLoginAdmin(
  page: import("@playwright/test").Page,
  idempotencyKey: string
): Promise<void> {
  const command = {
    company: {
      legalName: companyName,
      taxId,
      email
    },
    administrator: {
      displayName,
      userName,
      password
    }
  };

  await page.goto("/platform/installation");
  const initializeResponse = await page.request.post(
    "/api/platform/installation/initialize",
    {
      headers: {
        "Idempotency-Key": idempotencyKey
      },
      data: command
    }
  );
  expect(initializeResponse.status()).toBe(201);

  await page.goto("/login");
  await page.getByLabel("Usuario").fill(userName);
  await page.getByLabel("Contrasena").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/app$/);
}

async function loginLimitedUser(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Usuario").fill(limitedUserName);
  await page.getByLabel("Contrasena").fill(limitedPassword);
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page).toHaveURL(/\/app$/);
}

async function createAuthenticatedResource(
  page: import("@playwright/test").Page,
  path: string,
  data: unknown
): Promise<void> {
  const response = await page.evaluate(
    async ({ requestPath, payload }) => {
      const csrfResponse = await fetch("/api/auth/csrf");
      const csrfBody = (await csrfResponse.json()) as { csrfToken: string };
      const resourceResponse = await fetch(requestPath, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfBody.csrfToken
        },
        body: JSON.stringify(payload)
      });

      return {
        status: resourceResponse.status,
        body: await resourceResponse.json()
      };
    },
    { requestPath: path, payload: data }
  );

  expect(response.status).toBe(201);
}

async function createVerifiedBackupForAdmin() {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { normalizedUserName: userName }
  });

  return prisma.backupOperation.create({
    data: {
      status: "VERIFIED",
      requestedById: admin.id,
      productVersion: "0.1.0",
      storageKey: "e2e-verified.backup",
      sizeBytes: 2048n,
      sha256: "c".repeat(64),
      completedAt: new Date("2026-07-03T09:00:00.000Z")
    }
  });
}

async function resetPlatformTables(): Promise<void> {
  await prisma.$transaction([
    prisma.platformMaintenanceState.deleteMany(),
    prisma.restoreOperation.deleteMany(),
    prisma.backupOperation.deleteMany(),
    prisma.idempotencyRecord.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.installation.deleteMany(),
    prisma.reservedUserName.deleteMany(),
    prisma.session.deleteMany(),
    prisma.rateLimitBucket.deleteMany(),
    prisma.loginAttempt.deleteMany(),
    prisma.customerAddress.deleteMany(),

    prisma.customerStore.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.catalogItem.deleteMany(),

    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
