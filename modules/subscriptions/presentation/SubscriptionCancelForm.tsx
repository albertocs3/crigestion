"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

export function SubscriptionCancelForm({ subscriptionId, version }: { subscriptionId: string; version: number }) {
  const router = useRouter(); const [submitting, setSubmitting] = useState(false); const [message, setMessage] = useState<string | null>(null);
  const retry = useRef<{ payload: string; key: string } | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.confirm("La suscripcion quedara cancelada con fecha de hoy y no podra editarse. ¿Continuar?")) return;
    setSubmitting(true); setMessage(null);
    const data = new FormData(event.currentTarget); const payload = JSON.stringify({ expectedVersion: version, reason: String(data.get("reason") ?? "") });
    if (!retry.current || retry.current.payload !== payload) retry.current = { payload, key: crypto.randomUUID() };
    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch(`/api/subscriptions/${subscriptionId}/cancel`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": retry.current.key, "X-CSRF-Token": csrfToken }, body: payload });
      const result = (await response.json().catch(() => null)) as { message?: string; code?: string } | null;
      if (!response.ok) setMessage(result?.message ?? result?.code ?? "No se pudo cancelar la suscripcion.");
      else { retry.current = null; setMessage("Suscripcion cancelada."); router.refresh(); }
    } catch { setMessage("No se pudo conectar con el servidor."); }
    finally { setSubmitting(false); }
  }
  return <form className="form-grid" onSubmit={submit} aria-busy={submitting}><fieldset disabled={submitting}><legend>Cancelar suscripcion</legend><p className="message warning">La cancelacion es inmediata, conserva el historial y no prorratea periodos.</p><label>Motivo<textarea name="reason" required minLength={3} maxLength={500} /></label></fieldset><div className="form-actions"><button className="button button-danger-soft" disabled={submitting}>{submitting ? "Cancelando..." : "Cancelar suscripcion"}</button>{message ? <p className="message" aria-live="polite">{message}</p> : null}</div></form>;
}
