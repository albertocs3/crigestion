import Link from "next/link";
import { listCatalogCategories } from "@/modules/catalog/application/categories";
import {
  listCatalogItems,
  listCatalogItemsSchema,
  type CatalogItemListItem
} from "@/modules/catalog/application/items";
import { listCatalogTaxRates } from "@/modules/catalog/application/taxRates";
import { CatalogCategoryCreateForm } from "@/modules/catalog/presentation/CatalogCategoryCreateForm";
import { CatalogCategoryStatusButton } from "@/modules/catalog/presentation/CatalogCategoryStatusButton";
import { CatalogItemCreateForm } from "@/modules/catalog/presentation/CatalogItemCreateForm";
import { CatalogItemEditForm } from "@/modules/catalog/presentation/CatalogItemEditForm";
import { CatalogItemStatusButton } from "@/modules/catalog/presentation/CatalogItemStatusButton";
import { CatalogStockAdjustmentForm } from "@/modules/catalog/presentation/CatalogStockAdjustmentForm";
import { CatalogTaxRateActions } from "@/modules/catalog/presentation/CatalogTaxRateActions";
import { CatalogTaxRateCreateForm } from "@/modules/catalog/presentation/CatalogTaxRateCreateForm";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

type CatalogPageProps = {
  searchParams: Promise<{
    cursor?: string;
    status?: string;
    kind?: string;
    categoryId?: string;
    search?: string;
  }>;
};

