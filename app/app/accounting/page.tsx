import Link from "next/link";
import type { ReactNode } from "react";
import { z } from "zod";
import {
  listAccountingAccounts,
  listAccountingAccountsSchema,
  listJournalEntries,
  listJournalEntriesSchema
} from "@/modules/accounting/application/journal";
import { AccountingAccountCreateForm } from "@/modules/accounting/presentation/AccountingAccountCreateForm";
import { listAccountingFiscalYears } from "@/modules/accounting/application/fiscalYears";
import { listFiscalYearCloseRequests } from "@/modules/accounting/application/fiscalYearCloseRequests";
import { listFiscalYearReopenRequests } from "@/modules/accounting/application/fiscalYearReopenRequests";
import { listFiscalYearLifecycleHistory } from "@/modules/accounting/application/fiscalYearLifecycleHistory";
import { AccountingFiscalYearCloseActions, AccountingFiscalYearCreateForm, AccountingFiscalYearReopenActions } from "@/modules/accounting/presentation/AccountingFiscalYearActions";
import { AccountingFiscalYearLifecycleHistory } from "@/modules/accounting/presentation/AccountingFiscalYearLifecycleHistory";
import { ManualJournalEntryCreateForm } from "@/modules/accounting/presentation/ManualJournalEntryCreateForm";
import {
  getWaiverEvidenceReplacementDetail,
  listWaiverEvidenceReplacementProposals,
  listWaiverEvidenceReplacementProposalsSchema,
  prepareWaiverEvidenceReplacement
} from "@/modules/accounting/application/waiverEvidenceReplacements";
import { WaiverEvidenceReplacementRequestForm } from "@/modules/accounting/presentation/WaiverEvidenceReplacementRequestForm";
import { WaiverEvidenceReplacementReview } from "@/modules/accounting/presentation/WaiverEvidenceReplacementReview";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";
const uuidSchema = z.string().uuid();

type AccountingPageProps = {
  searchParams: Promise<{
    accountCursor?: string;
    entryCursor?: string;
    year?: string;
    search?: string;
    entryId?: string;
    waiverReviewId?: string;
    waiverReplacementReviewId?: string;
    waiverReplacementRequestId?: string;
    waiverReplacementCursor?: string;
  }>;
};

