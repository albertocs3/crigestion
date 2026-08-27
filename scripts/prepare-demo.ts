import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma";
import {
  createInitialAccountingFiscalYear,
  listAccountingFiscalYears
} from "../modules/accounting/application/fiscalYears";
import {
  addInvoiceLine,
  createInvoiceDraft,
  issueInvoice
} from "../modules/billing/application/invoices";
import { createCatalogCategory } from "../modules/catalog/application/categories";
import { createCatalogItem } from "../modules/catalog/application/items";
import { createCustomer } from "../modules/customers/application/customers";
import type { SessionUser } from "../modules/platform/application/auth";
import {
  hashRequestBody,
  initializePlatform
} from "../modules/platform/application/installation";

const demoDatabaseName = "crigestion_demo";
const demoUserName = "admin-demo";
const demoCompanyTaxId = "B12345678";
const demoCustomerTaxId = "B12345674";
const demoInvoiceMarker = "CRIGESTION_DEMO_DATASET_V1";
const demoCorrelationId = "demo-dataset-v1";

type FunctionalResult = {
  ok: boolean;
  error?: { code: string; message: string };
};

async function main(): Promise<void> {
  await assertDemoDatabase();

  const installation = await prisma.installation.findFirst({
    select: {
      company: { select: { taxId: true } },
      initialAdministrator: { select: { normalizedUserName: true } }
    }
  });

  if (!installation) {
    const password = process.env.DEMO_ADMIN_PASSWORD;
    if (!password) {
      throw new Error("DEMO_ADMIN_PASSWORD_REQUIRED");
    }

    const command = {
      company: {
        legalName: "CriGestión Demo SL",
        taxId: demoCompanyTaxId,
        email: "administracion@crigestion-demo.example.test"
      },
      administrator: {
        displayName: "Administrador Demo",
        userName: demoUserName,
        password
      }
    };
    const rawBody = JSON.stringify(command);
    const result = await initializePlatform(
      command,
      "crigestion-demo-installation-v1",
      hashRequestBody(rawBody)
    );
    assertFunctionalResult("inicializar la plataforma", result);
  } else if (
    installation.company?.taxId !== demoCompanyTaxId ||
    installation.initialAdministrator?.normalizedUserName !== demoUserName
  ) {
    throw new Error("DEMO_DATABASE_CONTAINS_ANOTHER_INSTALLATION");
  }

  const actor = await readDemoAdministrator();
  const fiscalYears = await listAccountingFiscalYears();
  if (fiscalYears.length === 0) {
    assertFunctionalResult(
      "crear el ejercicio contable",
      await createInitialAccountingFiscalYear(2026, actor, {
        correlationId: demoCorrelationId
      })
    );
  }

  let customer = await prisma.customer.findUnique({
    where: { normalizedTaxId: demoCustomerTaxId },
    select: { id: true }
  });
  if (!customer) {
    const result = await createCustomer(
      {
        type: "COMPANY",
        legalName: "Cliente Demostración SL",
        tradeName: "Cliente Demo",
        taxId: demoCustomerTaxId,
        fiscalTreatment: "DOMESTIC",
        email: "contacto@cliente-demo.example.test",
        phone: "+34910000000",
        fiscalAddressLine: "Calle de la Innovación 10",
        fiscalPostalCode: "28001",
        fiscalCity: "Madrid",
        fiscalProvince: "Madrid",
        fiscalCountry: "ES",
        defaultPaymentMethod: "BANK_TRANSFER",
        paymentTermsType: "IMMEDIATE",
        paymentDays: null,
        paymentFixedDay: null,
        creditLimit: "5000.00",
        notes: "Datos sintéticos para la presentación de CriGestión"
      },
      actor,
      { correlationId: demoCorrelationId }
    );
    assertFunctionalResult("crear el cliente de demostración", result);
    customer = { id: result.value.id };
  }

  let category = await prisma.catalogCategory.findFirst({
    where: { name: "Servicios profesionales" },
    select: { id: true }
  });
  if (!category) {
    const result = await createCatalogCategory(
      {
        name: "Servicios profesionales",
        description: "Servicios recurrentes de consultoría y soporte"
      },
      actor,
      { correlationId: demoCorrelationId }
    );
    assertFunctionalResult("crear la categoría de demostración", result);
    category = { id: result.value.id };
  }

  const taxRate = await prisma.catalogTaxRate.findUniqueOrThrow({
    where: { code: "IVA_21" },
    select: { id: true }
  });
  let item = await prisma.catalogItem.findFirst({
    where: { name: "Servicio mensual de soporte" },
    select: { id: true }
  });
  if (!item) {
    const result = await createCatalogItem(
      {
        categoryId: category.id,
        kind: "SERVICE",
        name: "Servicio mensual de soporte",
        description: "Soporte, mantenimiento y seguimiento mensual",
        unitName: "Mes",
        salePrice: "100.00",
        costPrice: "35.00",
        taxRateId: taxRate.id,
        stockTracked: false,
        stockCurrent: "0.000",
        stockMinimum: "0.000"
      },
      actor,
      { correlationId: demoCorrelationId }
    );
    assertFunctionalResult("crear el servicio de demostración", result);
    item = { id: result.value.id };
  }

  let invoice = await prisma.invoice.findFirst({
    where: { notes: demoInvoiceMarker },
    select: { id: true, status: true, _count: { select: { lines: true } } }
  });
  if (!invoice) {
    const result = await createInvoiceDraft(
      {
        customerId: customer.id,
        issueDate: "2026-08-27",
        operationDate: "2026-08-27",
        notes: demoInvoiceMarker
      },
      actor,
      { correlationId: demoCorrelationId }
    );
    assertFunctionalResult("crear el borrador de factura", result);
    invoice = { id: result.value.id, status: result.value.status, _count: { lines: 0 } };
  }

  if (invoice.status === "DRAFT" && invoice._count.lines === 0) {
    assertFunctionalResult(
      "añadir la línea de factura",
      await addInvoiceLine(
        invoice.id,
        {
          catalogItemId: item.id,
          description: "Servicio mensual de soporte",
          quantity: "1.000",
          unitPrice: "100.00",
          discountPercent: "0.00",
          discountAmount: "0.00",
          taxRateId: taxRate.id
        },
        actor,
        { correlationId: demoCorrelationId }
      )
    );
  }

  if (invoice.status === "DRAFT") {
    const issueCommand = { issueDate: "2026-08-27" };
    assertFunctionalResult(
      "emitir la factura de demostración",
      await issueInvoice(
        invoice.id,
        issueCommand,
        actor,
        {
          correlationId: demoCorrelationId,
          idempotencyKey: "crigestion-demo-invoice-issue-v1",
          requestHash: digest(issueCommand)
        },
        {}
      )
    );
  }

  const summary = await Promise.all([
    prisma.customer.count(),
    prisma.catalogItem.count(),
    prisma.invoice.count(),
    prisma.accountingFiscalYear.count()
  ]);
  console.log(
    `DEMO_READY database=${demoDatabaseName} user=${demoUserName} customers=${summary[0]} items=${summary[1]} invoices=${summary[2]} fiscalYears=${summary[3]}`
  );
}

