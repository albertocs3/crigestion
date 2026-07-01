import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  requirePermission,
  sessionCookieName
} from "@/modules/platform/application/auth";
import {
  listPermissions,
  listRoles
} from "@/modules/platform/application/roles";
import { RoleCreateForm } from "@/modules/platform/presentation/RoleCreateForm";
import { RolePermissionsForm } from "@/modules/platform/presentation/RolePermissionsForm";

export const dynamic = "force-dynamic";

export default async function RolesPage() {
  const cookieStore = await cookies();
  const authorization = await requirePermission(
    cookieStore.get(sessionCookieName)?.value,
    "Platform.ManageRoles"
  );

  if (!authorization.ok) {
    if (authorization.status === 401) {
      redirect("/login");
    }

    return (
      <main className="shell">
        <header className="topbar">
          <div className="brand">CriGestión</div>
          <Link className="button button-secondary" href="/app">
            Volver
          </Link>
        </header>
        <section className="content">
          <div className="panel stack">
            <h1>Roles</h1>
            <p className="message error">{authorization.error.message}</p>
          </div>
        </section>
      </main>
    );
  }

  const [roles, permissions] = await Promise.all([listRoles(), listPermissions()]);

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <Link className="button button-secondary" href="/app">
          Volver
        </Link>
      </header>
      <section className="content stack">
        <div className="panel stack">
          <div>
            <h1>Roles</h1>
            <p className="muted">
              Roles protegidos y personalizados con permisos asignados.
            </p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Codigo</th>
                  <th>Nombre</th>
                  <th>Tipo</th>
                  <th>Usuarios</th>
                  <th>Permisos</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <tr key={role.id}>
                    <td>{role.code}</td>
                    <td>{role.name}</td>
                    <td>{role.isProtected ? "Protegido" : "Personalizado"}</td>
                    <td>{role.userCount}</td>
                    <td>
                      <RolePermissionsForm role={role} permissions={permissions} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel stack">
          <RoleCreateForm permissions={permissions} />
        </div>
      </section>
    </main>
  );
}
