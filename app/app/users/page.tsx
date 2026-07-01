import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  requirePermission,
  sessionCookieName
} from "@/modules/platform/application/auth";
import {
  listAssignableRoles,
  listUsers
} from "@/modules/platform/application/users";
import { UserCreateForm } from "@/modules/platform/presentation/UserCreateForm";
import { UserRoleSelect } from "@/modules/platform/presentation/UserRoleSelect";
import { UserStatusButton } from "@/modules/platform/presentation/UserStatusButton";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const cookieStore = await cookies();
  const authorization = await requirePermission(
    cookieStore.get(sessionCookieName)?.value,
    "Platform.ManageUsers"
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
            <h1>Usuarios</h1>
            <p className="message error">{authorization.error.message}</p>
          </div>
        </section>
      </main>
    );
  }

  const [users, roles] = await Promise.all([listUsers(), listAssignableRoles()]);

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
            <h1>Usuarios</h1>
            <p className="muted">
              Usuarios internos, estado de acceso y rol asignado.
            </p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Usuario</th>
                  <th>Nombre</th>
                  <th>Rol</th>
                  <th>Estado</th>
                  <th>Ultimo acceso</th>
                  <th>Bloqueo</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>{user.userName}</td>
                    <td>{user.displayName}</td>
                    <td>
                      <UserRoleSelect
                        userId={user.id}
                        currentRoleCode={user.role.code}
                        roles={roles}
                        isCurrentUser={user.id === authorization.user.id}
                      />
                    </td>
                    <td>{user.status}</td>
                    <td>{formatDate(user.lastLoginAt)}</td>
                    <td>{formatDate(user.lockedUntil)}</td>
                    <td>
                      <UserStatusButton
                        userId={user.id}
                        status={user.status}
                        isCurrentUser={user.id === authorization.user.id}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel stack">
          <UserCreateForm roles={roles} />
        </div>
      </section>
    </main>
  );
}

function formatDate(value: string | null): string {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString("es-ES");
}
