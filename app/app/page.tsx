import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSessionState,
  sessionCookieName
} from "@/modules/platform/application/auth";
import { ChangePasswordForm } from "@/modules/platform/presentation/ChangePasswordForm";
import { LogoutButton } from "@/modules/platform/presentation/LogoutButton";

export const dynamic = "force-dynamic";

export default async function AppHomePage() {
  const cookieStore = await cookies();
  const session = await getSessionState(cookieStore.get(sessionCookieName)?.value);

  if (!session.authenticated) {
    redirect("/login");
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <LogoutButton />
      </header>
      <section className="content stack">
        <div className="panel stack">
          <div>
            <h1>Inicio operativo</h1>
            <p className="muted">
              Sesion activa de {session.user.displayName} con rol{" "}
              {session.user.role.name}.
            </p>
          </div>
          <div className="data-grid">
            <div>
              <span className="data-label">Usuario</span>
              <strong>{session.user.userName}</strong>
            </div>
            <div>
              <span className="data-label">Permisos</span>
              <strong>{session.user.permissions.length}</strong>
            </div>
            <div>
              <span className="data-label">Caducidad</span>
              <strong>{new Date(session.expiresAt).toLocaleString("es-ES")}</strong>
            </div>
          </div>
          <div>
            <div className="button-row">
              <Link className="button" href="/app/users">
                Gestionar usuarios
              </Link>
              <Link className="button button-secondary" href="/app/roles">
                Gestionar roles
              </Link>
            </div>
          </div>
        </div>
        <div className="panel stack">
          <ChangePasswordForm />
        </div>
      </section>
    </main>
  );
}
