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
const billingViewerUserName = "facturacion-e2e";
const billingViewerPassword = "Cambiar-facturacion-2026";
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

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Iniciar sesion" })).toBeVisible();

  await page.goto("/login");
  await page.getByLabel("Usuario").fill(userName);
  await page.getByLabel("Contrasena").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Inicio" })).toBeAttached();
  await expect(page.getByText(`Sesion activa de ${displayName}`)).toBeVisible();
  await expect(page.getByText(userName)).not.toBeVisible();
  await page.getByText("Utilidades", { exact: true }).click();
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
  await expect(page.getByRole("heading", { name: "Inicio" })).toBeAttached();
  await expect(page.getByText("Sesion activa de Usuario Auditor E2E")).toBeVisible();
  await page.getByText("Utilidades", { exact: true }).click();
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

  await page.getByText("Utilidades", { exact: true }).click();
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
  await expect(page.getByRole("heading", { name: "Inicio" })).toBeAttached();
  await page.getByRole("button", { name: "Cerrar sesion" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Usuario").fill(userName);
  await page.getByLabel("Contrasena").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Inicio" })).toBeAttached();

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

test("creates and issues a manual invoice from the UI", async ({ page }) => {
  test.setTimeout(60000);

  await initializeAndLoginAdmin(page, "e2e-invoice-setup");

  await page.getByRole("link", { name: "Clientes" }).click();
  await fillCustomerForm(page);
  await page.getByRole("button", { name: "Crear cliente" }).click();
  await expect(page.getByText("Cliente creado.")).toBeVisible();

  await page.goto("/app/invoices");
  await expect(page).toHaveURL(/\/app\/invoices$/);
  await expect(page.getByRole("heading", { name: "Facturas" })).toBeVisible();
  await expect(page.getByText("No hay facturas para mostrar.")).toBeVisible();

  await page.getByLabel("Fecha de emision").fill("2026-07-07");
  await page.getByLabel("Fecha de operacion").fill("2026-07-07");
  await page.getByRole("button", { name: "Crear borrador" }).click();

  await expect(page).toHaveURL(/\/app\/invoices\/[a-f0-9-]+$/, {
    timeout: 15000
  });
  await expect(page.getByRole("heading", { name: "Borrador de factura" })).toBeVisible();
  await expect(page.getByText("Todavia no hay lineas.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Emitir factura" })).toBeDisabled();

  await page.getByLabel("Descripcion").fill("Servicio mensual E2E");
  await page.getByLabel("Cantidad").fill("1.000");
  await page.getByLabel("Precio unitario sin IVA").fill("100.00");
  await page.getByRole("button", { name: "Agregar linea" }).click();

  await expect(page.getByText("Linea agregada.")).toBeVisible();
  await expect(page.getByText("Servicio mensual E2E")).toBeVisible();
  await expect(page.getByText("121.00 EUR").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Emitir factura" })).toBeEnabled();

  await page.getByLabel("Fecha definitiva de emision").fill("2026-07-07");
  await page.getByRole("button", { name: "Emitir factura" }).click();

  await expect(page.getByRole("heading", { name: "F2600001" })).toBeVisible();
  await expect(page.getByText("Emitida").first()).toBeVisible();
  await expect(page.getByText("Pendiente").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Descargar PDF" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Registrar cobro" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Agregar linea" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Emitir factura" })).not.toBeVisible();

  await page.getByLabel("Fecha de cobro").fill("2026-07-10");
  await page.getByLabel("Importe cobrado").fill("121.00");
  await page.getByLabel("Referencia").fill("Transferencia E2E");
  await page.getByRole("button", { name: "Registrar cobro" }).click();

  await expect(page.getByText("Cobro registrado.")).toBeVisible();
  await expect(page.getByText("Cobrada").first()).toBeVisible();
  await expect(page.getByText("0.00 EUR").first()).toBeVisible();
  await expect(page.getByText("Cobro 1")).toBeVisible();
  await expect(page.getByText("Transferencia E2E")).toBeVisible();
  await expect(page.getByText("Manual").first()).toBeVisible();

  await page.getByLabel("Fecha de emision").fill("2026-07-08");
  await page.locator('select[name="reason"]').selectOption("AMOUNT_ERROR");
  await page.getByRole("button", { name: "Crear rectificativa" }).click();

  await expect(page.getByRole("heading", { name: "R2600001" })).toBeVisible();
  await expect(page.getByText("Factura rectificativa").first()).toBeVisible();
  await expect(page.getByText("Error en importes")).toBeVisible();
  await expect(page.getByText("-121.00 EUR").first()).toBeVisible();
  await expect(page.getByText("Rectifica a")).toBeVisible();
  await expect(page.getByRole("link", { name: "F2600001" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Crear rectificativa" })).not.toBeVisible();

  await page.getByRole("link", { name: "Facturas" }).click();
  await expect(page).toHaveURL(/\/app\/invoices$/);
  await expect(page.getByText("F2600001").first()).toBeVisible();
  await expect(page.getByText("R2600001").first()).toBeVisible();
  await expect(page.getByText("Factura rectificativa").first()).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "F2600001" })
  ).toContainText("Rectificada");
  await expect(page.getByText("VeriFactu: Pendiente").first()).toBeVisible();
  await expect(page.getByText("Cobro: Pagada").first()).toBeVisible();

  const issuedInvoice = await prisma.invoice.findUniqueOrThrow({
    where: { number: "F2600001" },
    include: {
      verifactuRecord: true,
      lines: true,
      taxSummaries: true,
      dueDates: true,
      payments: true,
      rectificationInvoices: true
    }
  });
  const rectificationInvoice = await prisma.invoice.findUniqueOrThrow({
    where: { number: "R2600001" },
    include: {
      lines: true,
      taxSummaries: true,
      dueDates: true,
      rectifiesInvoice: true
    }
  });
  const issuedAuditCount = await prisma.auditEvent.count({
    where: { eventType: "INVOICE_ISSUED" }
  });
  const paymentAuditCount = await prisma.auditEvent.count({
    where: { eventType: "CUSTOMER_PAYMENT_REGISTERED" }
  });
  const rectificationAuditCount = await prisma.auditEvent.count({
    where: { eventType: "INVOICE_RECTIFICATION_CREATED" }
  });

  expect(issuedInvoice.status).toBe("RECTIFIED");
  expect(issuedInvoice.rectificationInvoices).toHaveLength(1);
  expect(issuedInvoice.paymentStatus).toBe("PAID");
  expect(issuedInvoice.verifactuStatus).toBe("PENDING");
  expect(issuedInvoice.total.toFixed(2)).toBe("121.00");
  expect(issuedInvoice.lines).toHaveLength(1);
  expect(issuedInvoice.taxSummaries).toHaveLength(1);
  expect(issuedInvoice.dueDates[0]?.amount.toFixed(2)).toBe("121.00");
  expect(issuedInvoice.dueDates[0]?.status).toBe("PAID");
  expect(issuedInvoice.payments[0]?.amount.toFixed(2)).toBe("121.00");
  expect(issuedInvoice.verifactuRecord?.status).toBe("PENDING");
  expect(rectificationInvoice.documentType).toBe("RECTIFICATION");
  expect(rectificationInvoice.status).toBe("ISSUED");
  expect(rectificationInvoice.paymentStatus).toBe("PAID");
  expect(rectificationInvoice.rectificationReason).toBe("AMOUNT_ERROR");
  expect(rectificationInvoice.rectifiesInvoice?.id).toBe(issuedInvoice.id);
  expect(rectificationInvoice.total.toFixed(2)).toBe("-121.00");
  expect(rectificationInvoice.lines[0]?.quantity.toFixed(3)).toBe("-1.000");
  expect(rectificationInvoice.taxSummaries[0]?.total.toFixed(2)).toBe("-121.00");
  expect(rectificationInvoice.dueDates[0]?.status).toBe("PAID");
  expect(issuedAuditCount).toBe(1);
  expect(paymentAuditCount).toBe(1);
  expect(rectificationAuditCount).toBe(1);
});

