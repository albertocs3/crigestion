import Link from "next/link";
import { notFound } from "next/navigation";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import {
  getSupportCommunication,
  listCommunicationReferences,
  supportCommunicationParamsSchema,
} from "@/modules/support/application/communications";
import { SupportCommunicationForm } from "@/modules/support/presentation/SupportCommunicationForm";
export const dynamic = "force-dynamic";
export default async function CommunicationPage({
  params,
}: {
  params: Promise<{ communicationId: string }>;
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
  const parsed = supportCommunicationParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const item = await getSupportCommunication(
    parsed.data.communicationId,
    auth.user,
  );
  if (!item) notFound();
  const canManage = auth.user.permissions.includes(
    "Support.ManageCommunications",
  );
  const refs = canManage ? await listCommunicationReferences() : null;
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">CriGestión</div>
        <Link
          className="button button-secondary"
          href="/app/support/communications"
        >
          Volver
        </Link>
      </header>
      <section className="content stack">
        <div className="panel stack">
          <p className="eyebrow">Comunicación · v{item.version}</p>
          <h1>
            {item.customer.code} · {item.customer.legalName}
          </h1>
          <dl className="detail-grid">
            <div>
              <dt>Fecha</dt>
              <dd>{new Date(item.occurredAt).toLocaleString("es-ES")}</dd>
            </div>
            <div>
              <dt>Canal</dt>
              <dd>{item.channel === "PHONE" ? "Teléfono" : "WhatsApp"}</dd>
            </div>
            <div>
              <dt>Dirección</dt>
              <dd>{item.direction === "INBOUND" ? "Entrante" : "Saliente"}</dd>
            </div>
            <div>
              <dt>Número</dt>
              <dd>{item.contactNumber}</dd>
            </div>
            <div>
              <dt>Registrada por</dt>
              <dd>{item.registeredBy.displayName}</dd>
            </div>
            <div>
              <dt>Incidencia</dt>
              <dd>
                {item.incident ? (
                  <Link href={`/app/support/incidents/${item.incident.id}`}>
                    {item.incident.number}
                  </Link>
                ) : (
                  "Sin incidencia"
                )}
              </dd>
            </div>
          </dl>
          <div>
            <h2>Resumen</h2>
            <p style={{ whiteSpace: "pre-wrap" }}>{item.summary}</p>
          </div>
        </div>
        {item.corrections.length ? (
          <div className="panel stack">
            <h2>Correcciones</h2>
            {item.corrections.map((correction) => (
              <article className="compact-stack" key={correction.id}>
                <strong>
                  {correction.correctedBy.displayName} ·{" "}
                  {new Date(correction.correctedAt).toLocaleString("es-ES")}
                </strong>
                <p>
                  <strong>Motivo:</strong> {correction.reason}
                </p>
                <p>
                  <strong>Resumen anterior:</strong>{" "}
                  {correction.previous.summary}
                </p>
              </article>
            ))}
          </div>
        ) : null}
        {canManage && refs ? (
          <div className="panel stack">
            <SupportCommunicationForm references={refs} current={item} />
          </div>
        ) : null}
      </section>
    </main>
  );
}
