import Link from "next/link";
import {
  listBackupOperations,
  listBackupOperationsSchema,
  type BackupOperationListItem
} from "@/modules/platform/application/backups";
import { BackupRequestButton } from "@/modules/platform/presentation/BackupRequestButton";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

type BackupsPageProps = {
  searchParams: Promise<{
    cursor?: string;
    status?: string;
  }>;
};

const statusOptions = ["REQUESTED", "RUNNING", "VERIFIED", "FAILED"] as const;

export default async function BackupsPage({ searchParams }: BackupsPageProps) {
  const authorization = await authorizePagePermission("Platform.ManageBackups");
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
            <h1>Copias de seguridad</h1>
            <p className="message error">{authorization.message}</p>
          </div>
        </section>
      </main>
    );
  }

  const payload = listBackupOperationsSchema.safeParse({
    limit: 25,
    cursor: params.cursor,
    status: params.status
  });

  const backups = payload.success
    ? await listBackupOperations(payload.data, authorization.user)
    : { backups: [], nextCursor: null };

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
            <h1>Copias de seguridad</h1>
            <p className="muted">
              Solicitudes manuales y resultado del worker de copias. Los artefactos
              no se descargan desde el navegador.
            </p>
          </div>

          <div className="button-row">
            <BackupRequestButton />
          </div>

          <form className="filter-row" action="/app/backups">
            <label>
              Estado
              <select name="status" defaultValue={params.status ?? ""}>
                <option value="">Todos</option>
                {statusOptions.map((status) => (
                  <option key={status} value={status}>
                    {statusLabel(status)}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-actions">
              <button className="button" type="submit">
                Filtrar
              </button>
              <Link className="button button-secondary" href="/app/backups">
                Limpiar
              </Link>
            </div>
          </form>

          {!payload.success ? (
            <p className="message error">Filtro de copias invalido.</p>
          ) : null}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Solicitud</th>
                  <th>Estado</th>
                  <th>Usuario</th>
                  <th>Resultado</th>
                </tr>
              </thead>
              <tbody>
                {backups.backups.length === 0 ? (
                  <tr>
                    <td colSpan={4}>No hay copias para mostrar.</td>
                  </tr>
                ) : (
                  backups.backups.map((backup) => (
                    <tr key={backup.id}>
                      <td>
                        <strong>{formatDate(backup.requestedAt)}</strong>
                        <span className="cell-detail">{backup.id}</span>
                        <span className="cell-detail">
                          Version {backup.productVersion}
                        </span>
                      </td>
                      <td>{renderStatus(backup.status)}</td>
                      <td>
                        <strong>{backup.requestedBy.displayName}</strong>
                        <span className="cell-detail">
                          {backup.requestedBy.userName}
                        </span>
                      </td>
                      <td>{renderResult(backup)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {backups.nextCursor ? (
            <div className="button-row">
              <Link
                className="button button-secondary"
                href={nextPageHref(backups.nextCursor, params.status)}
              >
                Siguiente pagina
              </Link>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function renderStatus(status: BackupOperationListItem["status"]) {
  return (
    <span className="status">
      <span className={`status-dot status-dot-${status.toLowerCase()}`} />
      {statusLabel(status)}
    </span>
  );
}

function renderResult(backup: BackupOperationListItem) {
  if (backup.status === "FAILED") {
    return (
      <>
        <strong>{backup.errorCode ?? "BACKUP_FAILED"}</strong>
        <span className="cell-detail">Finalizada: {formatNullableDate(backup.completedAt)}</span>
      </>
    );
  }

  if (backup.status === "VERIFIED") {
    return (
      <>
        <strong>{formatBytes(backup.sizeBytes)}</strong>
        <span className="cell-detail">SHA-256: {backup.sha256}</span>
        <span className="cell-detail">Finalizada: {formatNullableDate(backup.completedAt)}</span>
      </>
    );
  }

  return (
    <>
      <strong>{backup.status === "RUNNING" ? "En ejecucion" : "Pendiente"}</strong>
      <span className="cell-detail">Inicio: {formatNullableDate(backup.startedAt)}</span>
    </>
  );
}

function statusLabel(status: BackupOperationListItem["status"]): string {
  switch (status) {
    case "REQUESTED":
      return "Solicitada";
    case "RUNNING":
      return "En ejecucion";
    case "VERIFIED":
      return "Verificada";
    case "FAILED":
      return "Fallida";
  }
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("es-ES");
}

function formatNullableDate(value: string | null): string {
  return value ? formatDate(value) : "Sin dato";
}

function formatBytes(value: string | null): string {
  if (!value) {
    return "Sin tamano";
  }

  const bytes = Number(value);

  if (!Number.isSafeInteger(bytes)) {
    return `${value} bytes`;
  }

  return `${new Intl.NumberFormat("es-ES").format(bytes)} bytes`;
}

function nextPageHref(cursor: string, status: string | undefined): string {
  const searchParams = new URLSearchParams({ cursor });

  if (status) {
    searchParams.set("status", status);
  }

  return `/app/backups?${searchParams.toString()}`;
}
