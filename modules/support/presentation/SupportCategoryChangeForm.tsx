"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type Category = { id: string; name: string; description: string | null; color: string; isActive: boolean; version: number };

export function SupportCategoryChangeForm({ category }: { category: Category }) {
  const router = useRouter();
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const idempotencyKey = useRef<string | null>(null);

  async function submitUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await submit({
      action: "update",
      expectedVersion: category.version,
      name: String(data.get("name") ?? "").trim(),
      description: String(data.get("description") ?? "").trim() || null,
      color: String(data.get("color") ?? "#475569"),
      reason: String(data.get("reason") ?? "").trim(),
    }, "Categoría actualizada.");
  }

  async function submitStatus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nextActive = !category.isActive;
    await submit({
      action: "set-status",
      expectedVersion: category.version,
      isActive: nextActive,
      confirmation: nextActive ? "ACTIVATE_SUPPORT_CATEGORY" : "DEACTIVATE_SUPPORT_CATEGORY",
      reason: String(data.get("statusReason") ?? "").trim(),
    }, nextActive ? "Categoría activada." : "Categoría desactivada.");
  }

  async function submit(body: unknown, successMessage: string) {
    setSubmitting(true); setMessage(null); idempotencyKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch(`/api/support/categories/${category.id}/changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.current, "X-CSRF-Token": await fetchCsrfToken() },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => null) as { message?: string } | null;
      if (response.ok) { idempotencyKey.current = null; setMessage({ error: false, text: successMessage }); router.refresh(); }
      else { if (response.status < 500) idempotencyKey.current = null; setMessage({ error: true, text: result?.message ?? "No se pudo modificar la categoría." }); }
    } catch { setMessage({ error: true, text: "Resultado incierto. Reintenta sin cambiar los datos." }); }
    finally { setSubmitting(false); }
  }

  return <details>
    <summary className="button button-secondary">Gestionar</summary>
    <div className="stack compact-stack">
      <form className="form-grid" onSubmit={submitUpdate}>
        <fieldset disabled={submitting}>
          <legend>Editar {category.name}</legend>
          <label>Nombre<input name="name" required minLength={2} maxLength={120} defaultValue={category.name}/></label>
          <label>Descripción<input name="description" minLength={3} maxLength={500} defaultValue={category.description ?? ""}/></label>
          <label>Color<input name="color" type="color" required defaultValue={category.color}/></label>
          <label>Motivo<input name="reason" required minLength={3} maxLength={500}/></label>
        </fieldset>
        <button className="button" disabled={submitting}>{submitting ? "Guardando…" : "Guardar cambios"}</button>
      </form>
      <form className="form-grid" onSubmit={submitStatus}>
        <fieldset disabled={submitting}>
          <legend>{category.isActive ? "Desactivar categoría" : "Activar categoría"}</legend>
          <label>Motivo<input name="statusReason" required minLength={3} maxLength={500}/></label>
          <label><input name="confirmed" type="checkbox" required/> Confirmo el cambio de estado</label>
        </fieldset>
        <button className={category.isActive ? "button button-danger" : "button button-secondary"} disabled={submitting}>
          {category.isActive ? "Desactivar" : "Activar"}
        </button>
      </form>
      {message ? <p role="status" className={message.error ? "message error" : "message"}>{message.text}</p> : null}
    </div>
  </details>;
}
