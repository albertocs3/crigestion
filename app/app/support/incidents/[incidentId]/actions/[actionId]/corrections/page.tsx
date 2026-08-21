import Link from "next/link";
import { notFound } from "next/navigation";
import {
  isSupportActionCorrectionHistoryCursor,
  listSupportActionCorrections,
  supportActionCorrectionHistoryQuerySchema,
  supportActionCorrectionParamsSchema,
} from "@/modules/support/application/actionCorrections";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

export default async function SupportActionCorrectionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ incidentId: string; actionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const authorization = await authorizePagePermission("Support.View");
  if (!authorization.ok) {
    return <main className="shell"><section className="content"><div className="panel"><p className="message error">{authorization.message}</p></div></section></main>;
  }
  const parsedParams = supportActionCorrectionParamsSchema.safeParse(await params);
  const parsedQuery = supportActionCorrectionHistoryQuerySchema.safeParse(await searchParams);
  if (!parsedParams.success || !parsedQuery.success
    || (parsedQuery.data.cursor && !isSupportActionCorrectionHistoryCursor(parsedQuery.data.cursor, parsedParams.data.incidentId, parsedParams.data.actionId, parsedQuery.data.limit))) notFound();
  const result = await listSupportActionCorrections(
    parsedParams.data.incidentId,
    parsedParams.data.actionId,
    parsedQuery.data,
    authorization.user,
  );
  if (!result.ok && result.status === 404) notFound();
  if (!result.ok) {
    return <main className="shell"><section className="content"><div className="panel stack"><h1>Historial de correcciones</h1><p className="message error">{result.error.message}</p><Link className="button button-secondary" href={`/app/support/incidents/${parsedParams.data.incidentId}`}>Volver a la incidencia</Link></div></section></main>;
  }
  const value = result.value;
  const baseHref = `/app/support/incidents/${value.incident.id}/actions/${value.action.id}/corrections`;
  return <main className="shell"><header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href={`/app/support/incidents/${value.incident.id}`}>Volver a {value.incident.number}</Link></header><section className="content stack">
    <section className="panel stack" aria-labelledby="action-corrections-heading"><div><p className="eyebrow">{value.incident.number}</p><h1 id="action-corrections-heading">Historial de correcciones de la actuación</h1></div><p className="muted">La cadena se presenta por versión de la actuación; cada página contiene como máximo {parsedQuery.data.limit} evidencias.</p>
      {value.items.length === 0 ? <p className="muted">No hay correcciones en esta página.</p> : value.items.map((item) => <article className="compact-stack" key={item.id}><div><strong>Corrección v{item.resultingActionVersion}</strong> · {item.correctedBy.displayName} · <time dateTime={item.correctedAt}>{formatMadrid(item.correctedAt)}</time></div><p style={{ whiteSpace: "pre-wrap" }}><strong>Anterior:</strong> {item.previousText}</p><p style={{ whiteSpace: "pre-wrap" }}><strong>Corregido:</strong> {item.correctedText}</p><p style={{ whiteSpace: "pre-wrap" }}><strong>Motivo:</strong> {item.reason}</p></article>)}
      <nav className="form-actions" aria-label="Paginación del historial de correcciones">{parsedQuery.data.cursor ? <Link className="button button-ghost" href={baseHref}>Volver a las más recientes</Link> : null}{value.hasMore && value.nextCursor ? <Link className="button button-secondary" href={`${baseHref}?limit=${parsedQuery.data.limit}&cursor=${encodeURIComponent(value.nextCursor)}`}>Ver correcciones anteriores</Link> : null}</nav>
    </section>
  </section></main>;
}

function formatMadrid(value: string): string {
  return new Date(value).toLocaleString("es-ES", { timeZone: "Europe/Madrid" });
}
