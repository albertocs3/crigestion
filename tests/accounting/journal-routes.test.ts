import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { GET as csrfGet } from "@/app/api/auth/csrf/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import {
  GET as accountsGet,
  POST as accountsPost
} from "@/app/api/accounting/accounts/route";
import {
  GET as journalEntriesGet,
  POST as journalEntriesPost
} from "@/app/api/accounting/journal-entries/route";
import { GET as journalEntriesExportGet } from "@/app/api/accounting/journal-entries/export/route";
import { POST as fiscalYearClosePost } from "@/app/api/accounting/fiscal-years/[fiscalYearId]/close/route";
import { POST as fiscalYearCloseRequestPost } from "@/app/api/accounting/fiscal-years/[fiscalYearId]/close-requests/route";
import { POST as fiscalYearCloseApprovePost } from "@/app/api/accounting/fiscal-year-close-requests/[requestId]/approve/route";
import { POST as fiscalYearReopenRequestPost } from "@/app/api/accounting/fiscal-year-close-requests/[requestId]/reopen-requests/route";
import { POST as fiscalYearReopenApprovePost } from "@/app/api/accounting/fiscal-year-reopen-requests/[requestId]/approve/route";
import { POST as fiscalYearReopenCancelPost } from "@/app/api/accounting/fiscal-year-reopen-requests/[requestId]/cancel/route";
import { POST as fiscalYearReopenRejectPost } from "@/app/api/accounting/fiscal-year-reopen-requests/[requestId]/reject/route";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/modules/platform/application/passwords";
import {
  hashRequestBody,
  initializePlatform,
  type InitializeCommand
} from "@/modules/platform/application/installation";

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
const limitedPassword = "Cambiar-auditor-2026";
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

