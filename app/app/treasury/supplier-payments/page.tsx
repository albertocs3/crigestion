import Link from "next/link";
import { listSupplierDueDates, listSupplierDueDatesSchema } from "@/modules/purchases/application/purchases";
import { SupplierPaymentForm } from "@/modules/purchases/presentation/PurchaseForms";
import { listSuppliers } from "@/modules/suppliers/application/suppliers";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

export default async function SupplierPaymentsPage({ searchParams }: { searchParams: Promise<{ supplierId?: string; status?: string; dueBefore?: string }> }) {
  const authorization = await authorizePagePermission("Treasury.ViewSupplierPayments");
  const params = await searchParams;
  const status = params.status === undefined ? "PENDING" : params.status || undefined;
  if (!authorization.ok) {
    return <main className="shell"><section className="content"><div className="panel"><p className="message error">{authorization.message}</p></div></section></main>;
  }
  const payload = listSupplierDueDatesSchema.safeParse({ limit: 100, supplierId: params.supplierId || undefined, status, dueBefore: params.dueBefore || undefined });
  const [result, suppliers] = await Promise.all([
    payload.success ? listSupplierDueDates(payload.data, authorization.user) : { dueDates: [] },
    listSuppliers({ limit: 100, status: "ACTIVE" }, authorization.user)
  ]);
  const canPay = authorization.user.permissions.includes("Treasury.ManageSupplierPayments");
  return <main className="shell">
    <header className="topbar"><div className="brand">CriGestión</div><div className="button-row"><Link className="button button-secondary" href="/app/purchases">Compras</Link><Link className="button button-secondary" href="/app/treasury">Tesorería</Link></div></header>
    <section className="content stack"><div className="panel stack">
      <div><p className="eyebrow">Tesorería</p><h1>Vencimientos y pagos de proveedor</h1><p className="muted">Pagos parciales o totales con asiento automático.</p></div>
      <form className="filter-row"><label>Proveedor<select name="supplierId" defaultValue={params.supplierId ?? ""}><option value="">Todos</option>{suppliers.suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.code} - {supplier.legalName}</option>)}</select></label><label>Estado<select name="status" defaultValue={params.status ?? "PENDING"}><option value="">Todos</option><option value="PENDING">Pendientes</option><option value="PAID">Pagados</option></select></label><label>Vence hasta<input name="dueBefore" type="date" defaultValue={params.dueBefore ?? ""}/></label><button className="button">Filtrar</button></form>
      {!payload.success ? <p className="message error">Filtros inválidos.</p> : null}
      <div className="table-wrap"><table><thead><tr><th>Vencimiento</th><th>Proveedor / factura</th><th className="numeric">Importe</th><th className="numeric">Pagado</th><th className="numeric">Pendiente</th><th>Estado</th><th>Pago</th></tr></thead><tbody>{result.dueDates.length ? result.dueDates.map((due) => <tr key={due.id}><td>{due.dueDate}</td><td><strong>{due.supplierName}</strong><span className="cell-detail">{due.supplierCode} · <Link href={`/app/purchases/${due.purchaseInvoiceId}`}>{due.supplierInvoiceNumber}</Link></span></td><td className="numeric">{due.amount}</td><td className="numeric">{due.allocatedAmount}</td><td className="numeric">{due.pendingAmount}</td><td>{due.status}</td><td>{canPay && due.status === "PENDING" && due.pendingAmount !== "0.00" ? <SupplierPaymentForm dueDate={due}/> : "—"}</td></tr>) : <tr><td colSpan={7}>No hay vencimientos.</td></tr>}</tbody></table></div>
    </div></section>
  </main>;
}
