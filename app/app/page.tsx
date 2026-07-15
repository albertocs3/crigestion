import Link from "next/link";
import { requireAuthenticatedPage } from "@/modules/platform/presentation/pageAccess";
import { ChangePasswordForm } from "@/modules/platform/presentation/ChangePasswordForm";
import { LogoutButton } from "@/modules/platform/presentation/LogoutButton";

export const dynamic = "force-dynamic";

export default async function AppHomePage() {
  const session = await requireAuthenticatedPage();
  const permissions = session.user.permissions;
  const utilities = [
    permissions.includes("Platform.ManageUsers")
      ? { href: "/app/users", label: "Gestionar usuarios" }
      : null,
    permissions.includes("Platform.ManageRoles")
      ? { href: "/app/roles", label: "Gestionar roles" }
      : null,
    permissions.includes("Platform.ManageSessions")
      ? { href: "/app/sessions", label: "Gestionar sesiones" }
      : null,
    permissions.includes("Platform.ManageConfiguration")
      ? { href: "/app/configuration", label: "Configuracion" }
      : null,
    permissions.includes("Billing.ManageVerifactuCredentials")
      ? { href: "/app/verifactu/credentials", label: "Credenciales VeriFactu" }
      : null,
    permissions.includes("Billing.ManageVerifactuInstallations")
      ? { href: "/app/verifactu/installations", label: "Instalaciones SIF VeriFactu" }
      : null,
    permissions.includes("Billing.ViewVerifactuOperations")
      ? { href: "/app/verifactu/operations", label: "Operaciones VeriFactu" }
      : null,
    permissions.includes("Platform.ViewAudit")
      ? { href: "/app/audit", label: "Ver auditoria" }
      : null,
    permissions.includes("Platform.ManageBackups")
      ? { href: "/app/backups", label: "Copias de seguridad" }
      : null,
    permissions.includes("Platform.ManageBackups")
      ? { href: "/app/restores", label: "Restauraciones" }
      : null
  ].filter((utility): utility is { href: string; label: string } => utility !== null);
  const modules = [
    permissions.includes("Customers.View")
      ? { href: "/app/customers", label: "Clientes", tone: "customers" }
      : null,
    permissions.includes("Catalog.View")
      ? { href: "/app/catalog", label: "Catalogo", tone: "catalog" }
      : null,
    permissions.includes("Billing.View")
      ? { href: "/app/invoices", label: "Facturas", tone: "billing" }
      : null,
    permissions.includes("Treasury.ManagePayments")
      ? { href: "/app/treasury", label: "Tesoreria", tone: "treasury" }
      : null,
    permissions.includes("Accounting.View")
      ? { href: "/app/accounting", label: "Contabilidad", tone: "accounting" }
      : null
  ].filter(
    (module): module is { href: string; label: string; tone: string } => module !== null
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <LogoutButton />
      </header>
      <section className="content stack">
        <h1 className="sr-only">Inicio</h1>
        <div className="panel home-overview">
          <div className="home-main">
            <div className="home-session-summary">
              <p className="muted">
                Sesion activa de <strong>{session.user.displayName}</strong> con rol{" "}
                <strong>{session.user.role.name}</strong>.
              </p>
              <p className="home-expiry">
                <span className="data-label">Caducidad</span>
                <strong>
                  <time dateTime={session.expiresAt}>
                    {new Date(session.expiresAt).toLocaleString("es-ES")}
                  </time>
                </strong>
              </p>
            </div>
            <nav className="home-module-grid" aria-label="Modulos principales">
              {modules.map((module) => (
                <Link
                  className={`home-module-card home-module-${module.tone}`}
                  href={module.href}
                  key={module.href}
                >
                  {module.label}
                </Link>
              ))}
            </nav>
          </div>
          {utilities.length > 0 ? (
            <details className="home-utilities">
              <summary>Utilidades</summary>
              <nav aria-label="Utilidades de administracion">
                {utilities.map((utility) => (
                  <Link href={utility.href} key={utility.href}>
                    {utility.label}
                  </Link>
                ))}
              </nav>
            </details>
          ) : null}
        </div>
        <div className="panel stack">
          <ChangePasswordForm />
        </div>
      </section>
    </main>
  );
}
