import Link from "next/link";
import {
  listCustomerAddresses,
  listCustomerAddressesSchema,
  type CustomerAddressListItem
} from "@/modules/customers/application/addresses";
import { CustomerAddressCreateForm } from "@/modules/customers/presentation/CustomerAddressCreateForm";
import { CustomerAddressEditForm } from "@/modules/customers/presentation/CustomerAddressEditForm";
import { CustomerAddressStatusButton } from "@/modules/customers/presentation/CustomerAddressStatusButton";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

type CustomerAddressesPageProps = {
  params: Promise<{
    customerId: string;
  }>;
  searchParams: Promise<{
    status?: string;
    type?: string;
  }>;
};

export default async function CustomerAddressesPage({
  params,
  searchParams
}: CustomerAddressesPageProps) {
  const authorization = await authorizePagePermission("Customers.View");
  const routeParams = await params;
  const query = await searchParams;

  if (!authorization.ok) {
    return (
      <main className="shell">
        <header className="topbar">
          <div className="brand">CriGestión</div>
          <Link className="button button-secondary" href="/app/customers">
            Volver
          </Link>
        </header>
        <section className="content">
          <div className="panel stack">
            <h1>Direcciones</h1>
            <p className="message error">{authorization.message}</p>
          </div>
        </section>
      </main>
    );
  }

  const payload = listCustomerAddressesSchema.safeParse({
    status: query.status,
    type: query.type
  });
  const result = payload.success
    ? await listCustomerAddresses(routeParams.customerId, payload.data, authorization.user)
    : null;
  const canManage = authorization.user.permissions.includes("Customers.Manage");

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <Link className="button button-secondary" href="/app/customers">
          Volver
        </Link>
      </header>
      <section className="content stack">
        <div className="panel stack">
          <div>
            <h1>Direcciones</h1>
            {result ? (
              <p className="muted">
                {result.customer.code} - {result.customer.legalName}
              </p>
            ) : (
              <p className="message error">
                {payload.success ? "El cliente no existe." : "Filtro de direcciones invalido."}
              </p>
            )}
          </div>

          <form
            className="filter-row"
            action={`/app/customers/${routeParams.customerId}/addresses`}
          >
            <label>
              Tipo
              <select name="type" defaultValue={query.type ?? ""}>
                <option value="">Todos</option>
                <option value="BILLING">Facturacion</option>
                <option value="SHIPPING">Envio</option>
                <option value="OTHER">Otra</option>
              </select>
            </label>
            <label>
              Estado
              <select name="status" defaultValue={query.status ?? ""}>
                <option value="">Todas</option>
                <option value="ACTIVE">Activas</option>
                <option value="INACTIVE">Inactivas</option>
              </select>
            </label>
            <div className="form-actions">
              <button className="button" type="submit">
                Filtrar
              </button>
              <Link
                className="button button-secondary"
                href={`/app/customers/${routeParams.customerId}/addresses`}
              >
                Limpiar
              </Link>
            </div>
          </form>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Direccion</th>
                  <th>Tipo</th>
                  <th>Contacto</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {!result || result.addresses.length === 0 ? (
                  <tr>
                    <td colSpan={5}>No hay direcciones para mostrar.</td>
                  </tr>
                ) : (
                  result.addresses.map((address) => (
                    <tr key={address.id}>
                      <td>
                        <strong>{address.label}</strong>
                        <span className="cell-detail">{address.address.line}</span>
                        <span className="cell-detail">
                          {address.address.postalCode} {address.address.city}
                        </span>
                        <span className="cell-detail">
                          {[address.address.province, address.address.country]
                            .filter(Boolean)
                            .join(", ")}
                        </span>
                      </td>
                      <td>
                        <strong>{typeLabel(address.type)}</strong>
                        {address.isPrimary ? (
                          <span className="cell-detail">Principal</span>
                        ) : null}
                      </td>
                      <td>
                        <strong>{address.contact.name ?? "-"}</strong>
                        <span className="cell-detail">{address.contact.email ?? "-"}</span>
                        <span className="cell-detail">{address.contact.phone ?? "-"}</span>
                      </td>
                      <td>{renderStatus(address.status)}</td>
                      <td>
                        {canManage ? (
                          <div className="compact-stack">
                            <CustomerAddressEditForm address={address} />
                            <CustomerAddressStatusButton address={address} />
                          </div>
                        ) : (
                          <span className="muted">Solo lectura</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {canManage && result ? (
          <div className="panel stack">
            <CustomerAddressCreateForm customerId={result.customer.id} />
          </div>
        ) : null}
      </section>
    </main>
  );
}

function renderStatus(status: CustomerAddressListItem["status"]) {
  return (
    <span className="status">
      <span className={`status-dot status-dot-${status.toLowerCase()}`} />
      {status === "ACTIVE" ? "Activa" : "Inactiva"}
    </span>
  );
}

function typeLabel(type: CustomerAddressListItem["type"]): string {
  switch (type) {
    case "BILLING":
      return "Facturacion";
    case "SHIPPING":
      return "Envio";
    case "OTHER":
      return "Otra";
  }
}