test("shows issued invoices read-only for a billing viewer", async ({ page }) => {
  await initializeAndLoginAdmin(page, "e2e-billing-viewer-setup");
  const invoice = await createIssuedInvoiceForAdmin();

  await createBillingViewerUser(page);
  await loginBillingViewerUser(page);

  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("link", { name: "Facturas" })).toBeVisible();
  await page.getByRole("link", { name: "Facturas" }).click();

  await expect(page).toHaveURL(/\/app\/invoices$/);
  await expect(page.getByRole("heading", { name: "Facturas" })).toBeVisible();
  await expect(page.getByText("F2600001").first()).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "F2600001" })
  ).toContainText("Cliente Facturacion E2E SL");
  await expect(page.getByRole("button", { name: "Crear borrador" })).not.toBeVisible();
  await expect(page.getByText("Nuevo borrador")).not.toBeVisible();

  await page.getByRole("link", { name: "Abrir" }).first().click();

  await expect(page).toHaveURL(new RegExp(`/app/invoices/${invoice.id}$`));
  await expect(page.getByRole("heading", { name: "F2600001" })).toBeVisible();
  await expect(page.getByText("Servicio mensual E2E")).toBeVisible();
  await expect(page.getByText("121.00 EUR").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Descargar PDF" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Registrar cobro" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Agregar linea" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Emitir factura" })).not.toBeVisible();
});

