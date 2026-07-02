import Link from "next/link";
import { listActiveSessions } from "@/modules/platform/application/sessions";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import { SessionRevokeButton } from "@/modules/platform/presentation/SessionRevokeButton";

export const dynamic = "force-dynamic";

export default async function SessionsPage() {
  const authorization = await authorizePagePermission("Platform.ManageSessions");

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
            <h1>Sesiones activas</h1>
            <p className="message error">{authorization.message}</p>
          </div>
        </section>
      </main>
    );
  }

  const sessions = await listActiveSessions(authorization.sessionId);

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
            <h1>Sesiones activas</h1>
            <p className="muted">
              Sesiones web no revocadas con cierre remoto controlado.
            </p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Usuario</th>
                  <th>Rol</th>
                  <th>Inicio</th>
                  <th>Ultima actividad</th>
                  <th>Caducidad</th>
                  <th>Origen</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {sessions.length === 0 ? (
                  <tr>
                    <td colSpan={7}>No hay sesiones activas.</td>
                  </tr>
                ) : (
                  sessions.map((session) => (
                    <tr key={session.id}>
                      <td>
                        <strong>{session.user.userName}</strong>
                        <span className="cell-detail">{session.user.displayName}</span>
                      </td>
                      <td>{session.user.role.name}</td>
                      <td>{formatDate(session.startedAt)}</td>
                      <td>{formatDate(session.lastActivityAt)}</td>
                      <td>{formatDate(session.expiresAt)}</td>
                      <td>
                        <span>{session.ipAddress ?? "-"}</span>
                        <span className="cell-detail">
                          {summarizeUserAgent(session.userAgent)}
                        </span>
                      </td>
                      <td>
                        <SessionRevokeButton
                          sessionId={session.id}
                          isCurrentSession={session.isCurrentSession}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("es-ES");
}

function summarizeUserAgent(value: string | null): string {
  if (!value) {
    return "-";
  }

  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}
