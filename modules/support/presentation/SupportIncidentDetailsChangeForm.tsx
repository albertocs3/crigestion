"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCsrfToken } from "@/modules/platform/presentation/csrf";

type Props = {
  incident: { id: string; version: number; title: string; description: string; categoryId: string; storeId: string | null };
  categories: Array<{ id: string; name: string }>;
  stores: Array<{ id: string; code: string; name: string }>;
};

export function SupportIncidentDetailsChangeForm({ incident, categories, stores }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState(incident.title);
  const [description, setDescription] = useState(incident.description);
  const [categoryId, setCategoryId] = useState(incident.categoryId);
  const [storeId, setStoreId] = useState(incident.storeId ?? "");
  const [state, setState] = useState<{ submitting: boolean; error?: boolean; message?: string }>({ submitting: false });
  const key = useRef<string | null>(null);
  const payload = useRef<string | null>(null);
  const changed = title.trim() !== incident.title || description.trim() !== incident.description || categoryId !== incident.categoryId || (storeId || null) !== incident.storeId;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed) return;
    const data = new FormData(event.currentTarget);
    const body = {
      expectedVersion: incident.version,
      title: title.trim(),
      description: description.trim(),
      categoryId,
      storeId: storeId || null,
      reason: String(data.get("reason") ?? "").trim(),
    };
    const serialized = JSON.stringify(body);
    if (payload.current !== serialized) {
      key.current = crypto.randomUUID();
      payload.current = serialized;
    }
    const idempotencyKey = key.current ?? crypto.randomUUID();
    key.current = idempotencyKey;
    setState({ submitting: true });
    try {
      const response = await fetch(`/api/support/incidents/${incident.id}/detail-changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, "X-CSRF-Token": await fetchCsrfToken() },
        body: serialized,
      });
      const result = await response.json().catch(() => null) as { code?: string; message?: string } | null;
      if (response.ok) {
        key.current = null;
        payload.current = null;
        setState({ submitting: false, message: "Datos principales actualizados." });
        router.refresh();
        return;
      }
      if (response.status < 500) {
        key.current = null;
        payload.current = null;
      }
      if (result?.code === "SUPPORT_INCIDENT_VERSION_CONFLICT") router.refresh();
      const retryAfter = response.headers.get("Retry-After");
      setState({ submitting: false, error: true, message: `${result?.message ?? "No se pudo actualizar la incidencia."}${retryAfter ? ` Reintenta dentro de ${retryAfter} segundos.` : ""}` });
    } catch {
      setState({ submitting: false, error: true, message: "Resultado incierto. Reintenta sin cambiar los datos para reutilizar la clave idempotente." });
    }
  }

  return <form className="form-grid" onSubmit={submit}>
    <fieldset disabled={state.submitting}>
      <legend>Editar datos principales</legend>
      <label>Título<input value={title} onChange={(event) => setTitle(event.target.value)} required minLength={3} maxLength={200}/></label>
      <label>Descripción<textarea value={description} onChange={(event) => setDescription(event.target.value)} required minLength={3} maxLength={4000} rows={6}/></label>
      <label>Categoría<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} required>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
      <label>Tienda<select value={storeId} onChange={(event) => setStoreId(event.target.value)}><option value="">Sin tienda</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.code} · {store.name}</option>)}</select></label>
      <label>Motivo<textarea name="reason" required minLength={3} maxLength={500} rows={3}/></label>
      <label className="checkbox-row"><input type="checkbox" required/> Confirmo el cambio y su registro permanente.</label>
    </fieldset>
    <div className="form-actions"><button className="button" disabled={state.submitting || !changed}>{state.submitting ? "Guardando…" : "Guardar cambios"}</button>{state.message ? <p role={state.error ? "alert" : "status"} className={state.error ? "message error" : "message"}>{state.message}</p> : null}</div>
  </form>;
}
