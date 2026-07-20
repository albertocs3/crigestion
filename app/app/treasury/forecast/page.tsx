import Link from "next/link";
import {
  getCustomerCollectionForecast,
  getCustomerCollectionForecastSchema,
  type CustomerCollectionForecastItem
} from "@/modules/treasury/application/forecast";
import { listCustomers } from "@/modules/customers/application/customers";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

type TreasuryForecastPageProps = {
  searchParams: Promise<{
    year?: string;
    asOf?: string;
    customerId?: string;
    search?: string;
  }>;
};

export default async function TreasuryForecastPage({
  searchParams
}: TreasuryForecastPageProps) {
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
            <h1>Prevision de cobros</h1>
            <p className="message error">{authorization.message}</p>
          </div>
        </section>
      </main>
    );
  }

  const payload = getCustomerCollectionForecastSchema.safeParse({
    year: params.year,
    asOf: params.asOf,
    customerId: optionalSearchParam(params.customerId),
    search: optionalSearchParam(params.search),
    limit: 500
  });
  const forecast = payload.success
    ? await getCustomerCollectionForecast(payload.data, authorization.user)
    : {
        year: new Date().getUTCFullYear(),
        asOf: todayDateOnly(),
        months: [],
        items: [],
        summary: {
          itemCount: 0,
          expectedAmount: "0.00",
          overdueAmount: "0.00"
        }
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
          <Link className="button button-secondary" href="/app/treasury">
            Vencimientos
          </Link>
          <Link className="button button-secondary" href="/app">
            Inicio
          </Link>
        </div>
      </header>
      <section className="content stack">
        <div className="panel stack">
          <div>
            <h1>Prevision de cobros</h1>
            <p className="muted">
              Cobros previstos desde vencimientos reales con saldo pendiente.
            </p>
          </div>

          <div className="data-grid">
            <div>
              <span className="data-label">Vencimientos</span>
              <strong>{forecast.summary.itemCount}</strong>
            </div>
            <div>
              <span className="data-label">Previsto</span>
              <strong>{formatMoney(forecast.summary.expectedAmount)}</strong>
            </div>
            <div>
              <span className="data-label">Atrasado</span>
              <strong>{formatMoney(forecast.summary.overdueAmount)}</strong>
            </div>
            <div>
              <span className="data-label">Referencia</span>
              <strong>{formatDate(forecast.asOf)}</strong>
            </div>
          </div>

          <form className="filter-row" action="/app/treasury/forecast">
            <label>
              Ejercicio
              <input
                name="year"
                inputMode="numeric"
                defaultValue={params.year ?? String(forecast.year)}
              />
            </label>
            <label>
              Fecha referencia
              <input name="asOf" type="date" defaultValue={params.asOf ?? forecast.asOf} />
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
              Buscar
              <input
                name="search"
                maxLength={120}
                defaultValue={params.search ?? ""}
                placeholder="Factura, cliente o codigo"
              />
            </label>
            <div className="form-actions">
              <button className="button" type="submit">
                Filtrar
              </button>
              <Link className="button button-secondary" href="/app/treasury/forecast">
                Limpiar
              </Link>
              <Link className="button button-secondary" href={exportHref(params, forecast)}>
                Exportar CSV
              </Link>
            </div>
          </form>

          {!payload.success ? (
            <p className="message error">Filtro de prevision invalido.</p>
          ) : null}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Mes</th>
                  <th>Vencimientos</th>
                  <th>Previsto</th>
                  <th>Atrasado</th>
                </tr>
              </thead>
              <tbody>
                {forecast.months.map((month) => (
                  <tr key={month.month}>
                    <td>{monthName(month.month)}</td>
                    <td>{month.itemCount}</td>
                    <td>{formatMoney(month.expectedAmount)}</td>
                    <td>{formatMoney(month.overdueAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel stack">
          <div>
            <h2>Detalle previsto</h2>
            <p className="muted">Vencimientos considerados para el ejercicio.</p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Factura</th>
                  <th>Cliente</th>
                  <th>Vencimiento</th>
                  <th>Mes previsto</th>
                  <th>Pendiente</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {forecast.items.length === 0 ? (
                  <tr>
                    <td colSpan={6}>No hay cobros previstos para mostrar.</td>
                  </tr>
                ) : (
                  forecast.items.map((item) => (
                    <tr key={item.dueDateId}>
                      <td>
                        <strong>{item.invoiceNumber ?? "Sin numero"}</strong>
                        <span className="cell-detail">
                          <Link href={`/app/invoices/${item.invoiceId}`}>Abrir factura</Link>
                        </span>
                      </td>
                      <td>
                        <strong>{item.customer.legalName}</strong>
                        <span className="cell-detail">{item.customer.code}</span>
                      </td>
                      <td>{formatDate(item.dueDate)}</td>
                      <td>
                        {monthName(item.forecastMonth)}
                        {item.overdue ? (
                          <span className="cell-detail">Atrasado</span>
                        ) : null}
                      </td>
                      <td>{formatMoney(item.pendingAmount)}</td>
                      <td>{forecastStatusLabel(item)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  );
}

function forecastStatusLabel(item: CustomerCollectionForecastItem): string {
  if (item.status === "UNPAID") {
    return "Impagado";
  }

  if (item.status === "RETURNED") {
    return "Devuelto";
  }

  return item.paymentStatus === "PARTIALLY_PAID" ? "Parcial" : "Pendiente";
}

function monthName(month: number): string {
  const names = [
    "Enero",
    "Febrero",
    "Marzo",
    "Abril",
    "Mayo",
    "Junio",
    "Julio",
    "Agosto",
    "Septiembre",
    "Octubre",
    "Noviembre",
    "Diciembre"
  ];

  return names[month - 1] ?? String(month);
}

function formatDate(value: string): string {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString("es-ES");
}

function formatMoney(value: string): string {
  return `${value} EUR`;
}

function todayDateOnly(): string {
  return new Date().toISOString().slice(0, 10);
}

function optionalSearchParam(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function exportHref(
  params: {
    year?: string;
    asOf?: string;
    customerId?: string;
    search?: string;
  },
  forecast: {
    year: number;
    asOf: string;
  }
): string {
  const searchParams = new URLSearchParams({
    year: params.year ?? String(forecast.year),
    asOf: params.asOf ?? forecast.asOf
  });

  if (params.customerId) {
    searchParams.set("customerId", params.customerId);
  }

  if (params.search) {
    searchParams.set("search", params.search);
  }

  return `/api/treasury/customer-collection-forecast/export?${searchParams.toString()}`;
}
