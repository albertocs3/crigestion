import Link from "next/link";
import { notFound } from "next/navigation";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import { getSupportIncident, supportIncidentParamsSchema } from "@/modules/support/application/incidents";

export const dynamic = "force-dynamic";

export default async function SupportIncidentPage({ params }: { params: Promise<{ incidentId: string }> }) {
  const authorization = await authorizePagePermission("Support.View");
  if (!authorization.ok) return <main className="shell"><section className="content"><div className="panel stack"><h1>Incidencia</h1><p className="message error">{authorization.message}</p></div></section></main>;
  const parsed = supportIncidentParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const incident = await getSupportIncident(parsed.data.incidentId, authorization.user);
  if (!incident) notFound();
  return <main className="shell"><header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app/support">Volver a incidencias</Link></header><section className="content stack">
    <div className="panel stack"><div><p className="eyebrow">{incident.number}</p><h1>{incident.title}</h1><div className="form-actions"><span className={`badge ${incident.priority === "URGENT" ? "error" : incident.priority === "HIGH" ? "warning" : "neutral"}`}>{priorityLabel(incident.priority)}</span><span className="badge neutral">{statusLabel(incident.status)}</span></div></div><dl className="detail-grid"><div><dt>Cliente</dt><dd>{authorization.user.permissions.includes("Customers.View") ? <Link href={`/app/customers/${incident.customer.id}`}>{incident.customer.code} · {incident.customer.legalName}</Link> : `${incident.customer.code} · ${incident.customer.legalName}`}</dd></div><div><dt>Tienda</dt><dd>{incident.store ? `${incident.store.code} · ${incident.store.name}` : "Sin tienda"}</dd></div><div><dt>Categoría</dt><dd>{incident.category.name}</dd></div><div><dt>Responsable</dt><dd>{incident.responsible.displayName}</dd></div><div><dt>Creada por</dt><dd>{incident.createdBy.displayName}</dd></div><div><dt>Creación</dt><dd><time dateTime={incident.createdAt}>{new Date(incident.createdAt).toLocaleString("es-ES")}</time></dd></div></dl><div><h2>Descripción</h2><p style={{ whiteSpace: "pre-wrap" }}>{incident.description}</p></div></div>
    <div className="panel stack"><h2>Historial</h2><div className="table-wrap"><table><thead><tr><th>Fecha</th><th>Evento</th><th>Usuario</th><th>Estado</th></tr></thead><tbody>{incident.events.map((event) => <tr key={event.id}><td><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString("es-ES")}</time></td><td>{event.type === "CREATED" ? "Incidencia creada" : event.type}</td><td>{event.actor.displayName}</td><td>{event.toStatus ? statusLabel(event.toStatus) : "—"}</td></tr>)}</tbody></table></div></div>
  </section></main>;
}

function priorityLabel(value: string) { return ({ LOW: "Baja", MEDIUM: "Media", HIGH: "Alta", URGENT: "Urgente" } as Record<string, string>)[value] ?? value; }
function statusLabel(value: string) { return ({ NEW: "Nueva", IN_PROGRESS: "En curso", PENDING_CUSTOMER: "Pendiente del cliente", PENDING_THIRD_PARTY: "Pendiente de tercero", RESOLVED: "Resuelta", CLOSED: "Cerrada" } as Record<string, string>)[value] ?? value; }
