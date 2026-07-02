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
  expect(revokedSessionCount).toBe(1);
});

test("shows access denied for a user without users or roles permissions", async ({
  page
}) => {
  await createLimitedUser(page);

  await page.goto("/login");
  await page.getByLabel("Usuario").fill(limitedUserName);
  await page.getByLabel("Contrasena").fill(limitedPassword);
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Inicio operativo" })).toBeVisible();
  await expect(page.getByText("Sesion activa de Usuario Auditor E2E")).toBeVisible();

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

  const deniedAuditCount = await prisma.auditEvent.count({
    where: {
      eventType: "ACCESS_DENIED"
    }
  });
  expect(deniedAuditCount).toBe(2);
});

async function createLimitedUser(page: import("@playwright/test").Page): Promise<void> {
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
        "Idempotency-Key": "e2e-permissions-setup"
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

async function resetPlatformTables(): Promise<void> {
  await prisma.$transaction([
    prisma.idempotencyRecord.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.installation.deleteMany(),
    prisma.reservedUserName.deleteMany(),
    prisma.session.deleteMany(),
    prisma.loginAttempt.deleteMany(),
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
