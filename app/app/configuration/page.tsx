import Link from "next/link";
import { getPlatformConfiguration } from "@/modules/platform/application/configuration";
import { CompanyConfigurationForm } from "@/modules/platform/presentation/CompanyConfigurationForm";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

export default async function ConfigurationPage() {
  const authorization = await authorizePagePermission("Platform.ManageConfiguration");

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
            <h1>Configuracion</h1>
            <p className="message error">{authorization.message}</p>
          </div>
        </section>
      </main>
    );
  }

  const configuration = await getPlatformConfiguration();

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
            <h1>Configuracion</h1>
            <p className="muted">
              Datos base de empresa y estado tecnico de la instalacion.
            </p>
          </div>

          {configuration ? (
            <>
              <div className="data-grid">
                <div>
                  <span className="data-label">Version</span>
                  <strong>{configuration.installation.productVersion}</strong>
                </div>
                <div>
                  <span className="data-label">Estado</span>
                  <strong>{configuration.installation.status}</strong>
                </div>
                <div>
                  <span className="data-label">Actualizacion</span>
                  <strong>{formatDate(configuration.company.updatedAt)}</strong>
                </div>
              </div>
              <CompanyConfigurationForm company={configuration.company} />
            </>
          ) : (
            <p className="message error">La configuracion de plataforma no existe.</p>
          )}
        </div>
      </section>
    </main>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("es-ES");
}
