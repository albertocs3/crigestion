import Link from "next/link";
import { notFound } from "next/navigation";
import { authorizePagePermission } from "@/modules/platform/presentation/pageAccess";
import {
  getSupportCommunication,
  isSupportCommunicationCorrectionsCursor,
  listCommunicationReferences,
  supportCommunicationDetailQuerySchema,
  supportCommunicationParamsSchema,
  type SupportCommunicationDto,
} from "@/modules/support/application/communications";
import { SupportCommunicationForm } from "@/modules/support/presentation/SupportCommunicationForm";
import { CommunicationIncidentForm } from "@/modules/support/presentation/CommunicationIncidentForm";
import { listSupportReferences } from "@/modules/support/application/incidents";
export const dynamic = "force-dynamic";
export default async function CommunicationPage({
  params,
  searchParams,
}: {
  params: Promise<{ communicationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
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
  const query = supportCommunicationDetailQuerySchema.safeParse(await searchParams);
  if (
    !query.success ||
    (query.data.correctionsCursor &&
      !isSupportCommunicationCorrectionsCursor(
        query.data.correctionsCursor,
        parsed.data.communicationId,
      ))
  ) notFound();
  const item = await getSupportCommunication(
    parsed.data.communicationId,
    auth.user,
    {},
    query.data.correctionsCursor,
  );
  if (!item) notFound();
  const canManage = auth.user.permissions.includes(
    "Support.ManageCommunications",
  );
  const canViewIncidents = auth.user.permissions.includes("Support.View");
  const canConvert =
    !item.incidentId &&
    canManage &&
    auth.user.permissions.includes("Support.Create") &&
    auth.user.permissions.includes("Support.View");
  const refs = canManage ? await listCommunicationReferences() : null;
  const incidentRefs = canConvert ? await listSupportReferences() : null;
  const customerRefs = incidentRefs?.customers.find(
    (customer) => customer.id === item.customer.id,
  );
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
              <dd><time dateTime={item.occurredAt}>{formatDate(item.occurredAt)}</time></dd>
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
              <dt>Contacto</dt>
              <dd>{item.contact ? item.contact.name ?? item.contact.role ?? "Contacto maestro" : "Sin contacto maestro"}</dd>
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
                  <time dateTime={correction.correctedAt}>{formatDate(correction.correctedAt)}</time>
                </strong>
                <span className="badge neutral">Versión {correction.resultingVersion}</span>
                <p>
                  <strong>Motivo:</strong> {correction.reason}
                </p>
                <CommunicationCorrectionChanges correction={correction} canViewIncidents={canViewIncidents} />
              </article>
            ))}
            {item.correctionsHasMore && item.correctionsNextCursor ? (
              <Link className="button button-secondary" href={`/app/support/communications/${item.id}?correctionsCursor=${encodeURIComponent(item.correctionsNextCursor)}`}>
                Ver correcciones anteriores
              </Link>
            ) : null}
            {query.data.correctionsCursor ? (
              <Link className="button button-secondary" href={`/app/support/communications/${item.id}`}>
                Volver a las correcciones recientes
              </Link>
            ) : null}
          </div>
        ) : null}
        {canManage && refs ? (
          <div className="panel stack">
            <SupportCommunicationForm references={refs} current={item} />
          </div>
        ) : null}
        {canConvert && incidentRefs ? (
          <div className="panel stack">
            <CommunicationIncidentForm
              communication={item}
              categories={incidentRefs.categories}
              responsibleUsers={incidentRefs.responsibleUsers}
              stores={customerRefs?.stores ?? []}
            />
          </div>
        ) : null}
      </section>
    </main>
  );
}

type CommunicationCorrection = SupportCommunicationDto["corrections"][number];

