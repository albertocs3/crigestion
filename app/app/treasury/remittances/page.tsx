import Link from "next/link";
import {
  listCustomerDueDates,
  listCustomerDueDatesSchema
} from "@/modules/treasury/application/dueDates";
import {
  listCustomerRemittances,
  listCustomerRemittancesSchema
} from "@/modules/treasury/application/remittances";
import { CustomerRemittanceDraftCreateForm } from "@/modules/treasury/presentation/CustomerRemittanceDraftCreateForm";
import { CustomerRemittanceCancelButton } from "@/modules/treasury/presentation/CustomerRemittanceCancelButton";
import { CustomerRemittanceProcessForm } from "@/modules/treasury/presentation/CustomerRemittanceProcessForm";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

type TreasuryRemittancesPageProps = {
  searchParams: Promise<{
    cursor?: string;
    status?: string;
    year?: string;
  }>;
};

export default async function TreasuryRemittancesPage({
  searchParams
}: TreasuryRemittancesPageProps) {
  const authorization = await authorizePagePermission("Treasury.ManagePayments");
  const params = await searchParams;

  if (!authorization.ok) {
    return (
      <main className="shell">
        <header className="topbar">
          <div className="brand">CriGestión</div>
          <Link className="button button-secondary" href="/app/treasury">
            Volver
          </Link>
        </header>
        <section className="content">
          <div className="panel stack">
            <h1>Remesas</h1>
            <p className="message error">{authorization.message}</p>
          </div>
        </section>
      </main>
    );
  }

  const remittancesPayload = listCustomerRemittancesSchema.safeParse({
    limit: 25,
    cursor: params.cursor,
    status: params.status,
    year: params.year
  });
  const dueDatesPayload = listCustomerDueDatesSchema.safeParse({
    limit: 100,
    scope: "PENDING"
  });
  const [remittances, dueDateList] = await Promise.all([
    remittancesPayload.success
      ? listCustomerRemittances(remittancesPayload.data, authorization.user)
      : { remittances: [], nextCursor: null },
    dueDatesPayload.success
      ? listCustomerDueDates(dueDatesPayload.data, authorization.user)
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
        }
  ]);
  const remittableDueDates = dueDateList.dueDates.filter(
    (dueDate) =>
      dueDate.paymentMethod === "DIRECT_DEBIT" && Number(dueDate.pendingAmount) > 0
  );
  const totalPending = remittableDueDates.reduce(
    (total, dueDate) => total + Number(dueDate.pendingAmount),
    0
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
            <h1>Remesas</h1>
            <p className="muted">
              Borradores de remesas de cobro sobre vencimientos domiciliados.
            </p>
          </div>

          <div className="data-grid">
            <div>
              <span className="data-label">Remesas</span>
              <strong>{remittances.remittances.length}</strong>
            </div>
            <div>
              <span className="data-label">Remesables</span>
              <strong>{remittableDueDates.length}</strong>
            </div>
            <div>
              <span className="data-label">Pendiente</span>
              <strong>{formatMoney(totalPending.toFixed(2))}</strong>
            </div>
          </div>

          <form className="filter-row" action="/app/treasury/remittances">
            <label>
              Estado
              <select name="status" defaultValue={params.status ?? ""}>
                <option value="">Todos</option>
                <option value="DRAFT">Borrador</option>
                <option value="GENERATED">Generada</option>
                <option value="SENT">Enviada</option>
                <option value="REJECTED">Rechazada</option>
                <option value="PROCESSED">Procesada</option>
                <option value="PARTIALLY_RETURNED">Parcialmente devuelta</option>
                <option value="CLOSED">Cerrada</option>
                <option value="CANCELLED">Cancelada</option>
              </select>
            </label>
            <label>
              Ejercicio
              <input name="year" inputMode="numeric" defaultValue={params.year ?? ""} />
            </label>
            <div className="form-actions">
              <button className="button" type="submit">
                Filtrar
              </button>
              <Link
                className="button button-secondary"
                href={exportRemittancesHref(params)}
              >
                Exportar CSV
              </Link>
              <Link className="button button-secondary" href="/app/treasury/remittances">
                Limpiar
              </Link>
            </div>
          </form>

          {!remittancesPayload.success ? (
            <p className="message error">Filtro de remesas invalido.</p>
          ) : null}
        </div>

        <div className="panel stack">
          <CustomerRemittanceDraftCreateForm dueDates={remittableDueDates} />
        </div>

        <div className="panel stack">
          <div>
            <h2>Remesas creadas</h2>
            <p className="muted">Composicion inicial de borradores de cobro.</p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Numero</th>
                  <th>Estado</th>
                  <th>Cargo</th>
                  <th>Concepto</th>
                  <th>Total</th>
                  <th>Lineas</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {remittances.remittances.length === 0 ? (
                  <tr>
                    <td colSpan={7}>No hay remesas para mostrar.</td>
                  </tr>
                ) : (
                  remittances.remittances.map((remittance) => (
                    <tr key={remittance.id}>
                      <td>
                        <strong>
                          <Link href={`/app/treasury/remittances/${remittance.id}`}>
                            {remittance.number}
                          </Link>
                        </strong>
                      </td>
                      <td>{remittanceStatusLabel(remittance.status)}</td>
                      <td>{formatDate(remittance.chargeDate)}</td>
                      <td>{remittance.concept}</td>
                      <td>{formatMoney(remittance.totalAmount)}</td>
                      <td>
                        <div className="compact-stack">
                          {remittance.lines.map((line) => (
                            <span className="cell-detail" key={line.id}>
                              {line.invoiceNumber ?? "Sin numero"} - {line.customer.code} -{" "}
                              {formatMoney(line.amount)}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        {remittance.status === "DRAFT" ? (
                          <div className="compact-stack">
                            <Link
                              className="button button-secondary button-small"
                              href={`/app/treasury/remittances/${remittance.id}`}
                            >
                              Abrir
                            </Link>
                            <CustomerRemittanceProcessForm
                              remittanceId={remittance.id}
                              defaultPaymentDate={remittance.chargeDate}
                            />
                            <CustomerRemittanceCancelButton
                              remittanceId={remittance.id}
                            />
                          </div>
                        ) : (
                          <Link
                            className="button button-secondary button-small"
                            href={`/app/treasury/remittances/${remittance.id}`}
                          >
                            Abrir
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {remittances.nextCursor ? (
            <div className="button-row">
              <Link
                className="button button-secondary"
                href={nextPageHref(remittances.nextCursor, params)}
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

function exportRemittancesHref(
  params: Awaited<TreasuryRemittancesPageProps["searchParams"]>
): string {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.year) query.set("year", params.year);
  const queryString = query.toString();

  return `/api/treasury/customer-remittances/export${
    queryString ? `?${queryString}` : ""
  }`;
}

function nextPageHref(
  cursor: string,
  params: Awaited<TreasuryRemittancesPageProps["searchParams"]>
): string {
  const query = new URLSearchParams();
  query.set("cursor", cursor);
  if (params.status) query.set("status", params.status);
  if (params.year) query.set("year", params.year);

  return `/app/treasury/remittances?${query.toString()}`;
}

function remittanceStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    DRAFT: "Borrador",
    GENERATED: "Generada",
    SENT: "Enviada",
    REJECTED: "Rechazada",
    PROCESSED: "Procesada",
    PARTIALLY_RETURNED: "Parcialmente devuelta",
    CLOSED: "Cerrada",
    CANCELLED: "Cancelada"
  };

  return labels[status] ?? status;
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