test("marks an issued invoice due date unpaid from the UI", async ({ page }) => {
  await initializeAndLoginAdmin(page, "e2e-unpaid-due-date-setup");
  const invoice = await createIssuedInvoiceForAdmin();

  await page.goto(`/app/invoices/${invoice.id}`);
  await expect(page.getByRole("heading", { name: "F2600001" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Marcar impagado" })).toBeVisible();

  await page.getByLabel("Fecha de cobro").fill("2026-07-10");
  await page.getByLabel("Importe cobrado").fill("40.00");
  await page.getByLabel("Referencia").fill("Cobro parcial E2E");
  await page.getByRole("button", { name: "Registrar cobro" }).click();

  await expect(page.getByText("Cobro registrado.")).toBeVisible();
  await expect(page.getByText("Parcialmente cobrada").first()).toBeVisible();
  await expect(page.getByText("81.00 EUR").first()).toBeVisible();

  const unpaidForm = page.getByRole("group", { name: "Registrar impago" });
  await unpaidForm.getByLabel("Fecha de impago").fill("2026-07-20");
  await unpaidForm.getByLabel("Motivo").fill("BANK_DEFAULT");
  await page.getByRole("button", { name: "Marcar impagado" }).click();

  await expect(page.getByText("Impago registrado.")).toBeVisible();
  await expect(page.getByText("Impagada").first()).toBeVisible();
  await expect(page.getByText("Impagado").first()).toBeVisible();
  await expect(page.getByText("No hay vencimientos pendientes de cobro.")).toBeVisible();

  await page.goto("/app/treasury?scope=UNPAID");
  await expect(page.getByRole("heading", { name: "Tesoreria" })).toBeVisible();
  const dueDateRow = page.getByRole("row").filter({ hasText: "F2600001" });
  await expect(dueDateRow).toContainText("Impagado");
  await expect(dueDateRow).toContainText("81.00 EUR");

  await page.getByRole("link", { name: "Prevision" }).click();
  await expect(page).toHaveURL(/\/app\/treasury\/forecast$/);
  await expect(page.getByRole("heading", { name: "Prevision de cobros" })).toBeVisible();
  await expect(page.getByText("81.00 EUR").first()).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "F2600001" })
  ).toContainText("Atrasado");

  const storedInvoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoice.id },
    include: {
      dueDates: true,
      payments: true
    }
  });
  const unpaidAuditCount = await prisma.auditEvent.count({
    where: { eventType: "CUSTOMER_DUE_DATE_MARKED_UNPAID" }
  });
  const paymentAuditCount = await prisma.auditEvent.count({
    where: { eventType: "CUSTOMER_PAYMENT_REGISTERED" }
  });

  expect(storedInvoice.paymentStatus).toBe("UNPAID");
  expect(storedInvoice.dueDates[0]?.status).toBe("UNPAID");
  expect(storedInvoice.payments[0]?.amount.toFixed(2)).toBe("40.00");
  expect(paymentAuditCount).toBe(1);
  expect(unpaidAuditCount).toBe(1);
});

