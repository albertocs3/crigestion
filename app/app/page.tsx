import Link from "next/link";
import { requireAuthenticatedPage } from "@/modules/platform/presentation/pageAccess";
import { ChangePasswordForm } from "@/modules/platform/presentation/ChangePasswordForm";
import { resolveTreasuryHomeHref } from "@/modules/platform/presentation/homeNavigation";
import { LogoutButton } from "@/modules/platform/presentation/LogoutButton";
import { getUnreadNotificationCount } from "@/modules/platform/application/notifications";

export const dynamic = "force-dynamic";

export default async function AppHomePage() {
  const session = await requireAuthenticatedPage();
  const permissions = session.user.permissions;
  const treasuryHref = resolveTreasuryHomeHref(permissions);
  const unreadNotifications = await getUnreadNotificationCount(session.user);
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
      ? {
          href: "/app/customers",
          label: "Clientes",
          description: "Maestro fiscal, contactos y condiciones comerciales",
          tone: "customers"
        }
      : null,
    permissions.includes("Suppliers.View")
      ? {
          href: "/app/suppliers",
          label: "Proveedores",
          description: "Proveedores, datos fiscales y condiciones de pago",
          tone: "customers"
        }
      : null,
    permissions.includes("Purchases.View")
      ? {
          href: "/app/purchases",
          label: "Compras",
          description: "Facturas recibidas, IVA, stock y pagos",
          tone: "billing"
        }
      : null,
    permissions.includes("Catalog.View")
      ? {
          href: "/app/catalog",
          label: "Catálogo",
          description: "Productos, servicios, impuestos y existencias",
          tone: "catalog"
        }
      : null,
    permissions.includes("Billing.View")
      ? {
          href: "/app/invoices",
          label: "Facturación",
          description: "Emisión, vencimientos, cobros, PDF y VeriFactu",
          tone: "billing"
        }
      : null,
    permissions.includes("Subscriptions.View")
      ? {
          href: "/app/subscriptions",
          label: "Suscripciones",
          description: "Contratos, renovaciones y facturación periódica",
          tone: "billing"
        }
      : null,
    permissions.includes("Support.View")
      ? {
          href: "/app/support",
          label: "Atención al cliente",
          description: "Incidencias, actuaciones, comunicaciones y avisos",
          tone: "customers"
        }
      : null,
    treasuryHref
      ? {
          href: treasuryHref,
          label: "Tesorería",
          description: "Cobros, pagos, remesas y conciliación bancaria",
          tone: "treasury"
        }
      : null,
    permissions.includes("Accounting.View")
      ? {
          href: "/app/accounting",
          label: "Contabilidad",
          description: "Plan contable, diario y gestión de ejercicios",
          tone: "accounting"
        }
      : null
  ].filter(
    (module): module is { href: string; label: string; description: string; tone: string } => module !== null
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <LogoutButton />
      </header>
      <section className="content stack">
        <div className="home-heading">
          <div>
            <p className="eyebrow">Gestión empresarial</p>
            <h1>Panel de control</h1>
            <p className="muted">Accede a las áreas operativas disponibles para tu perfil.</p>
          </div>
          <span className="status">
            <span className="status-dot status-dot-active" />
            {modules.length} módulos disponibles
          </span>
        </div>
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
            <Link className="home-notifications" href="/app/notifications">
              <span>Notificaciones</span>
              <strong>{unreadNotifications} sin leer</strong>
            </Link>
            <nav className="home-module-grid" aria-label="Modulos principales">
              {modules.map((module) => (
                <Link
                  className={`home-module-card home-module-${module.tone}`}
                  href={module.href}
                  key={module.href}
                >
                  <strong>{module.label}</strong>
                  <span>{module.description}</span>
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
        <details className="panel home-account">
          <summary>Seguridad de la cuenta</summary>
          <div className="home-account-content">
            <ChangePasswordForm />
          </div>
        </details>
      </section>
    </main>
  );
}
