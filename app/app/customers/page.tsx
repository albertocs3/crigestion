import Link from "next/link";
import {
  listCustomers,
  listCustomersSchema,
  type CustomerListItem
} from "@/modules/customers/application/customers";
import { CustomerCreateForm } from "@/modules/customers/presentation/CustomerCreateForm";
import { CustomerEditForm } from "@/modules/customers/presentation/CustomerEditForm";
import { CustomerStatusButton } from "@/modules/customers/presentation/CustomerStatusButton";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

type CustomersPageProps = {
  searchParams: Promise<{
    cursor?: string;
    status?: string;
    search?: string;
  }>;
};

export default async function CustomersPage({ searchParams }: CustomersPageProps) {
  const authorization = await authorizePagePermission("Customers.View");
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
            <h1>Clientes</h1>
            <p className="message error">{authorization.message}</p>
          </div>
        </section>
      </main>
    );
  }

  const payload = listCustomersSchema.safeParse({
    limit: 25,
    cursor: params.cursor,
    status: params.status,
    search: params.search
  });
  const customers = payload.success
    ? await listCustomers(payload.data, authorization.user)
    : { customers: [], nextCursor: null };
  const canManage = authorization.user.permissions.includes("Customers.Manage");

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
            <h1>Clientes</h1>
            <p className="muted">
              Maestro fiscal inicial para facturacion, suscripciones y soporte.
            </p>
          </div>

          <form className="filter-row" action="/app/customers">
            <label>
              Buscar
              <input
                name="search"
                maxLength={120}
                defaultValue={params.search ?? ""}
                placeholder="Codigo, razon social o NIF"
              />
            </label>
            <label>
              Estado
              <select name="status" defaultValue={params.status ?? ""}>
                <option value="">Todos</option>
                <option value="ACTIVE">Activos</option>
                <option value="INACTIVE">Inactivos</option>
              </select>
            </label>
            <div className="form-actions">
              <button className="button" type="submit">
                Filtrar
              </button>
              <Link className="button button-secondary" href="/app/customers">
                Limpiar
              </Link>
            </div>
          </form>

          {!payload.success ? (
            <p className="message error">Filtro de clientes invalido.</p>
          ) : null}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Fiscal</th>
                  <th>Contacto</th>
                  <th>Direccion fiscal</th>
                  <th>Condiciones</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {customers.customers.length === 0 ? (
                  <tr>
                    <td colSpan={7}>No hay clientes para mostrar.</td>
                  </tr>
                ) : (
                  customers.customers.map((customer) => (
                    <tr key={customer.id}>
                      <td>
                        <strong>{customer.legalName}</strong>
                        <span className="cell-detail">{customer.code}</span>
                        <span className="cell-detail">{typeLabel(customer.type)}</span>
                        {customer.tradeName ? (
                          <span className="cell-detail">{customer.tradeName}</span>
                        ) : null}
                      </td>
                      <td>
                        <strong>{customer.taxId}</strong>
                        <span className="cell-detail">
                          {fiscalTreatmentLabel(customer.fiscalTreatment)}
                        </span>
                      </td>
                      <td>
                        <span>{customer.email ?? "-"}</span>
                        <span className="cell-detail">{customer.phone ?? "-"}</span>
                      </td>
                      <td>
                        <strong>{customer.fiscalAddress.line}</strong>
                        <span className="cell-detail">
                          {customer.fiscalAddress.postalCode} {customer.fiscalAddress.city}
                        </span>
                        <span className="cell-detail">
                          {[customer.fiscalAddress.province, customer.fiscalAddress.country]
                            .filter(Boolean)
                            .join(", ")}
                        </span>
                      </td>
                      <td>
                        <strong>
                          {paymentMethodLabel(customer.commercialTerms.defaultPaymentMethod)}
                        </strong>
                        <span className="cell-detail">
                          {paymentTermsLabel(customer.commercialTerms)}
                        </span>
                        <span className="cell-detail">
                          Limite: {customer.commercialTerms.creditLimit ?? "-"}
                        </span>
                        <span className="cell-detail">
                          IBAN: {maskIban(customer.bankAccount.iban)}
                        </span>
                        <span className="cell-detail">
                          SEPA: {customer.bankAccount.sepaMandate?.reference ?? "-"}
                        </span>
                      </td>
                      <td>{renderStatus(customer.status)}</td>
                      <td>
                        <div className="compact-stack">
                          <Link
                            className="button button-secondary button-small"
                            href={`/app/customers/${customer.id}`}
                          >
                            Ficha
                          </Link>
                          <Link
                            className="button button-secondary button-small"
                            href={`/app/customers/${customer.id}/stores`}
                          >
                            Tiendas
                          </Link>
                          <Link
                            className="button button-secondary button-small"
                            href={`/app/customers/${customer.id}/addresses`}
                          >
                            Direcciones
                          </Link>
                          {canManage ? (
                            <>
                            <CustomerEditForm customer={customer} />
                            <CustomerStatusButton
                              customerId={customer.id}
                              status={customer.status}
                            />
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {customers.nextCursor ? (
            <div className="button-row">
              <Link
                className="button button-secondary"
                href={nextPageHref(customers.nextCursor, params)}
              >
                Siguiente pagina
              </Link>
            </div>
          ) : null}
        </div>

        {canManage ? (
          <div className="panel stack">
            <CustomerCreateForm />
          </div>
        ) : null}
      </section>
    </main>
  );
}

function renderStatus(status: CustomerListItem["status"]) {
  return (
    <span className="status">
      <span className={`status-dot status-dot-${status.toLowerCase()}`} />
      {status === "ACTIVE" ? "Activo" : "Inactivo"}
    </span>
  );
}

function typeLabel(type: CustomerListItem["type"]): string {
  switch (type) {
    case "COMPANY":
      return "Empresa";
    case "SELF_EMPLOYED":
      return "Autonomo";
    case "INDIVIDUAL":
      return "Particular";
  }
}

function fiscalTreatmentLabel(
  fiscalTreatment: CustomerListItem["fiscalTreatment"]
): string {
  switch (fiscalTreatment) {
    case "DOMESTIC":
      return "Nacional";
    case "EU":
      return "Intracomunitario";
    case "EXPORT":
      return "Exportacion";
    case "CANARY_CEUTA_MELILLA":
      return "Canarias, Ceuta o Melilla";
  }
}

function paymentMethodLabel(
  paymentMethod: CustomerListItem["commercialTerms"]["defaultPaymentMethod"]
): string {
  switch (paymentMethod) {
    case "BANK_TRANSFER":
      return "Transferencia";
    case "CASH":
      return "Contado";
    case "DIRECT_DEBIT":
      return "Domiciliacion";
  }
}

function paymentTermsLabel(terms: CustomerListItem["commercialTerms"]): string {
  switch (terms.paymentTermsType) {
    case "IMMEDIATE":
      return "Al contado";
    case "DAYS":
      return `${terms.paymentDays ?? "-"} dias`;
    case "FIXED_DAY_OF_MONTH":
      return `Dia ${terms.paymentFixedDay ?? "-"} del mes`;
  }
}

function maskIban(value: string | null): string {
  if (!value) {
    return "-";
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function nextPageHref(
  cursor: string,
  params: { status?: string; search?: string }
): string {
  const searchParams = new URLSearchParams({ cursor });

  if (params.status) {
    searchParams.set("status", params.status);
  }

  if (params.search) {
    searchParams.set("search", params.search);
  }

  return `/app/customers?${searchParams.toString()}`;
}
