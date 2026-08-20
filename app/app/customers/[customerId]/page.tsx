import Link from "next/link";
import { z } from "zod";
import {
  listCustomerAddresses,
  type CustomerAddressListItem,
} from "@/modules/customers/application/addresses";
import {
  getCustomerDetail,
  type CustomerDetail,
  type CustomerListItem,
} from "@/modules/customers/application/customers";
import { listCustomerStores } from "@/modules/customers/application/stores";
import { CustomerEditForm } from "@/modules/customers/presentation/CustomerEditForm";
import { CustomerStatusButton } from "@/modules/customers/presentation/CustomerStatusButton";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import {
  getCustomerSupportContext,
  type CustomerSupportContextDto,
} from "@/modules/support/application/customerContext";

export const dynamic = "force-dynamic";

type CustomerDetailPageProps = {
  params: Promise<{
    customerId: string;
  }>;
};

const paramsSchema = z.object({
  customerId: z.string().uuid(),
});

export default async function CustomerDetailPage({
  params,
}: CustomerDetailPageProps) {
  const authorization = await authorizePagePermission("Customers.View");
  const parsedParams = paramsSchema.safeParse(await params);

  if (!authorization.ok) {
    return (
      <main className="shell">
        <header className="topbar">
          <div className="brand">CriGestión</div>
          <Link className="button button-secondary" href="/app/customers">
            Volver
          </Link>
        </header>
        <section className="content">
          <div className="panel stack">
            <h1>Ficha de cliente</h1>
            <p className="message error">{authorization.message}</p>
          </div>
        </section>
      </main>
    );
  }

  if (!parsedParams.success) {
    return (
      <main className="shell">
        <header className="topbar">
          <div className="brand">CriGestión</div>
          <Link className="button button-secondary" href="/app/customers">
            Volver
          </Link>
        </header>
        <section className="content">
          <div className="panel stack">
            <h1>Ficha de cliente</h1>
            <p className="message error">Identificador de cliente invalido.</p>
          </div>
        </section>
      </main>
    );
  }

  const customer = await getCustomerDetail(
    parsedParams.data.customerId,
    authorization.user,
  );
  const addresses = customer
    ? await listCustomerAddresses(
        customer.id,
        { status: "ACTIVE" },
        authorization.user,
      )
    : null;
  const stores = customer
    ? await listCustomerStores(
        customer.id,
        { status: "ACTIVE" },
        authorization.user,
      )
    : null;
  const canManage = authorization.user.permissions.includes("Customers.Manage");
  const canViewSupport = authorization.user.permissions.includes("Support.View");
  const supportContextResult =
    customer && canViewSupport
      ? await getCustomerSupportContext(customer.id, authorization.user)
      : null;
  const supportContext =
    supportContextResult?.ok === true ? supportContextResult.value : null;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <div className="button-row">
          <Link className="button button-secondary" href="/app/customers">
            Clientes
          </Link>
          {customer ? (
            <>
              <Link
                className="button button-secondary"
                href={`/app/customers/${customer.id}/addresses`}
              >
                Direcciones
              </Link>
              <Link
                className="button button-secondary"
                href={`/app/customers/${customer.id}/stores`}
              >
                Tiendas
              </Link>
              <Link
                className="button button-secondary"
                href={`/app/customers/${customer.id}/contacts`}
              >
                Contactos
              </Link>
            </>
          ) : null}
        </div>
      </header>
      <section className="content stack">
        {!customer ? (
          <div className="panel stack">
            <h1>Ficha de cliente</h1>
            <p className="message error">El cliente no existe.</p>
          </div>
        ) : (
          <>
            <div className="panel stack">
              <div className="split-header">
                <div>
                  <h1>{customer.legalName}</h1>
                  <p className="muted">
                    {customer.code} · {typeLabel(customer.type)} ·{" "}
                    {renderStatus(customer.status)}
                  </p>
                </div>
                {canManage ? (
                  <div className="compact-stack">
                    <CustomerEditForm customer={customer} />
                    <CustomerStatusButton
                      customerId={customer.id}
                      status={customer.status}
                    />
                  </div>
                ) : null}
              </div>

              <div className="data-grid">
                <div>
                  <span className="muted">Nombre comercial</span>
                  <strong>{customer.tradeName ?? "-"}</strong>
                </div>
                <div>
                  <span className="muted">Identificador fiscal</span>
                  <strong>{customer.taxId}</strong>
                </div>
                <div>
                  <span className="muted">Tratamiento fiscal</span>
                  <strong>
                    {fiscalTreatmentLabel(customer.fiscalTreatment)}
                  </strong>
                </div>
                <div>
                  <span className="muted">Metodo de pago</span>
                  <strong>
                    {paymentMethodLabel(
                      customer.commercialTerms.defaultPaymentMethod,
                    )}
                  </strong>
                </div>
                <div>
                  <span className="muted">Vencimiento</span>
                  <strong>{paymentTermsLabel(customer.commercialTerms)}</strong>
                </div>
                <div>
                  <span className="muted">Limite de credito</span>
                  <strong>{customer.commercialTerms.creditLimit ?? "-"}</strong>
                </div>
                <div>
                  <span className="muted">Direcciones activas</span>
                  <strong>{addresses?.addresses.length ?? 0}</strong>
                </div>
                <div>
                  <span className="muted">Tiendas activas</span>
                  <strong>
                    {stores?.stores.length ?? customer.storeCounts.active}
                  </strong>
                </div>
              </div>
            </div>

            {canViewSupport ? (
              <CustomerSupportSection
                customerId={customer.id}
                context={supportContext}
                canCreateIncident={authorization.user.permissions.includes(
                  "Support.Create",
                )}
                canManageCommunications={
                  authorization.user.permissions.includes(
                    "Support.ViewCommunications",
                  ) &&
                  authorization.user.permissions.includes(
                    "Support.ManageCommunications",
                  )
                }
              />
            ) : null}

            <div className="panel stack">
              <div className="split-header">
                <div>
                  <h2>Datos fiscales y contacto</h2>
                  <p className="muted">
                    Identidad, contacto general y domicilio fiscal.
                  </p>
                </div>
              </div>
              <div className="data-grid">
                <div>
                  <span className="muted">Email</span>
                  <strong>{customer.email ?? "-"}</strong>
                </div>
                <div>
                  <span className="muted">Telefono</span>
                  <strong>{customer.phone ?? "-"}</strong>
                </div>
                <div>
                  <span className="muted">Pais fiscal</span>
                  <strong>{customer.fiscalAddress.country}</strong>
                </div>
                <div>
                  <span className="muted">Direccion fiscal</span>
                  <strong>{customer.fiscalAddress.line}</strong>
                </div>
                <div>
                  <span className="muted">Poblacion</span>
                  <strong>
                    {customer.fiscalAddress.postalCode}{" "}
                    {customer.fiscalAddress.city}
                  </strong>
                </div>
                <div>
                  <span className="muted">Provincia</span>
                  <strong>{customer.fiscalAddress.province ?? "-"}</strong>
                </div>
              </div>
            </div>

            <div className="panel stack">
              <div className="split-header">
                <div>
                  <h2>Banco y SEPA</h2>
                  <p className="muted">
                    Cuenta bancaria y mandato activo para domiciliacion.
                  </p>
                </div>
              </div>
              <div className="data-grid">
                <div>
                  <span className="muted">IBAN</span>
                  <strong>{maskIban(customer.bankAccount.iban)}</strong>
                </div>
                <div>
                  <span className="muted">Mandato SEPA</span>
                  <strong>
                    {customer.bankAccount.sepaMandate?.reference ?? "-"}
                  </strong>
                </div>
                <div>
                  <span className="muted">Estado mandato</span>
                  <strong>
                    {customer.bankAccount.sepaMandate
                      ? sepaMandateStatusLabel(
                          customer.bankAccount.sepaMandate.status,
                        )
                      : "-"}
                  </strong>
                </div>
                <div>
                  <span className="muted">Fecha firma</span>
                  <strong>
                    {customer.bankAccount.sepaMandate?.signedAt ?? "-"}
                  </strong>
                </div>
                <div>
                  <span className="muted">Revocado</span>
                  <strong>
                    {formatDateTime(
                      customer.bankAccount.sepaMandate?.revokedAt,
                    )}
                  </strong>
                </div>
                <div>
                  <span className="muted">Uso previsto</span>
                  <strong>
                    {customer.commercialTerms.defaultPaymentMethod ===
                    "DIRECT_DEBIT"
                      ? "Domiciliacion"
                      : "No domiciliado"}
                  </strong>
                </div>
              </div>
            </div>

            <div className="panel stack">
              <div className="split-header">
                <div>
                  <h2>Direcciones</h2>
                  <p className="muted">
                    {addresses?.addresses.length ?? 0} activas de facturacion,
                    envio y otras ubicaciones.
                  </p>
                </div>
                <Link
                  className="button button-secondary"
                  href={`/app/customers/${customer.id}/addresses`}
                >
                  Gestionar direcciones
                </Link>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Direccion</th>
                      <th>Tipo</th>
                      <th>Contacto</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!addresses || addresses.addresses.length === 0 ? (
                      <tr>
                        <td colSpan={4}>
                          No hay direcciones activas para mostrar.
                        </td>
                      </tr>
                    ) : (
                      addresses.addresses.map((address) => (
                        <tr key={address.id}>
                          <td>
                            <strong>{address.label}</strong>
                            <span className="cell-detail">
                              {address.address.line}
                            </span>
                            <span className="cell-detail">
                              {address.address.postalCode}{" "}
                              {address.address.city}
                            </span>
                            <span className="cell-detail">
                              {[
                                address.address.province,
                                address.address.country,
                              ]
                                .filter(Boolean)
                                .join(", ")}
                            </span>
                          </td>
                          <td>
                            <strong>{addressTypeLabel(address.type)}</strong>
                            {address.isPrimary ? (
                              <span className="cell-detail">Principal</span>
                            ) : null}
                          </td>
                          <td>
                            <strong>{address.contact.name ?? "-"}</strong>
                            <span className="cell-detail">
                              {address.contact.email ?? "-"}
                            </span>
                            <span className="cell-detail">
                              {address.contact.phone ?? "-"}
                            </span>
                          </td>
                          <td>{renderAddressStatus(address.status)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="panel stack">
              <div className="split-header">
                <div>
                  <h2>Tiendas</h2>
                  <p className="muted">
                    {customer.storeCounts.active} activas ·{" "}
                    {customer.storeCounts.inactive} inactivas
                  </p>
                </div>
                <Link
                  className="button button-secondary"
                  href={`/app/customers/${customer.id}/stores`}
                >
                  Gestionar tiendas
                </Link>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Tienda</th>
                      <th>Direccion</th>
                      <th>Contacto</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!stores || stores.stores.length === 0 ? (
                      <tr>
                        <td colSpan={4}>
                          No hay tiendas activas para mostrar.
                        </td>
                      </tr>
                    ) : (
                      stores.stores.map((store) => (
                        <tr key={store.id}>
                          <td>
                            <strong>{store.name}</strong>
                            <span className="cell-detail">{store.code}</span>
                            {store.isPrimary ? (
                              <span className="cell-detail">Principal</span>
                            ) : null}
                          </td>
                          <td>
                            <strong>{store.address.line}</strong>
                            <span className="cell-detail">
                              {store.address.postalCode} {store.address.city}
                            </span>
                            <span className="cell-detail">
                              {[store.address.province, store.address.country]
                                .filter(Boolean)
                                .join(", ")}
                            </span>
                          </td>
                          <td>
                            <strong>{store.contact.name ?? "-"}</strong>
                            <span className="cell-detail">
                              {store.contact.email ?? store.email ?? "-"}
                            </span>
                            <span className="cell-detail">
                              {store.contact.mobile ?? store.phone ?? "-"}
                            </span>
                          </td>
                          <td>{renderStoreStatus(store.status)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function CustomerSupportSection({
  customerId,
  context,
  canCreateIncident,
  canManageCommunications,
}: {
  customerId: string;
  context: CustomerSupportContextDto | null;
  canCreateIncident: boolean;
  canManageCommunications: boolean;
}) {
  const customerQuery = new URLSearchParams({ customerId }).toString();
  return (
    <div className="panel stack">
      <div className="split-header">
        <div>
          <h2>Atención al cliente</h2>
          <p className="muted">
            Incidencias y comunicaciones relacionadas con este cliente.
          </p>
        </div>
        <div className="button-row">
          {canCreateIncident ? (
            <Link
              className="button"
              href={`/app/support?${customerQuery}#new-incident`}
            >
              Nueva incidencia
            </Link>
          ) : null}
          {canManageCommunications ? (
            <Link
              className="button button-secondary"
              href={`/app/support/communications?${customerQuery}#new-communication`}
            >
              Nueva comunicación
            </Link>
          ) : null}
        </div>
      </div>
      {!context ? (
        <p className="message error">
          No se pudo cargar el contexto de soporte del cliente.
        </p>
      ) : (
        <>
          <p className="muted">
            Foto a <time dateTime={context.asOf}>{formatMadrid(context.asOf)}</time>.
          </p>
          <CustomerIncidentTable
            title="Incidencias abiertas"
            label="Incidencias abiertas del cliente"
            emptyMessage="No hay incidencias abiertas."
            total={context.openIncidents.total}
            incidents={context.openIncidents.items}
          />
          <CustomerIncidentTable
            title="Incidencias resueltas y cerradas"
            label="Incidencias finalizadas del cliente"
            emptyMessage="No hay incidencias resueltas ni cerradas."
            total={context.finalizedIncidents.total}
            incidents={context.finalizedIncidents.items}
          />
          <Link
            href={`/app/support?${customerQuery}`}
            className="button button-secondary"
          >
            Ver todas las incidencias del cliente
          </Link>
          {context.communications ? (
            <section className="stack" aria-labelledby="customer-communications">
              <div className="split-header">
                <h3 id="customer-communications">
                  Historial de comunicaciones ({context.communications.total})
                </h3>
                <Link href={`/app/support/communications?${customerQuery}`}>
                  Ver todo
                </Link>
              </div>
              <div className="table-wrap">
                <table aria-label="Comunicaciones del cliente">
                  <thead>
                    <tr>
                      <th scope="col">Fecha</th>
                      <th scope="col">Canal</th>
                      <th scope="col">Dirección</th>
                      <th scope="col">Resultado</th>
                      <th scope="col">Incidencia</th>
                    </tr>
                  </thead>
                  <tbody>
                    {context.communications.items.length === 0 ? (
                      <tr>
                        <td colSpan={5}>No hay comunicaciones registradas.</td>
                      </tr>
                    ) : (
                      context.communications.items.map((communication) => (
                        <tr key={communication.id}>
                          <td>
                            <Link
                              href={`/app/support/communications/${communication.id}`}
                            >
                              <time dateTime={communication.occurredAt}>
                                {formatMadrid(communication.occurredAt)}
                              </time>
                            </Link>
                          </td>
                          <td>
                            {communication.channel === "PHONE"
                              ? "Teléfono"
                              : "WhatsApp"}
                          </td>
                          <td>
                            {communication.direction === "INBOUND"
                              ? "Entrante"
                              : "Saliente"}
                          </td>
                          <td>{communicationResultLabel(communication.result)}</td>
                          <td>
                            {communication.incident ? (
                              <Link
                                href={`/app/support/incidents/${communication.incident.id}`}
                              >
                                {communication.incident.number}
                              </Link>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function CustomerIncidentTable({
  title,
  label,
  emptyMessage,
  total,
  incidents,
}: {
  title: string;
  label: string;
  emptyMessage: string;
  total: number;
  incidents: CustomerSupportContextDto["openIncidents"]["items"];
}) {
  return (
    <section className="stack">
      <h3>{title} ({total})</h3>
      <div className="table-wrap">
        <table aria-label={label}>
          <thead>
            <tr>
              <th scope="col">Incidencia</th>
              <th scope="col">Prioridad</th>
              <th scope="col">Estado</th>
              <th scope="col">Actualizada</th>
            </tr>
          </thead>
          <tbody>
            {incidents.length === 0 ? (
              <tr>
                <td colSpan={4}>{emptyMessage}</td>
              </tr>
            ) : (
              incidents.map((incident) => (
                <tr key={incident.id}>
                  <td>
                    <Link href={`/app/support/incidents/${incident.id}`}>
                      <strong>{incident.number}</strong>
                    </Link>
                    <span className="cell-detail">{incident.title}</span>
                    {incident.mergedInto ? (
                      <span className="cell-detail">
                        Fusionada en {incident.mergedInto.number}
                      </span>
                    ) : null}
                  </td>
                  <td>{supportPriorityLabel(incident.priority)}</td>
                  <td>{supportStatusLabel(incident.status)}</td>
                  <td>
                    <time dateTime={incident.updatedAt}>
                      {formatMadrid(incident.updatedAt)}
                    </time>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function supportPriorityLabel(value: string): string {
  return (
    ({ LOW: "Baja", MEDIUM: "Media", HIGH: "Alta", URGENT: "Urgente" } as Record<
      string,
      string
    >)[value] ?? value
  );
}

function supportStatusLabel(value: string): string {
  return (
    ({
      NEW: "Nueva",
      IN_PROGRESS: "En curso",
      PENDING_CUSTOMER: "Pendiente del cliente",
      PENDING_THIRD_PARTY: "Pendiente de tercero",
      RESOLVED: "Resuelta",
      CLOSED: "Cerrada",
    } as Record<string, string>)[value] ?? value
  );
}

function communicationResultLabel(value: string): string {
  return (
    ({
      RESOLVED_NO_FOLLOW_UP: "Resuelta sin seguimiento",
      REQUIRES_FOLLOW_UP: "Requiere seguimiento",
      NO_ANSWER: "Sin respuesta",
      INFORMATION_PROVIDED: "Información facilitada",
      REFERRED_TO_INCIDENT: "Derivada a incidencia",
    } as Record<string, string>)[value] ?? value
  );
}

function formatMadrid(value: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Madrid",
  }).format(new Date(value));
}

function renderStatus(status: CustomerListItem["status"]) {
  return (
    <span className="status">
      <span className={`status-dot status-dot-${status.toLowerCase()}`} />
      {status === "ACTIVE" ? "Activo" : "Inactivo"}
    </span>
  );
}

function renderStoreStatus(status: CustomerDetail["stores"][number]["status"]) {
  return (
    <span className="status">
      <span className={`status-dot status-dot-${status.toLowerCase()}`} />
      {status === "ACTIVE" ? "Activa" : "Inactiva"}
    </span>
  );
}

function renderAddressStatus(status: CustomerAddressListItem["status"]) {
  return (
    <span className="status">
      <span className={`status-dot status-dot-${status.toLowerCase()}`} />
      {status === "ACTIVE" ? "Activa" : "Inactiva"}
    </span>
  );
}

function typeLabel(type: CustomerListItem["type"]): string {
  switch (type) {
    case "COMPANY":
      return "Empresa";
    case "SELF_EMPLOYED":
      return "Autonomo";
    case "INDIVIDUAL":
      return "Particular";
  }
}

function fiscalTreatmentLabel(
  fiscalTreatment: CustomerListItem["fiscalTreatment"],
): string {
  switch (fiscalTreatment) {
    case "DOMESTIC":
      return "Nacional";
    case "EU":
      return "Intracomunitario";
    case "EXPORT":
      return "Exportacion";
    case "CANARY_CEUTA_MELILLA":
      return "Canarias, Ceuta o Melilla";
  }
}

function paymentMethodLabel(
  paymentMethod: CustomerListItem["commercialTerms"]["defaultPaymentMethod"],
): string {
  switch (paymentMethod) {
    case "BANK_TRANSFER":
      return "Transferencia";
    case "CASH":
      return "Contado";
    case "DIRECT_DEBIT":
      return "Domiciliacion";
  }
}

function addressTypeLabel(type: CustomerAddressListItem["type"]): string {
  switch (type) {
    case "BILLING":
      return "Facturacion";
    case "SHIPPING":
      return "Envio";
    case "OTHER":
      return "Otra";
  }
}

function sepaMandateStatusLabel(
  status: NonNullable<CustomerListItem["bankAccount"]["sepaMandate"]>["status"],
): string {
  switch (status) {
    case "ACTIVE":
      return "Activo";
    case "REVOKED":
      return "Revocado";
    case "INVALIDATED":
      return "Invalidado";
  }
}

function paymentTermsLabel(terms: CustomerListItem["commercialTerms"]): string {
  switch (terms.paymentTermsType) {
    case "IMMEDIATE":
      return "Al contado";
    case "DAYS":
      return `${terms.paymentDays ?? "-"} dias`;
    case "FIXED_DAY_OF_MONTH":
      return `Dia ${terms.paymentFixedDay ?? "-"} del mes`;
  }
}

function maskIban(value: string | null): string {
  if (!value) {
    return "-";
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("es-ES", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
