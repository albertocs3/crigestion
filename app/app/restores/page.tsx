import Link from "next/link";
import {
  listBackupOperations,
  listBackupOperationsSchema,
  type BackupOperationListItem
} from "@/modules/platform/application/backups";
import { getMaintenanceModeState } from "@/modules/platform/application/maintenance";
import {
  listRestoreOperations,
  listRestoreOperationsSchema,
  type RestoreOperationListItem
} from "@/modules/platform/application/restores";
import { MaintenanceModePanel } from "@/modules/platform/presentation/MaintenanceModePanel";
import { RestoreRequestForm } from "@/modules/platform/presentation/RestoreRequestForm";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

type RestoresPageProps = {
  searchParams: Promise<{
    cursor?: string;
    status?: string;
  }>;
};

const statusOptions = [
  "REQUESTED",
  "VALIDATING",
  "VALIDATED",
  "PREPARING",
  "RESTORING",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "REQUIRES_RECOVERY"
] as const;

export default async function RestoresPage({ searchParams }: RestoresPageProps) {
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
            <h1>Restauraciones</h1>
            <p className="message error">{authorization.message}</p>
          </div>
        </section>
      </main>
    );
  }

  const payload = listRestoreOperationsSchema.safeParse({
    limit: 25,
    cursor: params.cursor,
    status: params.status
  });
  const restores = payload.success
    ? await listRestoreOperations(payload.data, authorization.user)
    : { restores: [], nextCursor: null };
  const verifiedBackups = await listVerifiedBackups(authorization.user);
  const validatedRestores = await listValidatedRestores(authorization.user);
  const canManageMaintenance = authorization.user.permissions.includes(
    "Platform.ManageMaintenance"
  );
  const maintenance = canManageMaintenance
    ? await getMaintenanceModeState()
    : null;

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
            <h1>Restauraciones</h1>
            <p className="muted">
              Validacion previa de copias y activacion controlada del modo
              mantenimiento. La restauracion real requiere confirmacion explicita
              con mantenimiento activo.
            </p>
          </div>

          <RestoreRequestForm backups={verifiedBackups} />

          {canManageMaintenance && maintenance ? (
            <MaintenanceModePanel
              maintenance={maintenance}
              validatedRestores={validatedRestores}
            />
          ) : (
            <p className="muted">
              El modo mantenimiento requiere permiso de administracion especifico.
            </p>
          )}

          <form className="filter-row" action="/app/restores">
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
              <Link className="button button-secondary" href="/app/restores">
                Limpiar
              </Link>
            </div>
          </form>

          {!payload.success ? (
            <p className="message error">Filtro de restauraciones invalido.</p>
          ) : null}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Solicitud</th>
                  <th>Estado</th>
                  <th>Copia</th>
                  <th>Resultado</th>
                </tr>
              </thead>
              <tbody>
                {restores.restores.length === 0 ? (
                  <tr>
                    <td colSpan={4}>No hay restauraciones para mostrar.</td>
                  </tr>
                ) : (
                  restores.restores.map((restore) => (
                    <tr key={restore.id}>
                      <td>
                        <strong>{formatDate(restore.requestedAt)}</strong>
                        <span className="cell-detail">{restore.id}</span>
                        <span className="cell-detail">
                          {restore.requestedBy.displayName} (
                          {restore.requestedBy.userName})
                        </span>
                        <span className="cell-detail">{restore.reason}</span>
                      </td>
                      <td>{renderStatus(restore.status)}</td>
                      <td>
                        <strong>{formatDate(restore.backup.requestedAt)}</strong>
                        <span className="cell-detail">{restore.backup.id}</span>
                        <span className="cell-detail">
                          Version {restore.backup.productVersion}
                        </span>
                        <span className="cell-detail">
                          SHA-256: {restore.backup.sha256 ?? "Sin dato"}
                        </span>
                      </td>
                      <td>{renderResult(restore)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {restores.nextCursor ? (
            <div className="button-row">
              <Link
                className="button button-secondary"
                href={nextPageHref(restores.nextCursor, params.status)}
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

async function listVerifiedBackups(
  user: Parameters<typeof listBackupOperations>[1]
): Promise<BackupOperationListItem[]> {
  const result = await listBackupOperations(
    listBackupOperationsSchema.parse({ limit: 100, status: "VERIFIED" }),
    user
  );

  return result.backups;
}

async function listValidatedRestores(
  user: Parameters<typeof listRestoreOperations>[1]
): Promise<RestoreOperationListItem[]> {
  const result = await listRestoreOperations(
    listRestoreOperationsSchema.parse({ limit: 100, status: "VALIDATED" }),
    user
  );

  return result.restores;
}

function renderStatus(status: RestoreOperationListItem["status"]) {
  return (
    <span className="status">
      <span className={`status-dot status-dot-${status.toLowerCase()}`} />
      {statusLabel(status)}
    </span>
  );
}

function renderResult(restore: RestoreOperationListItem) {
  if (restore.status === "FAILED" || restore.status === "REQUIRES_RECOVERY") {
    return (
      <>
        <strong>{restore.errorCode ?? restore.status}</strong>
        <span className="cell-detail">
          Finalizada: {formatNullableDate(restore.completedAt)}
        </span>
      </>
    );
  }

  if (restore.status === "VALIDATED") {
    return (
      <>
        <strong>Lista para mantenimiento</strong>
        <span className="cell-detail">
          Validada: {formatNullableDate(restore.validatedAt)}
        </span>
      </>
    );
  }

  if (restore.status === "COMPLETED") {
    return (
      <>
        <strong>Completada</strong>
        <span className="cell-detail">
          Finalizada: {formatNullableDate(restore.completedAt)}
        </span>
      </>
    );
  }

  return (
    <>
      <strong>Proceso pendiente</strong>
      <span className="cell-detail">
        Inicio: {formatNullableDate(restore.startedAt)}
      </span>
    </>
  );
}

function statusLabel(status: RestoreOperationListItem["status"]): string {
  switch (status) {
    case "REQUESTED":
      return "Solicitada";
    case "VALIDATING":
      return "Validando";
    case "VALIDATED":
      return "Validada";
    case "PREPARING":
      return "Preparando";
    case "RESTORING":
      return "Restaurando";
    case "VERIFYING":
      return "Verificando";
    case "COMPLETED":
      return "Completada";
    case "FAILED":
      return "Fallida";
    case "REQUIRES_RECOVERY":
      return "Requiere recuperacion";
  }
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("es-ES");
}

function formatNullableDate(value: string | null): string {
  return value ? formatDate(value) : "Sin dato";
}

function nextPageHref(cursor: string, status: string | undefined): string {
  const searchParams = new URLSearchParams({ cursor });

  if (status) {
    searchParams.set("status", status);
  }

  return `/app/restores?${searchParams.toString()}`;
}
