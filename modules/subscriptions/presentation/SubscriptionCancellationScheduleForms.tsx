"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";
import type { SubscriptionCancellationScheduleDto } from "@/modules/subscriptions/application/subscriptions";

type Props = {
  subscriptionId: string;
  subscriptionVersion: number;
  nextRenewalDate: string;
  pendingSchedule: SubscriptionCancellationScheduleDto | null;
};

export function SubscriptionCancellationScheduleForms(props: Props) {
  return props.pendingSchedule ? <RevokeForm {...props} schedule={props.pendingSchedule} /> : <CreateForm {...props} />;
}

function CreateForm({ subscriptionId, subscriptionVersion, nextRenewalDate }: Props) {
  const router = useRouter(); const [submitting, setSubmitting] = useState(false); const [message, setMessage] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmitting(true); setMessage(null);
    const data = new FormData(event.currentTarget); const payload = JSON.stringify({ expectedVersion: subscriptionVersion, effectiveDate: nextRenewalDate, reason: String(data.get("reason") ?? "") });
    key.current ??= crypto.randomUUID();
    try {
      const csrf = await fetchCsrfToken();
      const response = await fetch(`/api/subscriptions/${subscriptionId}/cancellation-schedules`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key.current, "X-CSRF-Token": csrf }, body: payload });
      const result = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
      if (!response.ok) setMessage(result?.message ?? result?.code ?? "No se pudo preparar la baja futura.");
      else { key.current = null; setMessage("Baja futura registrada como pendiente de aplicacion."); router.refresh(); }
    } catch { setMessage("No se pudo conectar con el servidor."); }
    finally { setSubmitting(false); }
  }
  return <form className="form-grid" onSubmit={submit} aria-busy={submitting}><fieldset disabled={submitting}><legend>Preparar baja futura</legend><p className="message warning">Se registrara para la proxima renovacion ({nextRenewalDate}). El futuro proceso de renovacion debera aplicar esta orden antes de autorizar cualquier factura.</p><label>Motivo<textarea name="reason" required minLength={3} maxLength={500} /></label></fieldset><div className="form-actions"><button className="button button-secondary" disabled={submitting}>{submitting ? "Registrando..." : "Registrar baja futura"}</button>{message ? <p className="message" aria-live="polite">{message}</p> : null}</div></form>;
}

function RevokeForm({ subscriptionId, subscriptionVersion, schedule }: Props & { schedule: SubscriptionCancellationScheduleDto }) {
  const router = useRouter(); const [submitting, setSubmitting] = useState(false); const [message, setMessage] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmitting(true); setMessage(null);
    const data = new FormData(event.currentTarget); const payload = JSON.stringify({ expectedSubscriptionVersion: subscriptionVersion, expectedScheduleVersion: schedule.version, reason: String(data.get("reason") ?? "") });
    key.current ??= crypto.randomUUID();
    try {
      const csrf = await fetchCsrfToken();
      const response = await fetch(`/api/subscriptions/${subscriptionId}/cancellation-schedules/${schedule.id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key.current, "X-CSRF-Token": csrf }, body: payload });
      const result = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
      if (!response.ok) setMessage(result?.message ?? result?.code ?? "No se pudo retirar la baja futura.");
      else { key.current = null; setMessage("Baja futura retirada; el historial se conserva."); router.refresh(); }
    } catch { setMessage("No se pudo conectar con el servidor."); }
    finally { setSubmitting(false); }
  }
  return <form className="form-grid" onSubmit={submit} aria-busy={submitting}><fieldset disabled={submitting}><legend>Retirar baja futura</legend><p className="message warning">Existe una baja pendiente para {schedule.effectiveDate}. La retirada conserva tanto el motivo original como su evidencia.</p><label>Motivo de retirada<textarea name="reason" required minLength={3} maxLength={500} /></label></fieldset><div className="form-actions"><button className="button button-secondary" disabled={submitting}>{submitting ? "Retirando..." : "Retirar programacion"}</button>{message ? <p className="message" aria-live="polite">{message}</p> : null}</div></form>;
}
