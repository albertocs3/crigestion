import Link from "next/link";
import { listNotifications, notificationListSchema } from "@/modules/platform/application/notifications";
import { NotificationStateActions } from "@/modules/platform/presentation/NotificationStateActions";
import { requireAuthenticatedPage } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";
type Props = { searchParams: Promise<{ state?: string; cursor?: string }> };

export default async function NotificationsPage({ searchParams }: Props) {
  const session = await requireAuthenticatedPage();
  const params = await searchParams;
  const parsed = notificationListSchema.safeParse({ state: params.state ?? "UNREAD", cursor: params.cursor, limit: 25 });
  const result = parsed.success ? await listNotifications(session.user, parsed.data) : null;
  const state = parsed.success ? parsed.data.state : "UNREAD";
  return <main className="shell">
    <header className="topbar"><div className="brand">CriGestión</div><Link className="button button-secondary" href="/app">Volver</Link></header>
    <section className="content stack"><div className="panel stack">
      <div><p className="eyebrow">Actividad interna</p><h1>Notificaciones</h1><p className="muted">{result?.unreadCount ?? 0} sin leer. Se actualizan al navegar o recargar.</p></div>
      <nav className="form-actions" aria-label="Filtrar notificaciones">
        {([['UNREAD','Sin leer'],['READ','Leídas'],['ARCHIVED','Archivadas'],['ALL','Todas']] as const).map(([value,label]) => <Link key={value} className={`button ${state === value ? "" : "button-secondary"}`} aria-current={state === value ? "page" : undefined} href={`/app/notifications?state=${value}`}>{label}</Link>)}
      </nav>
      {!parsed.success || !result ? <p className="message error">Los filtros no son válidos.</p> : result.items.length === 0 ? <p className="muted">No hay notificaciones en este filtro.</p> : <ul className="stack" aria-label="Notificaciones">{result.items.map((item) => <li className="panel stack" key={item.id}>
        <div className="form-actions"><span className={`badge ${item.severity === "URGENT" || item.severity === "CRITICAL" ? "error" : "neutral"}`}>{severityLabel(item.severity)}</span><span className="badge neutral">{statusLabel(item.status)}</span></div>
        <div><strong>{messageLabel(item.messageCode)}</strong><p className="muted">Incidencia {item.incident.number}</p><time className="muted" dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("es-ES")}</time></div>
        <div className="form-actions"><Link className="button button-secondary button-small" href={item.incident.href}>Abrir incidencia</Link><NotificationStateActions id={item.id} status={item.status} version={item.version}/></div>
      </li>)}</ul>}
      {result?.nextCursor ? <Link className="button button-secondary" href={`/app/notifications?state=${state}&cursor=${encodeURIComponent(result.nextCursor)}`}>Siguiente página</Link> : null}
    </div></section>
  </main>;
}

function statusLabel(value: string) { return ({ UNREAD: "Sin leer", READ: "Leída", ARCHIVED: "Archivada" } as Record<string,string>)[value] ?? value; }
function severityLabel(value: string) { return ({ INFO: "Información", URGENT: "Urgente", CRITICAL: "Crítica" } as Record<string,string>)[value] ?? value; }
function messageLabel(value: string) { return ({ "support.incident.assigned": "Nueva incidencia asignada", "support.incident.reassigned": "Incidencia reasignada", "support.incident.urgent": "Incidencia urgente" } as Record<string,string>)[value] ?? "Nueva notificación"; }
