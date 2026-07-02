import Link from "next/link";
import {
  listAuditEvents,
  listAuditEventsSchema
} from "@/modules/platform/application/audit";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

type AuditPageProps = {
  searchParams: Promise<{
    cursor?: string;
    eventType?: string;
  }>;
};

export default async function AuditPage({ searchParams }: AuditPageProps) {
  const authorization = await authorizePagePermission("Platform.ViewAudit");
  const params = await searchParams;

  if (!authorization.ok) {
    return (
      <main className="shell">
        <header className="topbar">
          <div className="brand">CriGestión</div>
          <Link className="button button-secondary" href="/app">
            Volver
          </Link>
        </header>
        <section className="content">
          <div className="panel stack">
            <h1>Auditoria</h1>
            <p className="message error">{authorization.message}</p>
          </div>
        </section>
      </main>
    );
  }

  const payload = listAuditEventsSchema.safeParse({
    limit: 25,
    cursor: params.cursor,
    eventType: params.eventType
  });

  const audit = payload.success
    ? await listAuditEvents(payload.data, authorization.user)
    : { events: [], nextCursor: null };

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <Link className="button button-secondary" href="/app">
          Volver
        </Link>
      </header>
      <section className="content stack">
        <div className="panel stack">
          <div>
            <h1>Auditoria</h1>
            <p className="muted">
              Eventos de seguridad y plataforma. Los payloads se muestran sin
              claves sensibles conocidas.
            </p>
          </div>

          <form className="filter-row" action="/app/audit">
            <label>
              Tipo de evento
              <input
                name="eventType"
                defaultValue={params.eventType ?? ""}
                maxLength={120}
                placeholder="LOGIN_SUCCEEDED"
              />
            </label>
            <div className="form-actions">
              <button className="button" type="submit">
                Filtrar
              </button>
              <Link className="button button-secondary" href="/app/audit">
                Limpiar
              </Link>
            </div>
          </form>

          {!payload.success ? (
            <p className="message error">Filtro de auditoria invalido.</p>
          ) : null}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Evento</th>
                  <th>Actor</th>
                  <th>Payload</th>
                </tr>
              </thead>
              <tbody>
                {audit.events.length === 0 ? (
                  <tr>
                    <td colSpan={4}>No hay eventos para mostrar.</td>
                  </tr>
                ) : (
                  audit.events.map((event) => (
                    <tr key={event.id}>
                      <td>{formatDate(event.createdAt)}</td>
                      <td>
                        <strong>{event.eventType}</strong>
                        <span className="cell-detail">{event.id}</span>
                      </td>
                      <td>{event.actorType}</td>
                      <td>
                        <code className="json-block">
                          {JSON.stringify(event.payload, null, 2)}
                        </code>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {audit.nextCursor ? (
            <div className="button-row">
              <Link className="button button-secondary" href={nextPageHref(audit.nextCursor, params.eventType)}>
                Siguiente pagina
              </Link>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("es-ES");
}

function nextPageHref(cursor: string, eventType: string | undefined): string {
  const searchParams = new URLSearchParams({ cursor });

  if (eventType) {
    searchParams.set("eventType", eventType);
  }

  return `/app/audit?${searchParams.toString()}`;
}
