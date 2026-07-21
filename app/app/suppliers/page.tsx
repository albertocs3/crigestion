import Link from "next/link";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import { listSuppliers, listSuppliersSchema } from "@/modules/suppliers/application/suppliers";
import { SupplierForm } from "@/modules/suppliers/presentation/SupplierForm";
import { SupplierStatusButton } from "@/modules/suppliers/presentation/SupplierStatusButton";

export const dynamic = "force-dynamic";
type Props = { searchParams: Promise<{ cursor?: string; status?: string; search?: string }> };

export default async function SuppliersPage({ searchParams }: Props) {
  const authorization = await authorizePagePermission("Suppliers.View"); const params = await searchParams;
  if (!authorization.ok) return <main className="shell"><header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app">Volver</Link></header><section className="content"><div className="panel stack"><h1>Proveedores</h1><p className="message error">{authorization.message}</p></div></section></main>;
  const parsed = listSuppliersSchema.safeParse({ limit: 25, cursor: params.cursor, status: params.status, search: params.search });
  const result = parsed.success ? await listSuppliers(parsed.data, authorization.user) : { suppliers: [], nextCursor: null };
  const canManage = authorization.user.permissions.includes("Suppliers.Manage");
  return <main className="shell"><header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app">Volver</Link></header><section className="content stack">
    <div className="panel stack"><div><h1>Proveedores</h1><p className="muted">Maestro de compras con subcuenta 400 automática por ejercicio abierto.</p></div>
      <form className="filter-row" action="/app/suppliers"><label>Buscar<input name="search" maxLength={120} defaultValue={params.search ?? ""} placeholder="Código o razón social"/></label><label>Estado<select name="status" defaultValue={params.status ?? ""}><option value="">Todos</option><option value="ACTIVE">Activos</option><option value="INACTIVE">Inactivos</option></select></label><div className="form-actions"><button className="button" type="submit">Filtrar</button><Link className="button button-secondary" href="/app/suppliers">Limpiar</Link></div></form>
      {!parsed.success ? <p className="message error">Filtro de proveedores inválido.</p> : null}
      <div className="table-wrap"><table><thead><tr><th>Proveedor</th><th>Fiscal</th><th>Contacto</th><th>Pago</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>
        {result.suppliers.length ? result.suppliers.map((supplier) => <tr key={supplier.id}><td><strong>{supplier.legalName}</strong><span className="cell-detail">{supplier.code} · {supplier.accountingCode}</span>{supplier.tradeName ? <span className="cell-detail">{supplier.tradeName}</span> : null}</td><td>{supplier.taxIdMasked}<span className="cell-detail">{supplier.fiscalLocation.city} ({supplier.fiscalLocation.country})</span></td><td>{supplier.contact.name ?? "Sin contacto"}<span className="cell-detail">{supplier.contact.hasEmail ? "Email guardado" : "Sin email"} · {supplier.contact.hasPhone ? "Teléfono guardado" : "Sin teléfono"}</span></td><td>{supplier.paymentTerms.method}<span className="cell-detail">{supplier.banking.ibanMasked ?? "Sin IBAN"}</span></td><td><span className={`badge ${supplier.status === "ACTIVE" ? "success" : "neutral"}`}>{supplier.status === "ACTIVE" ? "Activo" : "Inactivo"}</span></td><td><div className="compact-stack"><Link className="button button-secondary button-small" href={`/app/suppliers/${supplier.id}`}>{canManage ? "Ver y editar" : "Ver"}</Link>{canManage ? <SupplierStatusButton id={supplier.id} status={supplier.status} version={supplier.version}/> : null}</div></td></tr>) : <tr><td colSpan={6}>No hay proveedores para el filtro seleccionado.</td></tr>}
      </tbody></table></div>
      {result.nextCursor ? <Link className="button button-secondary" href={nextHref(result.nextCursor, params)}>Siguiente página</Link> : null}
    </div>
    {canManage ? <div className="panel stack"><SupplierForm/></div> : null}
  </section></main>;
}

function nextHref(cursor: string, params: { status?: string; search?: string }) { const query = new URLSearchParams({ cursor }); if (params.status) query.set("status", params.status); if (params.search) query.set("search", params.search); return `/app/suppliers?${query}`; }
