import Link from "next/link";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import { listSubscriptionRenewalPreview, listSubscriptionRenewalPreviewSchema, subscriptionRenewalBusinessDate } from "@/modules/subscriptions/application/renewals";
import { SubscriptionRenewalRunner } from "@/modules/subscriptions/presentation/SubscriptionRenewalRunner";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ processDate?: string; includePending?: string; limit?: string; cursor?: string }> };

export default async function SubscriptionRenewalsPage({ searchParams }: Props) {
  const authorization = await authorizePagePermission("Subscriptions.RunRenewals");
  if (!authorization.ok) return <main className="shell"><section className="content"><div className="panel stack"><h1>Renovaciones</h1><p className="message error">{authorization.message}</p></div></section></main>;
  const params = await searchParams;
  const includePending = params.includePending === undefined || params.includePending === "false"
    ? false
    : params.includePending === "true" ? true : params.includePending;
  const parsed = listSubscriptionRenewalPreviewSchema.safeParse({
    processDate: params.processDate ?? await subscriptionRenewalBusinessDate(),
    includePending,
    limit: params.limit,
    cursor: params.cursor
  });
  const queryData = parsed.success ? parsed.data : null;
  const result = queryData ? await listSubscriptionRenewalPreview(queryData, authorization.user) : null;
  return <main className="shell">
    <header className="topbar"><div className="brand">CriGestión</div><div className="form-actions"><Link className="button button-secondary" href="/app/subscriptions/renewal-exclusions">Ver pendientes</Link><Link className="button button-secondary" href="/app/subscriptions">Volver a suscripciones</Link></div></header>
    <section className="content stack">
      <div className="panel stack"><div><h1>Preparación de renovaciones</h1><p className="muted">Proceso manual supervisado. Preparar no emite; confirmar sí genera factura, asiento y evidencia fiscal.</p></div>
        <form className="filter-row" action="/app/subscriptions/renewals">
          <label>Fecha de proceso<input type="date" name="processDate" defaultValue={parsed.success ? parsed.data.processDate : params.processDate} /></label>
          <label><span>Incluir pendientes</span><select name="includePending" defaultValue={params.includePending ?? "false"}><option value="false">No, sólo activas</option><option value="true">Sí, selección manual</option></select></label>
          {parsed.success && parsed.data.limit !== 25 ? <input type="hidden" name="limit" value={parsed.data.limit} /> : null}
          <div className="form-actions"><button className="button" type="submit">Actualizar vista previa</button></div>
        </form>
        {!parsed.success ? <p className="message error">La fecha o los filtros no son válidos.</p> : result && !result.ok ? <p className="message error">{result.error.message}</p> : null}
      </div>
      {result?.ok ? <SubscriptionRenewalRunner
        preview={result.value}
        canConfirm={authorization.user.permissions.includes("Subscriptions.ConfirmRenewals") && authorization.user.permissions.includes("Billing.Issue")}
        canExclude={authorization.user.permissions.includes("Subscriptions.ManageRenewalExclusions")}
      /> : null}
      {result?.ok && queryData && (queryData.cursor || result.value.nextCursor) ? <nav className="panel form-actions" aria-label="Paginacion de grupos de renovacion">
        {queryData.cursor ? <Link className="button button-secondary" href={renewalPageHref(queryData.processDate, queryData.includePending, queryData.limit, null)}>Primera pagina</Link> : null}
        {result.value.nextCursor ? <Link className="button button-secondary" href={renewalPageHref(queryData.processDate, queryData.includePending, queryData.limit, result.value.nextCursor)}>Siguiente pagina</Link> : null}
      </nav> : null}
    </section>
  </main>;
}

function renewalPageHref(processDate: string, includePending: boolean, limit: number, cursor: string | null) {
  const query = new URLSearchParams({ processDate, includePending: String(includePending) });
  if (limit !== 25) query.set("limit", String(limit));
  if (cursor) query.set("cursor", cursor);
  return `/app/subscriptions/renewals?${query.toString()}`;
}
