import Link from "next/link";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import { defaultSupportIndicatorPeriod, getSupportIndicators, listSupportIndicatorTechnicians, supportIndicatorsQuerySchema, type SupportIndicatorsDto } from "@/modules/support/application/indicators";

export const dynamic = "force-dynamic";
type Props = { searchParams: Promise<{ from?: string; to?: string; scope?: string; technicianId?: string }> };

export default async function SupportIndicatorsPage({ searchParams }: Props) {
  const view = await authorizePagePermission("Support.View");
  if (!view.ok) return <Denied message={view.message}/>;
  const authorization = await authorizePagePermission("Support.ViewIndicators");
  if (!authorization.ok) return <Denied message={authorization.message}/>;
  const params = await searchParams;
  const defaults = defaultSupportIndicatorPeriod();
  const parsed = supportIndicatorsQuerySchema.safeParse({ from: params.from ?? defaults.from, to: params.to ?? defaults.to, scope: params.scope ?? "self", technicianId: params.technicianId || undefined });
  const result = parsed.success ? await getSupportIndicators(parsed.data, authorization.user) : null;
  const data = result?.ok ? result.value : null;
  const canGlobal = authorization.user.permissions.includes("Support.ViewGlobalIndicators");
  const technicians = canGlobal ? await listSupportIndicatorTechnicians(authorization.user) : [];

  return <main className="shell"><header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app/support">Volver</Link></header><section className="content stack">
    <div className="panel stack"><div><p className="eyebrow">Atención al cliente</p><h1>Indicadores</h1><p className="muted">Carga actual y rendimiento histórico en horario Europe/Madrid.</p></div>
      <form className="filter-row" action="/app/support/indicators"><label>Desde<input type="date" name="from" required defaultValue={parsed.success ? parsed.data.from : params.from ?? defaults.from}/></label><label>Hasta<input type="date" name="to" required defaultValue={parsed.success ? parsed.data.to : params.to ?? defaults.to}/></label><label>Alcance<select name="scope" defaultValue={parsed.success ? parsed.data.scope : "self"}><option value="self">Mis indicadores</option>{canGlobal ? <option value="global">Global</option> : null}</select></label>{canGlobal ? <label>Técnico (opcional)<select name="technicianId" defaultValue={parsed.success ? parsed.data.technicianId ?? "" : ""}><option value="">Todos</option>{technicians.map((technician) => <option key={technician.id} value={technician.id}>{technician.displayName}</option>)}</select></label> : null}<button className="button">Aplicar</button><Link className="button button-secondary" href="/app/support/indicators">Últimos 30 días</Link></form>
      {!parsed.success ? <p className="message error">El periodo o el alcance no son válidos.</p> : result && !result.ok ? <p className="message error">{result.error.message}</p> : null}
    </div>
    {data ? <IndicatorContent data={data}/> : null}
  </section></main>;
}

function IndicatorContent({ data }: { data: SupportIndicatorsDto }) {
  return <>
      <div className="panel stack"><div><h2>Foto actual</h2><p className="muted">Incidencias canónicas abiertas a <time dateTime={data.snapshot.asOf}>{new Date(data.snapshot.asOf).toLocaleString("es-ES", { timeZone: "Europe/Madrid" })}</time>.</p></div>
      <div className="table-wrap"><table aria-label="Incidencias abiertas por estado"><thead><tr><th>Nuevas</th><th>En curso</th><th>Pendiente cliente</th><th>Pendiente tercero</th></tr></thead><tbody><tr><td>{data.snapshot.openByStatus.NEW}</td><td>{data.snapshot.openByStatus.IN_PROGRESS}</td><td>{data.snapshot.openByStatus.PENDING_CUSTOMER}</td><td>{data.snapshot.openByStatus.PENDING_THIRD_PARTY}</td></tr></tbody></table></div>
      <div className="table-wrap"><table aria-label="Incidencias abiertas por prioridad"><thead><tr><th>Baja</th><th>Media</th><th>Alta</th><th>Urgente</th></tr></thead><tbody><tr><td>{data.snapshot.openByPriority.LOW}</td><td>{data.snapshot.openByPriority.MEDIUM}</td><td>{data.snapshot.openByPriority.HIGH}</td><td>{data.snapshot.openByPriority.URGENT}</td></tr></tbody></table></div>
    </div>
    <div className="panel stack"><div><h2>Rendimiento del periodo</h2><p className="muted">Del {data.period.from} al {data.period.to}, ambos incluidos. Los tiempos de resolución excluyen los intervalos pendientes.</p></div>
      <div className="table-wrap"><table aria-label="Rendimiento de soporte"><thead><tr><th>Primera actuación media</th><th>Resolución media</th><th>Resoluciones</th><th>Cierres ordinarios</th></tr></thead><tbody><tr><td>{formatMetric(data.performance.averageFirstActionSeconds)}</td><td>{formatMetric(data.performance.averageResolutionSeconds)}</td><td>{data.performance.resolvedCount}</td><td>{data.performance.closedCount}</td></tr></tbody></table></div>
    </div>
    {data.snapshot.assignedByTechnician ? <div className="panel stack"><h2>Carga por técnico</h2><div className="table-wrap"><table aria-label="Carga abierta por técnico"><thead><tr><th>Técnico</th><th>Abiertas asignadas</th></tr></thead><tbody>{data.snapshot.assignedByTechnician.map((row) => <tr key={row.id}><td>{row.displayName}</td><td>{row.count}</td></tr>)}</tbody></table></div></div> : null}
    {data.breakdown ? <div className="panel stack"><h2>Desglose por técnico</h2><div className="table-wrap"><table aria-label="Rendimiento por técnico"><thead><tr><th>Técnico</th><th>Abiertas</th><th>Primera actuación</th><th>Resolución</th><th>Resueltas</th><th>Cerradas</th></tr></thead><tbody>{data.breakdown.map((row) => <tr key={row.id}><td>{row.displayName}</td><td>{row.assignedOpen}</td><td>{formatMetric(row.averageFirstActionSeconds)}</td><td>{formatMetric(row.averageResolutionSeconds)}</td><td>{row.resolvedCount}</td><td>{row.closedCount}</td></tr>)}</tbody></table></div></div> : null}
  </>;
}

function formatMetric(metric: { value: number | null; sampleSize: number }): string { return metric.value === null ? "— (sin muestra)" : `${formatDuration(metric.value)} · ${metric.sampleSize} ${metric.sampleSize === 1 ? "caso" : "casos"}`; }
function formatDuration(seconds: number): string { const totalMinutes = Math.round(seconds / 60); const hours = Math.floor(totalMinutes / 60); const minutes = totalMinutes % 60; return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`; }
function Denied({ message }: { message: string }) { return <main className="shell"><section className="content"><div className="panel"><p className="message error">{message}</p></div></section></main>; }