test("creates accounting accounts and a manual journal entry from the UI", async ({
  page
}) => {
  await initializeAndLoginAdmin(page, "e2e-accounting-ui-setup");

  await expect(page.getByRole("link", { name: "Contabilidad" })).toBeVisible();
  await page.getByRole("link", { name: "Contabilidad" }).click();

  await expect(page).toHaveURL(/\/app\/accounting$/);
  await expect(page.getByRole("heading", { name: "Contabilidad" })).toBeVisible();
  await expect(page.getByText("No hay cuentas para mostrar.")).toBeVisible();
  await expect(page.getByText("No hay asientos para mostrar.")).toBeVisible();

  const accountForm = page.getByRole("group", { name: "Nueva cuenta" });
  await accountForm.getByLabel("Codigo").fill("572000001");
  await accountForm.getByLabel("Nombre").fill("Banco E2E");
  await accountForm.getByLabel("Tipo").fill("Activo corriente");
  await accountForm.getByLabel("Nivel").fill("9");
  await page.getByRole("button", { name: "Crear cuenta" }).click();
  await expect(page.getByText("Cuenta creada.")).toBeVisible();
  await expect(page.getByText("572000001", { exact: true })).toBeVisible();

  await accountForm.getByLabel("Codigo").fill("700000001");
  await accountForm.getByLabel("Nombre").fill("Ventas E2E");
  await accountForm.getByLabel("Tipo").fill("Ingresos");
  await accountForm.getByLabel("Nivel").fill("9");
  await page.getByRole("button", { name: "Crear cuenta" }).click();
  await expect(page.getByText("700000001", { exact: true })).toBeVisible();

  const entryForm = page.getByRole("group", { name: "Nuevo asiento manual" });
  await entryForm.getByLabel("Fecha contable").fill("2026-07-10");
  await entryForm.getByLabel("Concepto").fill("Cobro factura E2E");
  await entryForm.getByLabel("Importe").fill("121.00");
  await entryForm.getByLabel("Cuenta debe").selectOption({ label: "572000001 - Banco E2E" });
  await entryForm.getByLabel("Cuenta haber").selectOption({ label: "700000001 - Ventas E2E" });
  await page.getByRole("button", { name: "Crear asiento" }).click();

  await expect(page.getByText("Asiento creado.")).toBeVisible();
  await expect(page.getByText("2026/000001")).toBeVisible();
  await expect(page.getByText("Cobro factura E2E").first()).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "2026/000001" })
  ).toContainText("121,00");

  const accountCount = await prisma.accountingAccount.count();
  const entry = await prisma.accountingJournalEntry.findFirstOrThrow({
    where: { number: "2026/000001" },
    include: { lines: true }
  });
  const accountAuditCount = await prisma.auditEvent.count({
    where: { eventType: "ACCOUNTING_ACCOUNT_CREATED" }
  });
  const entryAuditCount = await prisma.auditEvent.count({
    where: { eventType: "ACCOUNTING_JOURNAL_ENTRY_CREATED" }
  });

  expect(accountCount).toBe(2);
  expect(entry.totalDebit.toFixed(2)).toBe("121.00");
  expect(entry.totalCredit.toFixed(2)).toBe("121.00");
  expect(entry.lines).toHaveLength(2);
  expect(accountAuditCount).toBe(2);
  expect(entryAuditCount).toBe(1);
});

