import Link from "next/link";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import {
  listCommunicationFilterReferences,
  listCommunicationReferences,
  listSupportCommunications,
  listSupportCommunicationsSchema,
} from "@/modules/support/application/communications";
import { SupportCommunicationForm } from "@/modules/support/presentation/SupportCommunicationForm";
export const dynamic = "force-dynamic";
type CommunicationParams = { cursor?: string; customerId?: string; channel?: string; contactId?: string; incidentId?: string; direction?: string; result?: string; occurredFrom?: string; occurredTo?: string };
export default async function CommunicationsPage({
  searchParams,
}: {
  searchParams: Promise<CommunicationParams>;
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
  const safeParams: CommunicationParams = parsed.success ? parsed.data : {};
  const result = parsed.success
    ? await listSupportCommunications(parsed.data, auth.user)
    : { communications: [], nextCursor: null };
  const canManage = auth.user.permissions.includes(
    "Support.ManageCommunications",
  );
  const filterRefs = await listCommunicationFilterReferences({ customerId: safeParams.customerId, contactId: safeParams.contactId });
  const refs = canManage
    ? await listCommunicationReferences(
        safeParams.customerId,
      )
    : null;
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
          <form className="filter-row" action="/app/support/communications">
            {safeParams.incidentId ? <input type="hidden" name="incidentId" value={safeParams.incidentId}/> : null}
            <label>Cliente<select name="customerId" defaultValue={safeParams.customerId ?? ""}><option value="">Todos</option>{filterRefs.customers.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.legalName}</option>)}</select></label>
            <label>Contacto<select name="contactId" defaultValue={safeParams.contactId ?? ""}><option value="">Todos</option>{filterRefs.contacts.map((item) => { const customer = filterRefs.customers.find((candidate) => candidate.id === item.customerId); return <option key={item.id} value={item.id}>{customer ? `${customer.code} · ` : ""}{item.name ?? "Sin nombre"}{item.role ? ` · ${item.role}` : ""}{item.status === "ACTIVE" ? "" : " · Inactivo"}</option>; })}</select></label>
            <label>Canal<select name="channel" defaultValue={safeParams.channel ?? ""}><option value="">Todos</option><option value="PHONE">Teléfono</option><option value="WHATSAPP">WhatsApp</option></select></label>
            <label>Dirección<select name="direction" defaultValue={safeParams.direction ?? ""}><option value="">Todas</option><option value="INBOUND">Entrante</option><option value="OUTBOUND">Saliente</option></select></label>
            <label>Resultado<select name="result" defaultValue={safeParams.result ?? ""}><option value="">Todos</option><option value="RESOLVED_NO_FOLLOW_UP">Resuelta sin seguimiento</option><option value="REQUIRES_FOLLOW_UP">Requiere seguimiento</option><option value="NO_ANSWER">Sin respuesta</option><option value="INFORMATION_PROVIDED">Información facilitada</option><option value="REFERRED_TO_INCIDENT">Derivada a incidencia</option></select></label>
            <label>Ocurrida desde<input type="date" name="occurredFrom" defaultValue={safeParams.occurredFrom ?? ""}/></label><label>Ocurrida hasta<input type="date" name="occurredTo" defaultValue={safeParams.occurredTo ?? ""}/></label>
            <div className="form-actions"><button className="button">Filtrar</button><Link className="button button-secondary" href="/app/support/communications">Limpiar</Link></div>
          </form>
          {!parsed.success ? <p className="message error">Los filtros no son válidos.</p> : null}
          <div className="table-wrap">
            <table aria-label="Listado de comunicaciones">
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
                            {new Date(item.occurredAt).toLocaleString("es-ES", { timeZone: "Europe/Madrid" })}
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
          {result.nextCursor ? (
            <Link
              className="button button-secondary"
              href={nextHref(result.nextCursor, safeParams)}
            >
              Siguiente página
            </Link>
          ) : null}
        </div>
        {canManage && refs ? (
          <div className="panel stack" id="new-communication">
            <SupportCommunicationForm
              references={refs}
              defaultCustomerId={safeParams.customerId}
            />
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

function nextHref(
  cursor: string,
  params: CommunicationParams,
): string {
  const query = new URLSearchParams({ cursor });
  for (const key of ["customerId", "channel", "contactId", "incidentId", "direction", "result", "occurredFrom", "occurredTo"] as const) if (params[key]) query.set(key, params[key]!);
  return `/app/support/communications?${query}`;
}
