import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import {
  GET as remittancesGet,
  POST as remittancesPost
} from "@/app/api/treasury/customer-remittances/route";
import { POST as remittanceCancelPost } from "@/app/api/treasury/customer-remittances/[remittanceId]/cancel/route";
import { POST as remittanceClosePost } from "@/app/api/treasury/customer-remittances/[remittanceId]/close/route";
import { POST as remittanceGenerateSepaPost } from "@/app/api/treasury/customer-remittances/[remittanceId]/generate-sepa/route";
import { GET as remittanceBankResponseTemplateGet } from "@/app/api/treasury/customer-remittances/[remittanceId]/bank-response-csv-template/route";
import { POST as remittanceImportBankResponseCsvPost } from "@/app/api/treasury/customer-remittances/[remittanceId]/import-bank-response-csv/route";
import { POST as remittanceMarkSentPost } from "@/app/api/treasury/customer-remittances/[remittanceId]/mark-sent/route";
import { POST as remittanceProcessPost } from "@/app/api/treasury/customer-remittances/[remittanceId]/process/route";
import { POST as remittanceRejectPost } from "@/app/api/treasury/customer-remittances/[remittanceId]/reject/route";
import { POST as remittanceSettleBankResponsePost } from "@/app/api/treasury/customer-remittances/[remittanceId]/settle-bank-response/route";
import { GET as remittanceSepaFileGet } from "@/app/api/treasury/customer-remittances/[remittanceId]/sepa-file/route";
import { GET as remittancesExportGet } from "@/app/api/treasury/customer-remittances/export/route";
import { GET as bankAccountsGet, POST as bankAccountsPost } from "@/app/api/treasury/bank-accounts/route";
import { GET as bankMovementsGet, POST as bankMovementsPost } from "@/app/api/treasury/bank-movements/route";
import { POST as norma43PreviewPost } from "@/app/api/treasury/bank-statements/preview/route";
import { POST as norma43ImportPost } from "@/app/api/treasury/bank-statements/route";
import { POST as bankReconciliationsPost } from "@/app/api/treasury/bank-reconciliations/route";
import { POST as bankReconciliationUndoPost } from "@/app/api/treasury/bank-reconciliations/[reconciliationId]/undo/route";
import { GET as reconciliationCandidatesGet } from "@/app/api/treasury/reconciliation-candidates/route";
import { GET as reconciliationProposalsGet } from "@/app/api/treasury/reconciliation-proposals/route";
import { prisma } from "@/lib/prisma";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";
import { createTestAccountingFiscalYear } from "@/tests/helpers/accountingFiscalYear";

type CookieSetOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  path?: string;
  expires?: Date;
};

const cookieMock = vi.hoisted(() => {
  const values = new Map<string, string>();

  return {
    values,
    store: {
      get(name: string) {
        const value = values.get(name);
        return value ? { name, value } : undefined;
      },
      set(name: string, value: string, options: CookieSetOptions) {
        void options;
        values.set(name, value);
      },
      delete(name: string) {
        values.delete(name);
      }
    },
    reset() {
      values.clear();
    }
  };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieMock.store)
}));

const appBaseUrl = "http://localhost:3000";
const adminPassword = "Cambiar-esta-clave-2026";
const baseCommand: InitializeCommand = {
  company: {
    legalName: "CriGestion Test SL",
    taxId: "B12345678",
    email: "admin@example.test"
  },
  administrator: {
    displayName: "Administrador",
    userName: "admin",
    password: adminPassword
  }
};