describe("accounting journal HTTP contracts", () => {
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

  it("creates accounts and manual journal entries through accounting contracts", async () => {
    cookieMock.reset();
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const bankResponse = await accountsPost(
      jsonRequest(
        "/api/accounting/accounts",
        {
          code: "572000001",
          name: "Banco operativo",
          type: "Activo corriente",
          level: 9,
          isPostable: true
        },
        { csrfToken }
      )
    );
    const revenueResponse = await accountsPost(
      jsonRequest(
        "/api/accounting/accounts",
        {
          code: "700000001",
          name: "Ventas servicios",
          type: "Ingresos",
          level: 9,
          isPostable: true
        },
        { csrfToken }
      )
    );
    const bank = await bankResponse.json();
    const revenue = await revenueResponse.json();
    const entryResponse = await journalEntriesPost(
      jsonRequest(
        "/api/accounting/journal-entries",
        {
          accountingDate: "2026-07-10",
          concept: "Ingreso manual",
          lines: [
            {
              accountId: bank.id,
              concept: "Banco",
              debit: "121.00",
              credit: "0.00"
            },
            {
              accountId: revenue.id,
              concept: "Ingreso",
              debit: "0.00",
              credit: "121.00"
            }
          ]
        },
        { csrfToken }
      )
    );
    const entry = await entryResponse.json();
    const listResponse = await journalEntriesGet(
      apiRequest("/api/accounting/journal-entries?year=2026")
    );
    const list = await listResponse.json();

    expect(bankResponse.status).toBe(201);
    expect(revenueResponse.status).toBe(201);
    expect(entryResponse.status).toBe(201);
    expect(entry).toMatchObject({
      number: "2026/000001",
      totalDebit: "121.00",
      totalCredit: "121.00",
      lines: [
        {
          debit: "121.00",
          account: { code: "572000001" }
        },
        {
          credit: "121.00",
          account: { code: "700000001" }
        }
      ]
    });
    expect(listResponse.status).toBe(200);
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]?.number).toBe("2026/000001");
  });

  it("exports posted journal entries as CSV", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const bankResponse = await accountsPost(
      jsonRequest(
        "/api/accounting/accounts",
        {
          code: "572000001",
          name: "Banco operativo",
          type: "Activo corriente",
          level: 9,
          isPostable: true
        },
        { csrfToken }
      )
    );
    const revenueResponse = await accountsPost(
      jsonRequest(
        "/api/accounting/accounts",
        {
          code: "700000001",
          name: "Ventas servicios",
          type: "Ingresos",
          level: 9,
          isPostable: true
        },
        { csrfToken }
      )
    );
    const bank = await bankResponse.json();
    const revenue = await revenueResponse.json();
    await journalEntriesPost(
      jsonRequest(
        "/api/accounting/journal-entries",
        {
          accountingDate: "2026-07-10",
          concept: "Ingreso exportable",
          lines: [
            {
              accountId: bank.id,
              concept: "Banco",
              debit: "121.00",
              credit: "0.00"
            },
            {
              accountId: revenue.id,
              concept: "Ingreso",
              debit: "0.00",
              credit: "121.00"
            }
          ]
        },
        { csrfToken }
      )
    );

    const exportResponse = await journalEntriesExportGet(
      apiRequest("/api/accounting/journal-entries/export?year=2026")
    );
    const csv = await exportResponse.text();
    const exportAuditCount = await prisma.auditEvent.count({
      where: { eventType: "ACCOUNTING_JOURNAL_EXPORTED" }
    });

    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("Content-Type")).toContain("text/csv");
    expect(exportResponse.headers.get("Content-Disposition")).toContain(
      "diario-contable-2026.csv"
    );
    expect(csv).toContain("numero;ejercicio;fecha_contable");
    expect(csv).toContain("2026/000001;2026;2026-07-10;POSTED");
    expect(csv).toContain("572000001;Banco operativo;Banco;121.00;0.00");
    expect(csv).toContain("700000001;Ventas servicios;Ingreso;0.00;121.00");
    expect(exportAuditCount).toBe(1);
  });

  it("protects accounting mutations with CSRF, idempotency and permissions", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const missingIdempotencyResponse = await accountsPost(
      jsonRequest(
        "/api/accounting/accounts",
        {
          code: "572000001",
          name: "Banco operativo",
          type: "Activo corriente",
          level: 9,
          isPostable: true
        },
        { csrfToken, idempotencyKey: null }
      )
    );

    cookieMock.reset();
    await createAccountingViewer();
    await loginWith("contabilidad-lectura", limitedPassword);
    const limitedCsrfToken = await getCsrfToken();
    const forbiddenResponse = await accountsPost(
      jsonRequest(
        "/api/accounting/accounts",
        {
          code: "572000001",
          name: "Banco operativo",
          type: "Activo corriente",
          level: 9,
          isPostable: true
        },
        { csrfToken: limitedCsrfToken }
      )
    );

    cookieMock.reset();
    const unauthenticatedResponse = await accountsGet(
      apiRequest("/api/accounting/accounts")
    );

    expect(missingIdempotencyResponse.status).toBe(400);
    expect(await missingIdempotencyResponse.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
    expect(forbiddenResponse.status).toBe(403);
    expect(await forbiddenResponse.json()).toMatchObject({
      code: "FORBIDDEN"
    });
    expect(unauthenticatedResponse.status).toBe(401);
    expect(await unauthenticatedResponse.json()).toMatchObject({
      code: "UNAUTHENTICATED"
    });
  });

  it("blocks direct close and executes a maker-checker close idempotently", async () => {
    await loginAsAdmin();
    const csrfToken = await getCsrfToken();
    const fiscalYear = await prisma.accountingFiscalYear.findFirstOrThrow({
      where: { year: 2026 }
    });
    const routeContext = (fiscalYearId: string) => ({
      params: Promise.resolve({ fiscalYearId })
    });

    const invalidIdResponse = await fiscalYearClosePost(
      jsonRequest(
        "/api/accounting/fiscal-years/not-a-uuid/close",
        {},
        { csrfToken }
      ),
      routeContext("not-a-uuid")
    );
    const directResponse = await fiscalYearClosePost(
      jsonRequest(
        `/api/accounting/fiscal-years/${fiscalYear.id}/close`,
        {},
        { csrfToken }
      ),
      routeContext(fiscalYear.id)
    );
    const missingIdempotencyResponse = await fiscalYearCloseRequestPost(
      jsonRequest(`/api/accounting/fiscal-years/${fiscalYear.id}/close-requests`, {}, { csrfToken, idempotencyKey: null }),
      routeContext(fiscalYear.id)
    );
    const requestResponse = await fiscalYearCloseRequestPost(
      jsonRequest(`/api/accounting/fiscal-years/${fiscalYear.id}/close-requests`, {}, { csrfToken }),
      routeContext(fiscalYear.id)
    );
    const closeRequest = await requestResponse.json() as { id: string };
    const selfApproval = await fiscalYearCloseApprovePost(
      jsonRequest(`/api/accounting/fiscal-year-close-requests/${closeRequest.id}/approve`, {}, { csrfToken }),
      { params: Promise.resolve({ requestId: closeRequest.id }) }
    );

    await createAccountingCloseApprover();
    cookieMock.reset();
    await loginWith("cierre-aprobador", limitedPassword);
    const approverCsrf = await getCsrfToken();
    const idempotencyKey = randomUUID();
    const approvalRequest = () => jsonRequest(
      `/api/accounting/fiscal-year-close-requests/${closeRequest.id}/approve`,
      {},
      { csrfToken: approverCsrf, idempotencyKey }
    );
    const firstResponse = await fiscalYearCloseApprovePost(
      approvalRequest(),
      { params: Promise.resolve({ requestId: closeRequest.id }) }
    );
    const replayResponse = await fiscalYearCloseApprovePost(
      approvalRequest(),
      { params: Promise.resolve({ requestId: closeRequest.id }) }
    );

    expect(invalidIdResponse.status).toBe(422);
    expect(await invalidIdResponse.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(directResponse.status).toBe(409);
    expect(await directResponse.json()).toMatchObject({ code: "FISCAL_YEAR_CLOSE_APPROVAL_REQUIRED" });
    expect(missingIdempotencyResponse.status).toBe(400);
    expect(await missingIdempotencyResponse.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED"
    });
    expect(requestResponse.status).toBe(201);
    expect(selfApproval.status).toBe(409);
    expect(await selfApproval.json()).toMatchObject({ code: "FISCAL_YEAR_CLOSE_SELF_APPROVAL_FORBIDDEN" });
    expect(firstResponse.status).toBe(200);
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toEqual(await firstResponse.json());
    expect(await prisma.accountingFiscalYear.count({ where: { year: 2027 } })).toBe(1);
    expect(await prisma.auditEvent.count({
      where: { eventType: "ACCOUNTING_FISCAL_YEAR_CLOSED" }
    })).toBe(1);

    await createAccountingReopenRequester();
    cookieMock.reset();
    await loginWith("reapertura-solicitante", limitedPassword);
    const reopenCsrf = await getCsrfToken();
    const reopenResponse = await fiscalYearReopenRequestPost(
      jsonRequest(`/api/accounting/fiscal-year-close-requests/${closeRequest.id}/reopen-requests`, {
        reasonCode: "PREMATURE_CLOSE",
        reason: "Cierre prematuro detectado durante la validacion UAT."
      }, { csrfToken: reopenCsrf }),
      { params: Promise.resolve({ requestId: closeRequest.id }) }
    );
    const firstReopenRequest = await reopenResponse.json() as { id: string };
    const cancelReopenResponse = await fiscalYearReopenCancelPost(
      jsonRequest(`/api/accounting/fiscal-year-reopen-requests/${firstReopenRequest.id}/cancel`, {}, { csrfToken: reopenCsrf }),
      { params: Promise.resolve({ requestId: firstReopenRequest.id }) }
    );
    const replacementReopenResponse = await fiscalYearReopenRequestPost(
      jsonRequest(`/api/accounting/fiscal-year-close-requests/${closeRequest.id}/reopen-requests`, {
        reasonCode: "PREMATURE_CLOSE",
        reason: "Cierre prematuro detectado durante la segunda validacion UAT."
      }, { csrfToken: reopenCsrf }),
      { params: Promise.resolve({ requestId: closeRequest.id }) }
    );
    const reopenRequest = await replacementReopenResponse.json() as { id: string };
    const reopenSelfApproval = await fiscalYearReopenApprovePost(
      jsonRequest(`/api/accounting/fiscal-year-reopen-requests/${reopenRequest.id}/approve`, {}, { csrfToken: reopenCsrf }),
      { params: Promise.resolve({ requestId: reopenRequest.id }) }
    );
    await createAccountingReopenApprover();
    cookieMock.reset();
    await loginWith("reapertura-aprobador", limitedPassword);
    const reopenApproverCsrf = await getCsrfToken();
    const rejectionKey = randomUUID();
    const rejectionRequest = () => jsonRequest(
      `/api/accounting/fiscal-year-reopen-requests/${reopenRequest.id}/reject`,
      { reason: "La justificacion no acredita una reapertura contable segura." },
      { csrfToken: reopenApproverCsrf, idempotencyKey: rejectionKey }
    );
    const reopenRejection = await fiscalYearReopenRejectPost(
      rejectionRequest(),
      { params: Promise.resolve({ requestId: reopenRequest.id }) }
    );
    const reopenRejectionReplay = await fiscalYearReopenRejectPost(
      rejectionRequest(),
      { params: Promise.resolve({ requestId: reopenRequest.id }) }
    );
    const reopenRejectionBody = await reopenRejection.json();
    const reopenRejectionReplayBody = await reopenRejectionReplay.json();

    const rejectedRecord = await prisma.accountingFiscalYearReopenRequest.findUniqueOrThrow({
      where: { id: reopenRequest.id },
      select: {
        companyId: true,
        closeRequestId: true,
        fiscalYearId: true,
        successorFiscalYearId: true,
        preflightSnapshot: true,
        requestedById: true
      }
    });
    const requestedAt = new Date();
    const approvedReopenRequest = await prisma.accountingFiscalYearReopenRequest.create({
      data: {
        ...rejectedRecord,
        preflightSnapshot: rejectedRecord.preflightSnapshot as Prisma.InputJsonValue,
        reasonCode: "ACCOUNTING_CORRECTION",
        reason: "Correccion contable respaldada tras el rechazo inicial de UAT.",
        requestedAt,
        expiresAt: new Date(requestedAt.getTime() + 7 * 24 * 60 * 60 * 1000)
      },
      select: { id: true }
    });

    const finalApproverCsrf = reopenApproverCsrf;
    const reopenApprovalKey = randomUUID();
    const reopenApprovalRequest = () => jsonRequest(
      `/api/accounting/fiscal-year-reopen-requests/${approvedReopenRequest.id}/approve`,
      {},
      { csrfToken: finalApproverCsrf, idempotencyKey: reopenApprovalKey }
    );
    const reopenApproval = await fiscalYearReopenApprovePost(
      reopenApprovalRequest(),
      { params: Promise.resolve({ requestId: approvedReopenRequest.id }) }
    );
    const reopenReplay = await fiscalYearReopenApprovePost(
      reopenApprovalRequest(),
      { params: Promise.resolve({ requestId: approvedReopenRequest.id }) }
    );
    expect(reopenResponse.status).toBe(201);
    expect(cancelReopenResponse.status).toBe(200);
    expect(await cancelReopenResponse.json()).toMatchObject({ status: "CANCELLED" });
    expect(replacementReopenResponse.status).toBe(201);
    expect(reopenSelfApproval.status).toBe(409);
    expect(await reopenSelfApproval.json()).toMatchObject({ code: "FISCAL_YEAR_REOPEN_SELF_APPROVAL_FORBIDDEN" });
    expect(reopenRejection.status).toBe(200);
    expect(reopenRejectionBody).toMatchObject({ status: "REJECTED" });
    expect(reopenRejectionReplayBody).toEqual(reopenRejectionBody);
    expect(reopenApproval.status).toBe(200);
    expect(await reopenReplay.json()).toEqual(await reopenApproval.json());
    expect(await prisma.accountingFiscalYear.findMany({
      where: { year: { in: [2026, 2027] } }, orderBy: { year: "asc" }, select: { status: true }
    })).toEqual([{ status: "OPEN" }, { status: "REVERSED" }]);
  });
});

