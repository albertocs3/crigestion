import Link from "next/link";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

async function getInstallationStatus() {
  const installation = await prisma.installation.findFirst({
    select: {
      status: true,
      completedAt: true
    }
  });

  return installation ?? null;
}

export default async function HomePage() {
  const installation = await getInstallationStatus();
  const isInitialized = installation?.status === "INITIALIZED";

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <span className="status">
          <span className="status-dot" />
          {isInitialized ? "Inicializado" : "Pendiente de inicializacion"}
        </span>
      </header>
      <section className="content">
        <div className="panel stack">
          <div>
            <h1>Plataforma CriGestión</h1>
            <p className="muted">
              Base Next.js con TypeScript, PostgreSQL y Prisma preparada para la
              primera rebanada vertical.
            </p>
          </div>
          <div>
            <Link className="button" href="/platform/installation">
              Abrir inicializacion
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
