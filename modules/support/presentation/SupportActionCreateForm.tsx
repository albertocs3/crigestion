"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

export function SupportActionCreateForm({ incidentId, expectedVersion, createdAt }: { incidentId: string; expectedVersion: number; createdAt: string }) {
  const router = useRouter();
  const [state, setState] = useState<{ submitting: boolean; message?: string; error?: boolean }>({ submitting: false });
  const idempotencyKey = useRef<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setState({ submitting: true });
    const form = event.currentTarget; const data = new FormData(form);
    const localDate = String(data.get("performedAt") ?? "");
    const body = { expectedVersion, text: String(data.get("text") ?? "").trim(), performedAt: new Date(localDate).toISOString() };
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch(`/api/support/incidents/${incidentId}/actions`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.current, "X-CSRF-Token": await fetchCsrfToken() }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => null) as { message?: string } | null;
      if (response.ok) { idempotencyKey.current = null; form.reset(); setState({ submitting: false, message: "Actuación registrada." }); router.refresh(); return; }
      if (response.status < 500) idempotencyKey.current = null;
      setState({ submitting: false, error: true, message: result?.message ?? (response.status >= 500 ? "Resultado incierto. Reintenta sin cambiar los datos." : "No se pudo registrar la actuación.") });
    } catch { setState({ submitting: false, error: true, message: "Resultado incierto. Reintenta sin cambiar los datos para reutilizar la clave idempotente." }); }
  }
  return <form className="form-grid" onSubmit={submit}><fieldset disabled={state.submitting}><legend>Nueva actuación</legend><label>Fecha y hora real<input name="performedAt" type="datetime-local" required min={toLocalInput(new Date(createdAt))} max={toLocalInput(new Date())} defaultValue={toLocalInput(new Date())}/></label><label>Trabajo realizado<textarea name="text" required minLength={3} maxLength={4000} rows={5}/></label><p className="muted">Evita contraseñas y datos sensibles innecesarios. La actuación no podrá eliminarse.</p></fieldset><div className="form-actions"><button className="button" disabled={state.submitting}>{state.submitting ? "Registrando…" : "Registrar actuación"}</button>{state.message ? <p role="status" className={state.error ? "message error" : "message"}>{state.message}</p> : null}</div></form>;
}

function toLocalInput(date: Date): string { const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000); return local.toISOString().slice(0, 16); }
