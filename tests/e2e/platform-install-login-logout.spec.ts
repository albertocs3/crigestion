import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";

const companyName = "CriGestion E2E SL";
const taxId = "B12345678";
const email = "admin-e2e@example.test";
const displayName = "Administrador E2E";
const userName = "admin-e2e";
const password = "Cambiar-e2e-2026";

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
  await expect(page.getByText("Estado:")).toBeVisible();
  await expect(page.getByText("INITIALIZED")).toBeVisible();
  await expect(page.getByText(`Empresa: ${companyName}`)).toBeVisible();
  await expect(page.getByText(`Administrador: ${userName}`)).toBeVisible();

  await page.goto("/login");
  await page.getByLabel("Usuario").fill(userName);
  await page.getByLabel("Contrasena").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Inicio operativo" })).toBeVisible();
  await expect(page.getByText(`Sesion activa de ${displayName}`)).toBeVisible();
  await expect(page.getByText(userName)).toBeVisible();

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