function CommunicationCorrectionChanges({ correction, canViewIncidents }: { correction: CommunicationCorrection; canViewIncidents: boolean }) {
  const { previous, corrected } = correction;
  return <dl className="detail-grid">
    {previous.channel !== corrected.channel ? <Change label="Canal" previous={channelLabel(previous.channel)} corrected={channelLabel(corrected.channel)} /> : null}
    {previous.direction !== corrected.direction ? <Change label="Dirección" previous={directionLabel(previous.direction)} corrected={directionLabel(corrected.direction)} /> : null}
    {previous.occurredAt !== corrected.occurredAt ? <DateChange previous={previous.occurredAt} corrected={corrected.occurredAt} /> : null}
    {previous.contactNumber !== corrected.contactNumber ? <Change label="Número" previous={previous.contactNumber} corrected={corrected.contactNumber} /> : null}
    {previous.contactId !== corrected.contactId ? <Change label="Contacto" previous={contactLabel(correction.previousContact, previous.contactId)} corrected={contactLabel(correction.correctedContact, corrected.contactId)} /> : null}
    {previous.durationSeconds !== corrected.durationSeconds ? <Change label="Duración" previous={durationLabel(previous.durationSeconds)} corrected={durationLabel(corrected.durationSeconds)} /> : null}
    {previous.summary !== corrected.summary ? <Change label="Resumen" previous={previous.summary} corrected={corrected.summary} preserveWhitespace /> : null}
    {previous.result !== corrected.result ? <Change label="Resultado" previous={resultLabel(previous.result)} corrected={resultLabel(corrected.result)} /> : null}
    {previous.incidentId !== corrected.incidentId ? <IncidentChange correction={correction} canViewIncidents={canViewIncidents} /> : null}
  </dl>;
}

function Change({ label, previous, corrected, preserveWhitespace = false }: { label: string; previous: string; corrected: string; preserveWhitespace?: boolean }) {
  return <div>
    <dt>{label}</dt>
    <dd style={preserveWhitespace ? { whiteSpace: "pre-wrap" } : undefined}>{previous} → {corrected}</dd>
  </div>;
}

function DateChange({ previous, corrected }: { previous: string; corrected: string }) {
  return <div>
    <dt>Fecha</dt>
    <dd><time dateTime={previous}>{formatDate(previous)}</time> → <time dateTime={corrected}>{formatDate(corrected)}</time></dd>
  </div>;
}

function IncidentChange({ correction, canViewIncidents }: { correction: CommunicationCorrection; canViewIncidents: boolean }) {
  return <div>
    <dt>Incidencia</dt>
    <dd><IncidentReference reference={correction.previousIncident} id={correction.previous.incidentId} canLink={canViewIncidents} /> → <IncidentReference reference={correction.correctedIncident} id={correction.corrected.incidentId} canLink={canViewIncidents} /></dd>
  </div>;
}

function IncidentReference({ reference, id, canLink }: { reference: { id: string; number: string } | null; id: string | null; canLink: boolean }) {
  if (!id) return <>Sin incidencia</>;
  if (!reference) return <>Incidencia histórica no disponible</>;
  return canLink ? <Link href={`/app/support/incidents/${reference.id}`}>{reference.number}</Link> : <>{reference.number}</>;
}

function channelLabel(value: string) { return value === "PHONE" ? "Teléfono" : "WhatsApp"; }
function directionLabel(value: string) { return value === "INBOUND" ? "Entrante" : "Saliente"; }
function formatDate(value: string) { return new Date(value).toLocaleString("es-ES", { timeZone: "Europe/Madrid" }); }
function contactLabel(reference: { name: string | null; role: string | null } | null, id: string | null) {
  if (!id) return "Sin contacto maestro";
  return reference?.name ?? reference?.role ?? "Contacto histórico no disponible";
}
function durationLabel(value: number | null) { return value === null ? "Sin duración" : `${value} s`; }
function resultLabel(value: string) {
  return ({
    RESOLVED_NO_FOLLOW_UP: "Resuelta sin seguimiento",
    REQUIRES_FOLLOW_UP: "Requiere seguimiento",
    NO_ANSWER: "Sin respuesta",
    INFORMATION_PROVIDED: "Información facilitada",
    REFERRED_TO_INCIDENT: "Derivada a incidencia",
  } as Record<string, string>)[value] ?? value;
}
