import { getInstallationState } from "@/modules/platform/application/installation";
import { InstallationForm } from "@/modules/platform/presentation/InstallationForm";
import { requireInstallationPageAccess } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

export default async function InstallationPage() {
  await requireInstallationPageAccess();

  const state = await getInstallationState();

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <span className="muted">Instalacion</span>
      </header>
      <section className="content">
        <div className="panel stack">
          <h1>Estado de la instalacion</h1>
          {state.installation ? (
            <div className="stack">
              <p>
                Estado: <strong>{state.installation.status}</strong>
              </p>
              <p className="muted">La instalacion aun no esta operativa.</p>
            </div>
          ) : (
            <div className="stack">
              <p className="muted">
                La base aun no tiene una instalacion registrada. Completa los
                datos minimos para crear la empresa y el primer administrador.
              </p>
              <InstallationForm />
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