async function loginAsAdmin(): Promise<void> {
  await loginWith("admin", adminPassword);
}

async function loginWith(userName: string, password: string): Promise<void> {
  const response = await loginPost(
    jsonRequest("/api/auth/login", {
      userName,
      password
    })
  );

  expect(response.status).toBe(200);
}

async function getCsrfToken(): Promise<string> {
  const response = await csrfGet(apiRequest("/api/auth/csrf"));
  const body = (await response.json()) as { csrfToken: string };

  return body.csrfToken;
}

async function createAccountingViewer(): Promise<void> {
  const role = await prisma.role.create({
    data: {
      code: "ConsultaContabilidad",
      name: "Consulta contabilidad",
      isProtected: false,
      permissions: {
        create: {
          permission: {
            connect: {
              code: "Accounting.View"
            }
          }
        }
      }
    }
  });

  await prisma.user.create({
    data: {
      displayName: "Usuario Contabilidad Lectura",
      userName: "contabilidad-lectura",
      normalizedUserName: "contabilidad-lectura",
      passwordHash: await hashPassword(limitedPassword),
      roleId: role.id
    }
  });
}

async function createAccountingCloseApprover(): Promise<void> {
  const role = await prisma.role.create({
    data: {
      code: "AprobadorCierreContable",
      name: "Aprobador cierre contable",
      isProtected: false,
      permissions: {
        create: {
          permission: { connect: { code: "Accounting.ApproveExerciseClosures" } }
        }
      }
    }
  });
  await prisma.user.create({
    data: {
      displayName: "Aprobador cierre",
      userName: "cierre-aprobador",
      normalizedUserName: "cierre-aprobador",
      passwordHash: await hashPassword(limitedPassword),
      roleId: role.id
    }
  });
}

