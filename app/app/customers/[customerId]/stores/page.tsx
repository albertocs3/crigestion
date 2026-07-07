import Link from "next/link";
import {
  listCustomerStores,
  listCustomerStoresSchema,
  type CustomerStoreListItem
} from "@/modules/customers/application/stores";
import { CustomerStoreCreateForm } from "@/modules/customers/presentation/CustomerStoreCreateForm";
import { CustomerStoreEditForm } from "@/modules/customers/presentation/CustomerStoreEditForm";
import { CustomerStoreStatusButton } from "@/modules/customers/presentation/CustomerStoreStatusButton";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

type CustomerStoresPageProps = {
  params: Promise<{
    customerId: string;
  }>;
  searchParams: Promise<{
    status?: string;
  }>;
};

export default async function CustomerStoresPage({
  params,
  searchParams
}: CustomerStoresPageProps) {
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
            <h1>Tiendas</h1>
            <p className="message error">{authorization.message}</p>
          </div>
        </section>
      </main>
    );
  }

  const payload = listCustomerStoresSchema.safeParse({
    status: query.status
  });
  const result = payload.success
    ? await listCustomerStores(routeParams.customerId, payload.data, authorization.user)
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
            <h1>Tiendas</h1>
            {result ? (
              <p className="muted">
                {result.customer.code} - {result.customer.legalName}
              </p>
            ) : (
              <p className="message error">
                {payload.success ? "El cliente no existe." : "Filtro de tiendas invalido."}
              </p>
            )}
          </div>

          <form className="filter-row" action={`/app/customers/${routeParams.customerId}/stores`}>
            <label>
              Estado
              <select name="status" defaultValue={query.status ?? ""}>
                <option value="">Todos</option>
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
                href={`/app/customers/${routeParams.customerId}/stores`}
              >
                Limpiar
              </Link>
            </div>
          </form>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tienda</th>
                  <th>Direccion</th>
                  <th>Contacto</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {!result || result.stores.length === 0 ? (
                  <tr>
                    <td colSpan={5}>No hay tiendas para mostrar.</td>
                  </tr>
                ) : (
                  result.stores.map((store) => (
                    <tr key={store.id}>
                      <td>
                        <strong>{store.name}</strong>
                        <span className="cell-detail">{store.code}</span>
                        {store.isPrimary ? (
                          <span className="cell-detail">Principal</span>
                        ) : null}
                      </td>
                      <td>
                        <strong>{store.address.line}</strong>
                        <span className="cell-detail">
                          {store.address.postalCode} {store.address.city}
                        </span>
                        <span className="cell-detail">
                          {[store.address.province, store.address.country]
                            .filter(Boolean)
                            .join(", ")}
                        </span>
                      </td>
                      <td>
                        <strong>{store.contact.name ?? "-"}</strong>
                        <span className="cell-detail">{store.contact.role ?? "-"}</span>
                        <span className="cell-detail">
                          {store.contact.email ?? store.email ?? "-"}
                        </span>
                        <span className="cell-detail">
                          {store.contact.mobile ?? store.phone ?? "-"}
                        </span>
                      </td>
                      <td>{renderStatus(store.status)}</td>
                      <td>
                        {canManage ? (
                          <div className="compact-stack">
                            <CustomerStoreEditForm store={store} />
                            <CustomerStoreStatusButton store={store} />
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
            <CustomerStoreCreateForm customerId={result.customer.id} />
          </div>
        ) : null}
      </section>
    </main>
  );
}

function renderStatus(status: CustomerStoreListItem["status"]) {
  return (
    <span className="status">
      <span className={`status-dot status-dot-${status.toLowerCase()}`} />
      {status === "ACTIVE" ? "Activa" : "Inactiva"}
    </span>
  );
}
