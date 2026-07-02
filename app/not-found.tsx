import Link from "next/link";

export default function NotFoundPage() {
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
      </header>
      <section className="content narrow">
        <div className="panel stack">
          <h1>Pagina no encontrada</h1>
          <p className="muted">
            La ruta solicitada no existe o ya no esta disponible.
          </p>
          <Link className="button" href="/">
            Volver al inicio
          </Link>
        </div>
      </section>
    </main>
  );
}
