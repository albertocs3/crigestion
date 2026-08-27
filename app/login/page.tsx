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
        <div className="panel stack login-panel">
          <div>
            <p className="eyebrow">Gestión empresarial integrada</p>
            <h1>Acceso a CriGestión</h1>
            <p className="muted">Inicia sesión para acceder a tu espacio de trabajo.</p>
          </div>
          <LoginForm />
          <p className="login-help">Acceso restringido a usuarios autorizados.</p>
        </div>
      </section>
    </main>
  );
}