describe("customer remittance HTTP contracts", () => {
  beforeEach(async () => {
    process.env.APP_BASE_URL = appBaseUrl;
    process.env.AUTH_COOKIE_SECURE = "false";
    cookieMock.reset();
    await resetPlatformTables();
    await initializeForRoutes();
  });

  afterAll(async () => {
    await resetPlatformTables();
    await prisma.$disconnect();
  });

  it("creates and lists draft remittances through treasury contracts", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const dueDate = await createIssuedDirectDebitDueDate();

    const createResponse = await remittancesPost(
      jsonRequest(
        "/api/treasury/customer-remittances",
        {
          chargeDate: "2026-07-15",
          concept: "Remesa julio",
          dueDateIds: [dueDate.id]
        },
        { csrfToken }
      )
    );
    const created = await createResponse.json();
    const listResponse = await remittancesGet(
      apiRequest("/api/treasury/customer-remittances?year=2026")
    );
    const list = await listResponse.json();

    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({
      number: "RC2026/000001",
      status: "DRAFT",
      totalAmount: "121.00"
    });
    expect(listResponse.status).toBe(200);
    expect(list.remittances).toHaveLength(1);
    expect(list.remittances[0]?.number).toBe("RC2026/000001");
  });

  it("protects remittance mutations with CSRF and idempotency", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const dueDate = await createIssuedDirectDebitDueDate();
    const missingIdempotencyResponse = await remittancesPost(
      jsonRequest(
        "/api/treasury/customer-remittances",
        {
          chargeDate: "2026-07-15",
          concept: "Remesa julio",
          dueDateIds: [dueDate.id]
        },
        { csrfToken, idempotencyKey: null }
      )
    );

    cookieMock.reset();
    const unauthenticatedResponse = await remittancesGet(
      apiRequest("/api/treasury/customer-remittances")
    );

    expect(missingIdempotencyResponse.status).toBe(400);
    expect(await missingIdempotencyResponse.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
    expect(unauthenticatedResponse.status).toBe(401);
    expect(await unauthenticatedResponse.json()).toMatchObject({
      code: "UNAUTHENTICATED"
    });
  });

  it("creates and lists masked bank accounts and movements through protected contracts", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const accountResponse = await bankAccountsPost(jsonRequest("/api/treasury/bank-accounts", { name: "Cuenta operativa", iban: "ES9121000418450200051332", currency: "EUR" }, { csrfToken }));
    const account = await accountResponse.json();
    const movementResponse = await bankMovementsPost(jsonRequest("/api/treasury/bank-movements", { bankAccountId: account.id, bookingDate: "2026-07-17", amount: "121.00", currency: "EUR", reference: "Factura F2600001" }, { csrfToken }));
    const movement = await movementResponse.json();
    const accountsResponse = await bankAccountsGet(apiRequest("/api/treasury/bank-accounts"));
    const accounts = await accountsResponse.json();
    const movementsResponse = await bankMovementsGet(apiRequest("/api/treasury/bank-movements?status=PENDING"));
    const movements = await movementsResponse.json();
    const proposalsResponse = await reconciliationProposalsGet(apiRequest(`/api/treasury/reconciliation-proposals?movementId=${movement.id}&limit=10`));
    const proposals = await proposalsResponse.json();
    expect(accountResponse.status).toBe(201);
    expect(account).toMatchObject({ name: "Cuenta operativa", maskedIban: "ES91 **** **** 1332" });
    expect(JSON.stringify(account)).not.toContain("ES9121000418450200051332");
    expect(movementResponse.status).toBe(201);
    expect(accounts.bankAccounts).toHaveLength(1);
    expect(movements.bankMovements[0]).toMatchObject({ amount: "121.00", pendingAmount: "121.00", status: "PENDING" });
    expect(proposalsResponse.status).toBe(200);
    expect(proposals).toMatchObject({ movement: { id: movement.id }, proposals: [] });
    expect(await prisma.auditEvent.count({ where: { eventType: "BANK_RECONCILIATION_PROPOSALS_VIEWED" } })).toBe(1);
  });

  it("protects banking reads and mutations", async () => {
    const unauthenticated = await bankAccountsGet(apiRequest("/api/treasury/bank-accounts"));
    const unauthenticatedProposals = await reconciliationProposalsGet(apiRequest(`/api/treasury/reconciliation-proposals?movementId=${randomUUID()}`));
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const missingIdempotency = await bankAccountsPost(jsonRequest("/api/treasury/bank-accounts", { name: "Cuenta", iban: "ES9121000418450200051332", currency: "EUR" }, { csrfToken, idempotencyKey: null }));
    const missingCsrf = await bankAccountsPost(jsonRequest("/api/treasury/bank-accounts", { name: "Cuenta", iban: "ES9121000418450200051332", currency: "EUR" }, { csrfToken: null }));
    const invalidIban = await bankAccountsPost(jsonRequest("/api/treasury/bank-accounts", { name: "Cuenta", iban: "ES0012345678901234567890", currency: "EUR" }, { csrfToken }));
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticatedProposals.status).toBe(401);
    expect(missingIdempotency.status).toBe(400);
    expect(await missingIdempotency.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    expect(missingCsrf.status).toBe(403);
    expect(invalidIban.status).toBe(422);
  });

  it("previews and imports Norma 43 through protected contracts", async () => {
    await loginAsAdmin(); const csrfToken = await getCsrfToken();
    const accountResponse = await bankAccountsPost(jsonRequest("/api/treasury/bank-accounts", { name: "Norma 43", iban: "ES9121000418450200051332", currency: "EUR" }, { csrfToken }));
    const account = await accountResponse.json();
    const body = { bankAccountId: account.id, contentBase64: Buffer.from(validNorma43RouteFixture(), "latin1").toString("base64") };
    const previewResponse = await norma43PreviewPost(jsonRequest("/api/treasury/bank-statements/preview", body, { csrfToken }));
    const preview = await previewResponse.json();
    const importResponse = await norma43ImportPost(jsonRequest("/api/treasury/bank-statements", body, { csrfToken, idempotencyKey: "n43-import-key" }));
    const imported = await importResponse.json();
    const replayResponse = await norma43ImportPost(jsonRequest("/api/treasury/bank-statements", body, { csrfToken, idempotencyKey: "n43-import-key" }));
    const duplicateResponse = await norma43ImportPost(jsonRequest("/api/treasury/bank-statements", body, { csrfToken, idempotencyKey: "different-n43-key" }));
    expect(previewResponse.status).toBe(200);
    expect(preview).toMatchObject({ maskedIban: "ES91 **** **** 1332", duplicate: false, overlap: false });
    expect(JSON.stringify(preview)).not.toContain("ES9121000418450200051332");
    expect(importResponse.status).toBe(201);
    expect(imported).toMatchObject({ movementCount: 1 });
    expect(replayResponse.status).toBe(201);
    expect(await replayResponse.json()).toEqual(imported);
    expect(duplicateResponse.status).toBe(409);
    expect(await duplicateResponse.json()).toMatchObject({ code: "BANK_STATEMENT_DUPLICATE" });
    expect(await prisma.bankStatement.count()).toBe(1);
  });

  it("reconciles and undoes a customer payment through protected contracts", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const dueDate = await createIssuedDirectDebitDueDate();
    const remittanceResponse = await remittancesPost(jsonRequest("/api/treasury/customer-remittances", {
      chargeDate: "2026-07-15",
      concept: "Cobro para conciliar",
      dueDateIds: [dueDate.id]
    }, { csrfToken }));
    const remittance = await remittanceResponse.json();
    const processResponse = await remittanceProcessPost(
      jsonRequest(`/api/treasury/customer-remittances/${remittance.id}/process`, { paymentDate: "2026-07-16" }, { csrfToken }),
      { params: Promise.resolve({ remittanceId: remittance.id }) }
    );
    expect(processResponse.status).toBe(200);
    const payment = await prisma.customerPayment.findFirstOrThrow({ where: { dueDateId: dueDate.id } });

    const accountResponse = await bankAccountsPost(jsonRequest("/api/treasury/bank-accounts", {
      name: "Cuenta conciliacion",
      iban: "ES9121000418450200051332",
      currency: "EUR"
    }, { csrfToken }));
    const account = await accountResponse.json();
    const movementResponse = await bankMovementsPost(jsonRequest("/api/treasury/bank-movements", {
      bankAccountId: account.id,
      bookingDate: "2026-07-17",
      amount: "121.00",
      currency: "EUR",
      reference: "Cobro de cliente"
    }, { csrfToken }));
    const movement = await movementResponse.json();

    const candidatesResponse = await reconciliationCandidatesGet(apiRequest(`/api/treasury/reconciliation-candidates?movementId=${movement.id}`));
    const candidates = await candidatesResponse.json();
    expect(candidatesResponse.status).toBe(200);
    expect(candidates.candidates[0]).toMatchObject({ paymentId: payment.id, availableAmount: "121.00" });

    const reconciliationResponse = await bankReconciliationsPost(jsonRequest("/api/treasury/bank-reconciliations", {
      bankMovementId: movement.id,
      applications: [{ customerPaymentId: payment.id, amount: "121.00" }]
    }, { csrfToken }));
    const reconciled = await reconciliationResponse.json();
    expect(reconciliationResponse.status).toBe(201);
    expect(reconciled).toMatchObject({ status: "RECONCILED", pendingAmount: "0.00", reconciledAmount: "121.00" });

    const reconciliationId = reconciled.activeReconciliations[0].id;
    const undoResponse = await bankReconciliationUndoPost(
      jsonRequest(`/api/treasury/bank-reconciliations/${reconciliationId}/undo`, {}, { csrfToken }),
      { params: Promise.resolve({ reconciliationId }) }
    );
    expect(undoResponse.status).toBe(200);
    expect(await undoResponse.json()).toMatchObject({ status: "PENDING", pendingAmount: "121.00", reconciledAmount: "0.00" });
    expect(await prisma.auditEvent.count({ where: { eventType: { in: ["BANK_RECONCILIATION_CREATED", "BANK_RECONCILIATION_UNDONE"] } } })).toBe(2);
  });

  it("cancels draft remittances through the action contract", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const dueDate = await createIssuedDirectDebitDueDate();
    const createResponse = await remittancesPost(
      jsonRequest(
        "/api/treasury/customer-remittances",
        {
          chargeDate: "2026-07-15",
          concept: "Remesa julio",
          dueDateIds: [dueDate.id]
        },
        { csrfToken }
      )
    );
    const created = await createResponse.json();
    const cancelResponse = await remittanceCancelPost(
      actionRequest(`/api/treasury/customer-remittances/${created.id}/cancel`, {
        csrfToken
      }),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const cancelled = await cancelResponse.json();
    const missingIdempotencyResponse = await remittanceCancelPost(
      actionRequest(`/api/treasury/customer-remittances/${created.id}/cancel`, {
        csrfToken,
        idempotencyKey: null
      }),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const auditCount = await prisma.auditEvent.count({
      where: { eventType: "CUSTOMER_REMITTANCE_DRAFT_CANCELLED" }
    });

    expect(cancelResponse.status).toBe(200);
    expect(cancelled).toMatchObject({
      id: created.id,
      status: "CANCELLED"
    });
    expect(missingIdempotencyResponse.status).toBe(400);
    expect(await missingIdempotencyResponse.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
    expect(auditCount).toBe(1);
  });

  it("processes draft remittances through the action contract", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const dueDate = await createIssuedDirectDebitDueDate();
    const createResponse = await remittancesPost(
      jsonRequest(
        "/api/treasury/customer-remittances",
        {
          chargeDate: "2026-07-15",
          concept: "Remesa julio",
          dueDateIds: [dueDate.id]
        },
        { csrfToken }
      )
    );
    const created = await createResponse.json();
    const processIdempotencyKey = randomUUID();
    const processResponse = await remittanceProcessPost(
      jsonRequest(
        `/api/treasury/customer-remittances/${created.id}/process`,
        { paymentDate: "2026-07-16" },
        { csrfToken, idempotencyKey: processIdempotencyKey }
      ),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const processed = await processResponse.json();
    const replayResponse = await remittanceProcessPost(
      jsonRequest(
        `/api/treasury/customer-remittances/${created.id}/process`,
        { paymentDate: "2026-07-16" },
        { csrfToken, idempotencyKey: processIdempotencyKey }
      ),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const replayed = await replayResponse.json();
    const reusedResponse = await remittanceProcessPost(
      jsonRequest(
        `/api/treasury/customer-remittances/${created.id}/process`,
        { paymentDate: "2026-07-17" },
        { csrfToken, idempotencyKey: processIdempotencyKey }
      ),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const payment = await prisma.customerPayment.findFirstOrThrow({
      where: {
        dueDateId: dueDate.id,
        source: "SEPA_REMITTANCE"
      }
    });
    const missingIdempotencyResponse = await remittanceProcessPost(
      jsonRequest(
        `/api/treasury/customer-remittances/${created.id}/process`,
        { paymentDate: "2026-07-16" },
        { csrfToken, idempotencyKey: null }
      ),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const auditCount = await prisma.auditEvent.count({
      where: { eventType: "CUSTOMER_REMITTANCE_PROCESSED" }
    });

    expect(processResponse.status).toBe(200);
    expect(processed).toMatchObject({
      id: created.id,
      status: "PROCESSED"
    });
    expect(replayResponse.status).toBe(200);
    expect(replayed).toEqual(processed);
    expect(reusedResponse.status).toBe(409);
    expect(await reusedResponse.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(payment.amount.toFixed(2)).toBe("121.00");
    expect(await prisma.customerPayment.count({ where: { dueDateId: dueDate.id } })).toBe(1);
    expect(await prisma.accountingJournalEntry.count({
      where: { customerPaymentId: payment.id }
    })).toBe(1);
    expect(missingIdempotencyResponse.status).toBe(400);
    expect(await missingIdempotencyResponse.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
    expect(auditCount).toBe(1);
  });

  it("closes processed remittances through the action contract", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const dueDate = await createIssuedDirectDebitDueDate();
    const createResponse = await remittancesPost(
      jsonRequest(
        "/api/treasury/customer-remittances",
        {
          chargeDate: "2026-07-15",
          concept: "Remesa julio",
          dueDateIds: [dueDate.id]
        },
        { csrfToken }
      )
    );
    const created = await createResponse.json();
    await remittanceProcessPost(
      jsonRequest(
        `/api/treasury/customer-remittances/${created.id}/process`,
        { paymentDate: "2026-07-16" },
        { csrfToken }
      ),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const closeResponse = await remittanceClosePost(
      actionRequest(`/api/treasury/customer-remittances/${created.id}/close`, {
        csrfToken
      }),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const closed = await closeResponse.json();
    const missingIdempotencyResponse = await remittanceClosePost(
      actionRequest(`/api/treasury/customer-remittances/${created.id}/close`, {
        csrfToken,
        idempotencyKey: null
      }),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const auditCount = await prisma.auditEvent.count({
      where: { eventType: "CUSTOMER_REMITTANCE_CLOSED" }
    });

    expect(closeResponse.status).toBe(200);
    expect(closed).toMatchObject({
      id: created.id,
      status: "CLOSED"
    });
    expect(missingIdempotencyResponse.status).toBe(400);
    expect(await missingIdempotencyResponse.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
    expect(auditCount).toBe(1);
  });

  it("exports remittances as audited spreadsheet-safe CSV", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const dueDate = await createIssuedDirectDebitDueDate({
      customerCode: "=C-CSV",
      legalName: "+Cliente CSV SL",
      mandateReference: "MANDATO-CSV-001"
    });
    const createResponse = await remittancesPost(
      jsonRequest(
        "/api/treasury/customer-remittances",
        {
          chargeDate: "2026-07-15",
          concept: "Remesa julio",
          dueDateIds: [dueDate.id]
        },
        { csrfToken }
      )
    );
    const exportResponse = await remittancesExportGet(
      apiRequest("/api/treasury/customer-remittances/export?year=2026")
    );
    const csv = await exportResponse.text();
    const auditCount = await prisma.auditEvent.count({
      where: { eventType: "CUSTOMER_REMITTANCES_EXPORTED" }
    });

    expect(createResponse.status).toBe(201);
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("Content-Type")).toContain("text/csv");
    expect(exportResponse.headers.get("Content-Disposition")).toContain(
      "remesas-clientes-"
    );
    expect(exportResponse.headers.get("Cache-Control")).toBe("private, no-store");
    expect(csv).toContain('"remesa","ejercicio","secuencia"');
    expect(csv).toContain('"cobrado_linea","devuelto_linea","neto_linea"');
    expect(csv).toContain("RC2026/000001");
    expect(csv).toContain("F2600001");
    expect(csv).toContain("121.00");
    expect(csv).toContain("\"'=C-CSV\"");
    expect(csv).toContain("\"'+Cliente CSV SL\"");
    expect(csv).not.toContain("ES9121000418450200051332");
    expect(auditCount).toBe(1);
  });

  it("generates and downloads SEPA XML through treasury contracts", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    await configureCompanySepa();
    const dueDate = await createIssuedDirectDebitDueDate();
    const createResponse = await remittancesPost(
      jsonRequest(
        "/api/treasury/customer-remittances",
        {
          chargeDate: "2026-07-15",
          concept: "Remesa julio",
          dueDateIds: [dueDate.id]
        },
        { csrfToken }
      )
    );
    const created = await createResponse.json();
    const generateResponse = await remittanceGenerateSepaPost(
      actionRequest(`/api/treasury/customer-remittances/${created.id}/generate-sepa`, {
        csrfToken
      }),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const generated = await generateResponse.json();
    const missingIdempotencyResponse = await remittanceGenerateSepaPost(
      actionRequest(`/api/treasury/customer-remittances/${created.id}/generate-sepa`, {
        csrfToken,
        idempotencyKey: null
      }),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const downloadResponse = await remittanceSepaFileGet(
      apiRequest(`/api/treasury/customer-remittances/${created.id}/sepa-file`),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const xml = await downloadResponse.text();

    expect(generateResponse.status).toBe(200);
    expect(generated).toMatchObject({
      id: created.id,
      status: "GENERATED",
      sepaFormat: "pain.008.001.02",
      sepaFileName: "RC2026-000001.xml"
    });
    expect(missingIdempotencyResponse.status).toBe(400);
    expect(await missingIdempotencyResponse.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("Content-Type")).toContain("application/xml");
    expect(downloadResponse.headers.get("Content-Disposition")).toContain(
      "RC2026-000001.xml"
    );
    expect(downloadResponse.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(downloadResponse.headers.get("X-Remittance-SEPA-SHA256")).toMatch(
      /^[a-f0-9]{64}$/
    );
    expect(xml).toContain("<PmtMtd>DD</PmtMtd>");
    expect(xml).toContain("ES7921000813610123456789");
  });

  it("marks generated SEPA remittances as sent through treasury contracts", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    await configureCompanySepa();
    const dueDate = await createIssuedDirectDebitDueDate();
    const createResponse = await remittancesPost(
      jsonRequest(
        "/api/treasury/customer-remittances",
        {
          chargeDate: "2026-07-15",
          concept: "Remesa julio",
          dueDateIds: [dueDate.id]
        },
        { csrfToken }
      )
    );
    const created = await createResponse.json();
    const notSendableResponse = await remittanceMarkSentPost(
      actionRequest(`/api/treasury/customer-remittances/${created.id}/mark-sent`, {
        csrfToken
      }),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    await remittanceGenerateSepaPost(
      actionRequest(`/api/treasury/customer-remittances/${created.id}/generate-sepa`, {
        csrfToken
      }),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const sentResponse = await remittanceMarkSentPost(
      actionRequest(`/api/treasury/customer-remittances/${created.id}/mark-sent`, {
        csrfToken
      }),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const sent = await sentResponse.json();
    const missingIdempotencyResponse = await remittanceMarkSentPost(
      actionRequest(`/api/treasury/customer-remittances/${created.id}/mark-sent`, {
        csrfToken,
        idempotencyKey: null
      }),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );

    expect(notSendableResponse.status).toBe(409);
    expect(await notSendableResponse.json()).toMatchObject({
      code: "REMITTANCE_NOT_SENDABLE"
    });
    expect(sentResponse.status).toBe(200);
    expect(sent).toMatchObject({
      id: created.id,
      status: "SENT"
    });
    expect(sent.sentAt).not.toBeNull();
    expect(missingIdempotencyResponse.status).toBe(400);
    expect(await missingIdempotencyResponse.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
  });

  it("rejects sent remittances through treasury contracts", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    await configureCompanySepa();
    const dueDate = await createIssuedDirectDebitDueDate();
    const createResponse = await remittancesPost(
      jsonRequest(
        "/api/treasury/customer-remittances",
        {
          chargeDate: "2026-07-15",
          concept: "Remesa julio",
          dueDateIds: [dueDate.id]
        },
        { csrfToken }
      )
    );
    const created = await createResponse.json();
    const notRejectableResponse = await remittanceRejectPost(
      jsonRequest(
        `/api/treasury/customer-remittances/${created.id}/reject`,
        { reason: "Banco rechaza el fichero" },
        { csrfToken }
      ),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    await remittanceGenerateSepaPost(
      actionRequest(`/api/treasury/customer-remittances/${created.id}/generate-sepa`, {
        csrfToken
      }),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    await remittanceMarkSentPost(
      actionRequest(`/api/treasury/customer-remittances/${created.id}/mark-sent`, {
        csrfToken
      }),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const rejectedResponse = await remittanceRejectPost(
      jsonRequest(
        `/api/treasury/customer-remittances/${created.id}/reject`,
        { reason: "Banco rechaza el fichero por fecha de cargo" },
        { csrfToken }
      ),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const rejected = await rejectedResponse.json();
    const missingIdempotencyResponse = await remittanceRejectPost(
      jsonRequest(
        `/api/treasury/customer-remittances/${created.id}/reject`,
        { reason: "Banco rechaza el fichero" },
        { csrfToken, idempotencyKey: null }
      ),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const malformedResponse = await remittanceRejectPost(
      jsonRequest(
        `/api/treasury/customer-remittances/${created.id}/reject`,
        { reason: "" },
        { csrfToken }
      ),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const retryResponse = await remittancesPost(
      jsonRequest(
        "/api/treasury/customer-remittances",
        {
          chargeDate: "2026-07-18",
          concept: "Reintento remesa julio",
          dueDateIds: [dueDate.id]
        },
        { csrfToken }
      )
    );
    const retry = await retryResponse.json();

    expect(notRejectableResponse.status).toBe(409);
    expect(await notRejectableResponse.json()).toMatchObject({
      code: "REMITTANCE_NOT_REJECTABLE"
    });
    expect(rejectedResponse.status).toBe(200);
    expect(rejected).toMatchObject({
      id: created.id,
      status: "REJECTED",
      rejectionReason: "Banco rechaza el fichero por fecha de cargo"
    });
    expect(rejected.rejectedAt).not.toBeNull();
    expect(missingIdempotencyResponse.status).toBe(400);
    expect(await missingIdempotencyResponse.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
    expect(malformedResponse.status).toBe(422);
    expect(await malformedResponse.json()).toMatchObject({
      code: "VALIDATION_ERROR"
    });
    expect(retryResponse.status).toBe(201);
    expect(retry).toMatchObject({
      number: "RC2026/000002",
      status: "DRAFT"
    });
  });

  it("settles mixed bank responses through treasury contracts", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    await configureCompanySepa();
    const paidDueDate = await createIssuedDirectDebitDueDate();
    const rejectedDueDate = await createIssuedDirectDebitDueDate({
      customerCode: "600002",
      legalName: "Cliente Remesa Route 2 SL",
      mandateReference: "MANDATO-ROUTE-002",
      invoiceNumber: "F2600002",
      dueDatePosition: 2
    });
    const createResponse = await remittancesPost(
      jsonRequest(
        "/api/treasury/customer-remittances",
        {
          chargeDate: "2026-07-15",
          concept: "Remesa julio",
          dueDateIds: [paidDueDate.id, rejectedDueDate.id]
        },
        { csrfToken }
      )
    );
    const created = await createResponse.json();
    await remittanceGenerateSepaPost(
      actionRequest(`/api/treasury/customer-remittances/${created.id}/generate-sepa`, {
        csrfToken
      }),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    await remittanceMarkSentPost(
      actionRequest(`/api/treasury/customer-remittances/${created.id}/mark-sent`, {
        csrfToken
      }),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const paidLine = created.lines.find(
      (line: { dueDateId: string }) => line.dueDateId === paidDueDate.id
    );
    const rejectedLine = created.lines.find(
      (line: { dueDateId: string }) => line.dueDateId === rejectedDueDate.id
    );

    if (!paidLine || !rejectedLine) {
      throw new Error("Expected remittance lines.");
    }

    const settleResponse = await remittanceSettleBankResponsePost(
      jsonRequest(
        `/api/treasury/customer-remittances/${created.id}/settle-bank-response`,
        {
          paymentDate: "2026-07-16",
          paidLineIds: [paidLine.id],
          rejectedLineIds: [rejectedLine.id],
          rejectionReason: "Banco rechaza una linea"
        },
        { csrfToken }
      ),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const settled = await settleResponse.json();
    const missingIdempotencyResponse = await remittanceSettleBankResponsePost(
      jsonRequest(
        `/api/treasury/customer-remittances/${created.id}/settle-bank-response`,
        {
          paymentDate: "2026-07-16",
          paidLineIds: [paidLine.id],
          rejectedLineIds: [rejectedLine.id],
          rejectionReason: "Banco rechaza una linea"
        },
        { csrfToken, idempotencyKey: null }
      ),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const retryResponse = await remittancesPost(
      jsonRequest(
        "/api/treasury/customer-remittances",
        {
          chargeDate: "2026-07-18",
          concept: "Reintento linea rechazada",
          dueDateIds: [rejectedDueDate.id]
        },
        { csrfToken }
      )
    );
    const retry = await retryResponse.json();

    expect(settleResponse.status).toBe(200);
    expect(settled).toMatchObject({
      id: created.id,
      status: "PARTIALLY_PROCESSED",
      paymentAmount: "121.00"
    });
    expect(settled.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: paidLine.id, status: "ACTIVE" }),
        expect.objectContaining({ id: rejectedLine.id, status: "CANCELLED" })
      ])
    );
    expect(missingIdempotencyResponse.status).toBe(400);
    expect(await missingIdempotencyResponse.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
    expect(retryResponse.status).toBe(201);
    expect(retry).toMatchObject({
      number: "RC2026/000002",
      status: "DRAFT"
    });
  });

  it("imports controlled CSV bank responses through treasury contracts", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    await configureCompanySepa();
    const paidDueDate = await createIssuedDirectDebitDueDate();
    const rejectedDueDate = await createIssuedDirectDebitDueDate({
      customerCode: "600002",
      legalName: "Cliente Remesa CSV 2 SL",
      mandateReference: "MANDATO-CSV-002",
      invoiceNumber: "F2600002",
      dueDatePosition: 2
    });
    const createResponse = await remittancesPost(
      jsonRequest(
        "/api/treasury/customer-remittances",
        {
          chargeDate: "2026-07-15",
          concept: "Remesa julio",
          dueDateIds: [paidDueDate.id, rejectedDueDate.id]
        },
        { csrfToken }
      )
    );
    const created = await createResponse.json();
    await remittanceGenerateSepaPost(
      actionRequest(`/api/treasury/customer-remittances/${created.id}/generate-sepa`, {
        csrfToken
      }),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    await remittanceMarkSentPost(
      actionRequest(`/api/treasury/customer-remittances/${created.id}/mark-sent`, {
        csrfToken
      }),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );

    const templateResponse = await remittanceBankResponseTemplateGet(
      apiRequest(
        `/api/treasury/customer-remittances/${created.id}/bank-response-csv-template`
      ),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const template = await templateResponse.text();
    const completedTemplate = template
      .replace("\uFEFF", "")
      .split(/\r?\n/)
      .map((row, index) => {
        if (index === 1) {
          return row.replace(/,"",""$/, ',"COBRADA",""');
        }

        if (index === 2) {
          return row.replace(
            /,"",""$/,
            ',"RECHAZADA","Banco rechaza una linea"'
          );
        }

        return row;
      })
      .join("\r\n");

    const importIdempotencyKey = randomUUID();
    const importResponse = await remittanceImportBankResponseCsvPost(
      jsonRequest(
        `/api/treasury/customer-remittances/${created.id}/import-bank-response-csv`,
        {
          paymentDate: "2026-07-16",
          csv: completedTemplate
        },
        { csrfToken, idempotencyKey: importIdempotencyKey }
      ),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const imported = await importResponse.json();
    const importReplayResponse = await remittanceImportBankResponseCsvPost(
      jsonRequest(
        `/api/treasury/customer-remittances/${created.id}/import-bank-response-csv`,
        { paymentDate: "2026-07-16", csv: completedTemplate },
        { csrfToken, idempotencyKey: importIdempotencyKey }
      ),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );
    const importReplayed = await importReplayResponse.json();
    const templateAuditCount = await prisma.auditEvent.count({
      where: { eventType: "CUSTOMER_REMITTANCE_BANK_RESPONSE_TEMPLATE_EXPORTED" }
    });
    const missingIdempotencyResponse = await remittanceImportBankResponseCsvPost(
      jsonRequest(
        `/api/treasury/customer-remittances/${created.id}/import-bank-response-csv`,
        {
          paymentDate: "2026-07-16",
          csv: "linea,resultado,motivo\n1,COBRADA,\n2,RECHAZADA,Banco rechaza una linea"
        },
        { csrfToken, idempotencyKey: null }
      ),
      { params: Promise.resolve({ remittanceId: created.id }) }
    );

    expect(templateResponse.status).toBe(200);
    expect(templateResponse.headers.get("Content-Type")).toBe(
      "text/csv; charset=utf-8"
    );
    expect(templateResponse.headers.get("Content-Disposition")).toContain(
      "respuesta-bancaria-RC2026-000001.csv"
    );
    expect(templateResponse.headers.get("Cache-Control")).toBe("private, no-store");
    expect(template).toContain(
      '"linea","factura","cliente","importe","resultado","motivo"'
    );
    expect(template).toContain('"1","F2600001"');
    expect(template).toContain('"2","F2600002"');
    expect(template).not.toContain("ES9121000418450200051332");
    expect(templateAuditCount).toBe(1);
    expect(importResponse.status).toBe(200);
    expect(importReplayResponse.status).toBe(200);
    expect(importReplayed).toEqual(imported);
    expect(imported).toMatchObject({
      id: created.id,
      status: "PARTIALLY_PROCESSED",
      paymentAmount: "121.00"
    });
    expect(missingIdempotencyResponse.status).toBe(400);
    expect(await missingIdempotencyResponse.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
  });
});

async function loginAsAdmin(): Promise<void> {
  const response = await loginPost(
    jsonRequest("/api/auth/login", {
      userName: "admin",
      password: adminPassword
    })
  );

  expect(response.status).toBe(200);
}

async function getCsrfToken(): Promise<string> {
  const response = await csrfGet(apiRequest("/api/auth/csrf"));
  const body = (await response.json()) as { csrfToken: string };

  return body.csrfToken;
}

async function createIssuedDirectDebitDueDate(
  overrides: {
    customerCode?: string;
    legalName?: string;
    mandateReference?: string;
    invoiceNumber?: string;
    dueDatePosition?: number;
  } = {}
) {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { normalizedUserName: "admin" }
  });
  const invoiceNumber = overrides.invoiceNumber ?? "F2600001";
  const customerCode = overrides.customerCode ?? invoiceNumber.replace(/\D/g, "").slice(-6);
  const legalName = overrides.legalName ?? "Cliente Remesa Route SL";
  const mandateReference = overrides.mandateReference ?? "MANDATO-ROUTE-001";
  const taxId = `B${invoiceNumber.slice(-7)}`;
  const customer = await prisma.customer.create({
    data: {
      code: customerCode,
      type: "COMPANY",
      legalName,
      taxId,
      normalizedTaxId: taxId,
      fiscalTreatment: "DOMESTIC",
      fiscalAddressLine: "Calle Prueba 1",
      fiscalPostalCode: "28001",
      fiscalCity: "Madrid",
      fiscalProvince: "Madrid",
      fiscalCountry: "ES",
      defaultPaymentMethod: "DIRECT_DEBIT",
      paymentTermsType: "IMMEDIATE",
      bankIban: "ES9121000418450200051332",
      createdById: admin.id,
      sepaMandates: {
        create: {
          reference: mandateReference,
          referenceNormalized: mandateReference,
          signedAt: new Date("2026-01-01T00:00:00.000Z"),
          createdById: admin.id
        }
      }
    }
  });
  const fiscalYear = await prisma.accountingFiscalYear.findFirstOrThrow({
    where: { year: 2026 }
  });
  if (/^\d{1,6}$/.test(customer.code)) {
    await prisma.accountingAccount.create({
      data: {
        fiscalYearId: fiscalYear.id,
        code: `430${customer.code.padStart(6, "0")}`,
        name: customer.legalName,
        type: "ASSET",
        level: 9,
        isPostable: true,
        createdById: admin.id
      }
    });
  }
  const invoice = await prisma.invoice.create({
    data: {
      status: "ISSUED",
      paymentStatus: "PENDING",
      verifactuStatus: "PENDING",
      series: "F",
      year: 2026,
      numberSequence: overrides.dueDatePosition ?? 1,
      number: invoiceNumber,
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
          position: overrides.dueDatePosition ?? 1,
          dueDate: new Date("2026-07-15T00:00:00.000Z"),
          amount: "121.00",
          paymentMethod: "DIRECT_DEBIT"
        }
      }
    },
    include: {
      dueDates: true
    }
  });

  return invoice.dueDates[0]!;
}

async function configureCompanySepa(): Promise<void> {
  await prisma.company.update({
    where: { taxId: baseCommand.company.taxId },
    data: {
      bankIban: "ES7921000813610123456789",
      sepaCreditorIdentifier: "ES12B12345678"
    }
  });
}

function apiRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`${appBaseUrl}${path}`, {
    ...init,
    headers: {
      Origin: appBaseUrl,
      ...(init.headers ?? {})
    }
  });
}

function jsonRequest(
  path: string,
  body: unknown,
  options: {
    csrfToken?: string | null;
    idempotencyKey?: string | null;
  } = {}
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: appBaseUrl
  };

  if (options.csrfToken !== null && options.csrfToken) {
    headers["X-CSRF-Token"] = options.csrfToken;
  }

  if (options.idempotencyKey !== null) {
    headers["Idempotency-Key"] = options.idempotencyKey ?? randomUUID();
  }

  return new Request(`${appBaseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

function actionRequest(
  path: string,
  options: {
    csrfToken?: string | null;
    idempotencyKey?: string | null;
  } = {}
): Request {
  const headers: Record<string, string> = {
    Origin: appBaseUrl
  };

  if (options.csrfToken !== null && options.csrfToken) {
    headers["X-CSRF-Token"] = options.csrfToken;
  }

  if (options.idempotencyKey !== null) {
    headers["Idempotency-Key"] = options.idempotencyKey ?? randomUUID();
  }

  return new Request(`${appBaseUrl}${path}`, {
    method: "POST",
    headers
  });
}

async function initializeForRoutes(): Promise<void> {
  const rawBody = JSON.stringify(baseCommand);
  const result = await initializePlatform(
    baseCommand,
    randomUUID(),
    hashRequestBody(rawBody)
  );

  if (!result.ok) {
    throw new Error(result.error.code);
  }
  await createTestAccountingFiscalYear();
  const fiscalYear = await prisma.accountingFiscalYear.findFirstOrThrow({
    where: { year: 2026 }
  });
  const installation = await prisma.installation.findFirstOrThrow();
  await prisma.accountingAccount.createMany({
    data: ["570000000", "572000000"].map((code) => ({
      fiscalYearId: fiscalYear.id,
      code,
      name: code === "570000000" ? "Caja" : "Bancos",
      type: "ASSET",
      level: 9,
      isPostable: true,
      createdById: installation.initialAdministratorId!
    }))
  });
}

async function resetPlatformTables(): Promise<void> {
  await prisma.$transaction([
    prisma.invoiceVerifactuRecord.deleteMany(),
    prisma.customerRemittanceLine.deleteMany(),
    prisma.accountingJournalLine.deleteMany(),
    prisma.accountingJournalEntry.deleteMany(),
    prisma.bankReconciliationApplication.deleteMany(),
    prisma.bankReconciliation.deleteMany(),
    prisma.bankMovement.deleteMany(),
    prisma.bankStatement.deleteMany(),
    prisma.bankAccount.deleteMany(),
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
    prisma.catalogStockMovement.deleteMany(),
    prisma.catalogItem.deleteMany(),
    prisma.catalogCategory.deleteMany(),
    prisma.catalogTaxRate.deleteMany(),
    prisma.accountingAccount.deleteMany(),
    prisma.accountingFiscalYear.deleteMany(),
    prisma.customerRemittance.deleteMany(),
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}

function validNorma43RouteFixture(): string {
  const account = "210004180200051332";
  return [
    `11${account}260701260731H000000001000009781${"CRIGESTION".padEnd(26)}   `,
    `22${" ".repeat(8)}260715260715040012${"12100".padStart(14, "0")}${"1".padStart(10, "0")}${"0".repeat(12)}${"F2600001".padEnd(16)}`,
    `2301${"TRANSFERENCIA CLIENTE".padEnd(38)}${"FACTURA F2600001".padEnd(38)}`,
    `33${account}00000${"0".repeat(14)}00001${"12100".padStart(14, "0")}H${"112100".padStart(14, "0")}978${" ".repeat(4)}`,
    `88${"9".repeat(18)}${"4".padStart(6, "0")}${" ".repeat(54)}`
  ].join("\r\n");
}
