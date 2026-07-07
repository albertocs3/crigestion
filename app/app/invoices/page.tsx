import Link from "next/link";
import {
  listInvoices,
  listInvoicesSchema,
  type InvoiceListItem
} from "@/modules/billing/application/invoices";
import { InvoiceDraftCreateForm } from "@/modules/billing/presentation/InvoiceDraftCreateForm";
import { listCustomers } from "@/modules/customers/application/customers";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

type InvoicesPageProps = {
  searchParams: Promise<{
    cursor?: string;
    status?: string;
    paymentStatus?: string;
    customerId?: string;
    search?: string;
  }>;
};

export default async function InvoicesPage({ searchParams }: InvoicesPageProps) {
  const authorization = await authorizePagePermission("Billing.View");
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
            <h1>Facturas</h1>
            <p className="message error">{authorization.message}</p>
          </div>
        </section>
      </main>
    );
  }

  const payload = listInvoicesSchema.safeParse({
    limit: 25,
    cursor: params.cursor,
    status: params.status,
    paymentStatus: params.paymentStatus,
    customerId: params.customerId,
    search: params.search
  });
  const invoices = payload.success
    ? await listInvoices(payload.data, authorization.user)
    : { invoices: [], nextCursor: null };
  const canManageDrafts = authorization.user.permissions.includes("Billing.ManageDrafts");
  const customers = await listCustomers(
    { limit: 100, status: "ACTIVE" },
    authorization.user
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <Link className="button button-secondary" href="/app">
          Volver
        </Link>
      </header>
      <section className="content stack">
        <div className="panel stack">
          <div>
            <h1>Facturas</h1>
            <p className="muted">
              Borradores, emision fiscal y seguimiento basico de cobro.
            </p>
          </div>

          <form className="filter-row" action="/app/invoices">
            <label>
              Buscar
              <input
                name="search"
                maxLength={120}
                defaultValue={params.search ?? ""}
                placeholder="Numero, cliente o codigo"
              />
            </label>
            <label>
              Estado
              <select name="status" defaultValue={params.status ?? ""}>
                <option value="">Todos</option>
                <option value="DRAFT">Borrador</option>
                <option value="ISSUED">Emitida</option>
                <option value="RECTIFIED">Rectificada</option>
                <option value="VOIDED">Anulada</option>
              </select>
            </label>
            <label>
              Cobro
              <select name="paymentStatus" defaultValue={params.paymentStatus ?? ""}>
                <option value="">Todos</option>
                <option value="PENDING">Pendiente</option>
                <option value="PARTIALLY_PAID">Parcial</option>
                <option value="PAID">Pagada</option>
                <option value="UNPAID">Impagada</option>
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
            <div className="form-actions">
              <button className="button" type="submit">
                Filtrar
              </button>
              <Link className="button button-secondary" href="/app/invoices">
                Limpiar
              </Link>
            </div>
          </form>

          {!payload.success ? (
            <p className="message error">Filtro de facturas invalido.</p>
          ) : null}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Factura</th>
                  <th>Cliente</th>
                  <th>Fechas</th>
                  <th>Total</th>
                  <th>Estados</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {invoices.invoices.length === 0 ? (
                  <tr>
                    <td colSpan={6}>No hay facturas para mostrar.</td>
                  </tr>
                ) : (
                  invoices.invoices.map((invoice) => (
                    <tr key={invoice.id}>
                      <td>
                        <strong>{invoice.number ?? "Borrador sin numero"}</strong>
                        <span className="cell-detail">
                          Serie {invoice.series} - {invoice.year}
                        </span>
                      </td>
                      <td>
                        <strong>{invoice.customer.legalName}</strong>
                        <span className="cell-detail">{invoice.customer.code}</span>
                      </td>
                      <td>
                        <strong>{formatDate(invoice.issueDate)}</strong>
                        <span className="cell-detail">
                          Operacion: {formatDate(invoice.operationDate)}
                        </span>
                      </td>
                      <td>
                        <strong>{formatMoney(invoice.total)}</strong>
                      </td>
                      <td>
                        <div className="compact-stack">
                          {renderStatus(invoice.status)}
                          <span className="cell-detail">
                            Cobro: {paymentStatusLabel(invoice.paymentStatus)}
                          </span>
                          <span className="cell-detail">
                            VeriFactu: {verifactuStatusLabel(invoice.verifactuStatus)}
                          </span>
                        </div>
                      </td>
                      <td>
                        <Link
                          className="button button-secondary button-small"
                          href={`/app/invoices/${invoice.id}`}
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

          {invoices.nextCursor ? (
            <div className="button-row">
              <Link
                className="button button-secondary"
                href={nextPageHref(invoices.nextCursor, params)}
              >
                Siguiente pagina
              </Link>
            </div>
          ) : null}
        </div>

        {canManageDrafts ? (
          <div className="panel stack">
            <InvoiceDraftCreateForm customers={customers.customers} />
          </div>
        ) : null}
      </section>
    </main>
  );
}

function renderStatus(status: InvoiceListItem["status"]) {
  return (
    <span className="status">
      <span className={`status-dot status-dot-${status.toLowerCase()}`} />
      {invoiceStatusLabel(status)}
    </span>
  );
}

function invoiceStatusLabel(status: InvoiceListItem["status"]): string {
  switch (status) {
    case "DRAFT":
      return "Borrador";
    case "ISSUED":
      return "Emitida";
    case "RECTIFIED":
      return "Rectificada";
    case "VOIDED":
      return "Anulada";
  }
}

function paymentStatusLabel(status: InvoiceListItem["paymentStatus"]): string {
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

function verifactuStatusLabel(status: InvoiceListItem["verifactuStatus"]): string {
  switch (status) {
    case "NOT_APPLICABLE":
      return "No aplica";
    case "PENDING":
      return "Pendiente";
    case "SENT":
      return "Enviada";
    case "ACCEPTED":
      return "Aceptada";
    case "ACCEPTED_WITH_ERRORS":
      return "Aceptada con errores";
    case "REJECTED":
      return "Rechazada";
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
    status?: string;
    paymentStatus?: string;
    customerId?: string;
    search?: string;
  }
): string {
  const searchParams = new URLSearchParams({ cursor });

  if (params.status) {
    searchParams.set("status", params.status);
  }

  if (params.paymentStatus) {
    searchParams.set("paymentStatus", params.paymentStatus);
  }

  if (params.customerId) {
    searchParams.set("customerId", params.customerId);
  }

  if (params.search) {
    searchParams.set("search", params.search);
  }

  return `/app/invoices?${searchParams.toString()}`;
}
