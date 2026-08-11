import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { listCustomerContacts } from "@/modules/customers/application/contacts";
import { listCustomerStores } from "@/modules/customers/application/stores";
import {
  CustomerContactForm,
  CustomerContactStatusButton,
} from "@/modules/customers/presentation/CustomerContactForm";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";

export const dynamic = "force-dynamic";
const paramsSchema = z.object({ customerId: z.string().uuid() });
export default async function CustomerContactsPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const auth = await authorizePagePermission("Customers.View");
  if (!auth.ok)
    return (
      <main className="shell">
        <section className="content">
          <div className="panel">
            <p className="message error">{auth.message}</p>
          </div>
        </section>
      </main>
    );
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const result = await listCustomerContacts(parsed.data.customerId, auth.user);
  if (!result) notFound();
  const stores = await listCustomerStores(
    parsed.data.customerId,
    { status: "ACTIVE" },
    auth.user,
  );
  const canManage = auth.user.permissions.includes("Customers.Manage");
  const hasGeneralContact = result.contacts.some(
    (contact) => contact.store === null,
  );
  const availableStores = (stores?.stores ?? [])
    .filter(
      (store) =>
        !result.contacts.some((contact) => contact.store?.id === store.id),
    )
    .map((store) => ({ id: store.id, code: store.code, name: store.name }));
  const canCreateContact = !hasGeneralContact || availableStores.length > 0;
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <Link
          className="button button-secondary"
          href={`/app/customers/${parsed.data.customerId}`}
        >
          Volver al cliente
        </Link>
      </header>
      <section className="content stack">
        <div className="panel stack">
          <div>
            <p className="eyebrow">{result.customer.code}</p>
            <h1>Contactos de {result.customer.legalName}</h1>
            <p className="muted">
              Un contacto general y uno por tienda, conservados como datos
              maestros.
            </p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ámbito</th>
                  <th>Nombre</th>
                  <th>Función</th>
                  <th>Teléfonos</th>
                  <th>Correo</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {result.contacts.length ? (
                  result.contacts.map((contact) => (
                    <tr key={contact.id}>
                      <td>
                        {contact.store
                          ? `${contact.store.code} · ${contact.store.name}`
                          : "General"}
                      </td>
                      <td>{contact.name ?? "—"}</td>
                      <td>{contact.role ?? "—"}</td>
                      <td>
                        {[contact.phone, contact.mobile, contact.whatsapp]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </td>
                      <td>{contact.email ?? "—"}</td>
                      <td>
                        {contact.status === "ACTIVE" ? "Activo" : "Inactivo"}
                      </td>
                      <td>
                        {canManage ? (
                          <CustomerContactStatusButton
                            customerId={parsed.data.customerId}
                            contact={contact}
                          />
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7}>No hay contactos estructurados.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        {canManage ? (
          <>
            <div className="panel stack">
              {canCreateContact ? (
                <CustomerContactForm
                  customerId={parsed.data.customerId}
                  stores={availableStores}
                  allowGeneral={!hasGeneralContact}
                />
              ) : (
                <p className="muted">
                  El contacto general y todas las tiendas activas ya tienen un
                  contacto maestro.
                </p>
              )}
            </div>
            {result.contacts.map((contact) => (
              <div className="panel stack" key={`edit-${contact.id}`}>
                <CustomerContactForm
                  customerId={parsed.data.customerId}
                  stores={[]}
                  current={contact}
                />
              </div>
            ))}
          </>
        ) : null}
      </section>
    </main>
  );
}
