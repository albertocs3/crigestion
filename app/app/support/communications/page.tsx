import Link from "next/link";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import {
  listCommunicationReferences,
  listSupportCommunications,
  listSupportCommunicationsSchema,
} from "@/modules/support/application/communications";
import { SupportCommunicationForm } from "@/modules/support/presentation/SupportCommunicationForm";
export const dynamic = "force-dynamic";
export default async function CommunicationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    cursor?: string;
    customerId?: string;
    channel?: string;
  }>;
}) {
  const auth = await authorizePagePermission("Support.ViewCommunications");
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
  const params = await searchParams;
  const parsed = listSupportCommunicationsSchema.safeParse({
    limit: 25,
    ...params,
  });
  const result = parsed.success
    ? await listSupportCommunications(parsed.data, auth.user)
    : { communications: [], nextCursor: null };
  const canManage = auth.user.permissions.includes(
    "Support.ManageCommunications",
  );
  const refs = canManage ? await listCommunicationReferences() : null;
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <Link className="button button-secondary" href="/app/support">
          Volver
        </Link>
      </header>
      <section className="content stack">
        <div className="panel stack">
          <div>
            <p className="eyebrow">Atención al cliente</p>
            <h1>Comunicaciones</h1>
            <p className="muted">
              Registro cronológico de llamadas y WhatsApp.
            </p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Cliente</th>
                  <th>Canal</th>
                  <th>Dirección</th>
                  <th>Resultado</th>
                  <th>Incidencia</th>
                </tr>
              </thead>
              <tbody>
                {result.communications.length ? (
                  result.communications.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <Link href={`/app/support/communications/${item.id}`}>
                          <time dateTime={item.occurredAt}>
                            {new Date(item.occurredAt).toLocaleString("es-ES")}
                          </time>
                        </Link>
                      </td>
                      <td>
                        {item.customer.code} · {item.customer.legalName}
                      </td>
                      <td>
                        {item.channel === "PHONE" ? "Teléfono" : "WhatsApp"}
                      </td>
                      <td>
                        {item.direction === "INBOUND" ? "Entrante" : "Saliente"}
                      </td>
                      <td>{resultLabel(item.result)}</td>
                      <td>
                        {item.incident ? (
                          <Link
                            href={`/app/support/incidents/${item.incident.id}`}
                          >
                            {item.incident.number}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6}>No hay comunicaciones.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        {canManage && refs ? (
          <div className="panel stack">
            <SupportCommunicationForm references={refs} />
          </div>
        ) : null}
      </section>
    </main>
  );
}
function resultLabel(value: string) {
  return (
    (
      {
        RESOLVED_NO_FOLLOW_UP: "Resuelta sin seguimiento",
        REQUIRES_FOLLOW_UP: "Requiere seguimiento",
        NO_ANSWER: "Sin respuesta",
        INFORMATION_PROVIDED: "Información facilitada",
        REFERRED_TO_INCIDENT: "Derivada a incidencia",
      } as Record<string, string>
    )[value] ?? value
  );
}
