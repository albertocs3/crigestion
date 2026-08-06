import Link from "next/link";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import { listSubscriptionRenewalWaivers, listSubscriptionRenewalWaiversSchema } from "@/modules/subscriptions/application/renewalWaiverReports";
import { subscriptionRenewalBusinessDate } from "@/modules/subscriptions/application/renewals";
import { SubscriptionRenewalWaiverExportButton } from "@/modules/subscriptions/presentation/SubscriptionRenewalWaiverExportButton";
import { SubscriptionRenewalWaiverFiscalReviewActions } from "@/modules/subscriptions/presentation/SubscriptionRenewalWaiverFiscalReviewActions";

export const dynamic = "force-dynamic";

type Query = { cursor?: string; reasonCode?: string; customerId?: string; search?: string; periodFrom?: string; periodTo?: string; waivedFrom?: string; waivedTo?: string };
type Props = { searchParams: Promise<Query> };

export default async function SubscriptionRenewalWaiversPage({ searchParams }: Props) {
  const authorization = await authorizePagePermission("Subscriptions.ViewRenewalWaivers");
  if (!authorization.ok) return <Denied message={authorization.message} />;
  const params = await searchParams;
  const canViewFiscalReviews = authorization.user.permissions.includes("Subscriptions.ViewRenewalWaiverFiscalReviews");
  const canDecideFiscalReviews = authorization.user.permissions.includes("Subscriptions.DecideRenewalWaiverFiscalReviews");
  const canCompleteFiscalReviews = authorization.user.permissions.includes("Subscriptions.CompleteRenewalWaiverFiscalReviews");
  const parsed = listSubscriptionRenewalWaiversSchema.safeParse({ limit: 25, ...params });
  const result = parsed.success ? await listSubscriptionRenewalWaivers(parsed.data, authorization.user) : null;
  const today = await subscriptionRenewalBusinessDate();
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const exportFrom = params.waivedFrom ?? yearStart;
  const exportTo = params.waivedTo ?? today;
  return <main className="shell">
    <header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app/subscriptions">Volver a suscripciones</Link></header>
    <section className="content stack">
      <div className="panel stack">
        <div><h1>Periodos condonados</h1><p className="muted">Historial interno de periodos avanzados sin facturación.</p></div>
        <p className="message warning"><strong>Informe interno de control.</strong> No es factura, factura rectificativa, asiento contable, libro de IVA, justificante fiscal ni registro VeriFactu. La base e IVA mostrados son valoraciones teóricas.</p>
        <form className="filter-row" action="/app/subscriptions/renewal-waivers">
          <label>Buscar<input name="search" maxLength={120} defaultValue={params.search ?? ""} placeholder="Número o nombre de suscripción" /></label>
          <label>Motivo<select name="reasonCode" defaultValue={params.reasonCode ?? ""}><option value="">Todos</option><option value="COMMERCIAL_WAIVER">Decisión comercial</option><option value="SERVICE_FAILURE">Incidencia de servicio</option><option value="OTHER">Otro</option></select></label>
          <label>Periodo desde<input type="date" name="periodFrom" defaultValue={params.periodFrom ?? ""} /></label>
          <label>Periodo hasta<input type="date" name="periodTo" defaultValue={params.periodTo ?? ""} /></label>
          <label>Condonada desde<input type="date" name="waivedFrom" defaultValue={params.waivedFrom ?? ""} /></label>
          <label>Condonada hasta<input type="date" name="waivedTo" defaultValue={params.waivedTo ?? ""} /></label>
          <div className="form-actions"><button className="button" type="submit">Filtrar</button><Link className="button button-secondary" href="/app/subscriptions/renewal-waivers">Limpiar</Link></div>
        </form>
        {!parsed.success ? <p className="message error">Los filtros del historial no son válidos.</p> : result && !result.ok ? <p className="message error">{result.error.message}</p> : null}
      </div>
      {result?.ok ? <>
        <div className="panel stack">
          <h2>Totales del filtro</h2>
          <div className="table-wrap"><table><thead><tr><th>Periodos</th><th>Subtotal</th><th>Descuentos</th><th>Base teórica</th><th>IVA teórico</th><th>Total teórico</th></tr></thead><tbody><tr>
            <td>{result.value.summary.count}</td><td>{result.value.summary.subtotal} EUR</td><td>{result.value.summary.discountTotal} EUR</td><td>{result.value.summary.taxableBase} EUR</td><td>{result.value.summary.taxAmount} EUR</td><td><strong>{result.value.summary.total} EUR</strong></td>
          </tr></tbody></table></div>
          {authorization.user.permissions.includes("Subscriptions.ExportRenewalWaivers") ? <SubscriptionRenewalWaiverExportButton filters={{
            reasonCode: params.reasonCode, customerId: params.customerId, search: params.search,
            periodFrom: params.periodFrom, periodTo: params.periodTo, waivedFrom: exportFrom, waivedTo: exportTo
          }} /> : null}
          <p className="muted">La exportación exige un rango máximo de 366 días; si no se filtra, usa el año natural en curso.</p>
        </div>
        <div className="panel stack">
          <div className="table-wrap"><table><thead><tr><th>Condonación</th><th>Suscripción</th><th>Cliente</th><th>Motivo</th><th>Valoración teórica</th><th>Autorización</th>{canViewFiscalReviews ? <th>Revisión fiscal</th> : null}</tr></thead><tbody>
            {result.value.waivers.length === 0 ? <tr><td colSpan={canViewFiscalReviews ? 7 : 6}>No hay periodos condonados para estos filtros.</td></tr> : result.value.waivers.map((waiver) => <tr key={waiver.id}>
              <td><strong>{formatDateTime(waiver.waivedAt)}</strong><span className="cell-detail">{waiver.periodStart}–{waiver.periodEndExclusive}</span></td>
              <td><Link href={`/app/subscriptions/${waiver.subscription.id}`}><strong>{waiver.subscription.number}</strong></Link><span className="cell-detail">{waiver.subscription.name}</span><span className="cell-detail">v{waiver.versions.against} → v{waiver.versions.resulting}</span></td>
              <td><strong>{waiver.customer.legalName}</strong><span className="cell-detail">{waiver.customer.code}</span><span className="cell-detail">{waiver.customer.labelSource === "CAPTURED_AT_WAIVER" ? "Identidad capturada al condonar" : "Dato maestro recuperado posteriormente"}</span></td>
              <td>{reasonLabel(waiver.reasonCode)}<span className="cell-detail">{waiver.reason ?? (waiver.hasReason ? "Detalle restringido" : "Sin detalle")}</span></td>
              <td><strong>{waiver.valuation.total} EUR</strong><span className="cell-detail">Base {waiver.valuation.taxableBase} · IVA {waiver.valuation.taxAmount}</span>{waiver.valuation.taxBreakdown.map((summary) => <span className="cell-detail" key={`${summary.taxRateCode}:${summary.taxRate}`}>{summary.taxRateCode} ({summary.taxRate}%): base {summary.theoreticalTaxableBase} · IVA {summary.theoreticalTaxAmount}</span>)}<span className="cell-detail">{waiver.valuation.calculationVersion}</span></td>
              <td>{waiver.waivedBy.displayName}<span className="cell-detail">Suscripción actualmente {waiver.subscriptionState.currentStatus}</span></td>
              {canViewFiscalReviews ? <td>{waiver.fiscalReview ? <div className="stack">
                <strong>{fiscalReviewStatusLabel(waiver.fiscalReview.status)}</strong>
                <span className="cell-detail">Abierta por {waiver.fiscalReview.openedBy.displayName}</span>
                {waiver.fiscalReview.startedBy ? <span className="cell-detail">Revisor: {waiver.fiscalReview.startedBy.displayName}</span> : null}
                {waiver.fiscalReview.decision ? <span className="cell-detail">{fiscalReviewDecisionLabel(waiver.fiscalReview.decision)}</span> : null}
                {waiver.fiscalReview.actionDueDate ? <span className="cell-detail">Vence: {waiver.fiscalReview.actionDueDate}</span> : null}
                {waiver.fiscalReview.evidenceCount > 0 ? <span className="cell-detail">Evidencia acreditada: {waiver.fiscalReview.evidenceCount}</span> : null}
                {waiver.fiscalReview.completedBy ? <span className="cell-detail">Cerrada por {waiver.fiscalReview.completedBy.displayName}</span> : null}
                <SubscriptionRenewalWaiverFiscalReviewActions review={waiver.fiscalReview} canDecide={canDecideFiscalReviews} canComplete={canCompleteFiscalReviews} />
              </div> : <span className="message error">Evidencia de revisión ausente</span>}</td> : null}
            </tr>)}
          </tbody></table></div>
          {result.value.nextCursor ? <Link className="button button-secondary" href={nextPageHref(params, result.value.nextCursor)}>Siguiente página</Link> : null}
        </div>
      </> : null}
    </section>
  </main>;
}

