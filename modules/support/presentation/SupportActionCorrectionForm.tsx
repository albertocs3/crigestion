"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type Props = {
  incidentId: string;
  incidentVersion: number;
  action: { id: string; text: string; version: number };
};

export function SupportActionCorrectionForm({ incidentId, incidentVersion, action }: Props) {
  const router = useRouter();
  const [text, setText] = useState(action.text);
  const [state, setState] = useState<{ submitting: boolean; error?: boolean; message?: string }>({ submitting: false });
  const key = useRef<string | null>(null);
  const payload = useRef<string | null>(null);
  const changed = text.trim() !== action.text;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed) return;
    const data = new FormData(event.currentTarget);
    const body = {
      expectedIncidentVersion: incidentVersion,
      expectedActionVersion: action.version,
      text: text.trim(),
      reason: String(data.get("reason") ?? "").trim(),
    };
    const serialized = JSON.stringify(body);
    if (payload.current !== serialized) {
      key.current = crypto.randomUUID();
      payload.current = serialized;
    }
    key.current ??= crypto.randomUUID();
    setState({ submitting: true });
    try {
      const response = await fetch(`/api/support/incidents/${incidentId}/actions/${action.id}/corrections`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key.current, "X-CSRF-Token": await fetchCsrfToken() },
        body: serialized,
      });
      const result = await response.json().catch(() => null) as { code?: string; message?: string } | null;
      if (response.ok) {
        key.current = null;
        payload.current = null;
        setState({ submitting: false, message: "Actuación corregida." });
        router.refresh();
        return;
      }
      if (response.status < 500) {
        key.current = null;
        payload.current = null;
      }
      if (result?.code === "SUPPORT_INCIDENT_VERSION_CONFLICT" || result?.code === "SUPPORT_ACTION_VERSION_CONFLICT") router.refresh();
      const retryAfter = response.headers.get("Retry-After");
      setState({ submitting: false, error: true, message: `${result?.message ?? "No se pudo corregir la actuación."}${retryAfter ? ` Reintenta dentro de ${retryAfter} segundos.` : ""}` });
    } catch {
      setState({ submitting: false, error: true, message: "Resultado incierto. Reintenta sin cambiar los datos para reutilizar la clave idempotente." });
    }
  }

  return <form className="form-grid" onSubmit={submit}>
    <fieldset disabled={state.submitting}>
      <legend>Corregir actuación</legend>
      <label>Texto corregido<textarea value={text} onChange={(event) => setText(event.target.value)} required minLength={3} maxLength={4000} rows={5}/></label>
      <label>Motivo<textarea name="reason" required minLength={3} maxLength={500} rows={3}/></label>
      <label className="checkbox-row"><input type="checkbox" required/> Confirmo la corrección y su registro permanente.</label>
    </fieldset>
    <div className="form-actions"><button className="button button-secondary" disabled={state.submitting || !changed}>{state.submitting ? "Corrigiendo…" : "Guardar corrección"}</button>{state.message ? <p role={state.error ? "alert" : "status"} className={state.error ? "message error" : "message"}>{state.message}</p> : null}</div>
  </form>;
}
