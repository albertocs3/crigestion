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
    ["Platform.ManageMaintenance", "Gestionar modo mantenimiento"],
    ["Customers.View", "Consultar clientes"],
    ["Customers.Manage", "Gestionar clientes"],
    ["Suppliers.View", "Consultar proveedores"],
    ["Suppliers.Manage", "Gestionar proveedores"],
    ["Purchases.View", "Consultar compras"],
    ["Purchases.ManageDrafts", "Gestionar borradores de compra"],
    ["Purchases.Register", "Registrar facturas de compra"],
    ["Purchases.Rectify", "Registrar facturas rectificativas de compra"],
    ["Catalog.View", "Consultar catalogo"],
    ["Catalog.Manage", "Gestionar catalogo"],
    ["Billing.View", "Consultar facturas"],
    ["Billing.ManageDrafts", "Gestionar borradores de facturacion"],
    ["Billing.Issue", "Emitir facturas"],
    ["Billing.ManageVerifactuCredentials", "Gestionar credenciales VeriFactu"],
    ["Billing.ManageVerifactuInstallations", "Gestionar instalaciones SIF VeriFactu"],
    ["Billing.ViewVerifactuOperations", "Consultar operaciones VeriFactu"],
    ["Billing.ManageVerifactuOperations", "Intervenir operaciones VeriFactu"],
    ["Billing.CreateVerifactuRejectionCorrection", "Subsanar rechazos VeriFactu"],
    ["Billing.RequestVerifactuCancellation", "Solicitar anulaciones de registros VeriFactu"],
    ["Billing.FinalizeVerifactuCancellation", "Finalizar anulaciones tecnicas VeriFactu"],
    ["Treasury.ManagePayments", "Registrar cobros de clientes"],
    ["Treasury.ManageSupplierPayments", "Registrar pagos de proveedores"],
    ["Treasury.ViewSupplierPayments", "Consultar vencimientos y pagos de proveedores"],
    ["Treasury.ViewCustomerCredits", "Consultar creditos de clientes"],
    ["Treasury.ApplyCustomerCredits", "Compensar creditos de clientes"],
    ["Treasury.RequestCustomerRefunds", "Solicitar reembolsos de creditos"],
    ["Treasury.ApproveCustomerRefunds", "Aprobar reembolsos de creditos"],
    ["Treasury.PostCustomerRefunds", "Contabilizar reembolsos de creditos"],
    ["Treasury.ViewBanking", "Consultar movimientos y conciliaciones bancarias"],
    ["Treasury.ReconcileBanking", "Gestionar conciliaciones bancarias"],
    ["Treasury.ImportBankStatements", "Importar extractos bancarios"]
  ] as const;
  const catalogTaxRates = [
    ["IVA_21", "IVA general 21%", "21.00", true],
    ["IVA_10", "IVA reducido 10%", "10.00", false],
    ["IVA_4", "IVA superreducido 4%", "4.00", false],
    ["IVA_0", "IVA 0%", "0.00", false],
    ["EXEMPT", "Exento 0%", "0.00", false]
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

  for (const [code, name, rate, isDefault] of catalogTaxRates) {
    await prisma.catalogTaxRate.upsert({
      where: { code },
      update: {
        name,
        rate,
        status: "ACTIVE",
        isDefault
      },
      create: {
        code,
        name,
        rate,
        status: "ACTIVE",
        isDefault
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
