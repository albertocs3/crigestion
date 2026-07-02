import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const permissions = [
    ["Platform.ManageUsers", "Gestionar usuarios"],
    ["Platform.ManageRoles", "Gestionar roles"],
    ["Platform.ManageSessions", "Gestionar sesiones"],
    ["Platform.ManageConfiguration", "Gestionar configuracion"],
    ["Platform.ViewAudit", "Consultar auditoria"],
    ["Platform.ManageBackups", "Gestionar copias de seguridad"],
    ["Platform.ManageMaintenance", "Gestionar modo mantenimiento"]
  ] as const;

  for (const [code, name] of permissions) {
    await prisma.permission.upsert({
      where: { code },
      update: { name },
      create: { code, name }
    });
  }

  await prisma.role.upsert({
    where: { code: "Administrador" },
    update: { name: "Administrador", isProtected: true },
    create: { code: "Administrador", name: "Administrador", isProtected: true }
  });

  const administrator = await prisma.role.findUniqueOrThrow({
    where: { code: "Administrador" }
  });

  const allPermissions = await prisma.permission.findMany();

  for (const permission of allPermissions) {
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: {
          roleId: administrator.id,
          permissionId: permission.id
        }
      },
      update: {},
      create: {
        roleId: administrator.id,
        permissionId: permission.id
      }
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
