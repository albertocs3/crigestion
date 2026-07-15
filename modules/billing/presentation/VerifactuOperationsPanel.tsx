"use client";

import Link from "next/link";
import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { VerifactuOperationsDashboard } from "../application/verifactuOperations";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

export function VerifactuOperationsPanel({ dashboard, canManage, canManageCredentials, canCorrectRejections }: { dashboard: NonNullable<VerifactuOperationsDashboard>; canManage: boolean; canManageCredentials: boolean; canCorrectRejections: boolean }) {
  return <div className="stack">
    <section className="ops-summary" aria-label="Resumen operativo VeriFactu">
      <Summary label="Listos" value={dashboard.summary.pendingReady} tone="pending" />
      <Summary label="Procesando" value={dashboard.summary.claimed} tone="active" />
      <Summary label="Programados" value={dashboard.summary.scheduled} tone="unknown" />
      <Summary label="Requieren intervención" value={dashboard.summary.dead} tone="revoked" />
    </section>
    <section className="stack" aria-labelledby="worker-health-heading">
      <div><h2 id="worker-health-heading">Worker y comunicaciones</h2><p className="muted">Heartbeat persistente y contadores del último proceso observado por entorno.</p></div>
      {dashboard.workerAlert ? <p className={dashboard.workerAlert.severity === "CRITICAL" ? "message error" : "message"} role="alert"><code>{dashboard.workerAlert.code}</code> {dashboard.workerAlert.message}</p> : null}
      {dashboard.workerHealth.length === 0 ? <p className="message">Todavía no hay ejecuciones registradas. El worker permanece desactivado hasta iniciar la prueba controlada.</p> : <div className="table-wrap"><table aria-label="Salud de workers VeriFactu"><thead><tr><th>Entorno</th><th>Salud</th><th>Último heartbeat</th><th>Procesados</th><th>Errores</th><th>Último resultado</th></tr></thead><tbody>{dashboard.workerHealth.map((worker) => <tr key={worker.id}><td>{worker.environment}</td><td><Status value={workerHealthLabel(worker.health)} tone={workerHealthTone(worker.health)} /></td><td><time dateTime={worker.heartbeatAt}>{formatDate(worker.heartbeatAt)}</time></td><td>{worker.counters.processed}</td><td>{worker.counters.errors + worker.counters.leaseLost}</td><td>{worker.lastOutcome ? outcomeLabel(worker.lastOutcome) : worker.lastErrorCode ?? "Sin actividad"}</td></tr>)}</tbody></table></div>}
    </section>
    <section className="stack" aria-labelledby="credential-alerts-heading">
      <div className="split-header"><div><h2 id="credential-alerts-heading">Caducidad de certificados</h2><p className="muted">Avisos de versiones activas asignadas a instalaciones operativas.</p></div>{canManageCredentials ? <Link className="button button-secondary button-small" href="/app/verifactu/credentials">Gestionar credenciales</Link> : null}</div>
      {dashboard.credentialAlerts.length === 0 ? <p className="message">No hay certificados activos que caduquen en los próximos 30 días.</p> : <div className="table-wrap"><table aria-label="Alertas de caducidad de certificados"><thead><tr><th>Credencial</th><th>Instalación</th><th>Entorno</th><th>Vencimiento</th><th>Severidad</th></tr></thead><tbody>{dashboard.credentialAlerts.map((alert) => <tr key={`${alert.versionId}-${alert.installationCode}-${alert.environment}`}><td>{alert.credentialAlias}</td><td>{alert.installationCode}</td><td>{alert.environment}</td><td><time dateTime={alert.validUntil}>{formatDate(alert.validUntil)}</time></td><td><Status value={alert.severity === "CRITICAL" ? "Crítica" : "Aviso"} tone={alert.severity === "CRITICAL" ? "revoked" : "staged"} /></td></tr>)}</tbody></table></div>}
    </section>
    <section className="stack" aria-labelledby="outbox-heading">
      <div><h2 id="outbox-heading">Cola e incidencias</h2><p className="muted">La intervención solo reprograma trabajo seguro; la comunicación con AEAT la ejecuta el worker.</p></div>
      {dashboard.hasMore ? <p className="message">Se muestran los 100 mensajes más recientes. Acota los filtros para revisar el resto.</p> : null}
      {dashboard.messages.length === 0 ? <p className="message">No hay mensajes para los filtros seleccionados.</p> : <div className="table-wrap"><table aria-label="Mensajes operativos VeriFactu"><thead><tr><th>Factura</th><th>Instalación</th><th>Operación</th><th>Estado</th><th>Intentos</th><th>Último resultado</th><th>Planificación</th><th>Acción</th></tr></thead><tbody>{dashboard.messages.map((message) => <tr key={message.id}>
        <td><Link href={`/app/invoices/${message.invoice.id}`}>{message.invoice.number ?? "Sin número"}</Link><span className="cell-detail">{formatShortDate(message.invoice.issueDate)} · posición {message.chainPosition}</span></td>
        <td>{message.installation.installationCode}<span className="cell-detail">{message.installation.environment}</span></td>
        <td>{message.operation === "SUBMIT" ? "Envío" : "Conciliación"}</td>
        <td><Status value={statusLabel(message.status)} tone={statusTone(message.status)} />{message.lastErrorCode ? <code className="cell-detail">{message.lastErrorCode}</code> : null}</td>
        <td>{message.attemptCount} / {message.maxAttempts}</td>
        <td>{message.latestAttempt ? <>{outcomeLabel(message.latestAttempt.outcome)}<code className="cell-detail">{message.latestAttempt.stableErrorCode ?? "Sin código"}</code></> : "Sin intentos"}</td>
        <td>{message.status === "CLAIMED" && message.leaseUntil ? <>Lease hasta <time dateTime={message.leaseUntil}>{formatDate(message.leaseUntil)}</time></> : <time dateTime={message.nextAttemptAt}>{formatDate(message.nextAttemptAt)}</time>}</td>
        <td>{canCorrectRejections && message.rejectionCorrection ? <RejectionCorrectionForm message={message} /> : canManage && message.action ? <InterventionForm message={message} /> : message.rejectionCorrection ? <span className="muted">Requiere permiso de subsanación</span> : message.status === "DEAD" ? <span className="muted">Revisión técnica</span> : <span className="muted">Sin acción</span>}</td>
      </tr>)}</tbody></table></div>}
    </section>
  </div>;
}