export default async function CatalogPage({ searchParams }: CatalogPageProps) {
  const authorization = await authorizePagePermission("Catalog.View");
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
            <h1>Catalogo</h1>
            <p className="message error">{authorization.message}</p>
          </div>
        </section>
      </main>
    );
  }

  const payload = listCatalogItemsSchema.safeParse({
    limit: 25,
    cursor: params.cursor,
    status: params.status,
    kind: params.kind,
    categoryId: params.categoryId,
    search: params.search
  });
  const catalog = payload.success
    ? await listCatalogItems(payload.data, authorization.user)
    : { items: [], nextCursor: null };
  const canManage = authorization.user.permissions.includes("Catalog.Manage");
  const categories = canManage
    ? await listCatalogCategories({ includeInactive: false })
    : [];
  const managedCategories = canManage
    ? await listCatalogCategories({ includeInactive: true })
    : [];
  const taxRates = canManage
    ? await listCatalogTaxRates({ includeInactive: false })
    : [];
  const managedTaxRates = canManage
    ? await listCatalogTaxRates({ includeInactive: true })
    : [];

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
            <h1>Catalogo</h1>
            <p className="muted">Articulos, servicios, software y licencias para facturar.</p>
          </div>

          <form className="filter-row" action="/app/catalog">
            <label>
              Buscar
              <input
                name="search"
                maxLength={120}
                defaultValue={params.search ?? ""}
                placeholder="Codigo, nombre o descripcion"
              />
            </label>
            <label>
              Tipo
              <select name="kind" defaultValue={params.kind ?? ""}>
                <option value="">Todos</option>
                <option value="PRODUCT">Producto</option>
                <option value="SERVICE">Servicio</option>
                <option value="SOFTWARE">Software</option>
                <option value="LICENSE">Licencia</option>
              </select>
            </label>
            <label>
              Categoria
              <select name="categoryId" defaultValue={params.categoryId ?? ""}>
                <option value="">Todas</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
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
              <Link className="button button-secondary" href="/app/catalog">
                Limpiar
              </Link>
            </div>
          </form>

          {!payload.success ? (
            <p className="message error">Filtro de catalogo invalido.</p>
          ) : null}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Elemento</th>
                  <th>Tipo</th>
                  <th>Precios</th>
                  <th>Stock</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {catalog.items.length === 0 ? (
                  <tr>
                    <td colSpan={6}>No hay elementos para mostrar.</td>
                  </tr>
                ) : (
                  catalog.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>{item.name}</strong>
                        <span className="cell-detail">{item.code}</span>
                        {item.description ? (
                          <span className="cell-detail">{item.description}</span>
                        ) : null}
                      </td>
                      <td>
                        <strong>{kindLabel(item.kind)}</strong>
                        <span className="cell-detail">{item.unitName}</span>
                        <span className="cell-detail">
                          {item.category ? item.category.name : "Sin categoria"}
                        </span>
                      </td>
                      <td>
                        <strong>Venta: {item.salePrice}</strong>
                        <span className="cell-detail">Coste: {item.costPrice}</span>
                        <span className="cell-detail">
                          IVA: {item.tax.name} ({item.taxRate}%)
                        </span>
                      </td>
                      <td>
                        <strong>{item.stock.tracked ? item.stock.current : "-"}</strong>
                        {item.stock.tracked ? (
                          <>
                            <span className="cell-detail">Minimo: {item.stock.minimum}</span>
                            {item.stock.negative ? (
                              <span className="cell-detail">Stock negativo</span>
                            ) : null}
                            {item.stock.belowMinimum ? (
                              <span className="cell-detail">Bajo minimo</span>
                            ) : null}
                          </>
                        ) : (
                          <span className="cell-detail">Sin control</span>
                        )}
                      </td>
                      <td>{renderStatus(item.status)}</td>
                      <td>
                        {canManage ? (
                          <div className="compact-stack">
                            <CatalogItemEditForm
                              categories={categories}
                              item={item}
                              taxRates={taxRates}
                            />
                            <CatalogStockAdjustmentForm item={item} />
                            <CatalogItemStatusButton item={item} />
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

          {catalog.nextCursor ? (
            <div className="button-row">
              <Link
                className="button button-secondary"
                href={nextPageHref(catalog.nextCursor, params)}
              >
                Siguiente pagina
              </Link>
            </div>
          ) : null}
        </div>

        {canManage ? (
          <div className="panel stack">
            <CatalogItemCreateForm categories={categories} taxRates={taxRates} />
          </div>
        ) : null}

        {canManage ? (
          <div className="panel stack">
            <div>
              <h2>Categorias</h2>
              <p className="muted">
                Agrupan articulos y servicios para filtrar y ordenar el catalogo.
              </p>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Categoria</th>
                    <th>Descripcion</th>
                    <th>Estado</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {managedCategories.length === 0 ? (
                    <tr>
                      <td colSpan={4}>No hay categorias para mostrar.</td>
                    </tr>
                  ) : (
                    managedCategories.map((category) => (
                      <tr key={category.id}>
                        <td>
                          <strong>{category.name}</strong>
                          <span className="cell-detail">{category.code}</span>
                        </td>
                        <td>{category.description ?? "-"}</td>
                        <td>{renderStatus(category.status)}</td>
                        <td>
                          <CatalogCategoryStatusButton category={category} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <CatalogCategoryCreateForm />
          </div>
        ) : null}

        {canManage ? (
          <div className="panel stack">
            <div>
              <h2>Tipos de IVA</h2>
              <p className="muted">
                Los articulos usan tipos activos; al facturar se copiara el porcentaje aplicado.
              </p>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tipo</th>
                    <th>Porcentaje</th>
                    <th>Estado</th>
                    <th>Uso</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {managedTaxRates.length === 0 ? (
                    <tr>
                      <td colSpan={5}>No hay tipos de IVA para mostrar.</td>
                    </tr>
                  ) : (
                    managedTaxRates.map((taxRate) => (
                      <tr key={taxRate.id}>
                        <td>
                          <strong>{taxRate.name}</strong>
                          <span className="cell-detail">{taxRate.code}</span>
                        </td>
                        <td>{taxRate.rate}%</td>
                        <td>{renderTaxRateStatus(taxRate.status)}</td>
                        <td>{taxRate.isDefault ? "Por defecto" : "-"}</td>
                        <td>
                          <CatalogTaxRateActions taxRate={taxRate} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <CatalogTaxRateCreateForm />
          </div>
        ) : null}
      </section>
    </main>
  );
}

function renderStatus(status: CatalogItemListItem["status"]) {
  return (
    <span className="status">
      <span className={`status-dot status-dot-${status.toLowerCase()}`} />
      {status === "ACTIVE" ? "Activo" : "Inactivo"}
    </span>
  );
}

function kindLabel(kind: CatalogItemListItem["kind"]): string {
  switch (kind) {
    case "PRODUCT":
      return "Producto";
    case "SERVICE":
      return "Servicio";
    case "SOFTWARE":
      return "Software";
    case "LICENSE":
      return "Licencia";
  }
}

function renderTaxRateStatus(status: "ACTIVE" | "INACTIVE") {
  return (
    <span className="status">
      <span className={`status-dot status-dot-${status.toLowerCase()}`} />
      {status === "ACTIVE" ? "Activo" : "Inactivo"}
    </span>
  );
}

function nextPageHref(
  cursor: string,
  params: { status?: string; kind?: string; categoryId?: string; search?: string }
): string {
  const searchParams = new URLSearchParams({ cursor });

  if (params.status) {
    searchParams.set("status", params.status);
  }

  if (params.kind) {
    searchParams.set("kind", params.kind);
  }

  if (params.categoryId) {
    searchParams.set("categoryId", params.categoryId);
  }

  if (params.search) {
    searchParams.set("search", params.search);
  }

  return `/app/catalog?${searchParams.toString()}`;
}
