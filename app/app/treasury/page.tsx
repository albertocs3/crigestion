import Link from "next/link";
import {
  listCustomerDueDates,
  listCustomerDueDatesSchema,
  type CustomerDueDateListItem
} from "@/modules/treasury/application/dueDates";
import { listCustomers } from "@/modules/customers/application/customers";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

type TreasuryPageProps = {
  searchParams: Promise<{
    cursor?: string;
    scope?: string;
    customerId?: string;
    dueFrom?: string;
    dueTo?: string;
    search?: string;
  }>;
};

export default async function TreasuryPage({ searchParams }: TreasuryPageProps) {
  const authorization = await authorizePagePermission("Treasury.ManagePayments");
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
            <h1>Tesoreria</h1>
            <p className="message error">{authorization.message}</p>
          </div>
        </section>
      </main>
    );
  }

  const payload = listCustomerDueDatesSchema.safeParse({
    limit: 25,
    cursor: params.cursor,
    scope: params.scope,
    customerId: params.customerId,
    dueFrom: params.dueFrom,
    dueTo: params.dueTo,
    search: params.search
  });
  const dueDateList = payload.success
    ? await listCustomerDueDates(payload.data, authorization.user)
    : {
        dueDates: [],
        summary: {
          count: 0,
          totalAmount: "0.00",
          paidAmount: "0.00",
          returnedAmount: "0.00",
          pendingAmount: "0.00"
        },
        nextCursor: null
      };
  const customers = await listCustomers(
    { limit: 100, status: "ACTIVE" },
    authorization.user
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <div className="button-row">
          <Link className="button button-secondary" href="/app/treasury/remittances">
            Remesas
          </Link>
          <Link className="button button-secondary" href="/app/treasury/forecast">
            Prevision
          </Link>
          <Link className="button button-secondary" href="/app">
            Volver
          </Link>
        </div>
      </header>
      <section className="content stack">
        <div className="panel stack">
          <div>
            <h1>Tesoreria</h1>
            <p className="muted">
              Vencimientos de facturas emitidas, saldos pendientes y devoluciones.
            </p>
          </div>

          <div className="data-grid">
            <div>
              <span className="data-label">Vencimientos</span>
              <strong>{dueDateList.summary.count}</strong>
            </div>
            <div>
              <span className="data-label">Total</span>
              <strong>{formatMoney(dueDateList.summary.totalAmount)}</strong>
            </div>
            <div>
              <span className="data-label">Cobrado neto</span>
              <strong>{formatMoney(dueDateList.summary.paidAmount)}</strong>
            </div>
            <div>
              <span className="data-label">Pendiente</span>
              <strong>{formatMoney(dueDateList.summary.pendingAmount)}</strong>
            </div>
          </div>

          <form className="filter-row" action="/app/treasury">
            <label>
              Buscar
              <input
                name="search"
                maxLength={120}
                defaultValue={params.search ?? ""}
                placeholder="Factura, cliente o codigo"
              />
            </label>
            <label>
              Estado
              <select name="scope" defaultValue={params.scope ?? "OPEN"}>
                <option value="OPEN">Abiertos</option>
                <option value="ALL">Todos</option>
                <option value="PENDING">Pendientes</option>
                <option value="RETURNED">Devueltos</option>
                <option value="UNPAID">Impagados</option>
                <option value="PAID">Pagados</option>
              </select>
            </label>
            <label>
              Cliente
              <select name="customerId" defaultValue={params.customerId ?? ""}>
                <option value="">Todos</option>
                {customers.customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.code} - {customer.legalName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Desde
              <input name="dueFrom" type="date" defaultValue={params.dueFrom ?? ""} />
            </label>
            <label>
              Hasta
              <input name="dueTo" type="date" defaultValue={params.dueTo ?? ""} />
            </label>
            <div className="form-actions">
              <button className="button" type="submit">
                Filtrar
              </button>
              <Link className="button button-secondary" href="/app/treasury">
                Limpiar
              </Link>
              <Link
                className="button button-secondary"
                href={exportHref(params)}
              >
                Exportar CSV
              </Link>
            </div>
          </form>

          {!payload.success ? (
            <p className="message error">Filtro de vencimientos invalido.</p>
          ) : null}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Vencimiento</th>
                  <th>Cliente</th>
                  <th>Factura</th>
                  <th>Importes</th>
                  <th>Metodo</th>
                  <th>Estados</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {dueDateList.dueDates.length === 0 ? (
                  <tr>
                    <td colSpan={7}>No hay vencimientos para mostrar.</td>
                  </tr>
                ) : (
                  dueDateList.dueDates.map((dueDate) => (
                    <tr key={dueDate.id}>
                      <td>
                        <strong>{formatDate(dueDate.dueDate)}</strong>
                        <span className="cell-detail">
                          Emitida: {formatDate(dueDate.issueDate)}
                        </span>
                      </td>
                      <td>
                        <strong>{dueDate.customer.legalName}</strong>
                        <span className="cell-detail">{dueDate.customer.code}</span>
                      </td>
                      <td>
                        <strong>{dueDate.invoiceNumber ?? "Sin numero"}</strong>
                        <span className="cell-detail">
                          Serie {dueDate.invoiceSeries} - {dueDate.invoiceYear}
                        </span>
                      </td>
                      <td>
                        <strong>{formatMoney(dueDate.pendingAmount)}</strong>
                        <span className="cell-detail">
                          Total {formatMoney(dueDate.amount)}
                        </span>
                        <span className="cell-detail">
                          Cobrado {formatMoney(dueDate.paidAmount)}
                        </span>
                        {Number(dueDate.returnedAmount) > 0 ? (
                          <span className="cell-detail">
                            Devuelto {formatMoney(dueDate.returnedAmount)}
                          </span>
                        ) : null}
                      </td>
                      <td>{paymentMethodLabel(dueDate.paymentMethod)}</td>
                      <td>
                        <div className="compact-stack">
                          {renderDueDateStatus(dueDate.status)}
                          <span className="cell-detail">
                            Factura: {paymentStatusLabel(dueDate.paymentStatus)}
                          </span>
                        </div>
                      </td>
                      <td>
                        <Link
                          className="button button-secondary button-small"
                          href={`/app/invoices/${dueDate.invoiceId}`}
                        >
                          Abrir
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {dueDateList.nextCursor ? (
            <div className="button-row">
              <Link
                className="button button-secondary"
                href={nextPageHref(dueDateList.nextCursor, params)}
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

function renderDueDateStatus(status: CustomerDueDateListItem["status"]) {
  return (
    <span className="status">
      <span className={`status-dot status-dot-${status.toLowerCase()}`} />
      {dueDateStatusLabel(status)}
    </span>
  );
}

function dueDateStatusLabel(status: CustomerDueDateListItem["status"]): string {
  switch (status) {
    case "PENDING":
      return "Pendiente";
    case "PAID":
      return "Pagado";
    case "RETURNED":
      return "Devuelto";
    case "UNPAID":
      return "Impagado";
  }
}

function paymentStatusLabel(status: CustomerDueDateListItem["paymentStatus"]): string {
  switch (status) {
    case "PENDING":
      return "Pendiente";
    case "PARTIALLY_PAID":
      return "Parcial";
    case "PAID":
      return "Pagada";
    case "UNPAID":
      return "Impagada";
  }
}

function paymentMethodLabel(
  method: CustomerDueDateListItem["paymentMethod"]
): string {
  switch (method) {
    case "BANK_TRANSFER":
      return "Transferencia";
    case "CASH":
      return "Contado";
    case "DIRECT_DEBIT":
      return "Domiciliacion";
  }
}

function formatDate(value: string): string {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString("es-ES");
}

function formatMoney(value: string): string {
  return `${value} EUR`;
}

function nextPageHref(
  cursor: string,
  params: {
    scope?: string;
    customerId?: string;
    dueFrom?: string;
    dueTo?: string;
    search?: string;
  }
): string {
  const searchParams = new URLSearchParams({ cursor });

  if (params.scope) {
    searchParams.set("scope", params.scope);
  }

  if (params.customerId) {
    searchParams.set("customerId", params.customerId);
  }

  if (params.dueFrom) {
    searchParams.set("dueFrom", params.dueFrom);
  }

  if (params.dueTo) {
    searchParams.set("dueTo", params.dueTo);
  }

  if (params.search) {
    searchParams.set("search", params.search);
  }

  return `/app/treasury?${searchParams.toString()}`;
}

function exportHref(params: {
  scope?: string;
  customerId?: string;
  dueFrom?: string;
  dueTo?: string;
  search?: string;
}): string {
  const searchParams = new URLSearchParams();

  if (params.scope) {
    searchParams.set("scope", params.scope);
  }

  if (params.customerId) {
    searchParams.set("customerId", params.customerId);
  }

  if (params.dueFrom) {
    searchParams.set("dueFrom", params.dueFrom);
  }

  if (params.dueTo) {
    searchParams.set("dueTo", params.dueTo);
  }

  if (params.search) {
    searchParams.set("search", params.search);
  }

  const query = searchParams.toString();

  return query
    ? `/api/treasury/customer-due-dates/export?${query}`
    : "/api/treasury/customer-due-dates/export";
}