async function assertDemoDatabase(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (
    !connectionString ||
    process.env.APP_ENV !== "development" ||
    process.env.DEMO_PREPARE_CONFIRM !== demoDatabaseName ||
    process.env.VERIFACTU_ENABLED !== "false"
  ) {
    throw new Error("DEMO_ENVIRONMENT_INVALID");
  }
  const url = new URL(connectionString);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (
    !new Set(["postgres:", "postgresql:"]).has(url.protocol) ||
    !localHosts.has(url.hostname) ||
    databaseName !== demoDatabaseName ||
    decodeURIComponent(url.username) !== "crigestion" ||
    (url.searchParams.get("schema") ?? "public") !== "public" ||
    url.hash !== ""
  ) {
    throw new Error("DEMO_DATABASE_URL_INVALID");
  }
  const [identity] = await prisma.$queryRaw<
    Array<{ databaseName: string; databaseUser: string; databaseSchema: string }>
  >`SELECT current_database() AS "databaseName", current_user AS "databaseUser", current_schema() AS "databaseSchema"`;
  if (
    identity?.databaseName !== demoDatabaseName ||
    identity.databaseUser !== "crigestion" ||
    identity.databaseSchema !== "public"
  ) {
    throw new Error("DEMO_DATABASE_IDENTITY_INVALID");
  }
}

async function readDemoAdministrator(): Promise<SessionUser> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { normalizedUserName: demoUserName },
    select: {
      id: true,
      displayName: true,
      userName: true,
      role: {
        select: {
          code: true,
          name: true,
          permissions: {
            select: { permission: { select: { code: true } } }
          }
        }
      }
    }
  });
  return {
    id: user.id,
    displayName: user.displayName,
    userName: user.userName,
    role: { code: user.role.code, name: user.role.name },
    permissions: user.role.permissions.map(({ permission }) => permission.code)
  };
}

function assertFunctionalResult<T extends FunctionalResult>(
  action: string,
  result: T
): asserts result is T & { ok: true; value: { id: string; status?: string } } {
  if (!result.ok) {
    throw new Error(`${action}: ${result.error?.code ?? "UNKNOWN_ERROR"}`);
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "DEMO_PREPARATION_FAILED");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
