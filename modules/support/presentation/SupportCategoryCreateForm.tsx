"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

export function SupportCategoryCreateForm() {
  const router = useRouter();
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const idempotencyKey = useRef<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmitting(true); setMessage(null);
    const form = event.currentTarget; const data = new FormData(form);
    const body = { name: String(data.get("name") ?? "").trim(), description: String(data.get("description") ?? "").trim() || null, color: String(data.get("color") ?? "#475569") };
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/support/categories", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.current, "X-CSRF-Token": await fetchCsrfToken() }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => null) as { message?: string } | null;
      if (response.ok) { idempotencyKey.current = null; form.reset(); setMessage({ error: false, text: "Categoría creada." }); router.refresh(); }
      else { if (response.status < 500) idempotencyKey.current = null; setMessage({ error: true, text: result?.message ?? "No se pudo crear la categoría." }); }
    } catch { setMessage({ error: true, text: "Resultado incierto. Reintenta sin cambiar los datos." }); }
    finally { setSubmitting(false); }
  }
  return <form className="form-grid" onSubmit={submit}><fieldset disabled={submitting}><legend>Nueva categoría</legend><div className="form-three-columns"><label>Nombre<input name="name" required minLength={2} maxLength={120}/></label><label>Color<input name="color" type="color" defaultValue="#475569" required/></label><label>Descripción<input name="description" minLength={3} maxLength={500}/></label></div></fieldset><div className="form-actions"><button className="button" disabled={submitting}>{submitting ? "Creando…" : "Crear categoría"}</button>{message ? <p role="status" className={message.error ? "message error" : "message"}>{message.text}</p> : null}</div></form>;
}
