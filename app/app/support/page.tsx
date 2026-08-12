import Link from "next/link";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import { listSupportIncidents, listSupportIncidentsSchema, listSupportReferences } from "@/modules/support/application/incidents";
import { SupportIncidentCreateForm } from "@/modules/support/presentation/SupportIncidentCreateForm";
import { getUnreadNotificationCount } from "@/modules/platform/application/notifications";

export const dynamic = "force-dynamic";
type Props = { searchParams: Promise<{ cursor?: string; status?: string; priority?: string; search?: string }> };

export default async function SupportPage({ searchParams }: Props) {
  const authorization = await authorizePagePermission("Support.View");
  if (!authorization.ok) return <Denied message={authorization.message}/>;
  const params = await searchParams;
  const parsed = listSupportIncidentsSchema.safeParse({ limit: 25, ...params });
  const result = parsed.success ? await listSupportIncidents(parsed.data, authorization.user) : { incidents: [], nextCursor: null };
  const canCreate = authorization.user.permissions.includes("Support.Create");
  const unreadNotifications = await getUnreadNotificationCount(authorization.user);
  const references = canCreate ? await listSupportReferences() : null;
  return <main className="shell"><header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app">Volver</Link></header><section className="content stack">
    <div className="panel stack"><div><p className="eyebrow">Atención al cliente</p><h1>Incidencias</h1><p className="muted">Registro, asignación y seguimiento interno sin exponer datos económicos.</p><div className="form-actions"><Link className="button button-secondary" href="/app/notifications">Notificaciones ({unreadNotifications})</Link>{authorization.user.permissions.includes("Support.ViewIndicators") ? <Link className="button button-secondary" href="/app/support/indicators">Indicadores</Link> : null}{authorization.user.permissions.includes("Support.ViewCommunications") ? <Link className="button button-secondary" href="/app/support/communications">Comunicaciones</Link> : null}{authorization.user.permissions.includes("Support.ManageCategories") ? <Link className="button button-secondary" href="/app/support/categories">Categorías</Link> : null}</div></div>
      <form className="filter-row" action="/app/support"><label>Buscar<input name="search" maxLength={120} defaultValue={params.search ?? ""} placeholder="Número, título o descripción"/></label><label>Estado<select name="status" defaultValue={params.status ?? ""}><option value="">Todos</option><option value="NEW">Nueva</option><option value="IN_PROGRESS">En curso</option><option value="PENDING_CUSTOMER">Pendiente del cliente</option><option value="PENDING_THIRD_PARTY">Pendiente de tercero</option><option value="RESOLVED">Resuelta</option><option value="CLOSED">Cerrada</option></select></label><label>Prioridad<select name="priority" defaultValue={params.priority ?? ""}><option value="">Todas</option><option value="LOW">Baja</option><option value="MEDIUM">Media</option><option value="HIGH">Alta</option><option value="URGENT">Urgente</option></select></label><div className="form-actions"><button className="button">Filtrar</button><Link className="button button-secondary" href="/app/support">Limpiar</Link></div></form>
      {!parsed.success ? <p className="message error">Los filtros no son válidos.</p> : null}
      <div className="table-wrap"><table><thead><tr><th>Incidencia</th><th>Cliente</th><th>Categoría</th><th>Responsable</th><th>Prioridad</th><th>Estado</th></tr></thead><tbody>{result.incidents.length === 0 ? <tr><td colSpan={6}>No hay incidencias para mostrar.</td></tr> : result.incidents.map((incident) => <tr key={incident.id}><td><Link href={`/app/support/incidents/${incident.id}`}><strong>{incident.number}</strong></Link><span className="cell-detail">{incident.title}</span></td><td>{incident.customer.legalName}<span className="cell-detail">{incident.customer.code}{incident.customer.status === "INACTIVE" ? " · Inactivo" : ""}</span></td><td>{incident.category.name}</td><td>{incident.responsible.displayName}</td><td><span className={`badge ${incident.priority === "URGENT" ? "error" : incident.priority === "HIGH" ? "warning" : "neutral"}`}>{priorityLabel(incident.priority)}</span></td><td>{statusLabel(incident.status)}</td></tr>)}</tbody></table></div>
      {result.nextCursor ? <Link className="button button-secondary" href={nextHref(result.nextCursor, params)}>Siguiente página</Link> : null}
    </div>
    {canCreate && references ? <div className="panel stack"><SupportIncidentCreateForm references={references}/></div> : null}
  </section></main>;
}

function Denied({ message }: { message: string }) { return <main className="shell"><section className="content"><div className="panel stack"><h1>Atención al cliente</h1><p className="message error">{message}</p></div></section></main>; }
function priorityLabel(value: string) { return ({ LOW: "Baja", MEDIUM: "Media", HIGH: "Alta", URGENT: "Urgente" } as Record<string, string>)[value] ?? value; }
function statusLabel(value: string) { return ({ NEW: "Nueva", IN_PROGRESS: "En curso", PENDING_CUSTOMER: "Pendiente del cliente", PENDING_THIRD_PARTY: "Pendiente de tercero", RESOLVED: "Resuelta", CLOSED: "Cerrada" } as Record<string, string>)[value] ?? value; }
function nextHref(cursor: string, params: { status?: string; priority?: string; search?: string }) { const query = new URLSearchParams({ cursor }); if (params.status) query.set("status", params.status); if (params.priority) query.set("priority", params.priority); if (params.search) query.set("search", params.search); return `/app/support?${query}`; }
