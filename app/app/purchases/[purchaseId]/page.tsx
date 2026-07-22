import Link from "next/link";
import { z } from "zod";
import { getPurchase } from "@/modules/purchases/application/purchases";
import { PurchaseDueDatesForm, PurchaseLinesForm, PurchaseRectificationForm, PurchaseRegisterButton } from "@/modules/purchases/presentation/PurchaseForms";
import { listCatalogItems } from "@/modules/catalog/application/items";
import { listCatalogTaxRates } from "@/modules/catalog/application/taxRates";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";
const paramsSchema = z.object({ purchaseId: z.string().uuid() });

export default async function PurchasePage({ params }: { params: Promise<{ purchaseId: string }> }) {
  const authorization = await authorizePagePermission("Purchases.View");
  const parsed = paramsSchema.safeParse(await params);
  if (!authorization.ok || !parsed.success) return errorPage(authorization.ok ? "Identificador de compra inválido." : authorization.message);
  const result = await getPurchase(parsed.data.purchaseId, authorization.user);
  if (!result.ok) return errorPage(result.error.message);
  const purchase = result.value;
  const editable = purchase.status === "DRAFT" && authorization.user.permissions.includes("Purchases.ManageDrafts");
  const canRegister = authorization.user.permissions.includes("Purchases.Register");
  const canRectify = authorization.user.permissions.includes("Purchases.Rectify");
  const hasPaymentActivity = purchase.dueDates.some((due) => Number(due.allocatedAmount) > 0 || due.status === "PAID");
  const rectifiable = purchase.documentType === "STANDARD" && purchase.status === "REGISTERED" && purchase.paymentStatus === "PENDING" && !hasPaymentActivity && purchase.rectificationInvoices.length === 0;
  const [items, taxRates] = editable
    ? await Promise.all([listCatalogItems({ limit: 100, status: "ACTIVE" }, authorization.user), listCatalogTaxRates({ includeInactive: false })])
    : [{ items: [] }, []];
  return <main className="shell">
    <header className="topbar"><div className="brand">CriGestión</div><div className="button-row"><Link className="button button-secondary" href="/app/purchases">Compras</Link><Link className="button button-secondary" href="/app">Inicio</Link></div></header>
    <section className="content stack">
      <div className="panel stack"><div className="split-header"><div><p className="eyebrow">{purchase.documentType === "RECTIFICATION" ? "Rectificación de compra" : "Compra"}</p><h1>{purchase.supplierInvoiceNumber}</h1><p className="muted">{purchase.supplierCode} - {purchase.supplierName}</p></div><span className="badge neutral">{purchase.status === "DRAFT" ? "Borrador" : purchase.status === "RECTIFIED" ? "Rectificada" : purchase.status === "VOIDED" ? "Anulada" : "Registrada"}</span></div><div className="data-grid"><div><span className="data-label">Emisión</span><strong>{purchase.issueDate}</strong></div><div><span className="data-label">Contable</span><strong>{purchase.accountingDate}</strong></div><div><span className="data-label">Base</span><strong>{purchase.taxableBase} EUR</strong></div><div><span className="data-label">IVA</span><strong>{purchase.taxAmount} EUR</strong></div><div><span className="data-label">Total</span><strong>{purchase.total} EUR</strong></div><div><span className="data-label">Pago</span><strong>{purchase.paymentStatus}</strong></div></div><div className="button-row">{purchase.accountingEntry ? <Link className="button button-secondary button-small" href={`/app/accounting?entryId=${purchase.accountingEntry.id}`}>Asiento {purchase.accountingEntry.number}</Link> : null}{purchase.rectifiesPurchaseInvoice ? <Link className="button button-secondary button-small" href={`/app/purchases/${purchase.rectifiesPurchaseInvoice.id}`}>Original {purchase.rectifiesPurchaseInvoice.supplierInvoiceNumber}</Link> : null}{purchase.rectificationInvoices.map((rectification) => <Link key={rectification.id} className="button button-secondary button-small" href={`/app/purchases/${rectification.id}`}>Rectificativa {rectification.supplierInvoiceNumber}</Link>)}</div></div>
      {editable ? <>
        <div className="panel stack"><PurchaseLinesForm purchaseId={purchase.id} version={purchase.version} items={items.items.map((item) => ({ id: item.id, code: item.code, name: item.name, costPrice: item.costPrice, taxRateId: item.tax.id }))} taxRates={taxRates} existing={purchase.lines.map((line) => ({ catalogItemId: line.catalogItemId, description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, discountPercent: line.discountPercent, discountAmount: line.discountAmount, purchaseAccountCode: line.purchaseAccountCode, taxRateId: line.taxRateId }))}/></div>
        <div className="panel stack"><PurchaseDueDatesForm purchaseId={purchase.id} version={purchase.version} total={purchase.total} issueDate={purchase.issueDate} existing={purchase.dueDates.map((due) => ({ dueDate: due.dueDate, amount: due.amount, paymentMethod: due.paymentMethod }))}/></div>
        {canRegister ? <div className="panel stack"><h2>Registro definitivo</h2><p className="muted">Generará asiento, libro de IVA soportado y entradas de stock. Después no se podrá editar.</p><PurchaseRegisterButton purchaseId={purchase.id} version={purchase.version} disabled={!purchase.lines.length || !purchase.dueDates.length}/></div> : null}
      </> : purchase.dueDates.length ? <div className="panel stack"><h2>Vencimientos</h2><div className="table-wrap"><table><thead><tr><th>Fecha</th><th>Método</th><th className="numeric">Importe</th><th className="numeric">Pagado</th><th className="numeric">Pendiente</th><th>Estado</th></tr></thead><tbody>{purchase.dueDates.map((due) => <tr key={due.id}><td>{due.dueDate}</td><td>{due.paymentMethod}</td><td className="numeric">{due.amount}</td><td className="numeric">{due.allocatedAmount}</td><td className="numeric">{due.pendingAmount}</td><td>{due.status}</td></tr>)}</tbody></table></div>{purchase.status === "REGISTERED" ? <Link className="button" href={`/app/treasury/supplier-payments?supplierId=${purchase.supplierId}`}>Registrar pago</Link> : null}</div> : null}
      {canRectify && rectifiable ? <div className="panel stack"><PurchaseRectificationForm purchaseId={purchase.id} version={purchase.version} originalNumber={purchase.supplierInvoiceNumber} originalTotal={purchase.total}/></div> : null}
      {canRectify && purchase.documentType === "STANDARD" && purchase.status === "REGISTERED" && hasPaymentActivity ? <div className="panel stack"><h2>Rectificación no disponible</h2><p className="muted">Esta compra tiene pagos aplicados. El flujo quedará bloqueado hasta incorporar créditos y reembolsos de proveedor.</p></div> : null}
    </section>
  </main>;
}

function errorPage(message: string) { return <main className="shell"><header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app/purchases">Volver</Link></header><section className="content"><div className="panel stack"><h1>Compra</h1><p className="message error">{message}</p></div></section></main>; }
