import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function InstallationPage() {
  const installation = await prisma.installation.findFirst({
    include: {
      company: true,
      initialAdministrator: true
    }
  });

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <span className="muted">Instalacion</span>
      </header>
      <section className="content">
        <div className="panel stack">
          <h1>Estado de la instalacion</h1>
          {installation ? (
            <div className="stack">
              <p>
                Estado: <strong>{installation.status}</strong>
              </p>
              <p className="muted">
                Empresa: {installation.company?.legalName ?? "Pendiente"}
              </p>
              <p className="muted">
                Administrador:{" "}
                {installation.initialAdministrator?.userName ?? "Pendiente"}
              </p>
            </div>
          ) : (
            <p className="muted">
              La base aun no tiene una instalacion registrada. Usa el endpoint
              de inicializacion para crear los datos minimos.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
