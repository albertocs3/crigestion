import Link from "next/link";
import {
  listAccountingAccounts,
  listAccountingAccountsSchema,
  listJournalEntries,
  listJournalEntriesSchema
} from "@/modules/accounting/application/journal";
import { AccountingAccountCreateForm } from "@/modules/accounting/presentation/AccountingAccountCreateForm";
import { listAccountingFiscalYears } from "@/modules/accounting/application/fiscalYears";
import { listFiscalYearCloseRequests } from "@/modules/accounting/application/fiscalYearCloseRequests";
import { AccountingFiscalYearCloseActions, AccountingFiscalYearCreateForm } from "@/modules/accounting/presentation/AccountingFiscalYearActions";
import { ManualJournalEntryCreateForm } from "@/modules/accounting/presentation/ManualJournalEntryCreateForm";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

type AccountingPageProps = {
  searchParams: Promise<{
    accountCursor?: string;
    entryCursor?: string;
    year?: string;
    search?: string;
    entryId?: string;
  }>;
};

export default async function AccountingPage({
  searchParams
}: AccountingPageProps) {
  const authorization = await authorizePagePermission("Accounting.View");
  const params = await searchParams;

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
  const [accounts, entries, fiscalYears, closeRequests] = await Promise.all([
    accountsPayload.success
      ? listAccountingAccounts(accountsPayload.data, authorization.user)
      : { accounts: [], nextCursor: null },
    entriesPayload.success
      ? listJournalEntries(entriesPayload.data, authorization.user)
      : { entries: [], nextCursor: null },
    listAccountingFiscalYears(),
    listFiscalYearCloseRequests()
  ]);
  const canManageEntries = authorization.user.permissions.includes(
    "Accounting.ManageEntries"
  );
  const canManageExercises = authorization.user.permissions.includes("Accounting.ManageExercises");
  const canRequestClosures = authorization.user.permissions.includes("Accounting.RequestExerciseClosures");
  const canApproveClosures = authorization.user.permissions.includes("Accounting.ApproveExerciseClosures");
  const pendingCloseByFiscalYear = new Map(
    closeRequests.filter((request) => request.status === "REQUESTED").map((request) => [request.fiscalYearId, request])
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
            <div className="table-wrap"><table><thead><tr><th>Ejercicio</th><th>Estado</th><th>Plan</th><th>Cuentas</th><th>Acciones</th></tr></thead><tbody>{fiscalYears.map((fiscalYear) => <tr key={fiscalYear.id}><td><strong>{fiscalYear.year}</strong></td><td>{fiscalYear.status === "OPEN" ? "Abierto" : "Cerrado"}</td><td>{fiscalYear.planCode} {fiscalYear.planVersion}</td><td>{fiscalYear.accountCount}</td><td>{fiscalYear.status === "OPEN" && (canRequestClosures || canApproveClosures) ? <AccountingFiscalYearCloseActions fiscalYearId={fiscalYear.id} year={fiscalYear.year} request={pendingCloseByFiscalYear.get(fiscalYear.id) ?? null} actorUserId={authorization.user.id} canRequest={canRequestClosures} canApprove={canApproveClosures} /> : "-"}</td></tr>)}</tbody></table></div>
          </div>
        ) : null}

        {canManageEntries ? (
          <div className="panel stack">
            <AccountingAccountCreateForm />
            <ManualJournalEntryCreateForm accounts={accounts.accounts} />
          </div>
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
