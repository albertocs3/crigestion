import { LoginForm } from "@/modules/platform/presentation/LoginForm";
import { requireAnonymousInitializedPage } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  await requireAnonymousInitializedPage();

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <span className="muted">Acceso</span>
      </header>
      <section className="content narrow">
        <div className="panel stack">
          <div>
            <h1>Iniciar sesion</h1>
            <p className="muted">Acceso interno para usuarios autorizados.</p>
          </div>
          <LoginForm />
        </div>
      </section>
    </main>
  );
}