test("creates a customer remittance draft from the UI", async ({ page }) => {
  await initializeAndLoginAdmin(page, "e2e-remittance-ui-setup");
  await createIssuedDirectDebitInvoiceForAdmin();

  await page.getByRole("link", { name: "Tesoreria" }).click();
  await expect(page).toHaveURL(/\/app\/treasury$/);
  await page.getByRole("link", { name: "Remesas" }).click();

  await expect(page).toHaveURL(/\/app\/treasury\/remittances$/);
  await expect(
    page.getByRole("heading", { name: "Remesas", exact: true })
  ).toBeVisible();
  await expect(page.getByText("F2600003").first()).toBeVisible();
  await expect(page.getByText("Cliente Remesa E2E SL").first()).toBeVisible();

  const remittanceForm = page.getByRole("group", { name: "Nueva remesa" });
  await remittanceForm.getByLabel("Fecha de cargo").fill("2026-07-15");
  await remittanceForm.getByLabel("Concepto").fill("Remesa julio E2E");
  await page.getByRole("button", { name: "Crear remesa" }).click();

  await expect(page.getByText("Remesa creada.")).toBeVisible();
  await expect(page.getByText("RC2026/000001")).toBeVisible();
  await expect(page.getByText("121,00").first()).toBeVisible();
  await page.getByRole("link", { name: "RC2026/000001" }).click();

  await expect(page).toHaveURL(/\/app\/treasury\/remittances\/[a-f0-9-]+$/);
  await expect(page.getByRole("heading", { name: "RC2026/000001" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Lineas de remesa" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "F2600003", exact: true })).toBeVisible();
  await expect(page.getByText("Cliente Remesa E2E SL")).toBeVisible();
  await page.getByLabel("Fecha cobro").fill("2026-07-16");
  await page.getByRole("button", { name: "Procesar" }).click();
  await expect(page.getByText("Procesada").first()).toBeVisible();
  await page.getByLabel("Fecha devolucion").fill("2026-07-20");
  await page.getByLabel("Importe").fill("21.00");
  await page.getByRole("button", { name: "Registrar devolucion" }).click();
  await expect(page.getByText("Devolucion registrada.")).toBeVisible();
  await expect(page.getByText("Parcialmente devuelta").first()).toBeVisible();
  await page.getByRole("button", { name: "Cerrar remesa" }).click();
  await expect(page.getByText("Cerrada").first()).toBeVisible();

  const remittance = await prisma.customerRemittance.findFirstOrThrow({
    where: { number: "RC2026/000001" },
    include: { lines: true }
  });
  const payment = await prisma.customerPayment.findFirstOrThrow({
    where: {
      source: "SEPA_REMITTANCE",
      reference: "RC2026/000001"
    },
    include: {
      returns: true,
      dueDate: {
        include: {
          invoice: true
        }
      }
    }
  });
  const auditCount = await prisma.auditEvent.count({
    where: { eventType: "CUSTOMER_REMITTANCE_DRAFT_CREATED" }
  });
  const processedAuditCount = await prisma.auditEvent.count({
    where: { eventType: "CUSTOMER_REMITTANCE_PROCESSED" }
  });
  const closedAuditCount = await prisma.auditEvent.count({
    where: { eventType: "CUSTOMER_REMITTANCE_CLOSED" }
  });
  const returnedAuditCount = await prisma.auditEvent.count({
    where: { eventType: "CUSTOMER_REMITTANCE_PARTIALLY_RETURNED" }
  });
  const viewedAuditCount = await prisma.auditEvent.count({
    where: { eventType: "CUSTOMER_REMITTANCE_VIEWED" }
  });

  expect(remittance.status).toBe("CLOSED");
  expect(remittance.totalAmount.toFixed(2)).toBe("121.00");
  expect(remittance.lines).toHaveLength(1);
  expect(remittance.lines[0]?.status).toBe("ACTIVE");
  expect(payment.amount.toFixed(2)).toBe("121.00");
  expect(payment.returns[0]?.amount.toFixed(2)).toBe("21.00");
  expect(payment.dueDate.status).toBe("PENDING");
  expect(payment.dueDate.invoice.paymentStatus).toBe("PARTIALLY_PAID");
  expect(auditCount).toBe(1);
  expect(processedAuditCount).toBe(1);
  expect(closedAuditCount).toBe(1);
  expect(returnedAuditCount).toBe(1);
  expect(viewedAuditCount).toBeGreaterThanOrEqual(1);
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

async function createBillingViewerUser(
  page: import("@playwright/test").Page
): Promise<void> {
  await createAuthenticatedResource(page, "/api/platform/roles", {
    code: "ConsultaFacturas",
    name: "Consulta facturas",
    permissionCodes: ["Billing.View"]
  });
  await createAuthenticatedResource(page, "/api/platform/users", {
    displayName: "Usuario Facturacion E2E",
    userName: billingViewerUserName,
    password: billingViewerPassword,
    roleCode: "ConsultaFacturas"
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

async function loginBillingViewerUser(
  page: import("@playwright/test").Page
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Usuario").fill(billingViewerUserName);
  await page.getByLabel("Contrasena").fill(billingViewerPassword);
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
          "Idempotency-Key": crypto.randomUUID(),
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

async function createIssuedInvoiceForAdmin() {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { normalizedUserName: userName }
  });
  const taxRate = await prisma.catalogTaxRate.findFirstOrThrow({
    where: { code: "IVA_21" }
  });
  const customer = await prisma.customer.create({
    data: {
      code: "C-E2E-BILL",
      type: "COMPANY",
      legalName: "Cliente Facturacion E2E SL",
      tradeName: "Cliente Facturacion E2E",
      taxId: "B99887766",
      normalizedTaxId: "B99887766",
      fiscalTreatment: "DOMESTIC",
      email: "cliente-facturacion-e2e@example.test",
      phone: "+34910000004",
      fiscalAddressLine: "Calle Facturacion E2E 1",
      fiscalPostalCode: "28003",
      fiscalCity: "Madrid",
      fiscalProvince: "Madrid",
      fiscalCountry: "ES",
      defaultPaymentMethod: "BANK_TRANSFER",
      paymentTermsType: "IMMEDIATE",
      createdById: admin.id
    }
  });

  return prisma.invoice.create({
    data: {
      status: "ISSUED",
      paymentStatus: "PENDING",
      verifactuStatus: "PENDING",
      series: "F",
      year: 2026,
      numberSequence: 1,
      number: "F2600001",
      customerId: customer.id,
      customerCodeSnapshot: customer.code,
      customerLegalNameSnapshot: customer.legalName,
      customerTaxIdSnapshot: customer.taxId,
      customerFiscalTreatmentSnapshot: customer.fiscalTreatment,
      customerFiscalAddressSnapshot: {
        line: customer.fiscalAddressLine,
        postalCode: customer.fiscalPostalCode,
        city: customer.fiscalCity,
        province: customer.fiscalProvince,
        country: customer.fiscalCountry
      },
      issueDate: new Date("2026-07-07T00:00:00.000Z"),
      operationDate: new Date("2026-07-07T00:00:00.000Z"),
      issuedAt: new Date("2026-07-07T09:00:00.000Z"),
      subtotal: "100.00",
      taxableBase: "100.00",
      taxAmount: "21.00",
      total: "121.00",
      createdById: admin.id,
      issuedById: admin.id,
      lines: {
        create: {
          position: 1,
          description: "Servicio mensual E2E",
          quantity: "1.000",
          unitPrice: "100.00",
          taxRateId: taxRate.id,
          taxRateCodeSnapshot: taxRate.code,
          taxRateNameSnapshot: taxRate.name,
          taxRateSnapshot: taxRate.rate,
          lineSubtotal: "100.00",
          lineDiscountTotal: "0.00",
          lineTaxableBase: "100.00",
          lineTaxAmount: "21.00",
          lineTotal: "121.00"
        }
      },
      taxSummaries: {
        create: {
          taxRateCode: taxRate.code,
          taxRate: taxRate.rate,
          taxableBase: "100.00",
          taxAmount: "21.00",
          total: "121.00"
        }
      },
      dueDates: {
        create: {
          position: 1,
          dueDate: new Date("2026-07-07T00:00:00.000Z"),
          amount: "121.00",
          paymentMethod: "BANK_TRANSFER"
        }
      },
      verifactuRecord: {
        create: {
          status: "PENDING"
        }
      }
    }
  });
}

async function createIssuedDirectDebitInvoiceForAdmin() {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { normalizedUserName: userName }
  });
  const customer = await prisma.customer.create({
    data: {
      code: "C-E2E-REMIT",
      type: "COMPANY",
      legalName: "Cliente Remesa E2E SL",
      tradeName: "Cliente Remesa E2E",
      taxId: "B11223344",
      normalizedTaxId: "B11223344",
      fiscalTreatment: "DOMESTIC",
      email: "cliente-remesa-e2e@example.test",
      phone: "+34910000005",
      fiscalAddressLine: "Calle Remesa E2E 1",
      fiscalPostalCode: "28005",
      fiscalCity: "Madrid",
      fiscalProvince: "Madrid",
      fiscalCountry: "ES",
      defaultPaymentMethod: "DIRECT_DEBIT",
      paymentTermsType: "IMMEDIATE",
      bankIban: "ES9121000418450200051332",
      createdById: admin.id,
      sepaMandates: {
        create: {
          reference: "MANDATO-E2E-001",
          referenceNormalized: "MANDATO-E2E-001",
          signedAt: new Date("2026-01-01T00:00:00.000Z"),
          createdById: admin.id
        }
      }
    }
  });

  return prisma.invoice.create({
    data: {
      status: "ISSUED",
      paymentStatus: "PENDING",
      verifactuStatus: "PENDING",
      series: "F",
      year: 2026,
      numberSequence: 3,
      number: "F2600003",
      customerId: customer.id,
      customerCodeSnapshot: customer.code,
      customerLegalNameSnapshot: customer.legalName,
      customerTaxIdSnapshot: customer.taxId,
      customerFiscalTreatmentSnapshot: customer.fiscalTreatment,
      customerFiscalAddressSnapshot: {
        line: customer.fiscalAddressLine,
        postalCode: customer.fiscalPostalCode,
        city: customer.fiscalCity,
        province: customer.fiscalProvince,
        country: customer.fiscalCountry
      },
      issueDate: new Date("2026-07-10T00:00:00.000Z"),
      operationDate: new Date("2026-07-10T00:00:00.000Z"),
      issuedAt: new Date("2026-07-10T09:00:00.000Z"),
      subtotal: "100.00",
      taxableBase: "100.00",
      taxAmount: "21.00",
      total: "121.00",
      createdById: admin.id,
      issuedById: admin.id,
      dueDates: {
        create: {
          position: 1,
          dueDate: new Date("2026-07-15T00:00:00.000Z"),
          amount: "121.00",
          paymentMethod: "DIRECT_DEBIT"
        }
      },
      verifactuRecord: {
        create: {
          status: "PENDING"
        }
      }
    }
  });
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
    prisma.invoiceVerifactuRecord.deleteMany(),
    prisma.customerRemittanceLine.deleteMany(),

    prisma.customerPaymentReturn.deleteMany(),
    prisma.customerPayment.deleteMany(),
    prisma.invoiceDueDate.deleteMany(),
    prisma.invoiceTaxSummary.deleteMany(),
    prisma.invoiceLine.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.invoiceNumberSequence.deleteMany(),
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
    prisma.customerSepaMandate.deleteMany(),

    prisma.customerStore.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.catalogItem.deleteMany(),

    prisma.accountingJournalLine.deleteMany(),
    prisma.accountingJournalEntry.deleteMany(),
    prisma.accountingAccount.deleteMany(),
    prisma.customerRemittance.deleteMany(),

    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