export default async function AccountingPage({
  searchParams
}: AccountingPageProps) {
  const params = await searchParams;
  if (params.waiverReplacementReviewId) return replacementRequestPage(params.waiverReplacementReviewId);
  if (params.waiverReplacementRequestId) return replacementReviewPage(params.waiverReplacementRequestId);
  const authorization = await authorizePagePermission("Accounting.View");

  if (!authorization.ok) {
    return (
      <main className="shell">
        <header className="topbar">
          <div className="brand">CriGestión</div>
          <Link className="button button-secondary" href="/app">
            Volver
          </Link>
        </header>
        <section className="content">
          <div className="panel stack">
            <h1>Contabilidad</h1>
            <p className="message error">{authorization.message}</p>
          </div>
        </section>
      </main>
    );
  }

  const accountsPayload = listAccountingAccountsSchema.safeParse({
    limit: 50,
    cursor: params.accountCursor,
    status: "ACTIVE",
    search: params.search,
    year: params.year
  });
  const entriesPayload = listJournalEntriesSchema.safeParse({
    limit: 25,
    cursor: params.entryCursor,
    year: params.year,
    entryId: params.entryId
  });
  const replacementListPayload = listWaiverEvidenceReplacementProposalsSchema.safeParse({
    limit: 10,
    cursor: params.waiverReplacementCursor
  });
  const canApproveWaiverReplacements = authorization.user.permissions.includes("Accounting.ApproveWaiverEvidenceReplacements");
  const [accounts, entries, fiscalYears, replacementList] = await Promise.all([
    accountsPayload.success
      ? listAccountingAccounts(accountsPayload.data, authorization.user)
      : { accounts: [], nextCursor: null },
    entriesPayload.success
      ? listJournalEntries(entriesPayload.data, authorization.user)
      : { entries: [], nextCursor: null },
    listAccountingFiscalYears(),
    canApproveWaiverReplacements && replacementListPayload.success
      ? listWaiverEvidenceReplacementProposals(replacementListPayload.data, authorization.user)
      : null
  ]);
  const closeRequests = await listFiscalYearCloseRequests(fiscalYears.map((fiscalYear) => fiscalYear.id));
  const reopenRequests = await listFiscalYearReopenRequests(closeRequests.map((request) => request.id));
  const lifecycleHistory = await listFiscalYearLifecycleHistory(fiscalYears.map((fiscalYear) => fiscalYear.id));
  const canManageEntries = authorization.user.permissions.includes(
    "Accounting.ManageEntries"
  );
  const canManageExercises = authorization.user.permissions.includes("Accounting.ManageExercises");
  const canRequestClosures = authorization.user.permissions.includes("Accounting.RequestExerciseClosures");
  const canApproveClosures = authorization.user.permissions.includes("Accounting.ApproveExerciseClosures");
  const canRequestReopenings = authorization.user.permissions.includes("Accounting.RequestExerciseReopenings");
  const canApproveReopenings = authorization.user.permissions.includes("Accounting.ApproveExerciseReopenings");
  const selectedFiscalYear = params.year
    ? fiscalYears.find((fiscalYear) => fiscalYear.year === Number(params.year))
    : fiscalYears.find((fiscalYear) => fiscalYear.status === "OPEN");
  const canEditSelectedFiscalYear = canManageEntries && selectedFiscalYear?.status === "OPEN";
  const pendingCloseByFiscalYear = new Map(
    closeRequests.filter((request) => request.status === "REQUESTED").map((request) => [request.fiscalYearId, request])
  );
  const completedCloseByFiscalYear = new Map(
    closeRequests.filter((request) => request.status === "COMPLETED").reverse().map((request) => [request.fiscalYearId, request])
  );
  const pendingReopenByCloseRequest = new Map(
    reopenRequests.filter((request) => request.status === "REQUESTED").map((request) => [request.closeRequestId, request])
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <Link className="button button-secondary" href="/app">
          Inicio
        </Link>
      </header>
      <section className="content stack">
        <div className="panel stack">
          <div>
            <h1>Contabilidad</h1>
            <p className="muted">
              Plan contable y asientos manuales iniciales con trazabilidad.
            </p>
          </div>

          <div className="data-grid">
            <div>
              <span className="data-label">Cuentas activas</span>
              <strong>{accounts.accounts.length}</strong>
            </div>
            <div>
              <span className="data-label">Asientos</span>
              <strong>{entries.entries.length}</strong>
            </div>
            <div>
              <span className="data-label">Permiso</span>
              <strong>{canManageEntries ? "Gestion" : "Consulta"}</strong>
            </div>
          </div>

          <form className="filter-row" action="/app/accounting">
            <label>
              Buscar cuenta
              <input
                name="search"
                maxLength={120}
                defaultValue={params.search ?? ""}
                placeholder="Codigo o nombre"
              />
            </label>
            <label>
              Ejercicio
              <input
                name="year"
                inputMode="numeric"
                defaultValue={params.year ?? ""}
                placeholder="2026"
              />
            </label>
            <div className="form-actions">
              <button className="button" type="submit">
                Filtrar
              </button>
              <Link className="button button-secondary" href="/app/accounting">
                Limpiar
              </Link>
              <Link className="button button-secondary" href={exportHref(params)}>
                Exportar CSV
              </Link>
            </div>
          </form>

          {!accountsPayload.success ? (
            <p className="message error">Filtro de cuentas invalido.</p>
          ) : null}
          {!entriesPayload.success ? (
            <p className="message error">Filtro de asientos invalido.</p>
          ) : null}
        </div>

        {fiscalYears.length === 0 && canManageExercises ? (
          <div className="panel stack">
            <AccountingFiscalYearCreateForm defaultYear={new Date().getFullYear()} />
          </div>
        ) : null}

        {fiscalYears.length > 0 ? (
          <div className="panel stack">
            <div><h2>Ejercicios contables</h2><p className="muted">Cada ejercicio conserva su propio plan de cuentas.</p></div>
            <div className="table-wrap"><table><thead><tr><th>Ejercicio</th><th>Estado</th><th>Plan</th><th>Cuentas</th><th>Acciones</th></tr></thead><tbody>{fiscalYears.map((fiscalYear) => {
              const completedClose = completedCloseByFiscalYear.get(fiscalYear.id);
              return <tr key={fiscalYear.id}><td><strong>{fiscalYear.year}</strong></td><td>{fiscalYearStatusLabel(fiscalYear.status)}</td><td>{fiscalYear.planCode} {fiscalYear.planVersion}</td><td>{fiscalYear.accountCount}</td><td>
                {fiscalYear.status === "OPEN" && (canRequestClosures || canApproveClosures) ? <AccountingFiscalYearCloseActions fiscalYearId={fiscalYear.id} year={fiscalYear.year} request={pendingCloseByFiscalYear.get(fiscalYear.id) ?? null} actorUserId={authorization.user.id} canRequest={canRequestClosures} canApprove={canApproveClosures} /> : null}
                {fiscalYear.status === "CLOSED" && completedClose && (canRequestReopenings || canApproveReopenings) ? <AccountingFiscalYearReopenActions closeRequestId={completedClose.id} year={fiscalYear.year} request={pendingReopenByCloseRequest.get(completedClose.id) ?? null} actorUserId={authorization.user.id} canRequest={canRequestReopenings} canApprove={canApproveReopenings} /> : null}
                {fiscalYear.status === "REVERSED" || (fiscalYear.status === "CLOSED" && !completedClose) ? "-" : null}
              </td></tr>;
            })}</tbody></table></div>
          </div>
        ) : null}

        {fiscalYears.length > 0 ? <AccountingFiscalYearLifecycleHistory items={lifecycleHistory} /> : null}

        {canApproveWaiverReplacements ? (
          <div className="panel stack">
            <div>
              <h2>Propuestas de sustitución pendientes</h2>
              <p className="muted">Bandeja contable maker-checker. El detalle completo se audita al abrirlo.</p>
            </div>
            {!replacementListPayload.success ? <p className="message error">El cursor de propuestas no es válido.</p> : null}
            {replacementList && !replacementList.ok ? <p className="message error">{replacementList.error.message}</p> : null}
            {replacementList?.ok ? <>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Solicitada</th><th>Solicitante</th><th>Ejercicio / fecha</th><th>Motivo</th><th>Estado de revisión</th><th>Acción</th></tr></thead>
                  <tbody>{replacementList.value.proposals.length === 0 ? <tr><td colSpan={6}>No hay propuestas pendientes.</td></tr>
                    : replacementList.value.proposals.map((proposal) => <tr key={proposal.id}>
                      <td>{formatDateTime(proposal.requestedAt)}</td>
                      <td>{proposal.requestedBy.displayName}</td>
                      <td><strong>{proposal.fiscalYear}</strong><span className="cell-detail">Fecha {formatDate(proposal.accountingDate)} · {proposal.lineCount} líneas</span></td>
                      <td>{waiverReplacementReasonLabel(proposal.reasonCode)}</td>
                      <td>{proposal.eligibility.canApprove ? "Preparada" : "Requiere otro aprobador o subsanar bloqueos"}</td>
                      <td><Link className="button button-secondary" href={`/app/accounting?waiverReplacementRequestId=${encodeURIComponent(proposal.id)}`}>Revisar</Link></td>
                    </tr>)}</tbody>
                </table>
              </div>
              {replacementList.value.nextCursor ? <div className="button-row"><Link className="button button-secondary"
                href={replacementNextPageHref(replacementList.value.nextCursor)}>Siguiente página</Link></div> : null}
            </> : null}
          </div>
        ) : null}

        {canEditSelectedFiscalYear ? (
          <div className="panel stack">
            <AccountingAccountCreateForm />
            <ManualJournalEntryCreateForm accounts={accounts.accounts} waiverReviewId={params.waiverReviewId} />
          </div>
        ) : null}
        {canManageEntries && selectedFiscalYear && selectedFiscalYear.status !== "OPEN" ? (
          <div className="panel"><p className="message">El ejercicio {selectedFiscalYear.year} esta {fiscalYearStatusLabel(selectedFiscalYear.status).toLowerCase()} y no admite nuevas cuentas ni asientos.</p></div>
        ) : null}

        <div className="panel stack">
          <div>
            <h2>Plan contable</h2>
            <p className="muted">Cuentas activas disponibles para imputacion.</p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Codigo</th>
                  <th>Nombre</th>
                  <th>Tipo</th>
                  <th>Nivel</th>
                  <th>Uso</th>
                </tr>
              </thead>
              <tbody>
                {accounts.accounts.length === 0 ? (
                  <tr>
                    <td colSpan={5}>No hay cuentas para mostrar.</td>
                  </tr>
                ) : (
                  accounts.accounts.map((account) => (
                    <tr key={account.id}>
                      <td>
                        <strong>{account.code}</strong>
                      </td>
                      <td>{account.name}</td>
                      <td>{account.type}</td>
                      <td>{account.level}</td>
                      <td>{account.isPostable ? "Imputable" : "No imputable"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {accounts.nextCursor ? (
            <div className="button-row">
              <Link
                className="button button-secondary"
                href={accountNextPageHref(accounts.nextCursor, params)}
              >
                Siguiente pagina
              </Link>
            </div>
          ) : null}
        </div>

        <div className="panel stack">
          <div>
            <h2>Diario</h2>
            <p className="muted">Asientos contabilizados y sus lineas.</p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Numero</th>
                  <th>Fecha</th>
                  <th>Concepto</th>
                  <th>Total</th>
                  <th>Lineas</th>
                </tr>
              </thead>
              <tbody>
                {entries.entries.length === 0 ? (
                  <tr>
                    <td colSpan={5}>No hay asientos para mostrar.</td>
                  </tr>
                ) : (
                  entries.entries.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <strong>{entry.number}</strong>
                        <span className="cell-detail">{entry.origin}</span>
                      </td>
                      <td>{formatDate(entry.accountingDate)}</td>
                      <td>{entry.concept}</td>
                      <td>
                        <strong>{formatMoney(entry.totalDebit)}</strong>
                        <span className="cell-detail">
                          Haber {formatMoney(entry.totalCredit)}
                        </span>
                      </td>
                      <td>
                        <div className="compact-stack">
                          {entry.lines.map((line) => (
                            <span className="cell-detail" key={line.id}>
                              {line.account.code} {line.debit !== "0.00" ? "D" : "H"}{" "}
                              {formatMoney(
                                line.debit !== "0.00" ? line.debit : line.credit
                              )}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {entries.nextCursor ? (
            <div className="button-row">
              <Link
                className="button button-secondary"
                href={entryNextPageHref(entries.nextCursor, params)}
              >
                Siguiente pagina
              </Link>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

async function replacementRequestPage(rawReviewId: string) {
  const authorization = await authorizePagePermission("Accounting.RequestWaiverEvidenceReplacements");
  if (!authorization.ok) return focusedAccountingPage(<p className="message error">{authorization.message}</p>);
  const reviewId = uuidSchema.safeParse(rawReviewId);
  if (!reviewId.success) return focusedAccountingPage(<p className="message error">El identificador de la revisión no es válido.</p>);
  const preparation = await prepareWaiverEvidenceReplacement(reviewId.data);
  if (!preparation) return focusedAccountingPage(<p className="message error">La revisión no dispone de una evidencia revertida sustituible en un ejercicio abierto.</p>);
  const accountsPayload = listAccountingAccountsSchema.parse({ limit: 50, status: "ACTIVE", year: preparation.fiscalYear.toString() });
  const accounts = await listAccountingAccounts(accountsPayload, authorization.user);
  return focusedAccountingPage(<WaiverEvidenceReplacementRequestForm reviewId={preparation.reviewId} accounts={accounts.accounts} />);
}

async function replacementReviewPage(rawRequestId: string) {
  const authorization = await authorizePagePermission("Accounting.ApproveWaiverEvidenceReplacements");
  if (!authorization.ok) return focusedAccountingPage(<p className="message error">{authorization.message}</p>);
  const requestId = uuidSchema.safeParse(rawRequestId);
  if (!requestId.success) return focusedAccountingPage(<p className="message error">El identificador de la propuesta no es válido.</p>);
  const detail = await getWaiverEvidenceReplacementDetail(requestId.data, authorization.user);
  return focusedAccountingPage(detail.ok
    ? <WaiverEvidenceReplacementReview detail={detail.value} />
    : <p className="message error">{detail.error.message}</p>);
}

function focusedAccountingPage(content: ReactNode) {
  return <main className="shell">
    <header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app/subscriptions/renewal-waivers">Volver a condonaciones</Link></header>
    <section className="content"><div className="panel stack">{content}</div></section>
  </main>;
}

function accountNextPageHref(
  cursor: string,
  params: Awaited<AccountingPageProps["searchParams"]>
): string {
  const query = new URLSearchParams();
  query.set("accountCursor", cursor);
  if (params.entryCursor) query.set("entryCursor", params.entryCursor);
  if (params.year) query.set("year", params.year);
  if (params.search) query.set("search", params.search);
  if (params.entryId) query.set("entryId", params.entryId);

  return `/app/accounting?${query.toString()}`;
}

function entryNextPageHref(
  cursor: string,
  params: Awaited<AccountingPageProps["searchParams"]>
): string {
  const query = new URLSearchParams();
  query.set("entryCursor", cursor);
  if (params.accountCursor) query.set("accountCursor", params.accountCursor);
  if (params.year) query.set("year", params.year);
  if (params.search) query.set("search", params.search);
  if (params.entryId) query.set("entryId", params.entryId);

  return `/app/accounting?${query.toString()}`;
}

function replacementNextPageHref(cursor: string): string {
  const query = new URLSearchParams({ waiverReplacementCursor: cursor });
  return `/app/accounting?${query.toString()}`;
}

function exportHref(params: Awaited<AccountingPageProps["searchParams"]>): string {
  const query = new URLSearchParams();
  if (params.year) query.set("year", params.year);

  const suffix = query.toString();

  return `/api/accounting/journal-entries/export${suffix ? `?${suffix}` : ""}`;
}

function formatMoney(value: string): string {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR"
  }).format(Number(value));
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("es-ES").format(new Date(`${value}T00:00:00.000Z`));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("es-ES", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function waiverReplacementReasonLabel(reasonCode: "CORRECTED_CLASSIFICATION" | "CORRECTED_AMOUNT" | "CORRECTED_DATE" | "OTHER"): string {
  if (reasonCode === "CORRECTED_CLASSIFICATION") return "Clasificación corregida";
  if (reasonCode === "CORRECTED_AMOUNT") return "Importe corregido";
  if (reasonCode === "CORRECTED_DATE") return "Fecha corregida";
  return "Otro";
}

function fiscalYearStatusLabel(status: "OPEN" | "CLOSED" | "REVERSED"): string {
  if (status === "OPEN") return "Abierto";
  if (status === "CLOSED") return "Cerrado";
  return "Anulado / no operativo";
}