async function createAccountingReopenApprover(): Promise<void> {
  const role = await prisma.role.create({
    data: {
      code: "AprobadorReaperturaContable",
      name: "Aprobador reapertura contable",
      isProtected: false,
      permissions: {
        create: {
          permission: { connect: { code: "Accounting.ApproveExerciseReopenings" } }
        }
      }
    }
  });
  await prisma.user.create({
    data: {
      displayName: "Aprobador reapertura",
      userName: "reapertura-aprobador",
      normalizedUserName: "reapertura-aprobador",
      passwordHash: await hashPassword(limitedPassword),
      roleId: role.id
    }
  });
}

async function createAccountingReopenRequester(): Promise<void> {
  const role = await prisma.role.create({
    data: {
      code: "SolicitanteReaperturaContable",
      name: "Solicitante reapertura contable",
      isProtected: false,
      permissions: {
        create: [
          { permission: { connect: { code: "Accounting.RequestExerciseReopenings" } } },
          { permission: { connect: { code: "Accounting.ApproveExerciseReopenings" } } }
        ]
      }
    }
  });
  await prisma.user.create({
    data: {
      displayName: "Solicitante reapertura",
      userName: "reapertura-solicitante",
      normalizedUserName: "reapertura-solicitante",
      passwordHash: await hashPassword(limitedPassword),
      roleId: role.id
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

  const installation = await prisma.installation.findFirstOrThrow();
  await prisma.accountingFiscalYear.create({
    data: {
      companyId: installation.companyId!, year: 2026,
      startDate: new Date("2026-01-01T00:00:00.000Z"), endDate: new Date("2026-12-31T00:00:00.000Z"),
      planCode: "PGC_PYMES", planVersion: "2021.1", createdById: installation.initialAdministratorId!
    }
  });
}

async function resetPlatformTables(): Promise<void> {
  await prisma.$transaction([
    prisma.accountingFiscalYearReopenRequest.deleteMany(),
    prisma.accountingFiscalYearCloseRequest.deleteMany(),
    prisma.accountingJournalLine.deleteMany(),
    prisma.accountingJournalEntry.deleteMany(),
    prisma.accountingAccount.deleteMany(),
    prisma.accountingFiscalYear.deleteMany(),
    prisma.platformMaintenanceState.deleteMany(),
    prisma.idempotencyRecord.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.installation.deleteMany(),
    prisma.reservedUserName.deleteMany(),
    prisma.session.deleteMany(),
    prisma.rateLimitBucket.deleteMany(),
    prisma.loginAttempt.deleteMany(),
    prisma.customerRemittanceLine.deleteMany(),

    prisma.customerRemittance.deleteMany(),

    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.company.deleteMany()
  ]);
}
