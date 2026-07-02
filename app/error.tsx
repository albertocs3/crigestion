"use client";

export default function GlobalError({
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
      </header>
      <section className="content narrow">
        <div className="panel stack">
          <h1>No se pudo completar la operacion</h1>
          <p className="muted">
            Se ha producido un error inesperado. El detalle tecnico no se
            muestra en pantalla.
          </p>
          <button className="button" type="button" onClick={reset}>
            Reintentar
          </button>
        </div>
      </section>
    </main>
  );
}