function RejectionCorrectionForm({ message }: { message: NonNullable<VerifactuOperationsDashboard>["messages"][number] }) {
  const router = useRouter();
  const keyRef = useRef<string | null>(null);
  const [state, setState] = useState<{ status: "idle" | "submitting" | "success" | "error"; message?: string }>({ status: "idle" });
  const correction = message.rejectionCorrection;
  if (!correction) return null;
  const eligibleCorrection = correction;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (message.installation.environment === "PRODUCTION" && String(data.get("productionConfirmation") ?? "") !== message.invoice.number) {
      return setState({ status: "error", message: "Escribe el número exacto de factura para confirmar la subsanación en PRODUCCIÓN." });
    }
    setState({ status: "submitting" });
    try {
      keyRef.current ??= crypto.randomUUID();
      const response = await fetch(`/api/platform/verifactu/fiscal-records/${eligibleCorrection.rejectedRecordId}/correct-rejection`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": keyRef.current, "X-CSRF-Token": await fetchCsrfToken() },
        body: JSON.stringify({
          expectedRejectedAttemptId: eligibleCorrection.expectedRejectedAttemptId,
          recipientName: String(data.get("recipientName") ?? ""),
          recipientTaxId: String(data.get("recipientTaxId") ?? ""),
          reasonCode: String(data.get("reasonCode") ?? "RECIPIENT_IDENTIFICATION_CORRECTED"),
          rectificationNotRequired: data.get("rectificationNotRequired") === "on"
        })
      });
      if (response.status < 500) keyRef.current = null;
      const body = await response.json().catch(() => null) as { message?: string; chainPosition?: string } | null;
      if (!response.ok) return setState({ status: "error", message: body?.message ?? "No se pudo crear la subsanación." });
      setState({ status: "success", message: `Subsanación creada${body?.chainPosition ? ` en la posición ${body.chainPosition}` : ""} y puesta en cola.` });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Resultado incierto. Reintenta sin recargar para reutilizar la clave idempotente." });
    }
  }
  const invoiceNumber = message.invoice.number ?? "sin número";
  return <details>
    <summary className="button button-small">Subsanar rechazo</summary>
    <form className="table-form" onSubmit={submit}>
      <p className="muted">Se creará un registro fiscal nuevo. El registro rechazado y su respuesta AEAT permanecen inmutables.</p>
      {message.latestAttempt?.aeatCodes.length ? <p><strong>Códigos AEAT:</strong> {message.latestAttempt.aeatCodes.join(", ")}</p> : null}
      <label>Nombre del destinatario<input name="recipientName" defaultValue={eligibleCorrection.recipientName} required maxLength={120} disabled={state.status === "submitting"} /></label>
      <label>NIF del destinatario<input name="recipientTaxId" defaultValue={eligibleCorrection.recipientTaxId} required maxLength={16} autoCapitalize="characters" disabled={state.status === "submitting"} /></label>
      <label>Motivo<select name="reasonCode" defaultValue="RECIPIENT_IDENTIFICATION_CORRECTED" disabled={state.status === "submitting"}><option value="RECIPIENT_IDENTIFICATION_CORRECTED">Identificación del destinatario corregida</option><option value="TECHNICAL_DATA_CORRECTED">Dato técnico corregido</option></select></label>
      <label><input name="rectificationNotRequired" type="checkbox" required disabled={state.status === "submitting"} /> Confirmo que la corrección no exige emitir una factura rectificativa.</label>
      {message.installation.environment === "PRODUCTION" ? <label>Escribe {invoiceNumber} para confirmar<input name="productionConfirmation" required autoComplete="off" disabled={state.status === "submitting"} /></label> : null}
      <button className="button button-small" type="submit" disabled={state.status === "submitting"}>{state.status === "submitting" ? "Creando…" : "Crear y poner en cola"}</button>
      {state.status === "error" || state.status === "success" ? <p className={state.status === "error" ? "message error" : "message"} role={state.status === "error" ? "alert" : "status"}>{state.message}</p> : null}
    </form>
  </details>;
}

