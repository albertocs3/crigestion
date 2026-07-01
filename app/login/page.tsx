import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  getSessionState,
  sessionCookieName
} from "@/modules/platform/application/auth";
import { LoginForm } from "@/modules/platform/presentation/LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const cookieStore = await cookies();
  const session = await getSessionState(cookieStore.get(sessionCookieName)?.value);

  if (session.authenticated) {
    redirect("/app");
  }

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
