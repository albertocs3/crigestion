"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type Props = {
  subscriptionId: string;
  exclusionId: string;
  subscriptionNumber: string;
  customerName: string;
  expectedVersion: number;
  periodStart: string;
  periodEndExclusive: string;
  waivedTotal: string;
};

export function SubscriptionRenewalWaiverForm(props: Props) {
  const router = useRouter();
  const key = useRef<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!window.confirm(`Condonar definitivamente ${props.waivedTotal} EUR del periodo ${props.periodStart}–${props.periodEndExclusive} de ${props.subscriptionNumber} (${props.customerName}) sin emitir factura?`)) return;
    setSubmitting(true); setMessage(null); key.current ??= crypto.randomUUID();
    try {
      const csrf = await fetchCsrfToken();
      const response = await fetch(`/api/subscriptions/${props.subscriptionId}/renewal-exclusions/${props.exclusionId}/waive`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, "Idempotency-Key": key.current },
        body: JSON.stringify({
          expectedVersion: props.expectedVersion,
          reasonCode: String(data.get("reasonCode") ?? "OTHER"),
          reasonDetail: String(data.get("reasonDetail") ?? "").trim()
        })
      });
      const result = await response.json().catch(() => null) as { message?: string; code?: string } | null;
      if (!response.ok) { setMessage(result?.message ?? result?.code ?? "No se pudo condonar el periodo."); return; }
      key.current = null; form.reset(); setMessage("Periodo condonado; la suscripción vuelve a estar activa."); router.refresh();
    } catch { setMessage("No se pudo conectar con el servidor. Puede reintentar sin duplicar efectos."); }
    finally { setSubmitting(false); }
  }
  return <form className="stack" onSubmit={submit} aria-busy={submitting}>
    <p className="message warning">Acción irreversible: condona <strong>{props.waivedTotal} EUR</strong> del periodo {props.periodStart}–{props.periodEndExclusive} para {props.customerName}, sin factura, asiento ni VeriFactu.</p>
    <label>Tipo de condonación<select name="reasonCode" defaultValue="COMMERCIAL_WAIVER" disabled={submitting}><option value="COMMERCIAL_WAIVER">Decisión comercial</option><option value="SERVICE_FAILURE">Incidencia de servicio</option><option value="OTHER">Otro motivo</option></select></label>
    <label>Justificación<textarea name="reasonDetail" required minLength={10} maxLength={500} disabled={submitting} /></label>
    <button className="button button-secondary" disabled={submitting}>{submitting ? "Condonando..." : "Condonar sin facturar"}</button>
    {message ? <p className="message" aria-live="polite">{message}</p> : null}
  </form>;
}