function InterventionForm({ message }: { message: NonNullable<VerifactuOperationsDashboard>["messages"][number] }) {
  const router = useRouter();
  const keyRef = useRef<string | null>(null);
  const [state, setState] = useState<{ status: "idle" | "submitting" | "success" | "error"; message?: string }>({ status: "idle" });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const reason = String(data.get("reason") ?? "MANUAL_REVIEW");
    const label = message.action === "RETRY_SUBMIT" ? "reprogramar el envío" : "programar una conciliación";
    if (!window.confirm(`Se va a ${label} para ${message.invoice.number ?? "la factura"}. ¿Continuar?`)) return;
    if (message.installation.environment === "PRODUCTION" && !window.confirm("Confirmación de PRODUCCIÓN: esta intervención será procesada por el worker contra AEAT. ¿Confirmas?")) return;
    setState({ status: "submitting" });
    try {
      keyRef.current ??= crypto.randomUUID();
      const response = await fetch(`/api/platform/verifactu/outbox-messages/${message.id}/intervene`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": keyRef.current, "X-CSRF-Token": await fetchCsrfToken() }, body: JSON.stringify({ expectedUpdatedAt: message.updatedAt, reason }) });
      if (response.status < 500) keyRef.current = null;
      const body = await response.json().catch(() => null) as { message?: string; code?: string; action?: string } | null;
      if (!response.ok) return setState({ status: "error", message: body?.message ?? body?.code ?? "No se pudo programar la intervención." });
      setState({ status: "success", message: body?.action === "RECONCILE" ? "Conciliación programada." : "Envío reprogramado." });
      router.refresh();
    } catch { setState({ status: "error", message: "Resultado incierto. Reintenta para reutilizar la misma clave idempotente." }); }
  }
  const invoiceLabel = message.invoice.number ?? "sin número";
  return <form className="table-form" onSubmit={submit}><label>Motivo para factura {invoiceLabel}<select aria-label={`Motivo para factura ${invoiceLabel}`} name="reason" defaultValue="MANUAL_REVIEW" disabled={state.status === "submitting"}><option value="MANUAL_REVIEW">Revisión manual</option><option value="CREDENTIAL_CORRECTED">Credencial corregida</option><option value="SERVICE_RECOVERED">Servicio recuperado</option></select></label><button aria-label={`${message.action === "RETRY_SUBMIT" ? "Reintentar" : "Conciliar"} factura ${invoiceLabel}`} className="button button-small" disabled={state.status === "submitting"} type="submit">{state.status === "submitting" ? "Programando…" : message.action === "RETRY_SUBMIT" ? "Reintentar" : "Conciliar"}</button>{state.status === "error" || state.status === "success" ? <p className={state.status === "error" ? "message error" : "message"} role={state.status === "error" ? "alert" : "status"}>{state.message}</p> : null}</form>;
}

function Summary({ label, value, tone }: { label: string; value: number; tone: string }) { return <div><span className="data-label">{label}</span><strong><span aria-hidden="true" className={`status-dot status-dot-${tone}`} />{value}</strong></div>; }
function Status({ value, tone }: { value: string; tone: string }) { return <span className="status"><span aria-hidden="true" className={`status-dot status-dot-${tone}`} />{value}</span>; }
function statusLabel(value: string) { return value === "PENDING" ? "Pendiente" : value === "CLAIMED" ? "Procesando" : value === "PROCESSED" ? "Procesado" : "Intervención"; }
function statusTone(value: string) { return value === "PENDING" ? "staged" : value === "CLAIMED" ? "active" : value === "PROCESSED" ? "retired" : "revoked"; }
function outcomeLabel(value: string) { return value === "ACCEPTED" ? "Aceptado" : value === "ACCEPTED_WITH_ERRORS" ? "Aceptado con avisos" : value === "REJECTED" ? "Rechazado" : value === "UNKNOWN" ? "Desconocido" : "Fallo recuperable"; }
function workerHealthLabel(value: string) { return value === "HEALTHY" ? "Operativo" : value === "STALE" ? "Sin señal" : value === "FAILED" ? "Error" : "Detenido"; }
function workerHealthTone(value: string) { return value === "HEALTHY" ? "active" : value === "STOPPED" ? "retired" : "revoked"; }
function formatDate(value: string) { return new Date(value).toLocaleString("es-ES"); }
function formatShortDate(value: string) { return new Date(value).toLocaleDateString("es-ES"); }