function nextPageHref(params: Query, cursor: string): string { const query = new URLSearchParams(); for (const [key, value] of Object.entries(params)) if (key !== "cursor" && value) query.set(key, value); query.set("cursor", cursor); return `/app/subscriptions/renewal-waivers?${query.toString()}`; }
function reasonLabel(value: string) { return ({ COMMERCIAL_WAIVER: "Decisión comercial", SERVICE_FAILURE: "Incidencia de servicio", OTHER: "Otro motivo" } as Record<string, string>)[value] ?? value; }
function fiscalReviewStatusLabel(value: string) { return ({ PENDING: "Pendiente", IN_REVIEW: "En revisión", ESCALATED: "Escalada", ACTION_REQUIRED: "Actuación requerida", CLOSED: "Cerrada" } as Record<string, string>)[value] ?? value; }
function fiscalReviewDecisionLabel(value: string) { return ({ NO_ADDITIONAL_ACTION: "Sin actuación adicional", MANUAL_ACCOUNTING_ACTION_REQUIRED: "Actuación contable manual", BILLING_REGULARIZATION_REQUIRED: "Regularización de facturación", EXTERNAL_FISCAL_ACTION_REQUIRED: "Actuación fiscal externa", EXTERNAL_ADVICE_REQUIRED: "Asesoramiento externo" } as Record<string, string>)[value] ?? value; }
function formatDateTime(value: string) { return new Intl.DateTimeFormat("es-ES", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Madrid" }).format(new Date(value)); }
function Denied({ message }: { message: string }) { return <main className="shell"><section className="content"><div className="panel stack"><h1>Periodos condonados</h1><p className="message error">{message}</p></div></section></main>; }
