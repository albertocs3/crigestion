import Link from "next/link";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import {
  listSubscriptionRenewalExclusions,
  listSubscriptionRenewalExclusionsSchema
} from "@/modules/subscriptions/application/renewalExclusions";
import { subscriptionRenewalBusinessDate } from "@/modules/subscriptions/application/renewals";
import { SubscriptionRenewalWaiverForm } from "@/modules/subscriptions/presentation/SubscriptionRenewalWaiverForm";

export const dynamic = "force-dynamic";

type Query = { cursor?: string; reasonCode?: string; workState?: string; customerId?: string; search?: string; periodFrom?: string; periodTo?: string };
type Props = { searchParams: Promise<Query> };

export default async function SubscriptionRenewalExclusionsPage({ searchParams }: Props) {
  const authorization = await authorizePagePermission("Subscriptions.RunRenewals");
  if (!authorization.ok) return <Denied message={authorization.message} />;
  const params = await searchParams;
  const parsed = listSubscriptionRenewalExclusionsSchema.safeParse({ limit: 25, ...params });
  const result = parsed.success ? await listSubscriptionRenewalExclusions(parsed.data, authorization.user) : null;
  const businessDate = await subscriptionRenewalBusinessDate();
  const canWaive = authorization.user.permissions.includes("Subscriptions.WaiveRenewals");
  return <main className="shell">
    <header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app/subscriptions">Volver a suscripciones</Link></header>
    <section className="content stack">
      <div className="panel stack">
        <div><h1>Pendientes de renovación</h1><p className="muted">Expedientes abiertos que requieren revisión y reintento explícito.</p></div>
        <div className="form-actions"><Link className="button" href={`/app/subscriptions/renewals?includePending=true&processDate=${businessDate}`}>Abrir runner de pendientes</Link></div>
        <form className="filter-row" action="/app/subscriptions/renewal-exclusions">
          <label>Buscar<input name="search" maxLength={120} defaultValue={params.search ?? ""} placeholder="Suscripción o cliente" /></label>
          <label>Motivo<select name="reasonCode" defaultValue={params.reasonCode ?? ""}><option value="">Todos</option><option value="PREPARATION_FAILED">Bloqueo de preparación</option><option value="MANUAL_EXCLUSION">Exclusión manual</option><option value="LEGACY_PENDING">Pendiente migrada</option></select></label>
          <label>Situación<select name="workState" defaultValue={params.workState ?? ""}><option value="">Todas</option><option value="READY">Lista para reintento</option><option value="RESERVED">Reservada</option><option value="BLOCKED">Bloqueada</option></select></label>
          <label>Periodo desde<input type="date" name="periodFrom" defaultValue={params.periodFrom ?? ""} /></label>
          <label>Periodo hasta<input type="date" name="periodTo" defaultValue={params.periodTo ?? ""} /></label>
          <div className="form-actions"><button className="button" type="submit">Filtrar</button><Link className="button button-secondary" href="/app/subscriptions/renewal-exclusions">Limpiar</Link></div>
        </form>
        {!parsed.success ? <p className="message error">Los filtros de la cola no son válidos.</p> : result && !result.ok ? <p className="message error">{result.error.message}</p> : null}
      </div>
      {result?.ok ? <div className="panel stack">
        <div className="table-wrap"><table><thead><tr><th>Periodo</th><th>Suscripción</th><th>Cliente</th><th>Motivo</th><th>Seguimiento</th><th>Acción administrativa</th></tr></thead><tbody>
          {result.value.exclusions.length === 0 ? <tr><td colSpan={6}>No hay pendientes para estos filtros.</td></tr> : result.value.exclusions.map((exclusion) => <tr key={exclusion.id}>
            <td><strong>{exclusion.periodStart}</strong><span className="cell-detail">hasta {exclusion.periodEndExclusive}</span></td>
            <td><Link href={`/app/subscriptions/${exclusion.subscription.id}`}><strong>{exclusion.subscription.number}</strong></Link><span className="cell-detail">{exclusion.subscription.name} · v{exclusion.subscription.version}</span></td>
            <td><strong>{exclusion.customer.legalName}</strong><span className="cell-detail">{exclusion.customer.code} · {exclusion.customer.status === "ACTIVE" ? "Activo" : "Inactivo"}</span></td>
            <td>{reasonLabel(exclusion.reasonCode)}<span className="cell-detail">{exclusion.reason ?? (exclusion.hasReason ? "Detalle restringido" : "Sin detalle")}</span><span className="cell-detail">Abierto por {exclusion.openedBy?.displayName ?? "sistema"}</span></td>
            <td><strong>{workStateLabel(exclusion.work.state)}</strong><span className="cell-detail">{exclusion.work.action === "CANCEL" ? "Aplicará la baja vencida" : exclusion.work.action === "INVOICE" ? "Preparación disponible" : exclusion.work.reservation ? `Borrador reservado ${exclusion.work.reservation.invoiceId}` : exclusion.work.blockers.join(", ")}</span><span className="cell-detail">{exclusion.attemptCount} preparación(es){exclusion.lastAttemptAt ? ` · última ${formatDateTime(exclusion.lastAttemptAt)}` : ""}</span><span className="cell-detail">{exclusion.lastErrorCode ?? "Sin error vigente"}</span></td>
            <td>{canWaive && exclusion.waiver.allowed ? <SubscriptionRenewalWaiverForm
              subscriptionId={exclusion.subscription.id} exclusionId={exclusion.id}
              subscriptionNumber={exclusion.subscription.number} customerName={exclusion.customer.legalName}
              expectedVersion={exclusion.subscription.version} periodStart={exclusion.periodStart}
              periodEndExclusive={exclusion.periodEndExclusive} waivedTotal={exclusion.waiver.valuation.total}
            /> : <span className="muted">{!canWaive ? "Sin permiso" : waiverBlockerLabel(exclusion.waiver.blockers)}</span>}</td>
          </tr>)}
        </tbody></table></div>
        {result.value.nextCursor ? <Link className="button button-secondary" href={nextPageHref(params, result.value.nextCursor)}>Siguiente página</Link> : null}
      </div> : null}
    </section>
  </main>;
}

function nextPageHref(params: Query, cursor: string): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (key !== "cursor" && value) query.set(key, value);
  query.set("cursor", cursor);
  return `/app/subscriptions/renewal-exclusions?${query.toString()}`;
}

function reasonLabel(value: string): string {
  return ({ PREPARATION_FAILED: "Bloqueo de preparación", MANUAL_EXCLUSION: "Exclusión manual", LEGACY_PENDING: "Pendiente migrada" } as Record<string, string>)[value] ?? value;
}

function workStateLabel(value: string): string {
  return ({ READY: "Lista", RESERVED: "Reservada", BLOCKED: "Bloqueada" } as Record<string, string>)[value] ?? value;
}

function waiverBlockerLabel(blockers: string[]): string {
  if (blockers.includes("SUBSCRIPTION_RENEWAL_ALREADY_RESERVED")) return "Libere primero la reserva";
  if (blockers.includes("SUBSCRIPTION_CANCELLATION_PENDING")) return "Resuelva primero la baja pendiente";
  return "No disponible";
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("es-ES", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Madrid" }).format(new Date(value));
}

function Denied({ message }: { message: string }) {
  return <main className="shell"><section className="content"><div className="panel stack"><h1>Pendientes de renovación</h1><p className="message error">{message}</p></div></section></main>;
}
