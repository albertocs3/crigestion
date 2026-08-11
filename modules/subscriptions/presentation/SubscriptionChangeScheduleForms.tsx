"use client";

import { FormEvent, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";
import type { SubscriptionChangeScheduleDto } from "@/modules/subscriptions/application/subscriptionChanges";

type Line = { id: string; position: number; description: string; quantity: string };
type Props = {
  subscriptionId: string;
  subscriptionVersion: number;
  nextRenewalDate: string;
  lines: Line[];
  pendingSchedule: SubscriptionChangeScheduleDto | null;
};

export function SubscriptionChangeScheduleForms(props: Props) {
  return props.pendingSchedule ? <RevokeChange {...props} schedule={props.pendingSchedule} /> : <CreateChange {...props} />;
}

function CreateChange({ subscriptionId, subscriptionVersion, nextRenewalDate, lines }: Props) {
  const router = useRouter();
  const [quantities, setQuantities] = useState(() => Object.fromEntries(lines.map((line) => [line.id, line.quantity])));
  const [reason, setReason] = useState("");
  const [confirmedPayload, setConfirmedPayload] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const retry = useRef<{ payload: string; key: string } | null>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const changed = useMemo(() => lines.filter((line) => quantities[line.id] !== line.quantity), [lines, quantities]);

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(null);
    const normalizedReason = reason.trim();
    if (changed.length === 0) { setMessage("Cambie al menos una cantidad."); return; }
    if (normalizedReason.length < 3) { setMessage("El motivo debe contener al menos 3 caracteres."); return; }
    setConfirmedPayload(JSON.stringify({
      expectedVersion: subscriptionVersion,
      reason: normalizedReason,
      lines: changed.map((line) => ({ subscriptionLineId: line.id, quantity: quantities[line.id] }))
    }));
  }

  async function submit() {
    if (!confirmedPayload || submitting) return;
    setSubmitting(true); setMessage(null);
    if (!retry.current || retry.current.payload !== confirmedPayload) retry.current = { payload: confirmedPayload, key: crypto.randomUUID() };
    try {
      const csrf = await fetchCsrfToken();
      const response = await fetch(`/api/subscriptions/${subscriptionId}/change-schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": retry.current.key, "X-CSRF-Token": csrf },
        body: confirmedPayload
      });
      const result = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
      if (!response.ok) setMessage(result?.message ?? result?.code ?? "No se pudo programar el cambio.");
      else { retry.current = null; setMessage("Cambio programado."); router.refresh(); }
    } catch { setMessage("No se pudo conectar con el servidor. Puede reintentar la confirmacion."); }
    finally { setSubmitting(false); }
  }

  if (confirmedPayload) return <div className="form-grid" role="group" aria-busy={submitting}>
    <div className="stack"><h3>Confirmar cambio de cantidades</h3><p className="message warning">Se aplicara al reservar la renovacion de {nextRenewalDate}. Hasta entonces el contrato actual no cambia.</p>
      <ul>{changed.map((line) => <li key={line.id}>{line.description}: {line.quantity} → {quantities[line.id]}</li>)}</ul></div>
    <div className="form-actions"><button className="button" type="button" disabled={submitting} onClick={submit}>{submitting ? "Programando..." : "Programar cambio"}</button>
      <button className="button button-secondary" type="button" disabled={submitting} onClick={() => { setConfirmedPayload(null); setMessage(null); requestAnimationFrame(() => reviewButton.current?.focus()); }}>Volver</button>
      {message ? <p className="message error" role="alert">{message}</p> : null}</div>
  </div>;

  return <form className="form-grid" onSubmit={review}><fieldset><legend>Programar cambio de cantidades</legend>
    <p className="message warning">Primera version: solo cantidades de lineas existentes. Fecha efectiva: {nextRenewalDate}.</p>
    <div className="form-two-columns">{lines.map((line) => <label key={line.id} htmlFor={`subscription-change-${line.id}`}>{line.description}<span className="cell-detail">Actual: {line.quantity}</span>
      <input id={`subscription-change-${line.id}`} type="number" min="0.001" step="0.001" max="999999999.999" required value={quantities[line.id]}
        onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.currentTarget.value }))} /></label>)}</div>
    <label htmlFor="subscription-change-reason">Motivo<textarea id="subscription-change-reason" required minLength={3} maxLength={500} value={reason} onChange={(event) => setReason(event.currentTarget.value)} /></label>
    {message ? <p className="message error" role="alert">{message}</p> : null}</fieldset>
    <div className="form-actions"><button ref={reviewButton} className="button button-secondary" type="submit">Revisar cambio</button></div>
  </form>;
}

function RevokeChange({ subscriptionId, subscriptionVersion, schedule }: Props & { schedule: SubscriptionChangeScheduleDto }) {
  const router = useRouter(); const [reason, setReason] = useState(""); const [submitting, setSubmitting] = useState(false); const [message, setMessage] = useState<string | null>(null);
  const retry = useRef<{ payload: string; key: string } | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmitting(true); setMessage(null);
    const payload = JSON.stringify({ expectedSubscriptionVersion: subscriptionVersion, expectedScheduleVersion: schedule.version, reason: reason.trim() });
    if (!retry.current || retry.current.payload !== payload) retry.current = { payload, key: crypto.randomUUID() };
    try {
      const csrf = await fetchCsrfToken();
      const response = await fetch(`/api/subscriptions/${subscriptionId}/change-schedules/${schedule.id}/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": retry.current.key, "X-CSRF-Token": csrf }, body: payload
      });
      const result = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
      if (!response.ok) setMessage(result?.message ?? result?.code ?? "No se pudo retirar el cambio.");
      else { retry.current = null; setMessage("Cambio retirado; el historial se conserva."); router.refresh(); }
    } catch { setMessage("No se pudo conectar con el servidor."); }
    finally { setSubmitting(false); }
  }
  return <form className="form-grid" onSubmit={submit} aria-busy={submitting}><fieldset disabled={submitting}><legend>Retirar cambio programado</legend>
    <p className="message warning">Hay {schedule.lines.length} {schedule.lines.length === 1 ? "linea" : "lineas"} con cambio pendiente para {schedule.effectiveDate}.</p>
    <label>Motivo de retirada<textarea required minLength={3} maxLength={500} value={reason} onChange={(event) => setReason(event.currentTarget.value)} /></label></fieldset>
    <div className="form-actions"><button className="button button-secondary" disabled={submitting}>{submitting ? "Retirando..." : "Retirar cambio"}</button>{message ? <p className="message" aria-live="polite">{message}</p> : null}</div></form>;
}
