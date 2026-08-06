import Link from "next/link";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import { listSubscriptionReferences, listSubscriptions, listSubscriptionsSchema } from "@/modules/subscriptions/application/subscriptions";
import { SubscriptionCreateForm } from "@/modules/subscriptions/presentation/SubscriptionCreateForm";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ cursor?: string; status?: string; periodicity?: string; pricingMode?: string; customerId?: string; search?: string }> };

export default async function SubscriptionsPage({ searchParams }: Props) {
  const authorization = await authorizePagePermission("Subscriptions.View");
  const params = await searchParams;
  if (!authorization.ok) return <Denied message={authorization.message} />;
  const parsed = listSubscriptionsSchema.safeParse({ limit: 25, ...params });
  const result = parsed.success ? await listSubscriptions(parsed.data, authorization.user) : { subscriptions: [], nextCursor: null };
  const canManage = authorization.user.permissions.includes("Subscriptions.Manage");
  const references = canManage ? await listSubscriptionReferences() : null;
  return (
    <main className="shell">
      <header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app">Volver</Link></header>
      <section className="content stack">
        <div className="panel stack">
          <div><h1>Suscripciones</h1><p className="muted">Contratos periódicos y preparación supervisada de sus renovaciones.</p><div className="form-actions">{authorization.user.permissions.includes("Subscriptions.RunRenewals") ? <><Link className="button button-secondary" href="/app/subscriptions/renewals">Preparar renovaciones</Link><Link className="button button-secondary" href="/app/subscriptions/renewal-exclusions">Pendientes</Link></> : null}{authorization.user.permissions.includes("Subscriptions.ViewRenewalWaivers") ? <Link className="button button-secondary" href="/app/subscriptions/renewal-waivers">Periodos condonados</Link> : null}</div></div>
          <form className="filter-row" action="/app/subscriptions">
            <label>Buscar<input name="search" maxLength={120} defaultValue={params.search ?? ""} placeholder="Numero, nombre o cliente" /></label>
            <label>Estado<select name="status" defaultValue={params.status ?? ""}><option value="">Todos</option><option value="DRAFT">Borrador</option><option value="ACTIVE">Activa</option><option value="RENEWAL_PENDING">Pendiente</option><option value="CANCELLED">Cancelada</option></select></label>
            <label>Periodicidad<select name="periodicity" defaultValue={params.periodicity ?? ""}><option value="">Todas</option><option value="MONTHLY">Mensual</option><option value="QUARTERLY">Trimestral</option><option value="SEMIANNUAL">Semestral</option><option value="ANNUAL">Anual</option></select></label>
            <div className="form-actions"><button className="button" type="submit">Filtrar</button><Link className="button button-secondary" href="/app/subscriptions">Limpiar</Link></div>
          </form>
          {!parsed.success ? <p className="message error">Los filtros no son validos.</p> : null}
          <div className="table-wrap"><table><thead><tr><th>Suscripcion</th><th>Cliente</th><th>Contrato</th><th>Proxima fecha</th><th>Estimacion</th><th>Estado</th></tr></thead><tbody>
            {result.subscriptions.length === 0 ? <tr><td colSpan={6}>No hay suscripciones para mostrar.</td></tr> : result.subscriptions.map((subscription) => <tr key={subscription.id}>
              <td><Link href={`/app/subscriptions/${subscription.id}`}><strong>{subscription.number}</strong></Link><span className="cell-detail">{subscription.name}</span></td>
              <td><strong>{subscription.customer.legalName}</strong><span className="cell-detail">{subscription.customer.code}</span></td>
              <td>{periodicityLabel(subscription.periodicity)}<span className="cell-detail">{subscription.pricingMode === "FIXED" ? "Importe fijo" : "Por licencias"} · {subscription.lineCount} concepto(s)</span></td>
              <td>{subscription.nextRenewalDate}</td><td>{subscription.estimatedTotal} EUR</td><td>{statusLabel(subscription.status)}</td>
            </tr>)}</tbody></table></div>
          {result.nextCursor ? <Link className="button button-secondary" href={`/app/subscriptions?cursor=${result.nextCursor}`}>Siguiente pagina</Link> : null}
        </div>
        {canManage && references ? <div className="panel stack"><SubscriptionCreateForm {...references} canManageEconomics={authorization.user.permissions.includes("Subscriptions.ManageEconomics")} /></div> : null}
      </section>
    </main>
  );
}

function Denied({ message }: { message: string }) { return <main className="shell"><section className="content"><div className="panel stack"><h1>Suscripciones</h1><p className="message error">{message}</p></div></section></main>; }
function periodicityLabel(value: string) { return ({ MONTHLY: "Mensual", QUARTERLY: "Trimestral", SEMIANNUAL: "Semestral", ANNUAL: "Anual" } as Record<string, string>)[value] ?? value; }
function statusLabel(value: string) { return ({ DRAFT: "Borrador", ACTIVE: "Activa", RENEWAL_PENDING: "Pendiente", CANCELLED: "Cancelada" } as Record<string, string>)[value] ?? value; }
